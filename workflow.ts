import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

import { concatAudioFiles, sliceAndConcatAudio } from "./audio.js";
import { downloadAudio } from "./bili_audio.js";
import { downloadSubtitle } from "./bili_subtitle.js";
import { buildBiliClient } from "./bili_utils.js";
import { BiliVideo, BiliVideoPart, BiliVideoStore } from "./bili_video.js";
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

async function processVideos(
  dateInTitle?: string | [string, string] | string[] | null,
): Promise<void> {
  mkdirSync(OUTPUT_ROOT, { recursive: true });
  const client = buildBiliClient();
  const store = BiliVideoStore.open();
  try {
    const videos = store.listVideos(dateInTitle);
    for (const video of videos) {
      await processVideo(video, client);
    }
  } finally {
    store.close();
  }
}

async function processVideo(
  video: BiliVideo,
  client: ReturnType<typeof buildBiliClient>,
): Promise<void> {
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
  const outputDir = resolve(
    OUTPUT_ROOT,
    outputYear,
    `${outputMonth}-${outputDay}`,
  );
  mkdirSync(outputDir, { recursive: true });
  const parts = await video.getParts(client);
  const processedParts: ProcessedPartOfftopic[] = [];
  for (const part of parts) {
    const processedPart = await processPart(part, client, outputDir);
    if (processedPart !== null) {
      processedParts.push(processedPart);
    }
  }
  await mergeVideoOfftopicOutputs(video.bvid, processedParts, outputDir);
}

async function processPart(
  part: BiliVideoPart,
  client: Client,
  outputDir: string,
): Promise<ProcessedPartOfftopic | null> {
  // console.debug(part);
  if (part.duration < 10) {
    console.log(
      `skip short part: ${part.bvid} p${part.page} ${part.tittle} (${part.duration}s)`,
    );
    return null;
  }

  try {
    const subtitlePath = await downloadSubtitle(part, outputDir);
    const segmentJsonPath = buildSegmentJsonPath(subtitlePath, ".segments");
    const relativeSegmentsPath = buildSegmentJsonPath(
      subtitlePath,
      ".segments.relative",
    );

    if (
      (await Bun.file(segmentJsonPath).exists()) &&
      !(await Bun.file(relativeSegmentsPath).exists())
    ) {
      throw new Error(
        `Cached segments are missing relative segments: ${relativeSegmentsPath}`,
      );
    }

    const [audioPath, segments] = await Promise.all([
      downloadAudio(part, client, outputDir),
      extractSegments(subtitlePath, part.tittle),
    ]);
    const audioResult = await sliceAndConcatAudio(
      segments.map(({ start, end }) => [start, end] as const),
      audioPath,
    );
    return {
      page: part.page,
      offtopicAudioPath: audioResult.outputPath,
      relativeSegmentsPath,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `processPart failed for ${part.bvid} p${part.page} ${part.tittle}: ${message}`,
    );
  }
}

async function mergeVideoOfftopicOutputs(
  bvid: string,
  parts: readonly ProcessedPartOfftopic[],
  outputDir: string,
): Promise<void> {
  if (parts.length === 0) {
    return;
  }

  const sortedParts = parts.toSorted((left, right) => left.page - right.page);
  const mergedAudioPath = resolve(outputDir, `${bvid}.merge.offtopic.m4a`);
  const shownotesPath = resolve(outputDir, `${bvid}.shownotes.json`);

  await concatAudioFiles(
    sortedParts.map((part) => part.offtopicAudioPath),
    mergedAudioPath,
  );

  const shownotes = await buildMergedOfftopicShownotes(sortedParts);
  await Bun.write(shownotesPath, `${JSON.stringify(shownotes, null, 2)}\n`);
}

if (import.meta.main) {
  await processVideos("2026-02-08");
}
