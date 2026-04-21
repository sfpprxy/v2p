import { $ } from "bun";
import { resolve } from "node:path";

import { buildBiliPartFileStem } from "./bili_utils";
import { type BiliVideoPart } from "./bili_video";
import { runSubtitleDownloadLimited } from "./limits";
import { profileSpan } from "./perf";

export const DEFAULT_SUBTITLE_LANG = "ai-zh";
export const DEFAULT_BROWSER = "chrome";

export class MissingSubtitleError extends Error {
  public readonly bvid: string;
  public readonly page: number;
  public readonly title: string;

  constructor(
    videoPart: BiliVideoPart,
    public readonly subtitlePath: string,
    public readonly lang = DEFAULT_SUBTITLE_LANG,
  ) {
    super(
      `Missing ${lang} subtitle for ${videoPart.bvid} p${videoPart.page} ${videoPart.tittle}: expected ${subtitlePath}`,
    );
    this.name = "MissingSubtitleError";
    this.bvid = videoPart.bvid;
    this.page = videoPart.page;
    this.title = videoPart.tittle;
    Object.setPrototypeOf(this, MissingSubtitleError.prototype);
  }
}

export async function downloadSubtitle(
  videoPart: BiliVideoPart,
  outputDir: string,
  browser = DEFAULT_BROWSER,
  shouldLog = false,
): Promise<string> {
  const outputTemplate = resolve(
    outputDir,
    `${buildBiliPartFileStem(videoPart)}.%(ext)s`,
  );
  const subtitlePath = resolve(
    outputDir,
    `${buildBiliPartFileStem(videoPart)}.${DEFAULT_SUBTITLE_LANG}.srt`,
  );
  const targetUrl = `https://www.bilibili.com/video/${videoPart.bvid}?p=${videoPart.page}`;
  const partLabel = `${videoPart.bvid} p${videoPart.page} ${videoPart.tittle}`;

  return profileSpan(
    "downloadSubtitle",
    {
      bvid: videoPart.bvid,
      page: videoPart.page,
      title: videoPart.tittle,
      outputPath: subtitlePath,
    },
    async (span) => {
      let succeeded = false;

      if (shouldLog) {
        console.log(`[downloadSubtitle:start] ${subtitlePath}`);
      }
      if (await Bun.file(subtitlePath).exists()) {
        succeeded = true;
        span.set({ cacheHit: true });
        if (shouldLog) {
          console.log(`[downloadSubtitle:skip] exists ${subtitlePath}`);
          console.log(`[downloadSubtitle:end] ok ${subtitlePath}`);
        }
        return subtitlePath;
      }

      span.set({ cacheHit: false, browser });
      try {
        try {
          await runSubtitleDownloadLimited(() =>
            profileSpan(
              "downloadSubtitle.ytDlp",
              {
                bvid: videoPart.bvid,
                page: videoPart.page,
                browser,
              },
              async () => {
                await $`yt-dlp ${[
                  "--cookies-from-browser",
                  browser,
                  "--write-subs",
                  "--sub-langs",
                  DEFAULT_SUBTITLE_LANG,
                  "--skip-download",
                  "-o",
                  outputTemplate,
                  targetUrl,
                ]}`.quiet();
              },
            ),
          );
        } catch (error) {
          throw new Error(
            `Failed to download subtitle for ${partLabel}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }

        if (!(await Bun.file(subtitlePath).exists())) {
          const error = new MissingSubtitleError(videoPart, subtitlePath);
          if (shouldLog) {
            console.warn(`[downloadSubtitle:missing] ${error.message}`);
          }
          throw error;
        }

        succeeded = true;
      } finally {
        if (shouldLog) {
          console.log(
            `[downloadSubtitle:end] ${succeeded ? "ok" : "error"} ${subtitlePath}`,
          );
        }
      }
      return subtitlePath;
    },
  );
}
