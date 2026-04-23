import { resolve } from "node:path";

import type { BiliVideo, BiliVideoPart } from "./bili_video";

const PROCESSABLE_VIDEO_TITLE_PREFIX = "【星际老男孩】";
const DATE_IN_TITLE_PATTERN = /(^|[^0-9])(\d{1,2})月(\d{1,2})(?:号|日)/u;

export interface VideoOutputContext {
  outputDir: string;
  reportPath: string;
}

export interface VideoExecutionPlan extends VideoOutputContext {
  video: BiliVideo;
  parts: readonly BiliVideoPart[];
  llmModel: string;
  progressVideoTitle: string;
  processablePartPages: readonly number[];
}

export function filterProcessableVideos(
  videos: readonly BiliVideo[],
): readonly BiliVideo[] {
  return videos.filter((video) =>
    video.title.startsWith(PROCESSABLE_VIDEO_TITLE_PREFIX),
  );
}

export function buildVideoExecutionPlan(
  video: BiliVideo,
  parts: readonly BiliVideoPart[],
  llmModel: string,
  outputRoot: string,
): VideoExecutionPlan {
  const { outputDir, reportPath } = buildVideoOutputContext(video, outputRoot);
  return {
    video,
    parts,
    llmModel,
    outputDir,
    reportPath,
    progressVideoTitle: buildProgressVideoTitle(video.title),
    processablePartPages: parts
      .filter((part) => part.duration >= 10)
      .map((part) => part.page),
  };
}

function buildProgressVideoTitle(videoTitle: string): string {
  const dateMatch = videoTitle.match(DATE_IN_TITLE_PATTERN);
  const shortDate =
    dateMatch === null
      ? null
      : `${dateMatch[2]!.padStart(2, "0")}-${dateMatch[3]!.padStart(2, "0")}`;
  const normalizedTitle = videoTitle
    .replaceAll(PROCESSABLE_VIDEO_TITLE_PREFIX, "")
    .replace(DATE_IN_TITLE_PATTERN, " ")
    .replace(/[()（）[\]【】]/gu, " ")
    .replace(/[,:，、+]/gu, " ")
    .replace(/-/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const titleWords = normalizedTitle
    .split(" ")
    .map((word) => word.trim())
    .filter((word) => word !== "" && word !== "星际老男孩");
  const topic = titleWords.join(" ").slice(0, 12).trim();
  if (shortDate === null && topic === "") {
    return videoTitle;
  }
  if (shortDate === null) {
    return topic;
  }
  if (topic === "") {
    return shortDate;
  }
  return `${shortDate} ${topic}`;
}

function buildVideoOutputContext(
  video: BiliVideo,
  outputRoot: string,
): VideoOutputContext {
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
    .replaceAll(PROCESSABLE_VIDEO_TITLE_PREFIX, "")
    .replace(/[/:]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const outputDir = resolve(
    outputRoot,
    outputYear,
    outputTitle
      ? `${outputMonth}-${outputDay}-${outputTitle}`
      : `${outputMonth}-${outputDay}`,
  );
  return {
    outputDir,
    reportPath: resolve(outputDir, `${video.bvid}.report.json`),
  };
}
