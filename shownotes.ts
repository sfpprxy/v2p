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
          const wholeSecondsMilliseconds =
            Math.floor(startMilliseconds / 1000) * 1000;
          const start = AudioTimestamp.formatSegmentTimestampFromMilliseconds(
            wholeSecondsMilliseconds,
          ).slice(0, 8);

          shownotes.push(`${start} P${part.page} ${segment.summary}`);
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
