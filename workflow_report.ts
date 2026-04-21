import { resolve } from "node:path";

import type { BiliVideoPart } from "./bili_video";
import type { ProcessedPartOfftopic } from "./shownotes";

export type PartReportStatus = "running" | "ok" | "skipped" | "error";
export type PartReportSkipReason = "short" | "missingSubtitle";

export interface PartReportFix {
  type:
    | "timestampInsideSubtitleBlock"
    | "timestampBetweenSubtitleBlocks"
    | "endTimestampAtNextSubtitleStart"
    | "startTimestampAtPreviousSubtitleEnd"
    | "emptySubtitleBlockTextFilled";
  index: number;
  boundary?: "start" | "end";
  originalTimestamp?: string;
  fixedTimestamp?: string;
  sequence?: string;
  originalText?: string;
  fixedText?: string;
}

interface PartReportBase {
  page: number;
  title: string;
  durationSeconds: number;
  processingTime: string;
}

export interface PartReportOk extends PartReportBase {
  status: "ok";
  segmentCount: number;
  segmentFixes?: PartReportFix[];
}

export interface PartReportSkippedShort extends PartReportBase {
  status: "skipped";
  skipReason: "short";
}

export interface PartReportSkippedMissingSubtitle extends PartReportBase {
  status: "skipped";
  skipReason: "missingSubtitle";
  paths: {
    subtitlePath: string;
  };
  error: WorkflowReportError;
}

export interface PartReportError extends PartReportBase {
  status: "error";
  error: WorkflowReportError;
}

export type PartReport =
  | PartReportOk
  | PartReportSkippedShort
  | PartReportSkippedMissingSubtitle
  | PartReportError;

export interface VideoMergePaths {
  mergedAudioPath: string;
  shownotesPath: string;
}

interface VideoReportBase {
  bvid: string;
  title: string;
  llmModel: string;
  processingTime: string;
  parts: PartReport[];
}

export interface VideoReportRunning extends VideoReportBase {
  status: "running";
}

export interface VideoReportOk extends VideoReportBase {
  status: "ok";
}

export interface VideoReportError extends VideoReportBase {
  status: "error";
  paths?: VideoMergePaths;
  error: WorkflowReportError;
}

export type VideoReport = VideoReportRunning | VideoReportOk | VideoReportError;

export interface WorkflowReportError {
  name: string;
  message: string;
  details?: string[];
}

export type ProcessPartResult =
  | {
      processedPart: ProcessedPartOfftopic;
      report: PartReportOk;
    }
  | {
      processedPart: null;
      report: PartReportSkippedShort | PartReportSkippedMissingSubtitle;
    };

export interface ProcessedPartResultsSummary {
  partReports: PartReport[];
  processedParts: ProcessedPartOfftopic[];
  mergePaths: VideoMergePaths | undefined;
  firstRejectedResult: PromiseRejectedResult | undefined;
}

export function buildWorkflowReportError(error: unknown): WorkflowReportError {
  const name = error instanceof Error ? error.name : "Error";
  const message = error instanceof Error ? error.message : String(error);
  const details = message
    .split("\n")
    .slice(1)
    .filter((line) => line !== "");

  return details.length === 0 ? { name, message } : { name, message, details };
}

export async function writeVideoReport(
  reportPath: string,
  report: VideoReport,
): Promise<void> {
  await Bun.write(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}

export function summarizeProcessedPartResults(
  processedPartSettledResults: PromiseSettledResult<ProcessPartResult>[],
  parts: readonly BiliVideoPart[],
  videoStartedMs: number,
  outputDir: string,
  bvid: string,
): ProcessedPartResultsSummary {
  const processingTime = formatProcessingTime(performance.now() - videoStartedMs);
  const partReports = processedPartSettledResults.map((result, index) => {
    if (result.status === "fulfilled") {
      return result.value.report;
    }

    return {
      page: parts[index].page,
      title: parts[index].tittle,
      durationSeconds: parts[index].duration,
      processingTime,
      status: "error",
      error: buildWorkflowReportError(result.reason),
    } satisfies PartReport;
  });
  const processedParts = processedPartSettledResults
    .flatMap((result) => (result.status === "fulfilled" ? [result.value] : []))
    .flatMap((result) =>
      result.report.status === "ok" ? [result.processedPart] : [],
    )
    .filter((part): part is ProcessedPartOfftopic => part !== null);
  const mergePaths =
    processedParts.length === 0
      ? undefined
      : {
          mergedAudioPath: resolve(outputDir, `${bvid}.merge.offtopic.m4a`),
          shownotesPath: resolve(outputDir, `${bvid}.shownotes.txt`),
        };

  return {
    partReports,
    processedParts,
    mergePaths,
    firstRejectedResult: processedPartSettledResults.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    ),
  };
}

export function formatProcessingTime(durationMs: number): string {
  if (durationMs < 1000) {
    return `${Math.round(durationMs)}ms`;
  }

  if (durationMs < 60_000) {
    return `${(durationMs / 1000).toFixed(1)}s`;
  }

  const minutes = Math.floor(durationMs / 60_000);
  const seconds = (durationMs % 60_000) / 1000;
  return `${minutes}m ${seconds.toFixed(1).padStart(4, "0")}s`;
}
