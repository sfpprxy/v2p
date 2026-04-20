import { createConcurrencyLimiter } from "./concurrency.js";

export const AUDIO_DOWNLOAD_CONCURRENCY = readConcurrencyLimit(
  "V2P_AUDIO_DOWNLOAD_CONCURRENCY",
  2,
);
export const LLM_CONCURRENCY = readConcurrencyLimit("V2P_LLM_CONCURRENCY", 4);
export const SUBTITLE_DOWNLOAD_CONCURRENCY = readConcurrencyLimit(
  "V2P_SUBTITLE_DOWNLOAD_CONCURRENCY",
  4,
);

export const runSubtitleDownloadLimited = createConcurrencyLimiter(
  SUBTITLE_DOWNLOAD_CONCURRENCY,
);

function readConcurrencyLimit(name: string, defaultValue: number): number {
  const rawValue = process.env[name]?.trim();
  if (!rawValue) {
    return defaultValue;
  }

  const value = Number(rawValue);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got ${rawValue}`);
  }
  return value;
}
