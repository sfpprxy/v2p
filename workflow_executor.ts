import { mkdirSync } from "node:fs";

import type { Client } from "@renmu/bili-api";

import {
  createConcurrencyLimiter,
  createOrderedConcurrencyRunner,
} from "./concurrency";
import { AUDIO_DOWNLOAD_CONCURRENCY, LLM_CONCURRENCY } from "./limits";
import { mergeVideoOfftopicOutputs, processPart } from "./workflow_tasks";
import {
  buildWorkflowReportError,
  formatProcessingTime,
  type VideoReport,
  writeVideoReport,
} from "./workflow_report";
import type { WorkflowProgressDisplay } from "./workflow_progress";
import type { VideoExecutionPlan } from "./workflow_plan";
import {
  createVideoExecutionState,
  getWorkflowProgressVideoState,
  isVideoExecutionReadyForFinalize,
  reduceVideoExecutionState,
  summarizeVideoExecutionState,
  type VideoExecutionState,
} from "./workflow_state";

const processVideoPartLimited = createConcurrencyLimiter(LLM_CONCURRENCY);

export interface VideoExecutionController {
  completionPromise: Promise<string | null>;
  getState: () => VideoExecutionState;
}

export async function startVideoExecution(
  plan: VideoExecutionPlan,
  client: Client,
  progressDisplay: WorkflowProgressDisplay,
): Promise<VideoExecutionController> {
  mkdirSync(plan.outputDir, { recursive: true });
  let state = createVideoExecutionState(plan, performance.now());
  let resolveCompletion: ((value: string | null) => void) | undefined;
  let rejectCompletion: ((error: unknown) => void) | undefined;
  const completionPromise = new Promise<string | null>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  if (resolveCompletion === undefined || rejectCompletion === undefined) {
    throw new Error(`Failed to initialize completion promise for ${plan.video.bvid}`);
  }
  const resolveVideoExecution = resolveCompletion;
  const rejectVideoExecution = rejectCompletion;

  const controller = {
    completionPromise,
    getState: () => state,
  } satisfies VideoExecutionController;
  const updateState = (nextState: VideoExecutionState): void => {
    state = nextState;
  };

  await writeVideoReport(plan.reportPath, {
    bvid: plan.video.bvid,
    title: plan.video.title,
    llmModel: plan.llmModel,
    processingTime: formatProcessingTime(0),
    status: "running",
    parts: [],
  } satisfies VideoReport);

  const runAudioDownloadOrdered = createOrderedConcurrencyRunner(
    plan.processablePartPages,
    AUDIO_DOWNLOAD_CONCURRENCY,
  );
  const runLlmOrdered = createOrderedConcurrencyRunner(
    plan.processablePartPages,
    LLM_CONCURRENCY,
  );

  if (plan.parts.length === 0) {
    await finalizeVideoExecution(
      controller,
      updateState,
      resolveVideoExecution,
      rejectVideoExecution,
    );
    return controller;
  }

  void Promise.all(
    plan.parts.map((part, partIndex) =>
      processVideoPartLimited(async () => {
        updateState(
          reduceVideoExecutionState(controller.getState(), {
            type: "partStarted",
            partIndex,
            startedMs: performance.now(),
          }),
        );
        try {
          const result = await processPart(
            part,
            client,
            plan.outputDir,
            runAudioDownloadOrdered,
            runLlmOrdered,
            plan.llmModel,
          );
          updateState(
            reduceVideoExecutionState(controller.getState(), {
              type: "partSucceeded",
              partIndex,
              completedMs: performance.now(),
              result,
            }),
          );
        } catch (error) {
          updateState(
            reduceVideoExecutionState(controller.getState(), {
              type: "partFailed",
              partIndex,
              completedMs: performance.now(),
              error,
            }),
          );
        } finally {
          progressDisplay.totalBar.increment();
          await finalizeVideoExecution(
            controller,
            updateState,
            resolveVideoExecution,
            rejectVideoExecution,
          );
        }
      }),
    ),
  ).catch(rejectVideoExecution);

  return controller;
}

export function getWorkflowProgressState(
  controller: VideoExecutionController,
): ReturnType<typeof getWorkflowProgressVideoState> {
  return getWorkflowProgressVideoState(controller.getState());
}

async function finalizeVideoExecution(
  controller: VideoExecutionController,
  updateState: (state: VideoExecutionState) => void,
  resolveCompletion: (value: string | null) => void,
  rejectCompletion: (error: unknown) => void,
): Promise<void> {
  const currentState = controller.getState();
  if (!isVideoExecutionReadyForFinalize(currentState)) {
    return;
  }
  updateState(
    reduceVideoExecutionState(currentState, {
      type: "videoFinalized",
    }),
  );

  const finalizedState = controller.getState();
  const { partReports, processedParts, mergePaths, firstFailedResult } =
    summarizeVideoExecutionState(finalizedState);
  if (firstFailedResult !== undefined) {
    try {
      await writeVideoReport(finalizedState.plan.reportPath, {
        bvid: finalizedState.plan.video.bvid,
        title: finalizedState.plan.video.title,
        llmModel: finalizedState.plan.llmModel,
        processingTime: formatProcessingTime(
          performance.now() - finalizedState.videoStartedMs,
        ),
        status: "error",
        paths: mergePaths,
        parts: partReports,
        error: buildWorkflowReportError(firstFailedResult.reason),
      } satisfies VideoReport);
    } catch (error) {
      rejectCompletion(error);
      return;
    }
    rejectCompletion(firstFailedResult.reason);
    return;
  }

  try {
    await mergeVideoOfftopicOutputs(
      finalizedState.plan.video.bvid,
      processedParts,
      finalizedState.plan.outputDir,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const mergeError = new Error(
      `Failed to merge outputs for ${finalizedState.plan.video.bvid} ${finalizedState.plan.video.title}: ${message}`,
    );
    try {
      await writeVideoReport(finalizedState.plan.reportPath, {
        bvid: finalizedState.plan.video.bvid,
        title: finalizedState.plan.video.title,
        llmModel: finalizedState.plan.llmModel,
        processingTime: formatProcessingTime(
          performance.now() - finalizedState.videoStartedMs,
        ),
        status: "error",
        paths: mergePaths,
        parts: partReports,
        error: buildWorkflowReportError(error),
      } satisfies VideoReport);
    } catch (reportError) {
      rejectCompletion(reportError);
      return;
    }
    rejectCompletion(mergeError);
    return;
  }

  try {
    await writeVideoReport(finalizedState.plan.reportPath, {
      bvid: finalizedState.plan.video.bvid,
      title: finalizedState.plan.video.title,
      llmModel: finalizedState.plan.llmModel,
      processingTime: formatProcessingTime(
        performance.now() - finalizedState.videoStartedMs,
      ),
      status: "ok",
      parts: partReports,
    } satisfies VideoReport);
  } catch (error) {
    rejectCompletion(error);
    return;
  }

  resolveCompletion(
    processedParts.length === 0 ? null : finalizedState.plan.outputDir,
  );
}
