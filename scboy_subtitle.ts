import { format, parse } from "node:path";

import { AudioTimestamp } from "./audio";
import { DEFAULT_CODEX_MODEL, gen } from "./llm";
import { profileSpan } from "./perf";

export interface Segment {
  start: string;
  end: string;
  summary: string;
}

export interface SegmentFix {
  type:
    | "timestampInsideSubtitleBlock"
    | "timestampBetweenSubtitleBlocks"
    | "endTimestampAtNextSubtitleStart"
    | "startTimestampAtPreviousSubtitleEnd";
  index: number;
  boundary: "start" | "end";
  originalTimestamp: string;
  fixedTimestamp: string;
}

export interface ExtractSegmentsResult {
  segments: Segments;
  fixes: SegmentFix[];
}

export type Segments = Segment[];
const MAX_SEGMENT_TIMESTAMP_FIX_OFFSET_MILLISECONDS = 5_000;

export async function extractSegments(
  subtitlePath: string,
  partTitle: string,
  llmModel: string = DEFAULT_CODEX_MODEL,
  shouldLog = false,
): Promise<ExtractSegmentsResult> {
  return profileSpan(
    "extractSegments",
    { subtitlePath, partTitle, llmModel },
    async (span) => {
      let segments: Segments | null = null;
      let fixes: SegmentFix[] = [];
      const normalizedPartTitle = normalizePartTitle(partTitle);
      const segmentJsonPath = buildSegmentJsonPath(subtitlePath, ".segments");

      if (shouldLog) {
        console.log(`[extractSegments:start] ${subtitlePath}`);
      }

      try {
        const subtitleText = await Bun.file(subtitlePath).text();
        span.set({ subtitleBytes: subtitleText.length });
        const hasSavedSegments = await Bun.file(segmentJsonPath).exists();
        span.set({ cacheHit: hasSavedSegments, segmentJsonPath });
        if (hasSavedSegments) {
          const existingSegmentsText = await Bun.file(segmentJsonPath).text();
          segments = parseScboySubtitleJson(existingSegmentsText);
          ({ segments, fixes } = fixScboySubtitleSegmentsAgainstSubtitle(
            segments,
            subtitleText,
          ));
          validateScboySubtitleSegments(segments);
          validateScboySubtitleSegmentsAgainstSubtitle(segments, subtitleText);
          span.set({ segmentCount: segments.length, fixCount: fixes.length });
          if (fixes.length > 0) {
            await saveExtractedSegments(subtitlePath, segments);
          }
          if (shouldLog) {
            console.log(`[extractSegments:skip] exists ${segmentJsonPath}`);
          }
          return { segments, fixes };
        }

        const responseText = await gen(
          llmModel,
          buildScboySubtitlePrompt(normalizedPartTitle, subtitleText),
        );
        segments = parseScboySubtitleJson(responseText);
        ({ segments, fixes } = fixScboySubtitleSegmentsAgainstSubtitle(
          segments,
          subtitleText,
        ));
        validateScboySubtitleSegments(segments);
        validateScboySubtitleSegmentsAgainstSubtitle(segments, subtitleText);
        span.set({ segmentCount: segments.length, fixCount: fixes.length });
        await saveExtractedSegments(subtitlePath, segments);
        return { segments, fixes };
      } catch (error) {
        console.error("[extractSegments:error]", {
          subtitlePath,
          partTitle,
          llmModel,
          error,
        });
        throw error;
      } finally {
        if (shouldLog) {
          console.log(
            `[extractSegments:end] ${segments == null ? "error" : "ok"} ${subtitlePath}${segments == null ? "" : ` ${segments.length}`}`,
          );
        }
      }
    },
  );
}

export function parseScboySubtitleJson(responseText: string): Segments {
  const normalizedJson = normalizeJsonText(responseText);
  return JSON.parse(normalizedJson) as Segments;
}

export function normalizeJsonText(responseText: string): string {
  const trimmed = responseText.trim();
  if (trimmed.startsWith("```")) {
    const lines = trimmed.split("\n");
    if (lines.length >= 3 && lines.at(-1)?.startsWith("```")) {
      return lines.slice(1, -1).join("\n").trim();
    }
  }

  const arrayStart = trimmed.indexOf("[");
  const arrayEnd = trimmed.lastIndexOf("]");
  if (arrayStart >= 0 && arrayEnd >= arrayStart) {
    return trimmed.slice(arrayStart, arrayEnd + 1);
  }

  return trimmed;
}

function normalizePartTitle(partTitle: string): string {
  const trimmedPartTitle = partTitle.trim();
  const normalizedPartTitle = trimmedPartTitle.replace(/^\d+\s*[-—－]\s*/u, "");
  return normalizedPartTitle === "" ? trimmedPartTitle : normalizedPartTitle;
}

function buildScboySubtitlePrompt(
  partTitle: string,
  subtitleText: string,
): string {
  return `这段是星际老男孩直播${partTitle}时候的音频转字幕文本，其中有些文本是游戏内人物的台词。

你帮我识别并分析一下。星际老男孩及他们的朋友。聊了哪些跟${partTitle}无关的内容？

字段名：start(开始时间戳)，end(结束时间戳)，summary(内容简单总结)。

时间戳必须直接使用字幕时间行里的原始边界值，保留原始的精度与格式比如"01:15:03,430"。start必须使用某条字幕时间行左侧的开始时间戳，end必须使用某条字幕时间行右侧的结束时间戳，不要生成字幕中间的时间点。以纯JSON形式返回, JSON以外不要加其他任何内容，便于我直接解析。

字幕文本如下：
${subtitleText}`;
}

function validateScboySubtitleSegments(value: Segments): void {
  if (!Array.isArray(value)) {
    throw new Error("SC Boy subtitle response is not a JSON array");
  }

  let previousEndMilliseconds: number | null = null;

  for (const [index, item] of value.entries()) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error(
        `SC Boy subtitle response contains a non-object item at index ${index}`,
      );
    }

    const { start, end, summary } = item;
    if (
      typeof start !== "string" ||
      typeof end !== "string" ||
      typeof summary !== "string"
    ) {
      throw new Error(
        `SC Boy subtitle response item at index ${index} must contain string start, end, and summary fields`,
      );
    }

    AudioTimestamp.assertSegmentTimestamp(start, "start");
    AudioTimestamp.assertSegmentTimestamp(end, "end");

    const startMilliseconds =
      AudioTimestamp.parseSegmentTimestampToMilliseconds(start);
    const endMilliseconds =
      AudioTimestamp.parseSegmentTimestampToMilliseconds(end);
    if (endMilliseconds <= startMilliseconds) {
      throw new Error(
        `SC Boy subtitle response item at index ${index} has invalid range: ${start} -> ${end}`,
      );
    }
    if (
      previousEndMilliseconds !== null &&
      startMilliseconds < previousEndMilliseconds
    ) {
      throw new Error(
        `SC Boy subtitle response item at index ${index} overlaps or is out of order: ${start} starts before the previous segment ends`,
      );
    }

    previousEndMilliseconds = endMilliseconds;
  }
}

function fixScboySubtitleSegmentsAgainstSubtitle(
  segments: Segments,
  subtitleText: string,
): ExtractSegmentsResult {
  const subtitleBlocks = readSubtitleTimestampBlocks(subtitleText);
  const fixes: SegmentFix[] = [];

  return {
    segments: segments.map(({ start, end, summary }, index) => ({
      start: fixScboySubtitleSegmentBoundary(
        start,
        "start",
        subtitleBlocks,
        index,
        fixes,
      ),
      end: fixScboySubtitleSegmentBoundary(
        end,
        "end",
        subtitleBlocks,
        index,
        fixes,
      ),
      summary,
    })),
    fixes,
  };
}

function validateScboySubtitleSegmentsAgainstSubtitle(
  segments: Segments,
  subtitleText: string,
): void {
  const subtitleBlocks = readSubtitleTimestampBlocks(subtitleText);
  const subtitleBoundaries = new Set<string>(
    subtitleBlocks.flatMap(({ start, end }) => [start, end]),
  );

  for (const [index, { start, end }] of segments.entries()) {
    if (!subtitleBoundaries.has(start)) {
      throw new Error(
        `SC Boy subtitle response item at index ${index} has start timestamp not found in subtitle block boundaries: ${start}`,
      );
    }
    if (!subtitleBoundaries.has(end)) {
      throw new Error(
        `SC Boy subtitle response item at index ${index} has end timestamp not found in subtitle block boundaries: ${end}`,
      );
    }
  }
}

function readSubtitleTimestampBlocks(
  subtitleText: string,
): ReadonlyArray<{ start: string; end: string }> {
  const subtitleBlockPattern =
    /^(\d{2}:\d{2}:\d{2},\d{3}) --> (\d{2}:\d{2}:\d{2},\d{3})$/gm;
  const subtitleBlocks: Array<{ start: string; end: string }> = [];

  for (const match of subtitleText.matchAll(subtitleBlockPattern)) {
    subtitleBlocks.push({ start: match[1], end: match[2] });
  }

  if (subtitleBlocks.length === 0) {
    throw new Error(
      "Subtitle text does not contain any valid timestamp blocks",
    );
  }

  return subtitleBlocks;
}

function fixScboySubtitleSegmentBoundary(
  timestamp: string,
  boundary: "start" | "end",
  subtitleBlocks: ReadonlyArray<{ start: string; end: string }>,
  index: number,
  fixes: SegmentFix[],
): string {
  const boundaryValues = new Set<string>(
    subtitleBlocks.map((block) => block[boundary]),
  );
  if (boundaryValues.has(timestamp)) {
    return timestamp;
  }

  for (const [blockIndex, { start, end }] of subtitleBlocks.entries()) {
    const currentBlock = { start, end };
    const fixedTimestampAtPreviousSubtitleEnd =
      fixStartTimestampAtPreviousSubtitleEnd(
        timestamp,
        boundary,
        currentBlock,
        subtitleBlocks[blockIndex + 1],
        index,
        fixes,
      );
    if (fixedTimestampAtPreviousSubtitleEnd !== null) {
      return fixedTimestampAtPreviousSubtitleEnd;
    }

    const fixedTimestampInsideSubtitleBlock = fixTimestampInsideSubtitleBlock(
      timestamp,
      boundary,
      currentBlock,
      index,
      fixes,
    );
    if (fixedTimestampInsideSubtitleBlock !== null) {
      return fixedTimestampInsideSubtitleBlock;
    }

    const nextBlock = subtitleBlocks[blockIndex + 1];
    if (nextBlock === undefined) {
      continue;
    }

    const fixedTimestampBetweenSubtitleBlocks =
      fixTimestampBetweenSubtitleBlocks(
        timestamp,
        boundary,
        currentBlock,
        nextBlock,
        index,
        fixes,
      );
    if (fixedTimestampBetweenSubtitleBlocks !== null) {
      return fixedTimestampBetweenSubtitleBlocks;
    }
  }

  throw new Error(
    `SC Boy subtitle response item at index ${index} has ${boundary} timestamp not found in subtitle blocks: ${timestamp}`,
  );
}

function fixStartTimestampAtPreviousSubtitleEnd(
  timestamp: string,
  boundary: "start" | "end",
  currentBlock: { start: string; end: string },
  nextBlock: { start: string; end: string } | undefined,
  index: number,
  fixes: SegmentFix[],
): string | null {
  if (
    boundary !== "start" ||
    nextBlock === undefined ||
    timestamp !== currentBlock.end
  ) {
    return null;
  }

  recordSegmentFix(
    "startTimestampAtPreviousSubtitleEnd",
    timestamp,
    nextBlock.start,
    boundary,
    index,
    fixes,
  );
  return nextBlock.start;
}

function fixTimestampInsideSubtitleBlock(
  timestamp: string,
  boundary: "start" | "end",
  currentBlock: { start: string; end: string },
  index: number,
  fixes: SegmentFix[],
): string | null {
  const timestampMilliseconds =
    AudioTimestamp.parseSegmentTimestampToMilliseconds(timestamp);
  const startMilliseconds = AudioTimestamp.parseSegmentTimestampToMilliseconds(
    currentBlock.start,
  );
  const endMilliseconds = AudioTimestamp.parseSegmentTimestampToMilliseconds(
    currentBlock.end,
  );
  if (
    timestampMilliseconds <= startMilliseconds ||
    timestampMilliseconds >= endMilliseconds
  ) {
    return null;
  }

  const fixedTimestamp =
    boundary === "start" ? currentBlock.start : currentBlock.end;
  recordSegmentFix(
    "timestampInsideSubtitleBlock",
    timestamp,
    fixedTimestamp,
    boundary,
    index,
    fixes,
  );
  return fixedTimestamp;
}

function fixTimestampBetweenSubtitleBlocks(
  timestamp: string,
  boundary: "start" | "end",
  currentBlock: { start: string; end: string },
  nextBlock: { start: string; end: string },
  index: number,
  fixes: SegmentFix[],
): string | null {
  const timestampMilliseconds =
    AudioTimestamp.parseSegmentTimestampToMilliseconds(timestamp);
  const endMilliseconds = AudioTimestamp.parseSegmentTimestampToMilliseconds(
    currentBlock.end,
  );
  const nextStartMilliseconds =
    AudioTimestamp.parseSegmentTimestampToMilliseconds(nextBlock.start);

  if (boundary === "end" && timestampMilliseconds === nextStartMilliseconds) {
    recordSegmentFix(
      "endTimestampAtNextSubtitleStart",
      timestamp,
      currentBlock.end,
      boundary,
      index,
      fixes,
    );
    return currentBlock.end;
  }

  if (
    timestampMilliseconds <= endMilliseconds ||
    timestampMilliseconds >= nextStartMilliseconds
  ) {
    return null;
  }

  const fixedTimestamp =
    boundary === "start" ? nextBlock.start : currentBlock.end;
  recordSegmentFix(
    "timestampBetweenSubtitleBlocks",
    timestamp,
    fixedTimestamp,
    boundary,
    index,
    fixes,
  );
  return fixedTimestamp;
}

function recordSegmentFix(
  type: SegmentFix["type"],
  originalTimestamp: string,
  fixedTimestamp: string,
  boundary: "start" | "end",
  index: number,
  fixes: SegmentFix[],
): void {
  const originalMilliseconds =
    AudioTimestamp.parseSegmentTimestampToMilliseconds(originalTimestamp);
  const fixedMilliseconds =
    AudioTimestamp.parseSegmentTimestampToMilliseconds(fixedTimestamp);
  const fixOffsetMilliseconds = Math.abs(
    fixedMilliseconds - originalMilliseconds,
  );
  if (fixOffsetMilliseconds > MAX_SEGMENT_TIMESTAMP_FIX_OFFSET_MILLISECONDS) {
    throw new Error(
      `SC Boy subtitle response item at index ${index} has ${boundary} timestamp too far from the nearest fix boundary: ${originalTimestamp} -> ${fixedTimestamp}`,
    );
  }
  fixes.push({
    type,
    index,
    boundary,
    originalTimestamp,
    fixedTimestamp,
  });
}

async function saveExtractedSegments(
  subtitlePath: string,
  segments: Segments,
): Promise<void> {
  const relativeSegments = buildRelativeSegments(segments);
  await Promise.all([
    Bun.write(
      buildSegmentJsonPath(subtitlePath, ".segments"),
      `${JSON.stringify(segments, null, 2)}\n`,
    ),
    Bun.write(
      buildSegmentJsonPath(subtitlePath, ".segments.relative"),
      `${JSON.stringify(relativeSegments, null, 2)}\n`,
    ),
  ]);
}

export function buildRelativeSegments(segments: Segments): Segments {
  let currentStartMilliseconds = 0;

  return segments.map(({ start, end, summary }) => {
    const absoluteStartMilliseconds =
      AudioTimestamp.parseSegmentTimestampToMilliseconds(start);
    const absoluteEndMilliseconds =
      AudioTimestamp.parseSegmentTimestampToMilliseconds(end);
    const durationMilliseconds =
      absoluteEndMilliseconds - absoluteStartMilliseconds;

    if (durationMilliseconds <= 0) {
      throw new Error(`Invalid segment range: ${start} -> ${end}`);
    }

    const relativeSegment = {
      start: AudioTimestamp.formatSegmentTimestampFromMilliseconds(
        currentStartMilliseconds,
      ),
      end: AudioTimestamp.formatSegmentTimestampFromMilliseconds(
        currentStartMilliseconds + durationMilliseconds,
      ),
      summary,
    };

    currentStartMilliseconds += durationMilliseconds;
    return relativeSegment;
  });
}

export function buildSegmentJsonPath(
  subtitlePath: string,
  suffix: string,
): string {
  const parsedSubtitlePath = parse(subtitlePath);
  return format({
    ...parsedSubtitlePath,
    base: undefined,
    name: `${parsedSubtitlePath.name}${suffix}`,
    ext: ".json",
  });
}
