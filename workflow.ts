import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

import { $ } from "bun";
import chalk from "chalk";
import { MultiBar, Presets, SingleBar } from "cli-progress";
import { concatAudioFiles, sliceAndConcatAudio } from "./audio";
import { downloadAudio } from "./bili_audio";
import { downloadSubtitle, MissingSubtitleError } from "./bili_subtitle";
import { buildBiliClient } from "./bili_utils";
import {
  BiliVideo,
  BiliVideoPart,
  BiliVideoStore,
  isDateValue,
} from "./bili_video";
import {
  createConcurrencyLimiter,
  createOrderedConcurrencyRunner,
  type OrderedTaskRunner,
} from "./concurrency";
import { AUDIO_DOWNLOAD_CONCURRENCY, LLM_CONCURRENCY } from "./limits";
import { getProfileOutputPath, profileSpan } from "./perf";
import { stageEpisodes } from "./podcast";
import { buildSegmentJsonPath, extractSegments } from "./scboy_subtitle";
import {
  buildMergedOfftopicShownotes,
  type ProcessedPartOfftopic,
} from "./shownotes";
import {
  buildWorkflowReportError,
  formatProcessingTime,
  type ProcessPartResult,
  type VideoReport,
  summarizeProcessedPartResults,
  writeVideoReport,
} from "./workflow_report";
import { DEFAULT_CODEX_MODEL, DEFAULT_GEMINI_MODEL } from "./llm";
import { Client } from "@renmu/bili-api";

const PROJECT_ROOT = import.meta.dir;
export const OUTPUT_ROOT = resolve(PROJECT_ROOT, "output");
const PROCESSABLE_VIDEO_TITLE_PREFIX = "【星际老男孩】";
const DATE_IN_TITLE_PATTERN = /(^|[^0-9])(\d{1,2})月(\d{1,2})(?:号|日)/u;
const VISIBLE_PART_PROGRESS_SLOT_COUNT = 20;
const FINISHED_PART_PROGRESS_VISIBLE_MS = 2000;
const PODCAST_RELEASE_PATHS = ["podcast/episodes"];

interface VideoOutputContext {
  outputDir: string;
  reportPath: string;
}

interface VideoWithParts {
  video: BiliVideo;
  parts: readonly BiliVideoPart[];
}

interface VideoPartProgressState {
  page: number;
  title: string;
  status: "pending" | "running" | "ok" | "skipped" | "error";
  startedMs: number | null;
  completedMs: number | null;
  processingTime: string | null;
}

interface WorkflowProgressDisplay {
  multibar: MultiBar;
  totalBar: SingleBar;
  partBars: SingleBar[];
}

interface VisiblePartProgress {
  globalIndex: number;
  videoTitle: string;
  part: VideoPartProgressState;
}

interface VideoProcessingState {
  video: BiliVideo;
  parts: readonly BiliVideoPart[];
  outputDir: string;
  reportPath: string;
  llmModel: string;
  videoStartedMs: number;
  progressVideoTitle: string;
  partProgressStates: VideoPartProgressState[];
  runAudioDownloadOrdered: OrderedTaskRunner<number>;
  runLlmOrdered: OrderedTaskRunner<number>;
  processedPartSettledResults: PromiseSettledResult<ProcessPartResult>[];
  completedPartCount: number;
  isFinalized: boolean;
  finalizeResultPromise: Promise<string | null>;
  resolveFinalizeResult: (value: string | null) => void;
  rejectFinalizeResult: (error: unknown) => void;
}

async function processVideos(
  llmModel: string,
  dateInTitle?: string | [string, string] | string[] | null,
): Promise<string[]> {
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
      const store = BiliVideoStore.open();
      try {
        const listedVideos = store.listVideos(dateInTitle);
        const videos = listedVideos.filter((video) =>
          video.title.startsWith(PROCESSABLE_VIDEO_TITLE_PREFIX),
        );
        if (listedVideos.length !== videos.length) {
          console.log(
            `[processVideos:skip] ignored ${listedVideos.length - videos.length} videos without ${PROCESSABLE_VIDEO_TITLE_PREFIX} title prefix`,
          );
        }
        span.set({
          videoCount: videos.length,
          skippedVideoCount: listedVideos.length - videos.length,
        });

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

        const multibar = new MultiBar(
          {
            format: [
              chalk.dim("parts"),
              chalk.cyan("{bar}"),
              chalk.bold("{value}/{total}"),
              chalk.dim("{percentage}%"),
              chalk.dim("{title}"),
            ].join(" "),
            barCompleteChar: "█",
            barIncompleteChar: "░",
            barsize: 26,
            hideCursor: true,
            emptyOnZero: true,
          },
          Presets.shades_classic,
        );
        const totalProgressTitle =
          videosWithParts.length === 1
            ? videosWithParts[0]!.video.title
            : `${videosWithParts.length} videos`;
        const progressDisplay = {
          multibar,
          totalBar: multibar.create(totalPartCount, 0, {
            title: totalProgressTitle,
          }),
          partBars: Array.from(
            {
              length: Math.min(totalPartCount, VISIBLE_PART_PROGRESS_SLOT_COUNT),
            },
            () =>
              multibar.create(
                1,
                0,
                {
                  videoTitle: "",
                  label: "",
                  status: "",
                  processingTime: "",
                  title: "",
                },
                {
                  format: "{videoTitle} {label} {status} {processingTime} {title}",
                },
              ),
          ),
        } satisfies WorkflowProgressDisplay;
        const videoProcessingStates: VideoProcessingState[] = [];
        let progressTimer: ReturnType<typeof setInterval> | null = null;
        try {
          for (const { video, parts } of videosWithParts) {
            videoProcessingStates.push(
              await initializeVideoProcessingState(
                video,
                parts,
                llmModel,
              ),
            );
          }
          progressTimer = setInterval(() => {
            updateWorkflowProgressBars(progressDisplay, videoProcessingStates);
          }, 100);
          updateWorkflowProgressBars(progressDisplay, videoProcessingStates);
          await Promise.all(
            videoProcessingStates.flatMap((state) =>
              state.parts.map((part, index) =>
                processVideoPartLimited(() =>
                  processVideoPartTask(
                    state,
                    part,
                    index,
                    client,
                    progressDisplay,
                  ),
                ),
              ),
            ),
          );
          const finalizedVideoResults = await Promise.allSettled(
            videoProcessingStates.map((state) => state.finalizeResultPromise),
          );
          const firstFailedFinalizeResult = finalizedVideoResults.find(
            (result): result is PromiseRejectedResult => result.status === "rejected",
          );
          if (firstFailedFinalizeResult !== undefined) {
            throw firstFailedFinalizeResult.reason;
          }
          return finalizedVideoResults.flatMap((result) =>
            result.status === "fulfilled" && result.value !== null
              ? [result.value]
              : [],
          );
        } finally {
          if (progressTimer !== null) {
            clearInterval(progressTimer);
          }
          updateWorkflowProgressBars(progressDisplay, videoProcessingStates);
          for (const partBar of progressDisplay.partBars.toReversed()) {
            progressDisplay.multibar.remove(partBar);
          }
          multibar.stop();
        }
      } finally {
        store.close();
      }
    },
  );
}

const processVideoPartLimited = createConcurrencyLimiter(LLM_CONCURRENCY);

async function initializeVideoProcessingState(
  video: BiliVideo,
  parts: readonly BiliVideoPart[],
  llmModel: string,
): Promise<VideoProcessingState> {
  const { outputDir, reportPath } = buildVideoOutputContext(video);
  mkdirSync(outputDir, { recursive: true });
  const progressVideoTitle = buildProgressVideoTitle(video.title);
  const partProgressStates: VideoPartProgressState[] = parts.map((part) => ({
    page: part.page,
    title: part.tittle,
    status: "pending",
    startedMs: null,
    completedMs: null,
    processingTime: null,
  }));
  const processablePartPages = parts
    .filter((part) => part.duration >= 10)
    .map((part) => part.page);
  let resolveFinalizeResult: ((value: string | null) => void) | undefined;
  let rejectFinalizeResult: ((error: unknown) => void) | undefined;
  const finalizeResultPromise = new Promise<string | null>((resolve, reject) => {
    resolveFinalizeResult = resolve;
    rejectFinalizeResult = reject;
  });
  if (resolveFinalizeResult === undefined || rejectFinalizeResult === undefined) {
    throw new Error(`Failed to initialize finalize promise for ${video.bvid}`);
  }
  const state = {
    video,
    parts,
    outputDir,
    reportPath,
    llmModel,
    videoStartedMs: performance.now(),
    progressVideoTitle,
    partProgressStates,
    runAudioDownloadOrdered: createOrderedConcurrencyRunner(
      processablePartPages,
      AUDIO_DOWNLOAD_CONCURRENCY,
    ),
    runLlmOrdered: createOrderedConcurrencyRunner(
      processablePartPages,
      LLM_CONCURRENCY,
    ),
    processedPartSettledResults: [],
    completedPartCount: 0,
    isFinalized: false,
    finalizeResultPromise,
    resolveFinalizeResult,
    rejectFinalizeResult,
  } satisfies VideoProcessingState;

  await writeVideoReport(reportPath, {
    bvid: video.bvid,
    title: video.title,
    llmModel,
    processingTime: formatProcessingTime(0),
    status: "running",
    parts: [],
  } satisfies VideoReport);
  if (parts.length === 0) {
    await finalizeVideoProcessingState(state).catch(() => undefined);
  }
  return state;
}

async function processVideoPartTask(
  state: VideoProcessingState,
  part: BiliVideoPart,
  partIndex: number,
  client: ReturnType<typeof buildBiliClient>,
  progressDisplay: WorkflowProgressDisplay,
): Promise<void> {
  state.partProgressStates[partIndex].status = "running";
  state.partProgressStates[partIndex].startedMs = performance.now();
  state.partProgressStates[partIndex].completedMs = null;
  state.partProgressStates[partIndex].processingTime = null;
  const partStartedMs = state.partProgressStates[partIndex].startedMs;
  if (partStartedMs === null) {
    throw new Error(
      `Running part is missing startedMs: ${part.bvid} p${part.page} ${part.tittle}`,
    );
  }

  try {
    const result = await processPart(
      part,
      client,
      state.outputDir,
      state.runAudioDownloadOrdered,
      state.runLlmOrdered,
      state.llmModel,
    );
    state.processedPartSettledResults[partIndex] = {
      status: "fulfilled",
      value: result,
    } satisfies PromiseFulfilledResult<ProcessPartResult>;
    state.partProgressStates[partIndex].status = result.report.status;
    state.partProgressStates[partIndex].completedMs = performance.now();
    state.partProgressStates[partIndex].processingTime = result.report.processingTime;
  } catch (error) {
    state.processedPartSettledResults[partIndex] = {
      status: "rejected",
      reason: error,
    } satisfies PromiseRejectedResult;
    state.partProgressStates[partIndex].status = "error";
    state.partProgressStates[partIndex].completedMs = performance.now();
    state.partProgressStates[partIndex].processingTime = formatProcessingTime(
      performance.now() - partStartedMs,
    );
  } finally {
    progressDisplay.totalBar.increment();
    state.completedPartCount += 1;
    if (state.completedPartCount === state.parts.length) {
      await finalizeVideoProcessingState(state).catch(() => undefined);
    }
  }
}

async function finalizeVideoProcessingState(
  state: VideoProcessingState,
): Promise<void> {
  if (state.isFinalized) {
    return;
  }
  state.isFinalized = true;
  const { partReports, processedParts, mergePaths, firstFailedResult } =
    summarizeProcessedPartResults(
      state.processedPartSettledResults,
      state.parts,
      state.videoStartedMs,
      state.outputDir,
      state.video.bvid,
    );

  if (firstFailedResult !== undefined) {
    try {
      await writeVideoReport(state.reportPath, {
        bvid: state.video.bvid,
        title: state.video.title,
        llmModel: state.llmModel,
        processingTime: formatProcessingTime(
          performance.now() - state.videoStartedMs,
        ),
        status: "error",
        paths: mergePaths,
        parts: partReports,
        error: buildWorkflowReportError(firstFailedResult.reason),
      } satisfies VideoReport);
    } catch (error) {
      state.rejectFinalizeResult(error);
      return;
    }
    state.rejectFinalizeResult(firstFailedResult.reason);
    return;
  }

  try {
    await mergeVideoOfftopicOutputs(
      state.video.bvid,
      processedParts,
      state.outputDir,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const mergeError = new Error(
      `Failed to merge outputs for ${state.video.bvid} ${state.video.title}: ${message}`,
    );
    try {
      await writeVideoReport(state.reportPath, {
        bvid: state.video.bvid,
        title: state.video.title,
        llmModel: state.llmModel,
        processingTime: formatProcessingTime(
          performance.now() - state.videoStartedMs,
        ),
        status: "error",
        paths: mergePaths,
        parts: partReports,
        error: buildWorkflowReportError(error),
      } satisfies VideoReport);
    } catch (reportError) {
      state.rejectFinalizeResult(reportError);
      return;
    }
    state.rejectFinalizeResult(mergeError);
    return;
  }

  const processingTime = formatProcessingTime(
    performance.now() - state.videoStartedMs,
  );
  try {
    await writeVideoReport(state.reportPath, {
      bvid: state.video.bvid,
      title: state.video.title,
      llmModel: state.llmModel,
      processingTime,
      status: "ok",
      parts: partReports,
    } satisfies VideoReport);
  } catch (error) {
    state.rejectFinalizeResult(error);
    return;
  }
  state.resolveFinalizeResult(processedParts.length === 0 ? null : state.outputDir);
}

function updateWorkflowProgressBars(
  progressDisplay: WorkflowProgressDisplay,
  states: readonly VideoProcessingState[],
): void {
  const now = performance.now();
  const visibleParts: VisiblePartProgress[] = [];
  let globalIndex = 0;
  for (const state of states) {
    for (const part of state.partProgressStates) {
      if (
        (part.status === "ok" || part.status === "skipped") &&
        (part.completedMs === null ||
          now - part.completedMs > FINISHED_PART_PROGRESS_VISIBLE_MS)
      ) {
        globalIndex += 1;
        continue;
      }

      visibleParts.push({
        globalIndex,
        videoTitle: state.progressVideoTitle,
        part,
      });
      globalIndex += 1;
    }
  }

  visibleParts.sort((left, right) => {
    const leftRank =
      left.part.status === "error"
        ? 0
        : left.part.status === "running"
          ? 1
          : left.part.status === "skipped"
            ? 2
            : left.part.status === "ok"
              ? 3
              : 4;
    const rightRank =
      right.part.status === "error"
        ? 0
        : right.part.status === "running"
          ? 1
          : right.part.status === "skipped"
            ? 2
            : right.part.status === "ok"
              ? 3
              : 4;
    if (leftRank !== rightRank) {
      return leftRank - rightRank;
    }

    return left.globalIndex - right.globalIndex;
  });

  for (const [index, partBar] of progressDisplay.partBars.entries()) {
    const visiblePart = visibleParts[index];
    if (visiblePart === undefined) {
      partBar.update(0, {
        videoTitle: "",
        label: "",
        status: "",
        processingTime: "",
        title: "",
      });
      continue;
    }

    partBar.update(
      visiblePart.part.status === "pending" ||
        visiblePart.part.status === "running"
        ? 0
        : 1,
      buildPartProgressPayload(visiblePart.videoTitle, visiblePart.part),
    );
  }
}

function buildProgressVideoTitle(videoTitle: string): string {
  const dateMatch = videoTitle.match(DATE_IN_TITLE_PATTERN);
  const shortDate =
    dateMatch === null
      ? null
      : `${dateMatch[2]!.padStart(2, "0")}-${dateMatch[3]!.padStart(2, "0")}`;
  const normalizedTitle = videoTitle
    .replaceAll(PROCESSABLE_VIDEO_TITLE_PREFIX, "")
    .replace(DATE_IN_TITLE_PATTERN, " ")
    .replace(/[()（）[\]【】]/gu, " ")
    .replace(/[,:，、+]/gu, " ")
    .replace(/-/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const titleWords = normalizedTitle
    .split(" ")
    .map((word) => word.trim())
    .filter((word) => word !== "" && word !== "星际老男孩");
  const topic = titleWords.join(" ").slice(0, 12).trim();
  if (shortDate === null && topic === "") {
    return videoTitle;
  }
  if (shortDate === null) {
    return topic;
  }
  if (topic === "") {
    return shortDate;
  }
  return `${shortDate} ${topic}`;
}

function buildPartProgressPayload(
  videoTitle: string,
  part: VideoPartProgressState,
): {
  videoTitle: string;
  label: string;
  status: string;
  processingTime: string;
  title: string;
} {
  const processingTime =
    part.status === "running"
      ? formatProcessingTime(performance.now() - (part.startedMs ?? 0))
      : (part.processingTime ?? "-");
  const status =
    part.status === "pending"
      ? chalk.dim("pending")
      : part.status === "running"
        ? chalk.yellow("running")
        : part.status === "ok"
          ? chalk.green("done")
          : part.status === "skipped"
            ? chalk.gray("skipped")
            : chalk.red("error");
  return {
    videoTitle: chalk.dim(`[${videoTitle}]`),
    label: chalk.dim(`P${part.page}`),
    status,
    processingTime: chalk.dim(processingTime),
    title: part.title,
  };
}

function buildVideoOutputContext(video: BiliVideo): VideoOutputContext {
  const titleDateMatch = video.title.match(DATE_IN_TITLE_PATTERN);
  const uploadAt = video.uploadAt;
  const outputYear = String(uploadAt.getUTCFullYear());
  const outputMonth = String(
    Number(titleDateMatch?.[2] ?? uploadAt.getUTCMonth() + 1),
  ).padStart(2, "0");
  const outputDay = String(
    Number(titleDateMatch?.[3] ?? uploadAt.getUTCDate()),
  ).padStart(2, "0");
  const outputTitle = video.title
    .replaceAll(PROCESSABLE_VIDEO_TITLE_PREFIX, "")
    .replace(/[/:]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const outputDir = resolve(
    OUTPUT_ROOT,
    outputYear,
    outputTitle
      ? `${outputMonth}-${outputDay}-${outputTitle}`
      : `${outputMonth}-${outputDay}`,
  );

  return {
    outputDir,
    reportPath: resolve(outputDir, `${video.bvid}.report.json`),
  };
}

async function processPart(
  part: BiliVideoPart,
  client: Client,
  outputDir: string,
  runAudioDownloadOrdered: OrderedTaskRunner<number>,
  runLlmOrdered: OrderedTaskRunner<number>,
  llmModel: string,
): Promise<ProcessPartResult> {
  return profileSpan(
    "processPart",
    {
      bvid: part.bvid,
      page: part.page,
      title: part.tittle,
      durationSeconds: part.duration,
      llmModel,
    },
    async (span) => {
      // console.debug(part);
      const partStartedMs = performance.now();
      const baseReport = {
        page: part.page,
        title: part.tittle,
        durationSeconds: part.duration,
      };

      if (part.duration < 10) {
        span.set({ skipped: true, skipReason: "short" });
        console.log(
          `[processPart:skip] short ${part.bvid} p${part.page} ${part.tittle} (${part.duration}s)`,
        );
        return {
          processedPart: null,
          report: {
            ...baseReport,
            status: "skipped",
            processingTime: formatProcessingTime(
              performance.now() - partStartedMs,
            ),
            skipReason: "short",
          },
        } satisfies ProcessPartResult;
      }

      try {
        const subtitlePath = await downloadSubtitle(part, outputDir);
        const segmentJsonPath = buildSegmentJsonPath(subtitlePath, ".segments");
        const relativeSegmentsPath = buildSegmentJsonPath(
          subtitlePath,
          ".segments.relative",
        );
        span.set({ relativeSegmentsPath });

        if (
          (await Bun.file(segmentJsonPath).exists()) &&
          !(await Bun.file(relativeSegmentsPath).exists())
        ) {
          throw new Error(
            `Cached segments are missing relative segments: ${relativeSegmentsPath}`,
          );
        }

        const [extractResult, audioPath] = await Promise.all([
          runLlmOrdered(part.page, () =>
            extractSegments(subtitlePath, part.tittle, llmModel),
          ),
          runAudioDownloadOrdered(part.page, () =>
            downloadAudio(part, client, outputDir),
          ),
        ]);
        const { segments, fixes } = extractResult;
        span.set({ segmentCount: segments.length });

        const audioResult = await sliceAndConcatAudio(
          segments.map(({ start, end }) => [start, end] as const),
          audioPath,
        );
        span.set({ offtopicAudioPath: audioResult.outputPath });
        const processedPart = {
          page: part.page,
          offtopicAudioPath: audioResult.outputPath,
          relativeSegmentsPath,
        };
        return {
          processedPart,
          report: {
            ...baseReport,
            status: "ok",
            processingTime: formatProcessingTime(
              performance.now() - partStartedMs,
            ),
            segmentCount: segments.length,
            segmentFixes: fixes,
          },
        } satisfies ProcessPartResult;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof MissingSubtitleError) {
          span.set({
            skipped: true,
            skipReason: "missingSubtitle",
            subtitlePath: error.subtitlePath,
          });
          console.warn(
            `[processPart:skip] missing subtitle ${part.bvid} p${part.page} ${part.tittle}: ${message}`,
          );
          await Promise.all([
            runAudioDownloadOrdered(part.page, async () => null),
            runLlmOrdered(part.page, async () => null),
          ]);
          return {
            processedPart: null,
            report: {
              ...baseReport,
              status: "skipped",
              processingTime: formatProcessingTime(
                performance.now() - partStartedMs,
              ),
              skipReason: "missingSubtitle",
              paths: {
                subtitlePath: error.subtitlePath,
              },
              error: buildWorkflowReportError(error),
            },
          } satisfies ProcessPartResult;
        }
        throw new Error(
          `processPart failed for ${part.bvid} p${part.page} ${part.tittle}: ${message}`,
        );
      }
    },
  );
}

async function mergeVideoOfftopicOutputs(
  bvid: string,
  parts: readonly ProcessedPartOfftopic[],
  outputDir: string,
): Promise<void> {
  await profileSpan(
    "mergeVideoOfftopicOutputs",
    { bvid, partCount: parts.length, outputDir },
    async (span) => {
      if (parts.length === 0) {
        span.set({ skipped: true, skipReason: "emptyParts" });
        return;
      }

      const sortedParts = parts.toSorted(
        (left, right) => left.page - right.page,
      );
      const mergedAudioPath = resolve(outputDir, `${bvid}.merge.offtopic.m4a`);
      const shownotesPath = resolve(outputDir, `${bvid}.shownotes.txt`);
      span.set({ mergedAudioPath, shownotesPath });

      await concatAudioFiles(
        sortedParts.map((part) => part.offtopicAudioPath),
        mergedAudioPath,
      );

      const shownotes = await buildMergedOfftopicShownotes(sortedParts);
      span.set({ shownoteCount: shownotes.length });
      await Bun.write(shownotesPath, `${shownotes.join("\n")}\n`);
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

  const podcastOutputDirectories = await processVideos(
    llmModel,
    dateArgs.length === 0 ? null : dateArgs,
  );
  await stageEpisodes(podcastOutputDirectories);
  await publishPodcastRelease();
}

async function publishPodcastRelease(): Promise<void> {
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
    return;
  }

  await runGit(["push"], false);
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
