import { AudioTimestamp, probeDurationSeconds } from "./audio";
import { profileSpan } from "./perf";
import { parseScboySubtitleJson } from "./scboy_subtitle";

export interface OfftopicPart {
  page: number;
  offtopicAudioPath: string;
  relativeSegmentsPath: string;
}

export interface Shownote {
  start: string;
  summary: string;
}

export async function buildMergedOfftopicShownotes(
  parts: readonly OfftopicPart[],
): Promise<Shownote[]> {
  return profileSpan(
    "buildMergedOfftopicShownotes",
    { partCount: parts.length },
    async (span) => {
      const shownotes: Shownote[] = [];
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

          shownotes.push({
            start: formatShownoteStart(startMilliseconds),
            summary: `P${part.page} ${segment.summary}`,
          });
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
  const wholeSecondsMilliseconds = Math.floor(milliseconds / 1000) * 1000;
  return AudioTimestamp.formatSegmentTimestampFromMilliseconds(
    wholeSecondsMilliseconds,
  ).slice(0, 8);
}
