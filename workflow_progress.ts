import chalk from "chalk";
import { MultiBar, Presets, SingleBar } from "cli-progress";

import { formatProcessingTime } from "./workflow_report";

const VISIBLE_PART_PROGRESS_SLOT_COUNT = 20;
const FINISHED_PART_PROGRESS_VISIBLE_MS = 2000;

export type PartProgressStatus =
  | "pending"
  | "running"
  | "retrying"
  | "ok"
  | "skipped"
  | "error";

export interface VideoPartProgressState {
  page: number;
  title: string;
  status: PartProgressStatus;
  attemptCount: number | null;
  maxAttempts: number | null;
  startedMs: number | null;
  completedMs: number | null;
  processingTime: string | null;
}

export interface WorkflowProgressDisplay {
  multibar: MultiBar;
  totalBar: SingleBar;
  partBars: SingleBar[];
}

export interface WorkflowProgressVideoState {
  progressVideoTitle: string;
  partProgressStates: readonly VideoPartProgressState[];
}

export function createWorkflowProgressDisplay(
  totalPartCount: number,
  totalProgressTitle: string,
): WorkflowProgressDisplay {
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
  return {
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
  };
}

export function updateWorkflowProgressBars(
  progressDisplay: WorkflowProgressDisplay,
  states: readonly WorkflowProgressVideoState[],
): void {
  const now = performance.now();
  const visibleParts: {
    globalIndex: number;
    videoTitle: string;
    part: VideoPartProgressState;
  }[] = [];
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
        : left.part.status === "retrying"
          ? 1
          : left.part.status === "running"
            ? 2
            : left.part.status === "skipped"
              ? 3
              : left.part.status === "ok"
                ? 4
                : 5;
    const rightRank =
      right.part.status === "error"
        ? 0
        : right.part.status === "retrying"
          ? 1
          : right.part.status === "running"
            ? 2
            : right.part.status === "skipped"
              ? 3
              : right.part.status === "ok"
                ? 4
                : 5;
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
        visiblePart.part.status === "running" ||
        visiblePart.part.status === "retrying"
        ? 0
        : 1,
      buildPartProgressPayload(visiblePart.videoTitle, visiblePart.part),
    );
  }
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
    part.status === "running" || part.status === "retrying"
      ? formatProcessingTime(performance.now() - (part.startedMs ?? 0))
      : (part.processingTime ?? "-");
  const status =
    part.status === "pending"
      ? chalk.dim("pending")
      : part.status === "running"
        ? chalk.yellow("running")
        : part.status === "retrying"
          ? chalk.yellow(`retrying ${part.attemptCount}/${part.maxAttempts}`)
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
