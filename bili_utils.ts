import { $ } from "bun";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { Client } from "@renmu/bili-api";
import { dirname, resolve } from "node:path";
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

export interface BrowserCookieSource {
  browser: string;
  profile?: string;
}

const DEFAULT_BROWSER = "chrome";
const DEFAULT_COOKIE_TTL_HOURS = 24;
const DEFAULT_ENV_PATH = ".env";
const COOKIE_REFRESHED_AT_KEY = "BILIBILI_COOKIE_REFRESHED_AT";
const COOKIE_TTL_HOURS_KEY = "BILIBILI_COOKIE_TTL_HOURS";
const DEFAULT_COOKIE_EXPORT_FILE = "bilibili.cookies.txt";
const BILI_NAV_URL = "https://api.bilibili.com/x/web-interface/nav";
const DEFAULT_BROWSER_DEBUG_VERSION_URL = "http://127.0.0.1:9222/json/version";

type CookieValidationState = "valid" | "invalid" | "unknown";
type CookieRefreshAttempt = { source: string; reason: string };

let cachedCookieValidation:
  | Promise<{ state: CookieValidationState; reason?: string }>
  | null = null;

export async function syncBiliCookieFromBrowser(
  browser = DEFAULT_BROWSER,
  envPath = DEFAULT_ENV_PATH,
): Promise<{ cookie: string; missingKeys: string[] }> {
  const attempts: CookieRefreshAttempt[] = [];
  const cdpResult = await tryRefreshBiliCookie(
    "browser remote debugging",
    syncBiliCookieFromRemoteDebugging,
    envPath,
    attempts,
  );
  if (cdpResult !== null) {
    return cdpResult;
  }

  const exportPath = getDefaultBrowserCookieExportPath();
  if (exportPath !== null) {
    const result = await tryRefreshBiliCookie(
      `export file ${exportPath}`,
      async () => syncBiliCookieFromFile(exportPath),
      envPath,
      attempts,
    );
    if (result !== null) {
      return result;
    }
  }

  const result = await tryRefreshBiliCookie(
    "yt-dlp --cookies-from-browser",
    async () => syncBiliCookieFromYtDlp(browser),
    envPath,
    attempts,
  );
  if (result !== null) {
    return result;
  }

  throw buildBrowserCookieRefreshError(attempts);
}

export async function buildBiliClient(): Promise<Client> {
  const client = new Client();
  const cookie = await getBiliCookie();
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

export function getBrowserCookieSource(
  fallbackBrowser = DEFAULT_BROWSER,
): BrowserCookieSource {
  const browser =
    process.env.BILIBILI_COOKIE_BROWSER?.trim() || fallbackBrowser;
  const envProfile =
    process.env.BILIBILI_COOKIE_BROWSER_PROFILE?.trim() ||
    process.env.BILIBILI_COOKIE_BROWSER_PATH?.trim();

  if (!envProfile) {
    return { browser };
  }

  return {
    browser,
    profile: normalizeBrowserProfilePath(envProfile),
  };
}

export function getDefaultBrowserCookieExportPath(): string | null {
  const defaultPath = resolve(tmpdir(), DEFAULT_COOKIE_EXPORT_FILE);
  return existsSync(defaultPath) ? defaultPath : null;
}

export function formatBrowserCookieSource({
  browser,
  profile,
}: BrowserCookieSource): string {
  if (!profile) {
    return browser;
  }
  return `${browser}:${profile}`;
}

export function parseBiliCookieFromEnv(): BiliCookieMap | null {
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

export async function getBiliCookie(): Promise<BiliCookieMap | null> {
  const cachedCookie = parseBiliCookieFromEnv();
  const shouldRefreshByTtl = shouldRefreshBiliCookie();
  const validation =
    cachedCookie === null
      ? { state: "invalid" as const, reason: "Missing cached bilibili cookie." }
      : await validateBiliCookieOnce(cachedCookie);
  const shouldRefreshByValidation = validation.state === "invalid";

  if (shouldRefreshByTtl || shouldRefreshByValidation) {
    if (shouldRefreshByValidation && validation.reason) {
      console.warn(`[bili_cookie] cached cookie is not logged in: ${validation.reason}`);
    }
    try {
      await syncBiliCookieFromBrowser();
    } catch (error) {
      if (cachedCookie !== null) {
        const message = error instanceof Error ? error.message : String(error);
        if (validation.state === "valid" || validation.state === "unknown") {
          console.warn(
            `[bili_cookie] refresh failed, using cached cookie from .env: ${message}`,
          );
          return cachedCookie;
        }
      }
      throw error;
    }
  }

  return parseBiliCookieFromEnv();
}

export async function createTempBiliCookieFile(): Promise<string | null> {
  const cookie = await getBiliCookie();
  if (cookie === null) {
    return null;
  }

  const cookieEntries = Object.entries(cookie).filter(
    ([, value]) => typeof value === "string" && value.length > 0,
  );
  if (cookieEntries.length === 0) {
    return null;
  }

  const cookiePath = resolve(`.bilibili.yt-dlp.${Date.now()}.cookies.txt`);
  const expiresAt = "2147483647";
  const rows = [
    "# Netscape HTTP Cookie File",
    ...cookieEntries.map(
      ([key, value]) =>
        `.bilibili.com\tTRUE\t/\tTRUE\t${expiresAt}\t${key}\t${value ?? ""}`,
    ),
    "",
  ];
  await Bun.write(cookiePath, rows.join("\n"));
  return cookiePath;
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

function normalizeBrowserProfilePath(rawPath: string): string {
  const trimmed = rawPath.trim().replace(/^["']|["']$/g, "");
  if (!trimmed) {
    return trimmed;
  }

  const normalizedPath = resolve(trimmed);
  if (!normalizedPath.toLowerCase().endsWith(".exe")) {
    return normalizedPath;
  }

  const browserDir = dirname(normalizedPath);
  const siblingUserDataDir = resolve(browserDir, "User Data");
  if (existsSync(siblingUserDataDir)) {
    return siblingUserDataDir;
  }

  return browserDir;
}

function buildBrowserCookieRefreshError(
  attempts: readonly CookieRefreshAttempt[],
): Error {
  const detailLines =
    attempts.length === 0
      ? ["No refresh source was available."]
      : attempts.map(
          ({ source, reason }, index) => `${index + 1}. ${source}: ${reason}`,
        );
  return new Error(
    [
      "Failed to refresh bilibili cookie from browser profile.",
      `Prefer exporting a browser cookies.txt file to ${resolve(tmpdir(), DEFAULT_COOKIE_EXPORT_FILE)} so refresh still works while the browser is running.`,
      "If the browser is running, close it and retry; yt-dlp could not copy the cookie database.",
      ...detailLines,
    ].join("\n"),
  );
}

function shouldRefreshBiliCookie(now = Date.now()): boolean {
  const rawCookie = process.env.BILIBILI_COOKIE?.trim() ?? "";
  if (!rawCookie) {
    return true;
  }

  const refreshedAtText = process.env[COOKIE_REFRESHED_AT_KEY]?.trim() ?? "";
  if (!refreshedAtText) {
    return true;
  }

  const refreshedAtMs = Date.parse(refreshedAtText);
  if (Number.isNaN(refreshedAtMs)) {
    return true;
  }

  return now - refreshedAtMs >= getBiliCookieTtlMs();
}

function getBiliCookieTtlMs(): number {
  const rawTtlHours = process.env[COOKIE_TTL_HOURS_KEY]?.trim() ?? "";
  const ttlHours = Number(rawTtlHours);
  if (!Number.isFinite(ttlHours) || ttlHours <= 0) {
    return DEFAULT_COOKIE_TTL_HOURS * 60 * 60 * 1000;
  }

  return ttlHours * 60 * 60 * 1000;
}

async function writeEnvAssignments(
  envPath: string,
  assignments: Record<string, string>,
): Promise<void> {
  const envFile = Bun.file(envPath);
  let envText = "";
  if (await envFile.exists()) {
    envText = await envFile.text();
  }

  let nextEnvText = envText;
  for (const [key, value] of Object.entries(assignments)) {
    const escapedValue = escapeEnvValue(value);
    const line = `${key}=${escapedValue}`;
    const matcher = new RegExp(`^${escapeRegExp(key)}=.*$`, "m");
    nextEnvText = matcher.test(nextEnvText)
      ? nextEnvText.replace(matcher, line)
      : `${nextEnvText}${nextEnvText.endsWith("\n") || nextEnvText.length === 0 ? "" : "\n"}${line}\n`;
  }

  await Bun.write(envPath, nextEnvText);
}

function escapeEnvValue(value: string): string {
  return value.replace(/\r?\n/g, " ");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function syncBiliCookieFromFile(
  cookieFilePath: string,
): Promise<string> {
  const cookieText = await Bun.file(cookieFilePath).text();
  const parsedCookie = parseCookieFile(cookieText, cookieFilePath);
  return buildRawCookieFromMap(new Map(Object.entries(parsedCookie)));
}

async function syncBiliCookieFromRemoteDebugging(): Promise<string> {
  const versionResponse = await fetch(DEFAULT_BROWSER_DEBUG_VERSION_URL);
  if (!versionResponse.ok) {
    throw new Error(
      `Cannot query browser debug endpoint ${DEFAULT_BROWSER_DEBUG_VERSION_URL}: HTTP ${versionResponse.status}.`,
    );
  }

  const versionPayload = await versionResponse.json() as {
    webSocketDebuggerUrl?: string;
  };
  const webSocketDebuggerUrl =
    versionPayload.webSocketDebuggerUrl?.trim() ?? "";
  if (!webSocketDebuggerUrl) {
    throw new Error(
      `Browser debug endpoint ${DEFAULT_BROWSER_DEBUG_VERSION_URL} did not return webSocketDebuggerUrl.`,
    );
  }

  const cdpPayload = await new Promise<{ result?: { cookies?: Array<{
    name?: string;
    value?: string;
    domain?: string;
  }> } }>((resolve, reject) => {
    const socket = new WebSocket(webSocketDebuggerUrl);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("Timed out while reading cookies from browser remote debugging."));
    }, 15_000);

    socket.onopen = () => {
      socket.send(JSON.stringify({ id: 1, method: "Storage.getCookies" }));
    };
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as {
        id?: number;
        result?: { cookies?: Array<{ name?: string; value?: string; domain?: string }> };
        error?: { message?: string };
      };
      if (message.id !== 1) {
        return;
      }
      clearTimeout(timer);
      socket.close();
      if (message.error) {
        reject(
          new Error(
            message.error.message ||
              "Browser remote debugging returned an unknown error.",
          ),
        );
        return;
      }
      resolve(message);
    };
    socket.onerror = () => {
      clearTimeout(timer);
      reject(new Error("Browser remote debugging websocket failed."));
    };
  });

  const cookieMap = new Map<string, string>();
  for (const cookie of cdpPayload.result?.cookies ?? []) {
    if (!String(cookie.domain ?? "").includes("bilibili.com")) {
      continue;
    }
    const name = cookie.name?.trim() ?? "";
    if (!name) {
      continue;
    }
    cookieMap.set(name, cookie.value ?? "");
  }

  if (cookieMap.size === 0) {
    throw new Error(
      "Browser remote debugging returned no bilibili.com cookies.",
    );
  }

  return buildRawCookieFromMap(cookieMap);
}

async function syncBiliCookieFromYtDlp(browser: string): Promise<string> {
  const cookieSource = getBrowserCookieSource(browser);
  const cookiePath = resolve(`.bilibili.${Date.now()}.cookies.txt`);

  try {
    await $`yt-dlp ${[
      "--cookies-from-browser",
      formatBrowserCookieSource(cookieSource),
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

    return buildRawCookieFromMap(cookieMap);
  } finally {
    await Bun.file(cookiePath).delete().catch(() => {});
  }
}

async function persistBiliCookie(
  cookie: string,
  envPath: string,
): Promise<{ cookie: string; missingKeys: string[] }> {
  const parsedCookie = parseRawCookie(cookie);
  const missingKeys = ["SESSDATA", "bili_jct", "DedeUserID"].filter(
    (key) => !parsedCookie[key],
  );
  const refreshedAt = new Date().toISOString();
  await writeEnvAssignments(envPath, {
    BILIBILI_COOKIE: cookie,
    [COOKIE_REFRESHED_AT_KEY]: refreshedAt,
  });
  process.env.BILIBILI_COOKIE = cookie;
  process.env[COOKIE_REFRESHED_AT_KEY] = refreshedAt;
  cachedCookieValidation = null;
  return { cookie, missingKeys };
}

function parseCookieFile(
  cookieText: string,
  cookieFilePath: string,
): BiliCookieMap {
  const normalizedCookieText = cookieText.replace(/^\uFEFF/u, "");
  const parsedFromNetscape = parseNetscapeCookieFile(normalizedCookieText);
  if (Object.keys(parsedFromNetscape).length > 0) {
    return parsedFromNetscape;
  }

  const parsedFromRawCookie = parseRawCookie(normalizedCookieText.trim());
  if (Object.keys(parsedFromRawCookie).length > 0) {
    return parsedFromRawCookie;
  }

  throw new Error(
    `No bilibili.com cookie found in ${cookieFilePath}. Expected Netscape cookies.txt content or a raw Cookie header.`,
  );
}

function parseNetscapeCookieFile(cookieText: string): BiliCookieMap {
  const cookieMap = new Map<string, string>();

  for (const line of cookieText.split(/\r?\n/u)) {
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

  return Object.fromEntries(cookieMap.entries());
}

function buildRawCookieFromMap(cookieMap: Map<string, string>): string {
  return Array.from(cookieMap.entries())
    .map(([key, value]) => `${key}=${value}`)
    .join("; ");
}

async function validateBiliCookieOnce(
  cookie: BiliCookieMap,
): Promise<{ state: CookieValidationState; reason?: string }> {
  cachedCookieValidation ??= validateBiliCookie(cookie);
  return cachedCookieValidation;
}

async function validateBiliCookie(
  cookie: BiliCookieMap,
): Promise<{ state: CookieValidationState; reason?: string }> {
  const rawCookie = buildRawCookieFromMap(
    new Map(
      Object.entries(cookie).filter(
        ([, value]) => typeof value === "string" && value.length > 0,
      ) as [string, string][],
    ),
  );
  if (!rawCookie) {
    return { state: "invalid", reason: "Cookie string is empty." };
  }

  try {
    const response = await fetch(BILI_NAV_URL, {
      headers: {
        cookie: rawCookie,
        referer: "https://www.bilibili.com/",
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
      },
    });
    if (!response.ok) {
      return {
        state: "unknown",
        reason: `Validation request failed with HTTP ${response.status}.`,
      };
    }

    const payload = await response.json() as {
      code?: number;
      message?: string;
      data?: { isLogin?: boolean; uname?: string };
    };
    if (payload.code !== 0) {
      return {
        state: "invalid",
        reason: payload.message || `nav returned code ${payload.code ?? "unknown"}.`,
      };
    }

    if (payload.data?.isLogin === true) {
      return { state: "valid" };
    }

    return { state: "invalid", reason: "nav returned isLogin=false." };
  } catch (error) {
    return {
      state: "unknown",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

async function tryRefreshBiliCookie(
  source: string,
  loadCookie: () => Promise<string>,
  envPath: string,
  attempts: CookieRefreshAttempt[],
): Promise<{ cookie: string; missingKeys: string[] } | null> {
  try {
    const rawCookie = await loadCookie();
    const parsedCookie = parseRawCookie(rawCookie);
    const validation = await validateBiliCookie(parsedCookie);
    if (validation.state !== "valid") {
      attempts.push({
        source,
        reason:
          validation.reason ??
          `Cookie validation returned state ${validation.state}.`,
      });
      return null;
    }

    return persistBiliCookie(rawCookie, envPath);
  } catch (error) {
    attempts.push({
      source,
      reason: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

if (import.meta.main) {
  const result = await syncBiliCookieFromBrowser();
  console.log(result);
}
