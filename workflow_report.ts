import { resolve } from "node:path";

import type { BiliVideoPart } from "./bili_video";
import type { ProcessedPartOfftopic } from "./shownotes";

export type PartReportStatus = "running" | "ok" | "skipped" | "error";
export type PartReportSkipReason = "short" | "missingSubtitle";

export interface PartReportFix {
  index: number;
  boundary: "start" | "end";
  originalTimestamp: string;
  fixedTimestamp: string;
}

interface PartReportBase {
  page: number;
  title: string;
  durationSeconds: number;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
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
  error: {
    name: string;
    message: string;
  };
}

export interface PartReportError extends PartReportBase {
  status: "error";
  error: {
    name: string;
    message: string;
  };
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
  startedAt: string;
  updatedAt: string;
  parts: PartReport[];
}

export interface VideoReportRunning extends VideoReportBase {
  status: "running";
}

export interface VideoReportOk extends VideoReportBase {
  status: "ok";
  completedAt: string;
}

export interface VideoReportError extends VideoReportBase {
  status: "error";
  completedAt: string;
  paths?: VideoMergePaths;
  error: {
    name: string;
    message: string;
  };
}

export type VideoReport = VideoReportRunning | VideoReportOk | VideoReportError;

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

export async function writeVideoReport(
  reportPath: string,
  report: VideoReport,
): Promise<void> {
  await Bun.write(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}

export function summarizeProcessedPartResults(
  processedPartSettledResults: PromiseSettledResult<ProcessPartResult>[],
  parts: readonly BiliVideoPart[],
  startedAt: string,
  outputDir: string,
  bvid: string,
): ProcessedPartResultsSummary {
  const completedAt = new Date().toISOString();
  const partReports = processedPartSettledResults.map((result, index) => {
    if (result.status === "fulfilled") {
      return result.value.report;
    }

    const message =
      result.reason instanceof Error
        ? result.reason.message
        : String(result.reason);
    return {
      page: parts[index].page,
      title: parts[index].tittle,
      durationSeconds: parts[index].duration,
      startedAt,
      updatedAt: completedAt,
      completedAt,
      status: "error",
      error: {
        name: result.reason instanceof Error ? result.reason.name : "Error",
        message,
      },
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
          shownotesPath: resolve(outputDir, `${bvid}.shownotes.json`),
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
