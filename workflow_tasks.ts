import { resolve } from "node:path";

import type { Client } from "@renmu/bili-api";

import { concatAudioFiles, sliceAndConcatAudio } from "./audio";
import { downloadAudio } from "./bili_audio";
import { downloadSubtitle, MissingSubtitleError } from "./bili_subtitle";
import type { BiliVideoPart } from "./bili_video";
import type { OrderedTaskRunner } from "./concurrency";
import { profileSpan } from "./perf";
import { buildSegmentJsonPath, extractSegments } from "./scboy_subtitle";
import {
  buildMergedOfftopicShownotes,
  type ProcessedPartOfftopic,
} from "./shownotes";
import { runWithRetry } from "./workflow_retry";
import {
  buildWorkflowReportError,
  formatProcessingTime,
  type ProcessPartResult,
} from "./workflow_report";

export async function processPart(
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

        const [segmentResult, audioPath] = await Promise.all([
          runLlmOrdered(part.page, () =>
            runWithRetry(
              async () => extractSegments(subtitlePath, part.tittle, llmModel),
              {
                maxAttempts: 3,
                decide: () => "retry",
              },
            ),
          ),
          runAudioDownloadOrdered(part.page, () =>
            downloadAudio(part, client, outputDir),
          ),
        ]);
        const { segments, fixes } = segmentResult.value;
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

export async function mergeVideoOfftopicOutputs(
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
