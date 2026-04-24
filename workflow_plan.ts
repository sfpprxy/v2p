import { resolve } from "node:path";

import type { BiliVideo, BiliVideoPart } from "./bili_video";

export interface VideoOutputContext {
  outputDir: string;
  reportPath: string;
}

export interface WorkflowRunOptions {
  segmentExtraction: "reuse-existing" | "regenerate";
  forcePodcastUpload: boolean;
}

export interface VideoExecutionPlan extends VideoOutputContext {
  video: BiliVideo;
  parts: readonly BiliVideoPart[];
  llmModel: string;
  runOptions: WorkflowRunOptions;
  progressVideoTitle: string;
  processablePartPages: readonly number[];
}

export function buildVideoExecutionPlan(
  video: BiliVideo,
  parts: readonly BiliVideoPart[],
  llmModel: string,
  runOptions: WorkflowRunOptions,
  outputRoot: string,
  outputDirectoryName: string,
  progressVideoTitle: string,
): VideoExecutionPlan {
  const outputDir = resolve(outputRoot, outputDirectoryName);
  return {
    video,
    parts,
    llmModel,
    runOptions,
    outputDir,
    reportPath: resolve(outputDir, `${video.bvid}.report.json`),
    progressVideoTitle,
    processablePartPages: parts
      .filter((part) => part.duration >= 10)
      .map((part) => part.page),
  };
}
