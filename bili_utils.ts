import { $ } from "bun";
import { Client } from "@renmu/bili-api";
import { resolve } from "node:path";
import { type BiliVideoPart } from "./bili_video";

export interface BiliCookieMap {
  SESSDATA?: string;
  bili_jct?: string;
  buvid3?: string;
  buvid4?: string;
  DedeUserID?: string;
  ac_time_value?: string;
  [key: string]: string | undefined;
}

export async function syncBiliCookieFromBrowser(
  browser = "chrome",
  envPath = ".env",
): Promise<{ cookie: string; missingKeys: string[] }> {
  const cookiePath = resolve(`.bilibili.${Date.now()}.cookies.txt`);

  try {
    await $`yt-dlp ${[
      "--cookies-from-browser",
      browser,
      "--cookies",
      cookiePath,
      "--skip-download",
      "--simulate",
      "https://www.bilibili.com/video/BV1ffF4zoEmH",
    ]}`.quiet();

    const netscape = await Bun.file(cookiePath).text();
    const cookieMap = new Map<string, string>();

    for (const line of netscape.split("\n")) {
      const trimmed = line.trim();
      if (
        !trimmed ||
        (trimmed.startsWith("#") && !trimmed.startsWith("#HttpOnly_"))
      ) {
        continue;
      }

      const columns = trimmed.split("\t");
      if (columns.length < 7) {
        continue;
      }

      let domain = columns[0];
      if (domain.startsWith("#HttpOnly_")) {
        domain = domain.slice("#HttpOnly_".length);
      }
      if (!domain.includes("bilibili.com")) {
        continue;
      }

      const key = columns[5]?.trim() ?? "";
      if (!key) {
        continue;
      }
      cookieMap.set(key, columns[6] ?? "");
    }

    if (cookieMap.size === 0) {
      throw new Error(`No bilibili.com cookie found in ${cookiePath}`);
    }

    const cookie = Array.from(cookieMap.entries())
      .map(([key, value]) => `${key}=${value}`)
      .join("; ");
    const parsedCookie = parseRawCookie(cookie);
    const missingKeys = ["SESSDATA", "bili_jct", "DedeUserID"].filter(
      (key) => !parsedCookie[key],
    );

    const envFile = Bun.file(envPath);
    let envText = "";
    if (await envFile.exists()) {
      envText = await envFile.text();
    }

    const line = `BILIBILI_COOKIE=${cookie}`;
    const updatedEnv = /^BILIBILI_COOKIE=.*$/m.test(envText)
      ? envText.replace(/^BILIBILI_COOKIE=.*$/m, line)
      : `${envText}${envText.endsWith("\n") || envText.length === 0 ? "" : "\n"}${line}\n`;

    await Bun.write(envPath, updatedEnv);

    return { cookie, missingKeys };
  } finally {
    await Bun.file(cookiePath).delete().catch(() => {});
  }
}

export function buildBiliClient(): Client {
  const client = new Client();
  const cookie = buildBiliCookie();
  if (!cookie) {
    return client;
  }

  if (cookie.SESSDATA && cookie.bili_jct) {
    const uid = Number(cookie.DedeUserID ?? "0");
    client.setAuth(
      {
        ...cookie,
        DedeUserID: cookie.DedeUserID ?? (Number.isFinite(uid) ? uid : 0),
        SESSDATA: cookie.SESSDATA,
        bili_jct: cookie.bili_jct,
      } as {
        SESSDATA: string;
        bili_jct: string;
        DedeUserID: string | number;
        [key: string]: string | number;
      },
      Number.isFinite(uid) ? uid : 0,
    );
  }

  return client;
}

export function buildBiliCookie(): BiliCookieMap | null {
  const rawCookie = process.env.BILIBILI_COOKIE?.trim() ?? "";
  if (rawCookie) {
    return parseRawCookie(rawCookie);
  }

  const cookie: BiliCookieMap = {
    SESSDATA: process.env.BILIBILI_SESSDATA ?? process.env.SESSDATA,
    bili_jct: process.env.BILIBILI_BILI_JCT ?? process.env.BILI_JCT,
    buvid3: process.env.BILIBILI_BUVID3 ?? process.env.BUVID3,
    buvid4: process.env.BILIBILI_BUVID4 ?? process.env.BUVID4,
    DedeUserID: process.env.BILIBILI_DEDEUSERID ?? process.env.DEDEUSERID,
    ac_time_value:
      process.env.BILIBILI_AC_TIME_VALUE ?? process.env.AC_TIME_VALUE,
  };

  if (!Object.values(cookie).some(Boolean)) {
    return null;
  }

  return cookie;
}

export function buildBiliPartFileStem(part: BiliVideoPart): string {
  return `${part.bvid}_${part.title}`;
}

export function parseRawCookie(rawCookie: string): BiliCookieMap {
  const cookieItems: BiliCookieMap = {};
  for (const item of rawCookie.split(";")) {
    const trimmed = item.trim();
    if (!trimmed) {
      continue;
    }

    const index = trimmed.indexOf("=");
    if (index < 0) {
      continue;
    }

    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim();
    if (!key) {
      continue;
    }
    cookieItems[key] = value;
  }

  return cookieItems;
}

if (import.meta.main) {
  const result = await syncBiliCookieFromBrowser("chrome");
  console.log(result);
}
