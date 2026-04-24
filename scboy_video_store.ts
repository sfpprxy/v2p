import { Database } from "bun:sqlite";
import { Client } from "@renmu/bili-api";

import { BiliVideo, type BiliVideoApiItem } from "./bili_video";
import { buildBiliClient } from "./bili_utils";

const SCBOY_ID = 9717562;
const DATE_VALUE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

type DateInTitleFilter =
  | string
  | [string, string]
  | string[]
  | null
  | undefined;

export class ScboyVideoStore {
  constructor(public readonly conn: Database) {}

  static open(dbPath = "v2p.db"): ScboyVideoStore {
    return new ScboyVideoStore(new Database(dbPath));
  }

  close(): void {
    this.conn.close();
  }

  init(): void {
    this.conn.exec(`
      CREATE TABLE IF NOT EXISTS scboy_video (
        bvid TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        length TEXT NOT NULL,
        upload_at DATETIME NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
  }

  storeVideos(videos: BiliVideo[]): void {
    const statement = this.conn.prepare(`
      INSERT INTO scboy_video (bvid, title, length, upload_at, created_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(bvid) DO UPDATE SET
        title = CASE
          WHEN scboy_video.title != excluded.title THEN excluded.title
          ELSE scboy_video.title
        END,
        length = CASE
          WHEN scboy_video.length != excluded.length THEN excluded.length
          ELSE scboy_video.length
        END,
        upload_at = CASE
          WHEN scboy_video.upload_at != excluded.upload_at THEN excluded.upload_at
          ELSE scboy_video.upload_at
        END,
        created_at = CASE
          WHEN scboy_video.title != excluded.title
            OR scboy_video.length != excluded.length
            OR scboy_video.upload_at != excluded.upload_at
          THEN CURRENT_TIMESTAMP
          ELSE scboy_video.created_at
        END
    `);

    for (const video of videos) {
      statement.run(
        video.bvid,
        video.title,
        video.length,
        video.uploadAt.toISOString(),
      );
    }
  }

  loadVideos(): BiliVideo[] {
    const rows = this.conn
      .prepare(
        `
      SELECT bvid, title, length, upload_at
      FROM scboy_video
      ORDER BY upload_at
    `,
      )
      .all() as Record<string, unknown>[];

    return rows.map(BiliVideo.fromDbRow);
  }

  async fetchVideos(client: Client, pages = 1): Promise<BiliVideo[]> {
    let currentDelay = 1000;
    const maxDelay = 60000;

    for (let page = pages; page >= 1; page -= 1) {
      for (;;) {
        try {
          const result = await client.user.getVideos({
            mid: SCBOY_ID,
            pn: page,
            ps: 40,
          });
          const items = result.list.vlist as BiliVideoApiItem[];
          const videos = items.map(BiliVideo.fromApiItem);
          this.storeVideos(videos);
          console.log(
            `page ok ${page}, current delay: ${currentDelay / 1000}s`,
          );
          currentDelay = Math.max(1000, Math.floor(currentDelay * 0.8));
          await Bun.sleep(currentDelay);
          break;
        } catch (error) {
          if (isBiliRiskControlError(error)) {
            throw new Error(
              "Bilibili risk control blocked the request (code -352). Set valid BILIBILI_COOKIE (or SESSDATA + bili_jct) in .env and retry.",
            );
          }
          if (isRateLimitError(error)) {
            console.log(
              `Rate limit hit at page ${page}, waiting ${currentDelay / 1000}s before retry`,
            );
            await Bun.sleep(currentDelay);
            currentDelay = Math.min(currentDelay * 2, maxDelay);
            continue;
          }
          throw error;
        }
      }
    }

    return this.loadVideos();
  }

  searchVideos(keywords: string[]): BiliVideo[] {
    if (keywords.length === 0) {
      return this.loadVideos();
    }

    const whereClause = keywords.map(() => "title LIKE ?").join(" OR ");
    const params = keywords.map((keyword) => `%${keyword}%`);
    const rows = this.conn
      .prepare(
        `
      SELECT bvid, title, length, upload_at
      FROM scboy_video
      WHERE ${whereClause}
      ORDER BY upload_at
    `,
      )
      .all(...params) as Record<string, unknown>[];

    return rows.map(BiliVideo.fromDbRow);
  }

  listVideos(dateInTitle?: DateInTitleFilter): BiliVideo[] {
    const dateRange = parseDateRange(dateInTitle);
    if (!dateRange) {
      return this.loadVideos();
    }

    const [startDate, endDate] = dateRange;
    const whereClauses: string[] = [];
    const params: string[] = [];

    for (
      const current = new Date(startDate);
      current.getTime() <= endDate.getTime();
      current.setDate(current.getDate() + 1)
    ) {
      const targetDate = new Date(current);
      const yearText = String(targetDate.getFullYear());
      const month = targetDate.getMonth() + 1;
      const day = targetDate.getDate();
      whereClauses.push(
        "(substr(upload_at, 1, 4) = ? AND (title LIKE ? OR title LIKE ?))",
      );
      params.push(yearText, `%${month}月${day}号%`, `%${month}月${day}日%`);
    }

    const rows = this.conn
      .prepare(
        `
      SELECT bvid, title, length, upload_at
      FROM scboy_video
      WHERE ${whereClauses.join(" OR ")}
      ORDER BY upload_at
    `,
      )
      .all(...params) as Record<string, unknown>[];

    return rows.map(BiliVideo.fromDbRow);
  }

  findVideoByUploadDate(dateInput: string): BiliVideo {
    const videos = this.listVideos(dateInput);
    if (videos.length === 0) {
      throw new Error(`Cannot find video by upload date: ${dateInput}`);
    }
    if (videos.length > 1) {
      throw new Error(
        `Expected exactly one video for upload date ${dateInput}, got ${videos.length}`,
      );
    }
    return videos[0];
  }

  async saveLatestVideos(client: Client, pages = 1): Promise<BiliVideo[]> {
    this.init();
    const videos = await this.fetchVideos(client, pages);
    console.log(
      `saved latest ${pages} pages, total videos in db: ${videos.length}`,
    );
    return videos;
  }
}

function isBiliRiskControlError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  return (error as { code?: number }).code === -352;
}

function isRateLimitError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return text.includes("Expecting value");
}

function parseDateValue(value: string): Date {
  const trimmed = value.trim();
  if (!isDateValue(trimmed)) {
    throw new Error(`Invalid date value: ${value}`);
  }
  const date = new Date(`${trimmed}T00:00:00`);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid date value: ${value}`);
  }
  return date;
}

function parseDateRange(dateInTitle?: DateInTitleFilter): [Date, Date] | null {
  if (dateInTitle == null) {
    return null;
  }

  const parts =
    typeof dateInTitle === "string"
      ? dateInTitle.split(/\s+/).filter(Boolean)
      : dateInTitle.map((part) => String(part).trim()).filter(Boolean);

  if (parts.length === 0) {
    return null;
  }
  if (parts.length === 1) {
    const date = parseDateValue(parts[0]);
    return [date, date];
  }
  if (parts.length === 2) {
    const startDate = parseDateValue(parts[0]);
    const endDate = parseDateValue(parts[1]);
    if (startDate.getTime() > endDate.getTime()) {
      throw new Error(
        `Invalid date range: start date ${parts[0]} is after end date ${parts[1]}`,
      );
    }
    return [startDate, endDate];
  }

  throw new Error(
    "dateInTitle must be a single date like '2026-02-02' or a range like '2026-02-02 2026-03-02'",
  );
}

export function isDateValue(value: string): boolean {
  return DATE_VALUE_PATTERN.test(value);
}

if (import.meta.main) {
  const client = buildBiliClient();
  const store = ScboyVideoStore.open();
  await store.saveLatestVideos(client);
}
