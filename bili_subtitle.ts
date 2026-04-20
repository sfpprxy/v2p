import { $ } from "bun";
import { resolve } from "node:path";

import { buildBiliPartFileStem } from "./bili_utils.js";
import { type BiliVideoPart } from "./bili_video.js";

export const DEFAULT_SUBTITLE_LANG = "ai-zh";
export const DEFAULT_BROWSER = "chrome";

export async function downloadSubtitle(
  videoPart: BiliVideoPart,
  outputDir: string,
  browser = DEFAULT_BROWSER,
  shouldLog = true,
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
  let succeeded = false;

  if (shouldLog) {
    console.log(`[downloadSubtitle:start] ${subtitlePath}`);
  }
  if (await Bun.file(subtitlePath).exists()) {
    succeeded = true;
    if (shouldLog) {
      console.log(`[downloadSubtitle:skip] exists ${subtitlePath}`);
      console.log(`[downloadSubtitle:end] ok ${subtitlePath}`);
    }
    return subtitlePath;
  }

  try {
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
    // console.debug(commandOutput);
    succeeded = true;
  } catch (error) {
    throw new Error(
      `Failed to download subtitle for ${partLabel}: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    if (shouldLog) {
      console.log(
        `[downloadSubtitle:end] ${succeeded ? "ok" : "error"} ${subtitlePath}`,
      );
    }
  }
  return subtitlePath;
}
