import { mkdirSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { $ } from "bun";
import { buildBiliClient } from "./bili_utils";
import { BiliVideo, BiliVideoPart } from "./bili_video";
import { getProfileOutputPath, profileSpan } from "./perf";
import { stageEpisodes } from "./podcast";
import {
  createWorkflowProgressDisplay,
  updateWorkflowProgressBars,
} from "./workflow_progress";
import {
  buildScboyPodcastStageInputs,
  buildScboyEpisodeNumbers,
  buildScboyVideoExecutionPlan,
  filterScboyProcessableVideos,
  type ScboyProcessedVideo,
} from "./scboy_video_plan";
import {
  getWorkflowProgressState,
  startVideoExecution,
  type VideoExecutionController,
} from "./workflow_executor";
import { DEFAULT_CODEX_MODEL, DEFAULT_GEMINI_MODEL } from "./llm";
import { runWithRetry } from "./workflow_retry";
import {
  buildWorkflowReportError,
  updateVideoReportPublishStatus,
} from "./workflow_report";
import { ScboyVideoStore, isDateValue } from "./scboy_video_store";

const PROJECT_ROOT = import.meta.dir;
export const OUTPUT_ROOT = resolve(PROJECT_ROOT, "output");
const PODCAST_RELEASE_PATHS = ["podcast/episodes"];

interface VideoWithParts {
  video: BiliVideo;
  parts: readonly BiliVideoPart[];
}

async function processVideos(
  llmModel: string,
  dateInTitle?: string | [string, string] | string[] | null,
): Promise<ScboyProcessedVideo[]> {
  return profileSpan(
    "processVideos",
    {
      llmModel,
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
        const videos = filterScboyProcessableVideos(listedVideos);
        if (listedVideos.length !== videos.length) {
          console.log(
            `[processVideos:skip] ignored ${listedVideos.length - videos.length} videos without processable title prefix`,
          );
        }
        span.set({
          videoCount: videos.length,
          skippedVideoCount: listedVideos.length - videos.length,
        });
        const episodeNumbers = buildScboyEpisodeNumbers(videos);

        const videosWithParts: VideoWithParts[] = [];
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
          videosWithParts.push({ video, parts });
        }

        const totalPartCount = videosWithParts.reduce(
          (sum, { parts }) => sum + parts.length,
          0,
        );
        span.set({ partCount: totalPartCount });

        const totalProgressTitle =
          videosWithParts.length === 1
            ? videosWithParts[0]!.video.title
            : `${videosWithParts.length} videos`;
        const progressDisplay = createWorkflowProgressDisplay(
          totalPartCount,
          totalProgressTitle,
        );
        const videoExecutions: VideoExecutionController[] = [];
        let progressTimer: ReturnType<typeof setInterval> | null = null;
        try {
          for (const { video, parts } of videosWithParts) {
            videoExecutions.push(
              await startVideoExecution(
                buildScboyVideoExecutionPlan(video, parts, llmModel, OUTPUT_ROOT),
                client,
                progressDisplay,
              ),
            );
          }
          progressTimer = setInterval(() => {
            updateWorkflowProgressBars(
              progressDisplay,
              videoExecutions.map(getWorkflowProgressState),
            );
          }, 100);
          updateWorkflowProgressBars(
            progressDisplay,
            videoExecutions.map(getWorkflowProgressState),
          );
          const finalizedVideoResults = await Promise.allSettled(
            videoExecutions.map((execution) => execution.completionPromise),
          );
          const firstFailedFinalizeResult = finalizedVideoResults.find(
            (result): result is PromiseRejectedResult => result.status === "rejected",
          );
          if (firstFailedFinalizeResult !== undefined) {
            throw firstFailedFinalizeResult.reason;
          }
          return finalizedVideoResults.flatMap((result, index) => {
            if (result.status !== "fulfilled" || result.value === null) {
              return [];
            }
            const video = videosWithParts[index]!.video;
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
          updateWorkflowProgressBars(
            progressDisplay,
            videoExecutions.map(getWorkflowProgressState),
          );
          for (const partBar of progressDisplay.partBars.toReversed()) {
            progressDisplay.multibar.remove(partBar);
          }
          progressDisplay.multibar.stop();
        }
      } finally {
        store.close();
      }
    },
  );
}

if (import.meta.main) {
  const modelArgs: string[] = [];
  const dateArgs: string[] = [];
  for (const arg of process.argv.slice(2)) {
    if (arg === "gemini" || arg === "codex") {
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

  const processedVideos = await processVideos(
    llmModel,
    dateArgs.length === 0 ? null : dateArgs,
  );
  const podcastStageInputs = buildScboyPodcastStageInputs(processedVideos);
  await stageEpisodes(podcastStageInputs);
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
      error: buildWorkflowReportError(publishError),
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
        error: ReturnType<typeof buildWorkflowReportError>;
      },
): Promise<void> {
  for (const { outputDirectory } of podcastStageInputs) {
    await updateVideoReportPublishStatus(
      findVideoReportPath(outputDirectory),
      publish,
    );
  }
}

function findVideoReportPath(outputDirectory: string): string {
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
