import type { ProcessPartResult } from "./workflow_report";
import type { VideoExecutionPlan } from "./workflow_plan";
import {
  formatProcessingTime,
  summarizeProcessedPartResults,
} from "./workflow_report";
import type {
  VideoPartProgressState,
  WorkflowProgressVideoState,
} from "./workflow_progress";

export interface VideoPartExecutionState {
  attemptCount: number | null;
  progress: VideoPartProgressState;
  settledResult: PromiseSettledResult<ProcessPartResult> | null;
}

export interface VideoExecutionState {
  plan: VideoExecutionPlan;
  videoStartedMs: number;
  partStates: VideoPartExecutionState[];
  isFinalized: boolean;
}

export type VideoExecutionEvent =
  | {
      type: "partStarted";
      partIndex: number;
      startedMs: number;
    }
  | {
      type: "partSucceeded";
      partIndex: number;
      completedMs: number;
      attemptCount: number | null;
      result: ProcessPartResult;
    }
  | {
      type: "partFailed";
      partIndex: number;
      completedMs: number;
      attemptCount: number | null;
      error: unknown;
    }
  | {
      type: "videoFinalized";
    };

export function createVideoExecutionState(
  plan: VideoExecutionPlan,
  videoStartedMs: number,
): VideoExecutionState {
  return {
    plan,
    videoStartedMs,
    partStates: plan.parts.map((part) => ({
      attemptCount: null,
      progress: {
        page: part.page,
        title: part.tittle,
        status: "pending",
        startedMs: null,
        completedMs: null,
        processingTime: null,
      },
      settledResult: null,
    })),
    isFinalized: false,
  };
}

export function reduceVideoExecutionState(
  state: VideoExecutionState,
  event: VideoExecutionEvent,
): VideoExecutionState {
  switch (event.type) {
    case "partStarted":
      return {
        ...state,
        partStates: state.partStates.map((partState, index) =>
          index !== event.partIndex
            ? partState
            : {
                ...partState,
                progress: {
                  ...partState.progress,
                  status: "running",
                  startedMs: event.startedMs,
                  completedMs: null,
                  processingTime: null,
                },
              },
        ),
      };
    case "partSucceeded":
      return {
        ...state,
        partStates: state.partStates.map((partState, index) =>
          index !== event.partIndex
            ? partState
            : {
                attemptCount: event.attemptCount,
                settledResult: {
                  status: "fulfilled",
                  value: event.result,
                } satisfies PromiseFulfilledResult<ProcessPartResult>,
                progress: {
                  ...partState.progress,
                  status: event.result.report.status,
                  completedMs: event.completedMs,
                  processingTime: event.result.report.processingTime,
                },
              },
        ),
      };
    case "partFailed":
      return {
        ...state,
        partStates: state.partStates.map((partState, index) =>
          index !== event.partIndex
            ? partState
            : {
                attemptCount: event.attemptCount,
                settledResult: {
                  status: "rejected",
                  reason: event.error,
                } satisfies PromiseRejectedResult,
                progress: {
                  ...partState.progress,
                  status: "error",
                  completedMs: event.completedMs,
                  processingTime: formatProcessingTime(
                    event.completedMs - (partState.progress.startedMs ?? 0),
                  ),
                },
              },
        ),
      };
    case "videoFinalized":
      return {
        ...state,
        isFinalized: true,
      };
    default:
      return event satisfies never;
  }
}

export function getWorkflowProgressVideoState(
  state: VideoExecutionState,
): WorkflowProgressVideoState {
  return {
    progressVideoTitle: state.plan.progressVideoTitle,
    partProgressStates: state.partStates.map(({ progress }) => progress),
  };
}

export function isVideoExecutionReadyForFinalize(
  state: VideoExecutionState,
): boolean {
  return (
    !state.isFinalized &&
    state.partStates.every((partState) => partState.settledResult !== null)
  );
}

export function summarizeVideoExecutionState(state: VideoExecutionState): ReturnType<
  typeof summarizeProcessedPartResults
> {
  return summarizeProcessedPartResults(
    state.partStates.map((partState, index) => {
      if (partState.settledResult === null) {
        throw new Error(
          `Part state is missing settled result for ${state.plan.video.bvid} p${state.plan.parts[index]!.page}`,
        );
      }
      return partState.settledResult;
    }),
    state.plan.parts,
    state.partStates.map((partState) => partState.attemptCount),
    state.videoStartedMs,
    state.plan.outputDir,
    state.plan.video.bvid,
  );
}
