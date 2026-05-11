import { $ } from "bun";
import { resolve } from "node:path";

import {
  buildBiliPartFileStem,
  createTempBiliCookieFile,
  formatBrowserCookieSource,
  getBrowserCookieSource,
} from "./bili_utils";
import { type BiliVideoPart } from "./bili_video";
import { buildExternalCommandErrorMessage } from "./external_tools";
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
      `Missing ${lang} subtitle for ${videoPart.bvid} p${videoPart.page} ${videoPart.title}: expected ${subtitlePath}`,
    );
    this.name = "MissingSubtitleError";
    this.bvid = videoPart.bvid;
    this.page = videoPart.page;
    this.title = videoPart.title;
    Object.setPrototypeOf(this, MissingSubtitleError.prototype);
  }
}

export async function downloadSubtitle(
  videoPart: BiliVideoPart,
  outputDir: string,
  browser = DEFAULT_BROWSER,
  shouldLog = false,
): Promise<string> {
  const cookieSource = getBrowserCookieSource(browser);
  const outputTemplate = resolve(
    outputDir,
    `${buildBiliPartFileStem(videoPart)}.%(ext)s`,
  );
  const subtitlePath = resolve(
    outputDir,
    `${buildBiliPartFileStem(videoPart)}.${DEFAULT_SUBTITLE_LANG}.srt`,
  );
  const targetUrl = `https://www.bilibili.com/video/${videoPart.bvid}?p=${videoPart.page}`;
  const partLabel = `${videoPart.bvid} p${videoPart.page} ${videoPart.title}`;

  return profileSpan(
    "downloadSubtitle",
    {
      bvid: videoPart.bvid,
      page: videoPart.page,
      title: videoPart.title,
      outputPath: subtitlePath,
    },
    async (span) => {
      let succeeded = false;
      let cookieFilePath: string | null = null;

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
          cookieFilePath = await createTempBiliCookieFile();
          const cookieArgs =
            cookieFilePath !== null
              ? ["--cookies", cookieFilePath]
              : [
                  "--cookies-from-browser",
                  formatBrowserCookieSource(cookieSource),
                ];
          await runSubtitleDownloadLimited(() =>
            profileSpan(
              "downloadSubtitle.ytDlp",
              {
                bvid: videoPart.bvid,
                page: videoPart.page,
                browser,
                cookieSource:
                  cookieFilePath !== null
                    ? "env"
                    : formatBrowserCookieSource(cookieSource),
              },
              async () => {
                await $`yt-dlp ${[
                  ...cookieArgs,
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
          if (isMissingRequestedSubtitleError(error)) {
            const missingSubtitleError = new MissingSubtitleError(
              videoPart,
              subtitlePath,
            );
            if (shouldLog) {
              console.warn(
                `[downloadSubtitle:missing] ${missingSubtitleError.message}`,
              );
            }
            throw missingSubtitleError;
          }
          throw new Error(
            `Failed to download subtitle for ${partLabel}: ${buildExternalCommandErrorMessage("yt-dlp", error)}`,
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

function isMissingRequestedSubtitleError(error: unknown): boolean {
  const text = [
    extractExternalCommandText(error, "stderr"),
    extractExternalCommandText(error, "stdout"),
    error instanceof Error ? error.message : String(error),
  ]
    .filter((value) => value.length > 0)
    .join("\n")
    .toLowerCase();

  return text.includes("there are no subtitles for the requested languages");
}

function extractExternalCommandText(
  error: unknown,
  key: "stderr" | "stdout",
): string {
  if (!(error instanceof Error)) {
    return "";
  }
  const value = (error as unknown as Record<string, unknown>)[key];
  return typeof value === "string" ? value.trim() : "";
}
