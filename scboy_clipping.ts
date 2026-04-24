import type { BiliVideo, BiliVideoPart } from "./bili_video";
import type { PodcastStageInput } from "./podcast";
import {
  buildClippingPlan,
  type ClippingOptions,
  type ClippingPlan,
} from "./clipping_plan";

const PROCESSABLE_VIDEO_TITLE_PREFIX = "【星际老男孩】";
const TITLE_DATE_PATTERN = /(^|[^0-9])(\d{1,2})月(\d{1,2})(?:号|日)/u;

export interface ScboyClippingSource {
  video: BiliVideo;
  parts: readonly BiliVideoPart[];
}

export type ScboyEpisodeVideo = readonly [
  video: BiliVideo,
  episodeNumber: string,
];

export interface ScboyClippingResult {
  video: BiliVideo;
  outputDir: string;
  episodeNumber: string;
}

export function filterScboyClippableVideos(
  videos: readonly BiliVideo[],
): readonly BiliVideo[] {
  return videos.filter((video) =>
    video.title.startsWith(PROCESSABLE_VIDEO_TITLE_PREFIX),
  );
}

export function buildScboyClippingPlan(
  video: BiliVideo,
  parts: readonly BiliVideoPart[],
  llmModel: string,
  episodeNumber: string,
  clippingOptions: ClippingOptions,
  outputRoot: string,
): ClippingPlan {
  const titleDate = parseScboyTitleDate(video);
  return buildClippingPlan(
    video,
    parts,
    llmModel,
    titleDate.year,
    episodeNumber,
    clippingOptions,
    outputRoot,
    buildScboyOutputDirectoryName(video, titleDate),
    buildScboyClippingProgressTitle(video.title),
  );
}

export function buildScboyPodcastStageInputs(
  clippingResults: readonly ScboyClippingResult[],
): PodcastStageInput[] {
  return clippingResults.map((clippingResult) => ({
    outputDirectory: clippingResult.outputDir,
    episodeNumber: clippingResult.episodeNumber,
  }));
}

export function buildScboyEpisodeVideos(
  videos: readonly BiliVideo[],
): ScboyEpisodeVideo[] {
  const episodeVideos = videos.map((video) => ({
    video,
    titleDate: parseScboyTitleDate(video),
    episodeSequence: 1,
  }));

  [...episodeVideos]
    .sort((left, right) => {
      const leftDate = left.titleDate;
      const rightDate = right.titleDate;
      if (leftDate.key !== rightDate.key) {
        return leftDate.key.localeCompare(rightDate.key);
      }
      const uploadTimeDiff =
        left.video.uploadAt.getTime() - right.video.uploadAt.getTime();
      return uploadTimeDiff === 0
        ? left.video.bvid.localeCompare(right.video.bvid)
        : uploadTimeDiff;
    })
    .forEach((episodeVideo, sortedIndex, sortedEpisodeVideos) => {
      for (let index = sortedIndex - 1; index >= 0; index -= 1) {
        const previousTitleDate = sortedEpisodeVideos[index]!.titleDate;
        if (previousTitleDate.key !== episodeVideo.titleDate.key) {
          break;
        }
        episodeVideo.episodeSequence += 1;
      }
    });

  return episodeVideos.map(({ video, titleDate, episodeSequence }) => [
    video,
    `${titleDate.month}${titleDate.day}-${episodeSequence}`,
  ]);
}

function buildScboyClippingProgressTitle(videoTitle: string): string {
  const dateMatch = videoTitle.match(TITLE_DATE_PATTERN);
  const shortDate =
    dateMatch === null
      ? null
      : `${dateMatch[2]!.padStart(2, "0")}-${dateMatch[3]!.padStart(2, "0")}`;
  const normalizedTitle = videoTitle
    .replaceAll(PROCESSABLE_VIDEO_TITLE_PREFIX, "")
    .replace(TITLE_DATE_PATTERN, " ")
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

function buildScboyOutputDirectoryName(
  video: BiliVideo,
  titleDate: ReturnType<typeof parseScboyTitleDate>,
): string {
  const outputTitle = video.title
    .replaceAll(PROCESSABLE_VIDEO_TITLE_PREFIX, "")
    .replace(/[/:]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return outputTitle
    ? `${titleDate.year}/${titleDate.month}-${titleDate.day}-${outputTitle}`
    : `${titleDate.year}/${titleDate.month}-${titleDate.day}`;
}

function parseScboyTitleDate(video: BiliVideo): {
  year: string;
  month: string;
  day: string;
  key: string;
} {
  const titleDateMatch = video.title.match(TITLE_DATE_PATTERN);
  const uploadAt = video.uploadAt;
  const year = String(uploadAt.getUTCFullYear());
  const month = String(
    Number(titleDateMatch?.[2] ?? uploadAt.getUTCMonth() + 1),
  ).padStart(2, "0");
  const day = String(Number(titleDateMatch?.[3] ?? uploadAt.getUTCDate())).padStart(
    2,
    "0",
  );

  return {
    year,
    month,
    day,
    key: `${year}-${month}-${day}`,
  };
}
