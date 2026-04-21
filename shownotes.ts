import { AudioTimestamp, probeDurationSeconds } from "./audio";
import { profileSpan } from "./perf";
import { parseScboySubtitleJson } from "./scboy_subtitle";

export interface OfftopicPart {
  page: number;
  offtopicAudioPath: string;
  relativeSegmentsPath: string;
}

export interface ProcessedPartOfftopic extends OfftopicPart {}

export async function buildMergedOfftopicShownotes(
  parts: readonly OfftopicPart[],
): Promise<string[]> {
  return profileSpan(
    "buildMergedOfftopicShownotes",
    { partCount: parts.length },
    async (span) => {
      const shownotes: string[] = [];
      let currentStartMilliseconds = 0;

      for (const part of parts) {
        const relativeSegmentsText = await Bun.file(
          part.relativeSegmentsPath,
        ).text();
        const relativeSegments = parseScboySubtitleJson(relativeSegmentsText);

        for (const segment of relativeSegments) {
          const startMilliseconds =
            currentStartMilliseconds +
            AudioTimestamp.parseSegmentTimestampToMilliseconds(segment.start);
          const start = formatShownoteStart(startMilliseconds);

          shownotes.push(`(${start}) P${part.page} ${segment.summary}`);
        }

        currentStartMilliseconds += Math.round(
          (await probeDurationSeconds(part.offtopicAudioPath)) * 1000,
        );
      }

      span.set({ shownoteCount: shownotes.length });
      return shownotes;
    },
  );
}

function formatShownoteStart(milliseconds: number): string {
  const totalSeconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours === 0) {
    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
