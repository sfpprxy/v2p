import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

import { concatAudioFiles, sliceAndConcatAudio } from "./audio.js";
import { downloadAudio } from "./bili_audio.js";
import { downloadSubtitle, MissingSubtitleError } from "./bili_subtitle.js";
import { buildBiliClient, buildBiliPartFileStem } from "./bili_utils.js";
import { BiliVideo, BiliVideoPart, BiliVideoStore } from "./bili_video.js";
import {
  createOrderedConcurrencyRunner,
  type OrderedTaskRunner,
} from "./concurrency.js";
import { AUDIO_DOWNLOAD_CONCURRENCY, LLM_CONCURRENCY } from "./limits.js";
import { getProfileOutputPath, profileSpan } from "./perf.js";
import { buildSegmentJsonPath, extractSegments } from "./scboy_subtitle.js";
import {
  buildMergedOfftopicShownotes,
  type OfftopicPart,
} from "./shownotes.js";
import { Client } from "@renmu/bili-api";

const PROJECT_ROOT = import.meta.dir;
export const OUTPUT_ROOT = resolve(PROJECT_ROOT, "output");
const DATE_IN_TITLE_PATTERN = /(^|[^0-9])(\d{1,2})月(\d{1,2})(?:号|日)/u;

interface ProcessedPartOfftopic extends OfftopicPart {}
type PartReportStatus = "running" | "ok" | "skipped" | "error";

interface PartReport {
  status: PartReportStatus;
  bvid: string;
  page: number;
  title: string;
  durationSeconds: number;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  skipReason?: string;
  segmentCount?: number;
  paths?: Record<string, string>;
  error?: {
    name: string;
    message: string;
  };
}

async function processVideos(
  dateInTitle?: string | [string, string] | string[] | null,
): Promise<void> {
  await profileSpan(
    "processVideos",
    {
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
        const videos = store.listVideos(dateInTitle);
        span.set({ videoCount: videos.length });
        for (const video of videos) {
          await processVideo(video, client);
        }
      } finally {
        store.close();
      }
    },
  );
}

async function processVideo(
  video: BiliVideo,
  client: ReturnType<typeof buildBiliClient>,
): Promise<void> {
  await profileSpan(
    "processVideo",
    { bvid: video.bvid, title: video.title },
    async (span) => {
      console.log(video.title);
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
        .replaceAll("【星际老男孩】", "")
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
      span.set({ outputDir });
      mkdirSync(outputDir, { recursive: true });

      const parts = await profileSpan(
        "video.getParts",
        { bvid: video.bvid },
        async (partsSpan) => {
          const videoParts = await video.getParts(client);
          partsSpan.set({ partCount: videoParts.length });
          return videoParts;
        },
      );
      span.set({ partCount: parts.length });

      const processablePartPages = parts
        .filter((part) => part.duration >= 10)
        .map((part) => part.page);
      const runAudioDownloadOrdered = createOrderedConcurrencyRunner(
        processablePartPages,
        AUDIO_DOWNLOAD_CONCURRENCY,
      );
      const runLlmOrdered = createOrderedConcurrencyRunner(
        processablePartPages,
        LLM_CONCURRENCY,
      );
      const processedPartResults = await Promise.all(
        parts.map((part) =>
          processPart(
            part,
            client,
            outputDir,
            runAudioDownloadOrdered,
            runLlmOrdered,
          ),
        ),
      );
      const processedParts = processedPartResults.filter(
        (part): part is ProcessedPartOfftopic => part !== null,
      );
      span.set({ processedPartCount: processedParts.length });
      await mergeVideoOfftopicOutputs(video.bvid, processedParts, outputDir);
    },
  );
}

async function processPart(
  part: BiliVideoPart,
  client: Client,
  outputDir: string,
  runAudioDownloadOrdered: OrderedTaskRunner<number>,
  runLlmOrdered: OrderedTaskRunner<number>,
): Promise<ProcessedPartOfftopic | null> {
  return profileSpan(
    "processPart",
    {
      bvid: part.bvid,
      page: part.page,
      title: part.tittle,
      durationSeconds: part.duration,
    },
    async (span) => {
      // console.debug(part);
      const startedAt = new Date().toISOString();
      const reportPath = resolve(
        outputDir,
        `${buildBiliPartFileStem(part)}.report.json`,
      );
      const baseReport = {
        bvid: part.bvid,
        page: part.page,
        title: part.tittle,
        durationSeconds: part.duration,
        startedAt,
      };

      await writePartReport(reportPath, {
        ...baseReport,
        status: "running",
        updatedAt: startedAt,
      });

      if (part.duration < 10) {
        const completedAt = new Date().toISOString();
        span.set({ skipped: true, skipReason: "short" });
        console.log(
          `[processPart:skip] short ${part.bvid} p${part.page} ${part.tittle} (${part.duration}s), report=${reportPath}`,
        );
        await writePartReport(reportPath, {
          ...baseReport,
          status: "skipped",
          updatedAt: completedAt,
          completedAt,
          skipReason: "short",
        });
        return null;
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

        const [audioPath, segments] = await Promise.all([
          runAudioDownloadOrdered(part.page, () =>
            downloadAudio(part, client, outputDir),
          ),
          runLlmOrdered(part.page, () =>
            extractSegments(subtitlePath, part.tittle),
          ),
        ]);
        span.set({ segmentCount: segments.length });

        const audioResult = await sliceAndConcatAudio(
          segments.map(({ start, end }) => [start, end] as const),
          audioPath,
        );
        span.set({ offtopicAudioPath: audioResult.outputPath });
        const completedAt = new Date().toISOString();
        const processedPart = {
          page: part.page,
          offtopicAudioPath: audioResult.outputPath,
          relativeSegmentsPath,
        };
        await writePartReport(reportPath, {
          ...baseReport,
          status: "ok",
          updatedAt: completedAt,
          completedAt,
          segmentCount: segments.length,
          paths: {
            subtitlePath,
            segmentJsonPath,
            relativeSegmentsPath,
            audioPath,
            offtopicAudioPath: audioResult.outputPath,
          },
        });
        return processedPart;
      } catch (error) {
        const completedAt = new Date().toISOString();
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof MissingSubtitleError) {
          span.set({
            skipped: true,
            skipReason: "missingSubtitle",
            subtitlePath: error.subtitlePath,
          });
          console.warn(
            `[processPart:skip] missing subtitle ${part.bvid} p${part.page} ${part.tittle}: ${message}, report=${reportPath}`,
          );
          await writePartReport(reportPath, {
            ...baseReport,
            status: "skipped",
            updatedAt: completedAt,
            completedAt,
            skipReason: "missingSubtitle",
            paths: {
              subtitlePath: error.subtitlePath,
            },
            error: {
              name: error.name,
              message,
            },
          });
          await Promise.all([
            runAudioDownloadOrdered(part.page, async () => null),
            runLlmOrdered(part.page, async () => null),
          ]);
          return null;
        }

        await writePartReport(reportPath, {
          ...baseReport,
          status: "error",
          updatedAt: completedAt,
          completedAt,
          error: {
            name: error instanceof Error ? error.name : "Error",
            message,
          },
        });
        throw new Error(
          `processPart failed for ${part.bvid} p${part.page} ${part.tittle}: ${message}`,
        );
      }
    },
  );
}

async function writePartReport(
  reportPath: string,
  report: PartReport,
): Promise<void> {
  await Bun.write(reportPath, `${JSON.stringify(report, null, 2)}\n`);
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
      const shownotesPath = resolve(outputDir, `${bvid}.shownotes.json`);
      span.set({ mergedAudioPath, shownotesPath });

      await concatAudioFiles(
        sortedParts.map((part) => part.offtopicAudioPath),
        mergedAudioPath,
      );

      const shownotes = await buildMergedOfftopicShownotes(sortedParts);
      span.set({ shownoteCount: shownotes.length });
      await Bun.write(shownotesPath, `${JSON.stringify(shownotes, null, 2)}\n`);
    },
  );
}

if (import.meta.main) {
  await processVideos("2026-02-10");
}
