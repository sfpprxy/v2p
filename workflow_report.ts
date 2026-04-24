import { resolve } from "node:path";

import type { BiliVideoPart } from "./bili_video";
import type { SegmentFix } from "./scboy_subtitle";
import type { ProcessedPartOfftopic } from "./shownotes";

export type ClippingPartReportStatus =
  | "running"
  | "ok"
  | "skipped"
  | "error";
export type ClippingPartReportSkipReason = "short" | "missingSubtitle";

export type ClippingPartReportFix = SegmentFix;

interface ClippingPartReportBase {
  page: number;
  title: string;
  durationSeconds: number;
  processingTime: string;
}

export interface ClippingPartReportOk extends ClippingPartReportBase {
  status: "ok";
  attemptCount: number;
  llmModel?: string;
  segmentPromptHash?: string;
  subtitleSha256?: string;
  segmentCount: number;
  segmentFixes?: ClippingPartReportFix[];
}

export interface ClippingPartReportSkippedShort extends ClippingPartReportBase {
  status: "skipped";
  skipReason: "short";
}

export interface ClippingPartReportSkippedMissingSubtitle
  extends ClippingPartReportBase {
  status: "skipped";
  skipReason: "missingSubtitle";
  paths: {
    subtitlePath: string;
  };
  error: ReportError;
}

export interface ClippingPartReportError extends ClippingPartReportBase {
  status: "error";
  attemptCount?: number;
  error: ReportError;
}

export type ClippingPartReport =
  | ClippingPartReportOk
  | ClippingPartReportSkippedShort
  | ClippingPartReportSkippedMissingSubtitle
  | ClippingPartReportError;

export interface ClippingOutputPaths {
  mergedAudioPath: string;
  shownotesPath: string;
}

interface ClippingReportBase {
  bvid: string;
  title: string;
  llmModel: string;
  processingTime: string;
  parts: ClippingPartReport[];
  publish?: PublishReport;
}

export interface PublishReportPending {
  status: "pending";
}

export interface PublishReportOk {
  status: "ok";
  attemptCount: number;
}

export interface PublishReportError {
  status: "error";
  attemptCount: number;
  error: ReportError;
}

export type PublishReport =
  | PublishReportPending
  | PublishReportOk
  | PublishReportError;

export interface ClippingReportRunning extends ClippingReportBase {
  status: "running";
}

export interface ClippingReportOk extends ClippingReportBase {
  status: "ok";
}

export interface ClippingReportError extends ClippingReportBase {
  status: "error";
  paths?: ClippingOutputPaths;
  error: ReportError;
}

export type ClippingReport =
  | ClippingReportRunning
  | ClippingReportOk
  | ClippingReportError;

export interface ReportError {
  name: string;
  message: string;
  details?: string[];
}

export type ClipPartResult =
  | {
      processedPart: ProcessedPartOfftopic;
      report: ClippingPartReportOk;
    }
  | {
      processedPart: null;
      report:
        | ClippingPartReportSkippedShort
        | ClippingPartReportSkippedMissingSubtitle;
    };

export interface ClippingPartResultsSummary {
  clippingPartReports: ClippingPartReport[];
  clippedParts: ProcessedPartOfftopic[];
  mergePaths: ClippingOutputPaths | undefined;
  firstFailedResult: PromiseRejectedResult | undefined;
}

export function buildReportError(error: unknown): ReportError {
  const name = error instanceof Error ? error.name : "Error";
  const message = error instanceof Error ? error.message : String(error);
  const details = message
    .split("\n")
    .slice(1)
    .filter((line) => line !== "");

  return details.length === 0 ? { name, message } : { name, message, details };
}

export async function writeClippingReport(
  reportPath: string,
  report: ClippingReport,
): Promise<void> {
  await Bun.write(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}

export async function updateClippingReportPublishStatus(
  reportPath: string,
  publish: PublishReport,
): Promise<void> {
  const report = (await Bun.file(reportPath).json()) as ClippingReport;
  await writeClippingReport(reportPath, {
    ...report,
    publish,
  });
}

export function summarizeClipPartResults(
  clipPartSettledResults: PromiseSettledResult<ClipPartResult>[],
  parts: readonly BiliVideoPart[],
  attemptCounts: readonly (number | null)[],
  clippingStartedMs: number,
  outputDir: string,
  bvid: string,
): ClippingPartResultsSummary {
  const processingTime = formatProcessingTime(
    performance.now() - clippingStartedMs,
  );
  const clippingPartReports = clipPartSettledResults.map((result, index) => {
    if (result.status === "fulfilled") {
      return result.value.report;
    }

    return {
      page: parts[index].page,
      title: parts[index].title,
      durationSeconds: parts[index].duration,
      processingTime,
      status: "error",
      attemptCount: attemptCounts[index] ?? undefined,
      error: buildReportError(result.reason),
    } satisfies ClippingPartReport;
  });
  const clippedParts = clipPartSettledResults
    .flatMap((result) => (result.status === "fulfilled" ? [result.value] : []))
    .flatMap((result) =>
      result.report.status === "ok" ? [result.processedPart] : [],
    )
    .filter((part): part is ProcessedPartOfftopic => part !== null);
  const mergePaths =
    clippedParts.length === 0
      ? undefined
      : {
          mergedAudioPath: resolve(outputDir, `${bvid}.merge.offtopic.m4a`),
          shownotesPath: resolve(outputDir, `${bvid}.shownotes.txt`),
        };

  return {
    clippingPartReports,
    clippedParts,
    mergePaths,
    firstFailedResult: clipPartSettledResults.find(
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
