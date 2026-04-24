import { resolve } from "node:path";

import type { BiliVideo, BiliVideoPart } from "./bili_video";

export interface ClippingOutputContext {
  outputDir: string;
  reportPath: string;
}

export interface ClippingOptions {
  segmentExtraction: "reuse-existing" | "regenerate";
}

export interface ClippingPlan extends ClippingOutputContext {
  video: BiliVideo;
  parts: readonly BiliVideoPart[];
  llmModel: string;
  clippingOptions: ClippingOptions;
  progressTitle: string;
  clippablePartPages: readonly number[];
}

export function buildClippingPlan(
  video: BiliVideo,
  parts: readonly BiliVideoPart[],
  llmModel: string,
  clippingOptions: ClippingOptions,
  outputRoot: string,
  outputDirectoryName: string,
  progressTitle: string,
): ClippingPlan {
  const outputDir = resolve(outputRoot, outputDirectoryName);
  return {
    video,
    parts,
    llmModel,
    clippingOptions,
    outputDir,
    reportPath: resolve(outputDir, `${video.bvid}.report.json`),
    progressTitle,
    clippablePartPages: parts
      .filter((part) => part.duration >= 10)
      .map((part) => part.page),
  };
}
