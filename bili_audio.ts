import { Client } from "@renmu/bili-api";
import type { PlayUrlReturnType } from "@renmu/bili-api/dist/types/video.js";
import { resolve } from "node:path";

import { probeDurationSeconds, remuxAudio } from "./audio";
import { buildBiliPartFileStem } from "./bili_utils";
import { BiliVideoPart } from "./bili_video";
import { profileSpan } from "./perf";

type PlayurlDash = NonNullable<PlayUrlReturnType["dash"]>;
type AudioCandidate = PlayurlDash["audio"][number];

class AudioStreamSelector {
  constructor(private readonly client: Client) {}

  async getBestAudioUrl(videoPart: BiliVideoPart): Promise<string> {
    const { bvid, cid } = videoPart;
    const playurlResponse = await this.client.video.playurl({
      bvid,
      cid,
      fnval: 16,
    });
    AudioStreamSelector.assertNoUnsupportedAudioKinds(playurlResponse);
    const selectedCandidate =
      AudioStreamSelector.pickBestCandidate(playurlResponse);
    const url = selectedCandidate.baseUrl ?? selectedCandidate.backupUrl?.[0];
    if (url == null) {
      throw new Error("Selected audio stream does not contain a usable url");
    }

    return url;
  }

  private static assertNoUnsupportedAudioKinds(
    playurl: PlayUrlReturnType,
  ): void {
    const unsupportedKinds: string[] = [];
    const flacAudio: AudioCandidate | null | undefined =
      playurl.dash?.flac?.audio;

    if (flacAudio != null && this.hasCandidateUrl(flacAudio)) {
      unsupportedKinds.push("flac");
    }
    if ((playurl.dash?.dolby?.audio ?? []).some(this.hasCandidateUrl)) {
      unsupportedKinds.push("dolby");
    }

    if (unsupportedKinds.length > 0) {
      throw new Error(
        `Unsupported audio stream kind for current m4a pipeline: ${unsupportedKinds.join(", ")}`,
      );
    }
  }

  private static pickBestCandidate(playurl: PlayUrlReturnType): AudioCandidate {
    const candidates = (playurl.dash?.audio ?? []).filter(this.hasCandidateUrl);
    if (candidates.length === 0) {
      throw new Error("No supported audio stream found in playurl data");
    }

    candidates.sort(this.compareCandidates);
    return candidates[0];
  }

  private static hasCandidateUrl(candidate: AudioCandidate): boolean {
    return candidate.baseUrl != null || candidate.backupUrl?.[0] != null;
  }

  private static compareCandidates(
    left: AudioCandidate,
    right: AudioCandidate,
  ): number {
    // console.debug("compareCandidates", { left, right });

    const bandwidthDiff = (right.bandwidth ?? 0) - (left.bandwidth ?? 0);
    if (bandwidthDiff !== 0) {
      return bandwidthDiff;
    }

    return (right.id ?? 0) - (left.id ?? 0);
  }
}

export async function downloadAudio(
  videoPart: BiliVideoPart,
  client: Client,
  outputDir = ".",
  shouldLog = false,
): Promise<string> {
  const outputPath = resolve(
    outputDir,
    `${buildBiliPartFileStem(videoPart)}.m4a`,
  );
  const tempPath = `${outputPath}.download.m4s`;

  return profileSpan(
    "downloadAudio",
    {
      bvid: videoPart.bvid,
      page: videoPart.page,
      title: videoPart.tittle,
      outputPath,
    },
    async (span) => {
      let succeeded = false;

      if (shouldLog) {
        console.log(`[downloadAudio:start] ${outputPath}`);
      }

      if (await Bun.file(outputPath).exists()) {
        succeeded = true;
        span.set({ cacheHit: true });
        if (shouldLog) {
          console.log(`[downloadAudio:skip] exists ${outputPath}`);
          console.log(`[downloadAudio:end] ok ${outputPath}`);
        }
        return outputPath;
      }

      span.set({ cacheHit: false, tempPath });
      try {
        const audioStreamSelector = new AudioStreamSelector(client);
        const audioUrl = await profileSpan(
          "downloadAudio.playurl",
          {
            bvid: videoPart.bvid,
            page: videoPart.page,
          },
          async () => audioStreamSelector.getBestAudioUrl(videoPart),
        );

        await profileSpan(
          "downloadAudio.fetch",
          {
            bvid: videoPart.bvid,
            page: videoPart.page,
            outputPath: tempPath,
          },
          async (fetchSpan) => {
            const response = await fetch(audioUrl, {
              headers: {
                "User-Agent": "Mozilla/5.0",
                Referer: `https://www.bilibili.com/video/${videoPart.bvid}/`,
              },
            });
            const contentLength = Number(
              response.headers.get("content-length") ?? "",
            );
            fetchSpan.set({
              responseStatus: response.status,
              contentLength: Number.isFinite(contentLength)
                ? contentLength
                : undefined,
            });
            if (!response.ok || !response.body) {
              throw new Error(
                `Failed to download stream: ${response.status} ${response.statusText}`,
              );
            }

            const sink = Bun.file(tempPath).writer();
            const responseBody =
              response.body as unknown as AsyncIterable<Uint8Array>;
            let downloadedBytes = 0;
            let sinkClosed = false;
            try {
              for await (const value of responseBody) {
                downloadedBytes += value.byteLength;
                sink.write(value);
              }
              await sink.end();
              sinkClosed = true;
            } finally {
              if (!sinkClosed) {
                await Promise.resolve(sink.end()).catch(() => {});
              }
            }
            fetchSpan.set({ downloadedBytes });
          },
        );

        await remuxAudio(tempPath, outputPath);
        const durationSeconds = await probeDurationSeconds(outputPath);
        span.set({ durationSeconds });
        validateDuration(durationSeconds, videoPart.duration);
        succeeded = true;
      } catch (error) {
        await Bun.file(outputPath)
          .delete()
          .catch(() => {});
        throw error;
      } finally {
        await Bun.file(tempPath)
          .delete()
          .catch(() => {});
        if (shouldLog) {
          console.log(
            `[downloadAudio:end] ${succeeded ? "ok" : "error"} ${outputPath}`,
          );
        }
      }

      return outputPath;
    },
  );
}

function validateDuration(
  actualSeconds: number,
  expectedSeconds: number,
): void {
  if (expectedSeconds <= 0) {
    throw new Error(`期望时长无效：${expectedSeconds} 秒`);
  }

  const diffSeconds = Math.abs(actualSeconds - expectedSeconds);
  const diffRatio = diffSeconds / expectedSeconds;
  const maxDiffRatio = 0.05;

  if (diffRatio > maxDiffRatio) {
    throw new Error(
      `下载的音频时长不匹配：期望 ${expectedSeconds} 秒，实际 ${actualSeconds.toFixed(2)} 秒`,
    );
  }
}
