import type { ClipPartResult } from "./workflow_report";
import type { ClippingPlan } from "./clipping_plan";
import {
  formatProcessingTime,
  summarizeClipPartResults,
} from "./workflow_report";

export type ClippingPartProgressPhase =
  | "pending"
  | "active"
  | "ok"
  | "skipped"
  | "error";

export interface ClippingPartProgressState {
  page: number;
  title: string;
  phase: ClippingPartProgressPhase;
  statusLabel: string | null;
  attemptCount: number | null;
  maxAttempts: number | null;
  startedMs: number | null;
  completedMs: number | null;
  processingTime: string | null;
}

export interface ClippingProgressState {
  progressTitle: string;
  partProgressStates: readonly ClippingPartProgressState[];
}

export interface ClippingPartState {
  attemptCount: number | null;
  progress: ClippingPartProgressState;
  settledResult: PromiseSettledResult<ClipPartResult> | null;
}

export interface ClippingState {
  plan: ClippingPlan;
  clippingStartedMs: number;
  partStates: ClippingPartState[];
  isFinalized: boolean;
}

export type ClippingEvent =
  | {
      type: "partProgressStarted";
      partIndex: number;
      startedMs: number;
      statusLabel: string;
      attemptCount: number | null;
      maxAttempts: number | null;
    }
  | {
      type: "partSucceeded";
      partIndex: number;
      completedMs: number;
      attemptCount: number | null;
      result: ClipPartResult;
    }
  | {
      type: "partFailed";
      partIndex: number;
      completedMs: number;
      attemptCount: number | null;
      error: unknown;
    }
  | {
      type: "clippingFinalized";
    };

export function createClippingState(
  plan: ClippingPlan,
  clippingStartedMs: number,
): ClippingState {
  return {
    plan,
    clippingStartedMs,
    partStates: plan.parts.map((part) => ({
      attemptCount: null,
      progress: {
        page: part.page,
        title: part.title,
        phase: "pending",
        statusLabel: null,
        attemptCount: null,
        maxAttempts: null,
        startedMs: null,
        completedMs: null,
        processingTime: null,
      },
      settledResult: null,
    })),
    isFinalized: false,
  };
}

export function reduceClippingState(
  state: ClippingState,
  event: ClippingEvent,
): ClippingState {
  switch (event.type) {
    case "partProgressStarted":
      return {
        ...state,
        partStates: state.partStates.map((partState, index) =>
          index !== event.partIndex
            ? partState
            : {
                ...partState,
                progress: {
                  ...partState.progress,
                  phase: "active",
                  statusLabel: event.statusLabel,
                  attemptCount: event.attemptCount,
                  maxAttempts: event.maxAttempts,
                  startedMs: partState.progress.startedMs ?? event.startedMs,
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
                } satisfies PromiseFulfilledResult<ClipPartResult>,
                progress: {
                  ...partState.progress,
                  phase: event.result.report.status,
                  statusLabel: null,
                  attemptCount: event.attemptCount,
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
                  phase: "error",
                  statusLabel: null,
                  attemptCount: event.attemptCount,
                  completedMs: event.completedMs,
                  processingTime: formatProcessingTime(
                    event.completedMs - (partState.progress.startedMs ?? 0),
                  ),
                },
              },
        ),
      };
    case "clippingFinalized":
      return {
        ...state,
        isFinalized: true,
      };
    default:
      return event satisfies never;
  }
}

export function selectClippingProgressState(
  state: ClippingState,
): ClippingProgressState {
  return {
    progressTitle: state.plan.progressTitle,
    partProgressStates: state.partStates.map(({ progress }) => progress),
  };
}

export function isClippingReadyForFinalize(
  state: ClippingState,
): boolean {
  return (
    !state.isFinalized &&
    state.partStates.every((partState) => partState.settledResult !== null)
  );
}

export function summarizeClippingState(state: ClippingState): ReturnType<
  typeof summarizeClipPartResults
> {
  return summarizeClipPartResults(
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
    state.clippingStartedMs,
    state.plan.outputDir,
    state.plan.video.bvid,
  );
}
