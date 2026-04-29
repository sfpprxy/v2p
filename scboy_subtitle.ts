import { createHash } from "node:crypto";
import { format, parse } from "node:path";

import { AudioTimestamp } from "./audio";
import { DEFAULT_CODEX_MODEL, gen } from "./llm";
import { profileSpan } from "./perf";

export interface Segment {
  start: string;
  end: string;
  summary: string;
}

interface SubtitleBlock {
  sequence: string;
  start: string;
  end: string;
  raw: string;
}

export interface SegmentFix {
  type:
    | "timestampInsideSubtitleBlock"
    | "timestampBetweenSubtitleBlocks"
    | "endTimestampAtNextSubtitleStart"
    | "startTimestampAtPreviousSubtitleEnd"
    | "emptySubtitleBlockTextFilled";
  index: number;
  boundary?: "start" | "end";
  originalTimestamp?: string;
  fixedTimestamp?: string;
  sequence?: string;
  originalText?: string;
  fixedText?: string;
}

export interface ExtractSegmentsResult {
  segments: Segments;
  fixes: SegmentFix[];
  metadata: SegmentExtractionMetadata;
}

export type Segments = Segment[];
export interface SegmentExtractionMetadata {
  llmModel: string;
  segmentPromptHash: string;
  subtitleSha256: string;
}

export interface ExtractSegmentsOptions {
  segmentExtraction: "reuse-existing" | "regenerate";
}

const MAX_SEGMENT_TIMESTAMP_FIX_OFFSET_MILLISECONDS = 30_000;

export async function extractSegments(
  subtitlePath: string,
  partTitle: string,
  llmModel: string = DEFAULT_CODEX_MODEL,
  options: ExtractSegmentsOptions = { segmentExtraction: "reuse-existing" },
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
      const parsedSubtitlePath = parse(subtitlePath);
      const rawResponsePath = format({
        ...parsedSubtitlePath,
        base: undefined,
        name: `${parsedSubtitlePath.name}.segments.raw-response`,
        ext: ".txt",
      });

      if (shouldLog) {
        console.log(`[extractSegments:start] ${subtitlePath}`);
      }

      try {
        const originalSubtitleText = await Bun.file(subtitlePath).text();
        const { subtitleText, fixes: subtitleTextFixes } =
          fillEmptySubtitleBlocks(originalSubtitleText);
        const extractionMetadata = buildSegmentExtractionMetadata(
          normalizedPartTitle,
          originalSubtitleText,
          llmModel,
        );
        span.set({
          subtitleBytes: subtitleText.length,
          subtitleFixCount: subtitleTextFixes.length,
          segmentPromptHash: extractionMetadata.segmentPromptHash,
          subtitleSha256: extractionMetadata.subtitleSha256,
        });
        const hasSavedSegments = await Bun.file(segmentJsonPath).exists();
        const shouldReuseSavedSegments =
          hasSavedSegments && options.segmentExtraction === "reuse-existing";
        span.set({ cacheHit: shouldReuseSavedSegments, segmentJsonPath });
        if (shouldReuseSavedSegments) {
          const existingSegmentsText = await Bun.file(segmentJsonPath).text();
          segments = parseScboySubtitleJson(existingSegmentsText);
          ({ segments, fixes } = fixScboySubtitleSegmentsAgainstSubtitle(
            segments,
            subtitleText,
          ));
          validateScboySubtitleSegments(segments);
          validateScboySubtitleSegmentsAgainstSubtitle(segments, subtitleText);
          span.set({
            segmentCount: segments.length,
            fixCount: subtitleTextFixes.length + fixes.length,
          });
          if (fixes.length > 0) {
            await saveExtractedSegments(subtitlePath, segments);
          }
          if (shouldLog) {
            console.log(`[extractSegments:skip] exists ${segmentJsonPath}`);
          }
          return {
            segments,
            fixes: [...subtitleTextFixes, ...fixes],
            metadata: extractionMetadata,
          };
        }

        const responseText = await gen(
          llmModel,
          buildScboySubtitlePrompt(normalizedPartTitle, subtitleText),
        );
        await Bun.write(rawResponsePath, responseText);
        segments = parseScboySubtitleJson(responseText);
        ({ segments, fixes } = fixScboySubtitleSegmentsAgainstSubtitle(
          segments,
          subtitleText,
        ));
        validateScboySubtitleSegments(segments);
        validateScboySubtitleSegmentsAgainstSubtitle(segments, subtitleText);
        span.set({
          segmentCount: segments.length,
          fixCount: subtitleTextFixes.length + fixes.length,
        });
        await saveExtractedSegments(subtitlePath, segments);
        return {
          segments,
          fixes: [...subtitleTextFixes, ...fixes],
          metadata: extractionMetadata,
        };
      } catch (error) {
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
  _partTitle: string,
  subtitleText: string,
): string {
  return `这段是星际老男孩直播时候的音频转字幕文本，其中有些文本是游戏内人物语音转的台词。
${"这段有可能是一场游戏对局或者比赛解说(2选1)，你帮我识别并分析一下，星际老男孩及他们的朋友，聊了哪些跟当前游戏对局或比赛无关的内容？" +
  "(除了DOTA2以外的游戏的局前局后赛前赛后的点评复盘讨论打趣也可算作对局/比赛无关)"}
他们经常玩或解说的是DOTA/星际争霸2(包括RPG地图)/实况足球/三角洲。

字段名：start(开始时间戳)，end(结束时间戳)，summary(内容简单总结)。

时间戳必须直接使用字幕时间行里的原始边界值，保留原始的精度与格式比如"01:15:03,430"。
start必须使用某条字幕时间行左侧的开始时间戳，end必须使用某条字幕时间行右侧的结束时间戳，不要生成字幕中间的时间点。
输出片段必须严格按时间顺序排列，并且任意两个片段不能重叠：后一项的start必须大于或等于前一项的end。
如果两个无关内容在时间上连续或互相重叠，要合并成一个更大的片段；不要为了保留更细摘要而输出重叠片段。
不要在同一段连续闲聊里强行拆出很短的子片段；如果后一段只是前一段话题里的补充、接梗或一句插话，要把它合并进前一段summary，而不是输出单独片段。
不要用不存在于字幕时间行里的中间时间点作为两个片段的分割点。

以纯JSON形式返回, JSON以外不要加其他任何内容，便于我直接解析。

字幕文本如下：
${subtitleText}`;
}

function buildSegmentExtractionMetadata(
  partTitle: string,
  subtitleText: string,
  llmModel: string,
): SegmentExtractionMetadata {
  return {
    llmModel,
    segmentPromptHash: hashText(buildScboySubtitlePrompt(partTitle, "")),
    subtitleSha256: hashText(subtitleText),
  };
}

function hashText(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
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
      const windowStartIndex = Math.max(0, index - 4);
      const windowEndIndex = Math.min(value.length, index + 5);
      const segmentWindow = value
        .slice(windowStartIndex, windowEndIndex)
        .map((segment, segmentIndex) => {
          const actualIndex = windowStartIndex + segmentIndex;
          const label =
            actualIndex === index
              ? "current"
              : actualIndex === index - 1
                ? "previous"
                : "context";
          if (
            typeof segment !== "object" ||
            segment === null ||
            Array.isArray(segment)
          ) {
            return `[${actualIndex}] ${label}: ${JSON.stringify(segment)}`;
          }

          return `[${actualIndex}] ${label}: ${JSON.stringify(segment)}`;
        })
        .join("\n");
      throw new Error(
        [
          `SC Boy subtitle response item at index ${index} overlaps or is out of order: ${start} starts before the previous segment ends`,
          "Nearby AI segments:",
          segmentWindow,
        ].join("\n"),
      );
    }

    previousEndMilliseconds = endMilliseconds;
  }
}

function fixScboySubtitleSegmentsAgainstSubtitle(
  segments: Segments,
  subtitleText: string,
): Pick<ExtractSegmentsResult, "segments" | "fixes"> {
  const subtitleBlocks = readSubtitleBlocks(subtitleText);
  const fixes: SegmentFix[] = [];

  return {
    segments: segments.map((segment, index) => ({
      start: fixScboySubtitleSegmentBoundary(
        segment,
        "start",
        subtitleBlocks,
        index,
        fixes,
      ),
      end: fixScboySubtitleSegmentBoundary(
        segment,
        "end",
        subtitleBlocks,
        index,
        fixes,
      ),
      summary: segment.summary,
    })),
    fixes,
  };
}

function validateScboySubtitleSegmentsAgainstSubtitle(
  segments: Segments,
  subtitleText: string,
): void {
  const subtitleBlocks = readSubtitleBlocks(subtitleText);
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

function fixScboySubtitleSegmentBoundary(
  segment: Segment,
  boundary: "start" | "end",
  subtitleBlocks: ReadonlyArray<SubtitleBlock>,
  index: number,
  fixes: SegmentFix[],
): string {
  const timestamp = segment[boundary];
  const boundaryValues = new Set<string>(
    subtitleBlocks.map((block) => block[boundary]),
  );
  if (boundaryValues.has(timestamp)) {
    return timestamp;
  }

  for (const [blockIndex, currentBlock] of subtitleBlocks.entries()) {
    const fixedTimestampAtPreviousSubtitleEnd =
      fixStartTimestampAtPreviousSubtitleEnd(
        timestamp,
        segment,
        boundary,
        currentBlock,
        subtitleBlocks[blockIndex + 1],
        subtitleBlocks,
        blockIndex,
        index,
        fixes,
      );
    if (fixedTimestampAtPreviousSubtitleEnd !== null) {
      return fixedTimestampAtPreviousSubtitleEnd;
    }

    const fixedTimestampInsideSubtitleBlock = fixTimestampInsideSubtitleBlock(
      timestamp,
      segment,
      boundary,
      currentBlock,
      blockIndex,
      subtitleBlocks,
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
        segment,
        boundary,
        currentBlock,
        nextBlock,
        blockIndex,
        subtitleBlocks,
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
  segment: Segment,
  boundary: "start" | "end",
  currentBlock: SubtitleBlock,
  nextBlock: SubtitleBlock | undefined,
  subtitleBlocks: ReadonlyArray<SubtitleBlock>,
  subtitleBlockIndex: number,
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
    segment,
    boundary,
    subtitleBlockIndex + 1,
    subtitleBlocks,
    index,
    fixes,
  );
  return nextBlock.start;
}

function fixTimestampInsideSubtitleBlock(
  timestamp: string,
  segment: Segment,
  boundary: "start" | "end",
  currentBlock: SubtitleBlock,
  subtitleBlockIndex: number,
  subtitleBlocks: ReadonlyArray<SubtitleBlock>,
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
    segment,
    boundary,
    subtitleBlockIndex,
    subtitleBlocks,
    index,
    fixes,
  );
  return fixedTimestamp;
}

function fixTimestampBetweenSubtitleBlocks(
  timestamp: string,
  segment: Segment,
  boundary: "start" | "end",
  currentBlock: SubtitleBlock,
  nextBlock: SubtitleBlock,
  subtitleBlockIndex: number,
  subtitleBlocks: ReadonlyArray<SubtitleBlock>,
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
      segment,
      boundary,
      subtitleBlockIndex,
      subtitleBlocks,
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
    segment,
    boundary,
    boundary === "start" ? subtitleBlockIndex + 1 : subtitleBlockIndex,
    subtitleBlocks,
    index,
    fixes,
  );
  return fixedTimestamp;
}

function fillEmptySubtitleBlocks(subtitleText: string): {
  subtitleText: string;
  fixes: SegmentFix[];
} {
  const normalizedSubtitleText = subtitleText.replace(/\r\n/g, "\n").trim();
  const subtitleBlockTexts = normalizedSubtitleText.split(/\n{2,}/);
  const fixes: SegmentFix[] = [];
  const filledSubtitleText = subtitleBlockTexts
    .map((rawBlock, index) => {
      const lines = rawBlock.split("\n");
      if (lines.length < 2) {
        throw new Error(`Invalid subtitle block: ${rawBlock}`);
      }

      const timestampMatch = lines[1]?.match(
        /^(\d{2}:\d{2}:\d{2},\d{3}) --> (\d{2}:\d{2}:\d{2},\d{3})$/,
      );
      if (!timestampMatch) {
        throw new Error(`Invalid subtitle timestamp line: ${rawBlock}`);
      }

      if (lines.length >= 3 && lines.slice(2).some((line) => line !== "")) {
        return rawBlock;
      }

      fixes.push({
        type: "emptySubtitleBlockTextFilled",
        index,
        sequence: lines[0]!,
        originalText: "",
        fixedText: "(此处字幕缺失)",
      });
      return `${rawBlock}\n(此处字幕缺失)`;
    })
    .join("\n\n");

  if (subtitleBlockTexts.length === 0) {
    throw new Error(
      "Subtitle text does not contain any valid timestamp blocks",
    );
  }

  return {
    subtitleText: filledSubtitleText,
    fixes,
  };
}

function readSubtitleBlocks(
  subtitleText: string,
): ReadonlyArray<SubtitleBlock> {
  const normalizedSubtitleText = subtitleText.replace(/\r\n/g, "\n").trim();
  const subtitleBlockTexts = normalizedSubtitleText.split(/\n{2,}/);
  const subtitleBlocks = subtitleBlockTexts.map((rawBlock) => {
    const lines = rawBlock.split("\n");
    if (lines.length < 3) {
      throw new Error(`Invalid subtitle block: ${rawBlock}`);
    }

    const timestampMatch = lines[1]?.match(
      /^(\d{2}:\d{2}:\d{2},\d{3}) --> (\d{2}:\d{2}:\d{2},\d{3})$/,
    );
    if (!timestampMatch) {
      throw new Error(`Invalid subtitle timestamp line: ${rawBlock}`);
    }

    return {
      sequence: lines[0]!,
      start: timestampMatch[1],
      end: timestampMatch[2],
      raw: rawBlock,
    };
  });

  if (subtitleBlocks.length === 0) {
    throw new Error(
      "Subtitle text does not contain any valid timestamp blocks",
    );
  }

  return subtitleBlocks;
}

function recordSegmentFix(
  type: SegmentFix["type"],
  originalTimestamp: string,
  fixedTimestamp: string,
  segment: Segment,
  boundary: "start" | "end",
  subtitleBlockIndex: number,
  subtitleBlocks: ReadonlyArray<SubtitleBlock>,
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
    const subtitleContext = subtitleBlocks
      .slice(
        Math.max(0, subtitleBlockIndex - 2),
        Math.min(subtitleBlocks.length, subtitleBlockIndex + 3),
      )
      .map((block) => block.raw)
      .join("\n\n");
    throw new Error(
      [
        `SC Boy subtitle response item at index ${index} has ${boundary} timestamp too far from the nearest fix boundary: ${originalTimestamp} -> ${fixedTimestamp}`,
        "AI segment:",
        `start: ${segment.start}`,
        `end: ${segment.end}`,
        `summary: ${segment.summary}`,
        "Original subtitle context:",
        subtitleContext,
      ].join("\n"),
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
