import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

import type { Client } from "@renmu/bili-api";

import { concatAudioFiles, sliceAndConcatAudio } from "./audio";
import { downloadAudio } from "./bili_audio";
import { downloadSubtitle, MissingSubtitleError } from "./bili_subtitle";
import type { BiliVideoPart } from "./bili_video";
import {
  createConcurrencyLimiter,
  createOrderedConcurrencyRunner,
  type OrderedTaskRunner,
} from "./concurrency";
import { AUDIO_DOWNLOAD_CONCURRENCY, LLM_CONCURRENCY } from "./limits";
import { profileSpan } from "./perf";
import { runWithRetry } from "./retry";
import { buildSegmentJsonPath, extractSegments } from "./scboy_subtitle";
import {
  buildMergedOfftopicShownotes,
  type ProcessedPartOfftopic,
} from "./shownotes";
import {
  buildReportError,
  formatProcessingTime,
  type ClipPartResult,
  type PublishReport,
  type ClippingReport,
  writeClippingReport,
} from "./workflow_report";
import type { ProgressDisplay } from "./progress";
import type {
  ClippingPlan,
  ClippingOptions,
} from "./clipping_plan";
import {
  createClippingState,
  isClippingReadyForFinalize,
  reduceClippingState,
  selectClippingProgressState,
  summarizeClippingState,
  type ClippingState,
} from "./clipping_state";

const clipPartLimited = createConcurrencyLimiter(LLM_CONCURRENCY);

export interface ClippingController {
  completionPromise: Promise<string | null>;
  getState: () => ClippingState;
}

export async function startClipping(
  plan: ClippingPlan,
  client: Client,
  progressDisplay: ProgressDisplay,
): Promise<ClippingController> {
  mkdirSync(plan.outputDir, { recursive: true });
  let state = createClippingState(plan, performance.now());
  let resolveCompletion: ((value: string | null) => void) | undefined;
  let rejectCompletion: ((error: unknown) => void) | undefined;
  const completionPromise = new Promise<string | null>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  if (resolveCompletion === undefined || rejectCompletion === undefined) {
    throw new Error(`Failed to initialize completion promise for ${plan.video.bvid}`);
  }
  const resolveClipping = resolveCompletion;
  const rejectClipping = rejectCompletion;

  const controller = {
    completionPromise,
    getState: () => state,
  } satisfies ClippingController;
  const updateState = (nextState: ClippingState): void => {
    state = nextState;
  };

  await writeClippingReport(plan.reportPath, {
    bvid: plan.video.bvid,
    title: plan.video.title,
    llmModel: plan.llmModel,
    processingTime: formatProcessingTime(0),
    status: "running",
    parts: [],
    publish: {
      status: "pending",
    },
  } satisfies ClippingReport);

  const runAudioDownloadOrdered = createOrderedConcurrencyRunner(
    plan.clippablePartPages,
    AUDIO_DOWNLOAD_CONCURRENCY,
  );
  const runLlmOrdered = createOrderedConcurrencyRunner(
    plan.clippablePartPages,
    LLM_CONCURRENCY,
  );

  if (plan.parts.length === 0) {
    await finalizeClipping(
      controller,
      updateState,
      resolveClipping,
      rejectClipping,
    );
    return controller;
  }

  void Promise.all(
    plan.parts.map((part, partIndex) =>
      clipPartLimited(async () => {
        try {
          const result = await clipPart(
            part,
            client,
            plan.outputDir,
            runAudioDownloadOrdered,
            runLlmOrdered,
            plan.llmModel,
            plan.clippingOptions,
            (attemptCount, maxAttempts) => {
              updateState(
                reduceClippingState(controller.getState(), {
                  type: "partAttemptStarted",
                  partIndex,
                  startedMs: performance.now(),
                  attemptCount,
                  maxAttempts,
                }),
              );
            },
          );
          updateState(
            reduceClippingState(controller.getState(), {
              type: "partSucceeded",
              partIndex,
              completedMs: performance.now(),
              attemptCount:
                result.report.status === "ok" ? result.report.attemptCount : null,
              result,
            }),
          );
        } catch (error) {
          updateState(
            reduceClippingState(controller.getState(), {
              type: "partFailed",
              partIndex,
              completedMs: performance.now(),
              attemptCount: getRetryAttemptCount(error),
              error,
            }),
          );
        } finally {
          progressDisplay.totalBar.increment();
          await finalizeClipping(
            controller,
            updateState,
            resolveClipping,
            rejectClipping,
          );
        }
      }),
    ),
  ).catch(rejectClipping);

  return controller;
}

export function getClippingProgressState(
  controller: ClippingController,
): ReturnType<typeof selectClippingProgressState> {
  return selectClippingProgressState(controller.getState());
}

async function finalizeClipping(
  controller: ClippingController,
  updateState: (state: ClippingState) => void,
  resolveCompletion: (value: string | null) => void,
  rejectCompletion: (error: unknown) => void,
): Promise<void> {
  const currentState = controller.getState();
  if (!isClippingReadyForFinalize(currentState)) {
    return;
  }
  updateState(
    reduceClippingState(currentState, {
      type: "clippingFinalized",
    }),
  );

  const finalizedState = controller.getState();
  const { clippingPartReports, clippedParts, mergePaths, firstFailedResult } =
    summarizeClippingState(finalizedState);
  if (firstFailedResult !== undefined) {
    try {
      await writeClippingReport(finalizedState.plan.reportPath, {
        bvid: finalizedState.plan.video.bvid,
        title: finalizedState.plan.video.title,
        llmModel: finalizedState.plan.llmModel,
        processingTime: formatProcessingTime(
          performance.now() - finalizedState.clippingStartedMs,
        ),
        status: "error",
        paths: mergePaths,
        parts: clippingPartReports,
        publish: {
          status: "pending",
        } satisfies PublishReport,
        error: buildReportError(firstFailedResult.reason),
      } satisfies ClippingReport);
    } catch (error) {
      rejectCompletion(error);
      return;
    }
    rejectCompletion(firstFailedResult.reason);
    return;
  }

  try {
    await mergeClippingOutputs(
      finalizedState.plan.video.bvid,
      clippedParts,
      finalizedState.plan.outputDir,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const mergeError = new Error(
      `Failed to merge outputs for ${finalizedState.plan.video.bvid} ${finalizedState.plan.video.title}: ${message}`,
    );
    try {
      await writeClippingReport(finalizedState.plan.reportPath, {
        bvid: finalizedState.plan.video.bvid,
        title: finalizedState.plan.video.title,
        llmModel: finalizedState.plan.llmModel,
        processingTime: formatProcessingTime(
          performance.now() - finalizedState.clippingStartedMs,
        ),
        status: "error",
        paths: mergePaths,
        parts: clippingPartReports,
        publish: {
          status: "pending",
        } satisfies PublishReport,
        error: buildReportError(error),
      } satisfies ClippingReport);
    } catch (reportError) {
      rejectCompletion(reportError);
      return;
    }
    rejectCompletion(mergeError);
    return;
  }

  try {
    await writeClippingReport(finalizedState.plan.reportPath, {
      bvid: finalizedState.plan.video.bvid,
      title: finalizedState.plan.video.title,
      llmModel: finalizedState.plan.llmModel,
      processingTime: formatProcessingTime(
        performance.now() - finalizedState.clippingStartedMs,
      ),
      status: "ok",
      parts: clippingPartReports,
      publish: {
        status: "pending",
      },
    } satisfies ClippingReport);
  } catch (error) {
    rejectCompletion(error);
    return;
  }

  resolveCompletion(
    clippedParts.length === 0 ? null : finalizedState.plan.outputDir,
  );
}

async function clipPart(
  part: BiliVideoPart,
  client: Client,
  outputDir: string,
  runAudioDownloadOrdered: OrderedTaskRunner<number>,
  runLlmOrdered: OrderedTaskRunner<number>,
  llmModel: string,
  clippingOptions: ClippingOptions,
  onPartAttemptStarted: (attemptCount: number, maxAttempts: number) => void,
): Promise<ClipPartResult> {
  return profileSpan(
    "clipPart",
    {
      bvid: part.bvid,
      page: part.page,
      title: part.title,
      durationSeconds: part.duration,
      llmModel,
    },
    async (span) => {
      const partStartedMs = performance.now();
      const baseReport = {
        page: part.page,
        title: part.title,
        durationSeconds: part.duration,
      };
      if (part.duration < 10) {
        span.set({ skipped: true, skipReason: "short" });
        console.log(
          `[clipPart:skip] short ${part.bvid} p${part.page} ${part.title} (${part.duration}s)`,
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
        } satisfies ClipPartResult;
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

        const [segmentResult, audioPath] = await Promise.all([
          runLlmOrdered(part.page, () =>
            runWithRetry(
              async () =>
                extractSegments(subtitlePath, part.title, llmModel, {
                  segmentExtraction: clippingOptions.segmentExtraction,
                }),
              {
                maxAttempts: 3,
                decide: () => "retry",
                onAttemptStarted: onPartAttemptStarted,
              },
            ),
          ),
          runAudioDownloadOrdered(part.page, () =>
            downloadAudio(part, client, outputDir),
          ),
        ]);
        const { segments, fixes, metadata } = segmentResult.value;
        span.set({ segmentCount: segments.length });
        const audioResult = await sliceAndConcatAudio(
          segments.map(({ start, end }) => [start, end] as const),
          audioPath,
        );
        span.set({ offtopicAudioPath: audioResult.outputPath });
        return {
          processedPart: {
            page: part.page,
            offtopicAudioPath: audioResult.outputPath,
            relativeSegmentsPath,
          },
          report: {
            ...baseReport,
            status: "ok",
            attemptCount: segmentResult.attemptCount,
            ...(metadata === null
              ? {}
              : {
                  llmModel: metadata.llmModel,
                  segmentPromptHash: metadata.segmentPromptHash,
                  subtitleSha256: metadata.subtitleSha256,
                }),
            processingTime: formatProcessingTime(
              performance.now() - partStartedMs,
            ),
            segmentCount: segments.length,
            segmentFixes: fixes,
          },
        } satisfies ClipPartResult;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof MissingSubtitleError) {
          span.set({
            skipped: true,
            skipReason: "missingSubtitle",
            subtitlePath: error.subtitlePath,
          });
          console.warn(
            `[clipPart:skip] missing subtitle ${part.bvid} p${part.page} ${part.title}: ${message}`,
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
              error: buildReportError(error),
            },
          } satisfies ClipPartResult;
        }
        throw new Error(
          `clipPart failed for ${part.bvid} p${part.page} ${part.title}: ${message}`,
        );
      }
    },
  );
}

async function mergeClippingOutputs(
  bvid: string,
  parts: readonly ProcessedPartOfftopic[],
  outputDir: string,
): Promise<void> {
  await profileSpan(
    "mergeClippingOutputs",
    { bvid, partCount: parts.length, outputDir },
    async (span) => {
      if (parts.length === 0) {
        span.set({ skipped: true, skipReason: "emptyParts" });
        return;
      }
      const sortedParts = parts.toSorted((left, right) => left.page - right.page);
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

function getRetryAttemptCount(error: unknown): number | null {
  return error instanceof Error &&
    "attemptCount" in error &&
    typeof error.attemptCount === "number"
    ? error.attemptCount
    : null;
}
