import { $ } from "bun";
import { format, parse, resolve } from "node:path";
import { profileSpan } from "./perf.js";

export type AudioSegmentRange = readonly [start: string, end: string];

export interface ConcatenatedAudioResult {
  outputPath: string;
  segmentPaths: string[];
}

export async function sliceAndConcatAudio(
  ranges: readonly AudioSegmentRange[],
  inputPath: string,
  persistSegmentFiles = false,
): Promise<ConcatenatedAudioResult> {
  return profileSpan(
    "sliceAndConcatAudio",
    {
      inputPath,
      rangeCount: ranges.length,
      persistSegmentFiles,
    },
    async (span) => {
      if (ranges.length === 0) {
        throw new Error("At least one audio range is required");
      }

      const resolvedInputPath = resolve(inputPath);
      const inputFile = parse(resolvedInputPath);
      if (inputFile.ext === "") {
        throw new Error(`Audio file must have an extension: ${resolvedInputPath}`);
      }

      const segmentSpecs = ranges.map((range, index) =>
        buildAudioSegmentSpec(range, index, inputFile),
      );
      const outputPath = format({
        ...inputFile,
        base: undefined,
        name: `${inputFile.name}.offtopic`,
        ext: inputFile.ext,
      });
      const concatListPath = format({
        ...inputFile,
        base: undefined,
        name: `${inputFile.name}.offtopic.concat`,
        ext: ".txt",
      });
      span.set({ outputPath, concatListPath });

      try {
        await Promise.all(
          segmentSpecs.map((spec) => cutAudioSegment(resolvedInputPath, spec)),
        );

        await Bun.write(
          concatListPath,
          buildConcatFileContent(segmentSpecs.map((spec) => spec.outputPath)),
        );
        await concatAudioSegments(concatListPath, outputPath);
      } finally {
        await Bun.file(concatListPath)
          .delete()
          .catch(() => {});
        if (!persistSegmentFiles) {
          for (const spec of segmentSpecs) {
            await Bun.file(spec.outputPath)
              .delete()
              .catch(() => {});
          }
        }
      }

      return {
        outputPath,
        segmentPaths: persistSegmentFiles
          ? segmentSpecs.map((spec) => spec.outputPath)
          : [],
      };
    },
  );
}

export async function concatAudioFiles(
  inputPaths: readonly string[],
  outputPath: string,
): Promise<void> {
  await profileSpan(
    "concatAudioFiles",
    { inputCount: inputPaths.length, outputPath },
    async (span) => {
      if (inputPaths.length === 0) {
        throw new Error("At least one audio file is required");
      }

      const resolvedInputPaths = inputPaths.map((path) => resolve(path));
      const resolvedOutputPath = resolve(outputPath);
      const outputFile = parse(resolvedOutputPath);
      const concatListPath = format({
        ...outputFile,
        base: undefined,
        name: `${outputFile.name}.concat`,
        ext: ".txt",
      });
      span.set({ concatListPath });

      try {
        await Bun.write(concatListPath, buildConcatFileContent(resolvedInputPaths));
        await concatAudioSegments(concatListPath, resolvedOutputPath);
      } finally {
        await Bun.file(concatListPath)
          .delete()
          .catch(() => {});
      }
    },
  );
}

export async function remuxAudio(
  inputPath: string,
  outputPath: string,
): Promise<void> {
  await profileSpan("remuxAudio", { inputPath, outputPath }, async () => {
    await $`ffmpeg ${[
      "-y",
      "-i",
      inputPath,
      "-vn",
      "-acodec",
      "copy",
      outputPath,
    ]}`.quiet();
  });
}

export async function probeDurationSeconds(path: string): Promise<number> {
  return profileSpan("probeDurationSeconds", { path }, async (span) => {
    const stdout = await $`ffprobe ${[
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      path,
    ]}`.text();
    const value = Number(stdout.trim());
    if (!Number.isFinite(value)) {
      throw new Error(`Cannot probe duration for file: ${path}`);
    }
    span.set({ probedDurationSeconds: value });
    return value;
  });
}

interface AudioSegmentSpec {
  start: string;
  startForFfmpeg: string;
  durationSeconds: number;
  outputPath: string;
}

function buildAudioSegmentSpec(
  range: AudioSegmentRange,
  index: number,
  inputFile: ReturnType<typeof parse>,
): AudioSegmentSpec {
  const [start, end] = range;
  const startSeconds = AudioTimestamp.parseSegmentTimestampToSeconds(start);
  const endSeconds = AudioTimestamp.parseSegmentTimestampToSeconds(end);
  const durationSeconds = endSeconds - startSeconds;

  if (durationSeconds <= 0) {
    throw new Error(`Invalid audio range: ${start} -> ${end}`);
  }

  return {
    start,
    startForFfmpeg: AudioTimestamp.formatSegmentTimestampForFfmpeg(start),
    durationSeconds,
    outputPath: format({
      ...inputFile,
      base: undefined,
      name: `${inputFile.name}.${AudioTimestamp.sanitizeSegmentTimestampForFileName(start)}.${AudioTimestamp.sanitizeSegmentTimestampForFileName(end)}.part${index + 1}`,
      ext: inputFile.ext,
    }),
  };
}

async function cutAudioSegment(
  inputPath: string,
  spec: AudioSegmentSpec,
): Promise<void> {
  await profileSpan(
    "cutAudioSegment",
    {
      inputPath,
      outputPath: spec.outputPath,
      start: spec.start,
      durationSeconds: spec.durationSeconds,
    },
    async () => {
      await $`ffmpeg ${[
        "-y",
        "-ss",
        spec.startForFfmpeg,
        "-i",
        inputPath,
        "-t",
        spec.durationSeconds.toFixed(3),
        "-vn",
        "-acodec",
        "copy",
        spec.outputPath,
      ]}`.quiet();
    },
  );
}

function buildConcatFileContent(paths: readonly string[]): string {
  return `${paths.map((path) => `file '${escapeConcatFilePath(path)}'`).join("\n")}\n`;
}

async function concatAudioSegments(
  concatListPath: string,
  outputPath: string,
): Promise<void> {
  await profileSpan(
    "concatAudioSegments",
    { concatListPath, outputPath },
    async () => {
      await $`ffmpeg ${[
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        concatListPath,
        "-c",
        "copy",
        outputPath,
      ]}`.quiet();
    },
  );
}

function escapeConcatFilePath(path: string): string {
  return path.replace(/\\/g, "\\\\").replace(/'/g, "'\\''");
}

export class AudioTimestamp {
  private static readonly segmentTimestampPattern = /^\d{2}:\d{2}:\d{2},\d{3}$/;

  static parseSegmentTimestampToSeconds(timestamp: string): number {
    return this.parseSegmentTimestampToMilliseconds(timestamp) / 1000;
  }

  static parseSegmentTimestampToMilliseconds(timestamp: string): number {
    this.assertSegmentTimestamp(timestamp);

    const { hours, minutes, seconds, milliseconds } =
      this.readTimestampParts(timestamp);
    return ((hours * 60 + minutes) * 60 + seconds) * 1000 + milliseconds;
  }

  static formatSegmentTimestampFromMilliseconds(milliseconds: number): string {
    if (!Number.isInteger(milliseconds) || milliseconds < 0) {
      throw new Error(
        `Invalid milliseconds: expected non-negative integer, got ${milliseconds}`,
      );
    }

    const hours = Math.floor(milliseconds / 3_600_000);
    const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
    const seconds = Math.floor((milliseconds % 60_000) / 1000);
    const remainingMilliseconds = milliseconds % 1000;

    return `${hours.toString().padStart(2, "0")}:${minutes
      .toString()
      .padStart(2, "0")}:${seconds
      .toString()
      .padStart(2, "0")},${remainingMilliseconds.toString().padStart(3, "0")}`;
  }

  static formatSegmentTimestampForFfmpeg(timestamp: string): string {
    this.assertSegmentTimestamp(timestamp);
    return timestamp.replace(",", ".");
  }

  static sanitizeSegmentTimestampForFileName(timestamp: string): string {
    this.assertSegmentTimestamp(timestamp);
    return timestamp.replace(/[:,]/g, "-");
  }

  static assertSegmentTimestamp(
    timestamp: string,
    fieldName = "timestamp",
  ): void {
    if (!this.segmentTimestampPattern.test(timestamp)) {
      throw new Error(
        `Invalid ${fieldName}: expected HH:MM:SS,mmm, got ${timestamp}`,
      );
    }

    const { hours, minutes, seconds } = this.readTimestampParts(timestamp);
    if (
      !Number.isInteger(hours) ||
      !Number.isInteger(minutes) ||
      !Number.isInteger(seconds) ||
      minutes < 0 ||
      minutes > 59 ||
      seconds < 0 ||
      seconds > 59
    ) {
      throw new Error(
        `Invalid ${fieldName}: expected HH:MM:SS,mmm, got ${timestamp}`,
      );
    }
  }

  private static readTimestampParts(timestamp: string): {
    hours: number;
    minutes: number;
    seconds: number;
    milliseconds: number;
  } {
    const [hoursText, minutesText, secondsTextWithMillis] =
      timestamp.split(":");
    const [secondsText, millisecondsText] = secondsTextWithMillis.split(",");
    return {
      hours: Number(hoursText),
      minutes: Number(minutesText),
      seconds: Number(secondsText),
      milliseconds: Number(millisecondsText),
    };
  }
}
