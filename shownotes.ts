import { AudioTimestamp, probeDurationSeconds } from "./audio";
import { profileSpan } from "./perf";
import { parseScboySubtitleJson } from "./scboy_subtitle";

export interface OfftopicPart {
  page: number;
  offtopicAudioPath: string;
  relativeSegmentsPath: string;
  segmentPromptHash: string;
}

export interface ProcessedPartOfftopic extends OfftopicPart {}

export interface MergedOfftopicShownotesContext {
  generatedAt: Date;
  seasonNumber: string;
  episodeNumber: string;
}

export async function buildMergedOfftopicShownotes(
  parts: readonly OfftopicPart[],
  context: MergedOfftopicShownotesContext,
): Promise<string[]> {
  return profileSpan(
    "buildMergedOfftopicShownotes",
    { partCount: parts.length },
    async (span) => {
      const promptHash = parts[0]!.segmentPromptHash.replace(/^sha256:/u, "");
      if (!/^[0-9a-f]{64}$/u.test(promptHash)) {
        throw new Error(`Invalid segment prompt hash: ${parts[0]!.segmentPromptHash}`);
      }
      const generatedAt = `${String(context.generatedAt.getMonth() + 1).padStart(2, "0")}-${String(context.generatedAt.getDate()).padStart(2, "0")} ${String(context.generatedAt.getHours()).padStart(2, "0")}:${String(context.generatedAt.getMinutes()).padStart(2, "0")}`;
      const shownotes: string[] = [
        `prompt hash: ${promptHash.slice(0, 6)}, ${generatedAt}`,
        `${context.seasonNumber} ${context.episodeNumber}`,
      ];
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
          const totalSeconds = Math.floor(startMilliseconds / 1000);
          const hours = Math.floor(totalSeconds / 3600);
          const minutes = Math.floor((totalSeconds % 3600) / 60);
          const seconds = totalSeconds % 60;
          const start = `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;

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
