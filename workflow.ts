import { mkdirSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { $ } from "bun";
import chalk from "chalk";
import { buildBiliClient } from "./bili_utils";
import { BiliVideo, BiliVideoPart } from "./bili_video";
import { getProfileOutputPath, profileSpan } from "./perf";
import { stageEpisodes } from "./podcast";
import {
  createProgressDisplay,
  updateProgressBars,
  type ProgressDisplay,
  type ProgressItem,
} from "./progress";
import {
  buildScboyPodcastStageInputs,
  buildScboyEpisodeNumbers,
  buildScboyClippingPlan,
  filterScboyClippableVideos,
  type ScboyClippingResult,
} from "./scboy_clipping";
import {
  getClippingProgressState,
  startClipping,
  type ClippingController,
} from "./clipping";
import { DEFAULT_CODEX_MODEL, DEFAULT_GEMINI_MODEL } from "./llm";
import { runWithRetry } from "./retry";
import {
  buildReportError,
  formatProcessingTime,
  updateClippingReportPublishStatus,
} from "./workflow_report";
import type { ClippingProgressState } from "./clipping_state";
import { ScboyVideoStore, isDateValue } from "./scboy_video_store";

const PROJECT_ROOT = import.meta.dir;
export const OUTPUT_ROOT = resolve(PROJECT_ROOT, "output");
const PODCAST_RELEASE_PATHS = ["podcast/episodes"];
const FINISHED_CLIPPING_PART_PROGRESS_VISIBLE_MS = 2000;

interface ClippingSource {
  video: BiliVideo;
  parts: readonly BiliVideoPart[];
}

interface WorkflowRunOptions {
  segmentExtraction: "reuse-existing" | "regenerate";
  forcePodcastUpload: boolean;
}

async function runClipping(
  llmModel: string,
  runOptions: WorkflowRunOptions,
  dateInTitle?: string | [string, string] | string[] | null,
): Promise<ScboyClippingResult[]> {
  return profileSpan(
    "runClipping",
    {
      llmModel,
      segmentExtraction: runOptions.segmentExtraction,
      forcePodcastUpload: runOptions.forcePodcastUpload,
      dateInTitle: Array.isArray(dateInTitle)
        ? dateInTitle.join(" ")
        : (dateInTitle ?? null),
    },
    async (span) => {
      mkdirSync(OUTPUT_ROOT, { recursive: true });
      const profileOutputPath = getProfileOutputPath();
      if (profileOutputPath !== null) {
        console.log(`[profile] ${profileOutputPath}`);
      }

      const client = buildBiliClient();
      const store = ScboyVideoStore.open();
      try {
        const listedVideos = store.listVideos(dateInTitle);
        const videos = filterScboyClippableVideos(listedVideos);
        if (listedVideos.length !== videos.length) {
          console.log(
            `[runClipping:skip] ignored ${listedVideos.length - videos.length} videos without processable title prefix`,
          );
        }
        span.set({
          videoCount: videos.length,
          skippedVideoCount: listedVideos.length - videos.length,
        });
        const episodeNumbers = buildScboyEpisodeNumbers(videos);

        const clippingSources: ClippingSource[] = [];
        for (const video of videos) {
          const parts = await profileSpan(
            "video.getParts",
            { bvid: video.bvid },
            async (partsSpan) => {
              const videoParts = await video.getParts(client);
              partsSpan.set({ partCount: videoParts.length });
              return videoParts;
            },
          );
          clippingSources.push({ video, parts });
        }

        const totalPartCount = clippingSources.reduce(
          (sum, { parts }) => sum + parts.length,
          0,
        );
        span.set({ partCount: totalPartCount });

        const totalProgressTitle =
          clippingSources.length === 1
            ? clippingSources[0]!.video.title
            : `${clippingSources.length} videos`;
        const progressDisplay = createProgressDisplay(
          totalPartCount,
          totalProgressTitle,
          {
            totalLabel: "parts",
            itemFormat:
              "{videoTitle} {label} {status} {processingTime} {title}",
            emptyPayload: {
              videoTitle: "",
              label: "",
              status: "",
              processingTime: "",
              title: "",
            },
          },
        );
        const clippingControllers: ClippingController[] = [];
        let progressTimer: ReturnType<typeof setInterval> | null = null;
        try {
          for (const { video, parts } of clippingSources) {
            clippingControllers.push(
              await startClipping(
                buildScboyClippingPlan(
                  video,
                  parts,
                  llmModel,
                  runOptions,
                  OUTPUT_ROOT,
                ),
                client,
                progressDisplay,
              ),
            );
          }
          progressTimer = setInterval(() => {
            updateWorkflowProgress(progressDisplay, clippingControllers);
          }, 100);
          updateWorkflowProgress(progressDisplay, clippingControllers);
          const finalizedClippingResults = await Promise.allSettled(
            clippingControllers.map((controller) => controller.completionPromise),
          );
          const firstFailedClippingResult = finalizedClippingResults.find(
            (result): result is PromiseRejectedResult => result.status === "rejected",
          );
          if (firstFailedClippingResult !== undefined) {
            throw firstFailedClippingResult.reason;
          }
          return finalizedClippingResults.flatMap((result, index) => {
            if (result.status !== "fulfilled" || result.value === null) {
              return [];
            }
            const video = clippingSources[index]!.video;
            const episodeNumber = episodeNumbers.get(video.bvid);
            if (episodeNumber === undefined) {
              throw new Error(`Missing episode number for ${video.bvid}`);
            }
            return [
              {
                video,
                outputDir: result.value,
                episodeNumber,
              },
            ];
          });
        } finally {
          if (progressTimer !== null) {
            clearInterval(progressTimer);
          }
          updateWorkflowProgress(progressDisplay, clippingControllers);
          for (const itemBar of progressDisplay.itemBars.toReversed()) {
            progressDisplay.multibar.remove(itemBar);
          }
          progressDisplay.multibar.stop();
        }
      } finally {
        store.close();
      }
    },
  );
}

function updateWorkflowProgress(
  progressDisplay: ProgressDisplay,
  clippingControllers: readonly ClippingController[],
): void {
  updateProgressBars(
    progressDisplay,
    buildWorkflowProgressItems(
      clippingControllers.map(getClippingProgressState),
    ),
  );
}

function buildWorkflowProgressItems(
  states: readonly ClippingProgressState[],
): ProgressItem[] {
  const now = performance.now();
  const progressItems: ProgressItem[] = [];
  for (const state of states) {
    for (const part of state.partProgressStates) {
      const processingTime =
        part.status === "running" || part.status === "retrying"
          ? formatProcessingTime(now - (part.startedMs ?? 0))
          : (part.processingTime ?? "-");
      let rank: number;
      let status: string;
      switch (part.status) {
        case "error":
          rank = 0;
          status = chalk.red("error");
          break;
        case "retrying":
          rank = 1;
          status = chalk.yellow(
            `retrying ${part.attemptCount}/${part.maxAttempts}`,
          );
          break;
        case "running":
          rank = 2;
          status = chalk.yellow("running");
          break;
        case "skipped":
          rank = 3;
          status = chalk.gray("skipped");
          break;
        case "ok":
          rank = 4;
          status = chalk.green("done");
          break;
        case "pending":
          rank = 5;
          status = chalk.dim("pending");
          break;
      }
      progressItems.push({
        rank,
        isComplete:
          part.status !== "pending" &&
          part.status !== "running" &&
          part.status !== "retrying",
        completedMs: part.completedMs,
        completedVisibleMs:
          part.status === "ok" || part.status === "skipped"
            ? FINISHED_CLIPPING_PART_PROGRESS_VISIBLE_MS
            : null,
        payload: {
          videoTitle: chalk.dim(`[${state.progressTitle}]`),
          label: chalk.dim(`P${part.page}`),
          status,
          processingTime: chalk.dim(processingTime),
          title: part.title,
        },
      });
    }
  }
  return progressItems;
}

if (import.meta.main) {
  const modelArgs: string[] = [];
  const dateArgs: string[] = [];
  let rerun = false;
  for (const arg of process.argv.slice(2)) {
    if (arg === "--rerun") {
      rerun = true;
    } else if (arg === "gemini" || arg === "codex") {
      modelArgs.push(arg);
    } else if (isDateValue(arg)) {
      dateArgs.push(arg);
    } else {
      throw new Error(`Unsupported workflow argument: ${arg}`);
    }
  }
  if (modelArgs.length > 1) {
    throw new Error(`Expected at most one LLM backend, got ${modelArgs.length}`);
  }
  if (dateArgs.length > 2) {
    throw new Error(`Expected at most two date arguments, got ${dateArgs.length}`);
  }

  const modelArg = modelArgs[0] ?? "gemini";
  const runOptions: WorkflowRunOptions = rerun
    ? {
        segmentExtraction: "regenerate",
        forcePodcastUpload: true,
      }
    : {
        segmentExtraction: "reuse-existing",
        forcePodcastUpload: false,
      };
  let llmModel: string;
  switch (modelArg) {
    case "gemini":
      llmModel = DEFAULT_GEMINI_MODEL;
      break;
    case "codex":
      llmModel = DEFAULT_CODEX_MODEL;
      break;
    default:
      throw new Error(`Unsupported workflow LLM backend: ${modelArg}`);
  }

  const clippingResults = await runClipping(
    llmModel,
    runOptions,
    dateArgs.length === 0 ? null : dateArgs,
  );
  const podcastStageInputs = buildScboyPodcastStageInputs(clippingResults);
  await stageEpisodes(podcastStageInputs, {
    forceUpload: runOptions.forcePodcastUpload,
  });
  await publishPodcastRelease(podcastStageInputs);
}

async function publishPodcastRelease(
  podcastStageInputs: readonly { outputDirectory: string }[],
): Promise<void> {
  for (const releasePath of PODCAST_RELEASE_PATHS) {
    await runGit(["add", releasePath]);
  }

  const stagedDiffStatus = await readGitDiffQuietStatus(
    ["diff", "--cached", "--quiet", "--", ...PODCAST_RELEASE_PATHS],
  );
  if (stagedDiffStatus === "dirty") {
    const stagedEpisodePathResult = await runGit([
      "diff",
      "--cached",
      "--name-only",
      "--",
      ...PODCAST_RELEASE_PATHS,
    ]);
    const stagedEpisodePaths = stagedEpisodePathResult.stdout
      .toString()
      .trim()
      .split("\n")
      .filter((path) => path.endsWith(".json"));
    if (stagedEpisodePaths.length === 0) {
      throw new Error("Staged podcast release has no episode manifests");
    }
    const episodeLabels = stagedEpisodePaths.map((path) => {
      const match = path.match(/^podcast\/episodes\/([^/]+)\/([^/]+)\.json$/u);
      if (match === null) {
        throw new Error(`Invalid staged podcast episode path: ${path}`);
      }
      return `${match[1]}/${match[2]}`;
    });
    const visibleEpisodeLabels = episodeLabels.slice(0, 5);
    const hiddenEpisodeCount = episodeLabels.length - visibleEpisodeLabels.length;
    const commitSubject = `Publish podcast episode${
      episodeLabels.length === 1 ? "" : "s"
    }: ${visibleEpisodeLabels.join(", ")}${
      hiddenEpisodeCount === 0 ? "" : ` and ${hiddenEpisodeCount} more`
    }`;

    await runGit([
      "commit",
      "-m",
      commitSubject,
      "--",
      ...PODCAST_RELEASE_PATHS,
    ]);
  }

  const upstreamResult = await runGit([
    "rev-parse",
    "--abbrev-ref",
    "--symbolic-full-name",
    "@{u}",
  ]);

  const aheadResult = await runGit(
    [
      "rev-list",
      "--count",
      `${upstreamResult.stdout.toString().trim()}..HEAD`,
    ],
  );
  if (Number(aheadResult.stdout.toString().trim()) === 0) {
    console.log("Podcast release unchanged; nothing to push.");
    return;
  }

  const releaseAheadStatus = await readGitDiffQuietStatus(
    [
      "diff",
      "--quiet",
      `${upstreamResult.stdout.toString().trim()}..HEAD`,
      "--",
      ...PODCAST_RELEASE_PATHS,
    ],
  );
  if (releaseAheadStatus === "clean") {
    console.log("Podcast release unchanged; nothing to push.");
    await updatePublishStatusForOutputDirectories(podcastStageInputs, {
      status: "ok",
      attemptCount: 1,
    });
    return;
  }

  try {
    const { attemptCount } = await runWithRetry(
      async () => {
        await runGit(["push"], false);
      },
      {
        maxAttempts: 3,
        decide: () => "retry",
      },
    );
    await updatePublishStatusForOutputDirectories(podcastStageInputs, {
      status: "ok",
      attemptCount,
    });
  } catch (error) {
    const attemptCount =
      error instanceof Error &&
      "attemptCount" in error &&
      typeof error.attemptCount === "number"
        ? error.attemptCount
        : 1;
    const publishError =
      error instanceof Error && "cause" in error ? error.cause : error;
    await updatePublishStatusForOutputDirectories(podcastStageInputs, {
      status: "error",
      attemptCount,
      error: buildReportError(publishError),
    });
    throw publishError;
  }
}

async function runGit(
  args: readonly string[],
  quiet = true,
): Promise<$.ShellOutput> {
  return $`git ${args}`.cwd(PROJECT_ROOT).quiet(quiet);
}

async function readGitDiffQuietStatus(
  args: readonly string[],
): Promise<"clean" | "dirty"> {
  const result = await $`git ${args}`
    .cwd(PROJECT_ROOT)
    .nothrow()
    .quiet();

  if (result.exitCode === 0) {
    return "clean";
  }
  if (result.exitCode === 1) {
    return "dirty";
  }

  throw new Error(`Git diff status check failed with code ${result.exitCode}`);
}

async function updatePublishStatusForOutputDirectories(
  podcastStageInputs: readonly { outputDirectory: string }[],
  publish:
    | {
        status: "ok";
        attemptCount: number;
      }
    | {
        status: "error";
        attemptCount: number;
        error: ReturnType<typeof buildReportError>;
      },
): Promise<void> {
  for (const { outputDirectory } of podcastStageInputs) {
    await updateClippingReportPublishStatus(
      findClippingReportPath(outputDirectory),
      publish,
    );
  }
}

function findClippingReportPath(outputDirectory: string): string {
  const reportFilenames = readdirSync(outputDirectory).filter((filename) =>
    filename.endsWith(".report.json"),
  );
  if (reportFilenames.length !== 1) {
    throw new Error(
      `Expected exactly one report file in ${outputDirectory}, got ${reportFilenames.length}`,
    );
  }
  return resolve(outputDirectory, reportFilenames[0]!);
}
