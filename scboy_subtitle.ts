import { format, parse } from "node:path";

import { AudioTimestamp } from "./audio.js";
import { DEFAULT_CODEX_MODEL, gen } from "./llm.js";
import { profileSpan } from "./perf.js";

export interface Segment {
  start: string;
  end: string;
  summary: string;
}

export type Segments = Segment[];

export async function extractSegments(
  subtitlePath: string,
  partTitle: string,
  llmModel: string = DEFAULT_CODEX_MODEL,
  shouldLog = true,
): Promise<Segments> {
  return profileSpan(
    "extractSegments",
    { subtitlePath, partTitle, llmModel },
    async (span) => {
      let segments: Segments | null = null;
      const normalizedPartTitle = normalizePartTitle(partTitle);
      const segmentJsonPath = buildSegmentJsonPath(subtitlePath, ".segments");

      if (shouldLog) {
        console.log(`[extractSegments:start] ${subtitlePath}`);
      }

      try {
        const hasSavedSegments = await Bun.file(segmentJsonPath).exists();
        span.set({ cacheHit: hasSavedSegments, segmentJsonPath });
        if (hasSavedSegments) {
          const existingSegmentsText = await Bun.file(segmentJsonPath).text();
          segments = parseScboySubtitleJson(existingSegmentsText);
          span.set({ segmentCount: segments.length });
          if (shouldLog) {
            console.log(`[extractSegments:skip] exists ${segmentJsonPath}`);
          }
          return segments;
        }

        const subtitleText = await Bun.file(subtitlePath).text();
        span.set({ subtitleBytes: subtitleText.length });
        const responseText = await gen(
          llmModel,
          buildScboySubtitlePrompt(normalizedPartTitle, subtitleText),
        );
        segments = parseScboySubtitleJson(responseText);
        span.set({ segmentCount: segments.length });
        await saveExtractedSegments(subtitlePath, segments);
        return segments;
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
  const parsed: Segments = JSON.parse(normalizedJson) as Segments;
  assertScboySubtitleJson(parsed);
  return parsed;
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

时间戳保留原始的精度与格式比如"01:15:03,430"。以纯JSON形式返回, JSON以外不要加其他任何内容，便于我直接解析。

字幕文本如下：
${subtitleText}`;
}

function assertScboySubtitleJson(value: Segments): void {
  if (!Array.isArray(value)) {
    throw new Error("SC Boy subtitle response is not a JSON array");
  }

  for (const item of value) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error("SC Boy subtitle response contains a non-object item");
    }

    const { start, end, summary } = item;
    if (
      typeof start !== "string" ||
      typeof end !== "string" ||
      typeof summary !== "string"
    ) {
      throw new Error(
        "SC Boy subtitle response item must contain string start, end, and summary fields",
      );
    }

    AudioTimestamp.assertSegmentTimestamp(start, "start");
    AudioTimestamp.assertSegmentTimestamp(end, "end");
  }
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

export function buildSegmentJsonPath(subtitlePath: string, suffix: string): string {
  const parsedSubtitlePath = parse(subtitlePath);
  return format({
    ...parsedSubtitlePath,
    base: undefined,
    name: `${parsedSubtitlePath.name}${suffix}`,
    ext: ".json",
  });
}
