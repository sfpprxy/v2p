import { readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";

interface ProfileEvent {
  name: string;
  durationMs: number;
  runId?: string;
  status?: string;
  startTime?: string;
  endTime?: string;
  cacheHit?: boolean;
  bvid?: string;
  page?: number;
  title?: string;
  [key: string]: unknown;
}

interface SpanSummary {
  name: string;
  count: number;
  errors: number;
  totalMs: number;
  maxMs: number;
  durationsMs: number[];
  cacheHits: number;
  cacheMisses: number;
}

await main();

async function main(): Promise<void> {
  const profilePath = await resolveProfilePath(process.argv[2]);
  const events = await loadProfileEvents(profilePath);
  if (events.length === 0) {
    throw new Error(`Profile file contains no events: ${profilePath}`);
  }

  const summaries = summarizeEvents(events);
  const runIds = Array.from(
    new Set(events.map((event) => event.runId).filter((runId) => runId)),
  );
  const wallTimeMs = computeWallTimeMs(events);

  console.log(`Profile: ${profilePath}`);
  console.log(`Run: ${runIds.join(", ") || "(unknown)"}`);
  console.log(`Events: ${events.length}`);
  if (wallTimeMs !== null) {
    console.log(`Wall time: ${formatDuration(wallTimeMs)}`);
  }
  console.log("");

  printSummaryTable(summaries);
  console.log("");
  printCacheTable(summaries);
  console.log("");
  printSlowestEvents(events);
}

async function resolveProfilePath(inputPath: string | undefined): Promise<string> {
  const trimmedPath = inputPath?.trim();
  if (trimmedPath) {
    return resolve(trimmedPath);
  }

  const profileRoot = resolve(import.meta.dir, "output", "profiles");
  const entries = await readdir(profileRoot, { withFileTypes: true });
  const candidates: { path: string; mtimeMs: number }[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
      continue;
    }
    const path = resolve(profileRoot, entry.name);
    candidates.push({ path, mtimeMs: (await stat(path)).mtimeMs });
  }

  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  const latest = candidates[0];
  if (latest === undefined) {
    throw new Error(`No profile JSONL files found under ${profileRoot}`);
  }
  return latest.path;
}

async function loadProfileEvents(profilePath: string): Promise<ProfileEvent[]> {
  const text = await Bun.file(profilePath).text();
  const events: ProfileEvent[] = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim();
    if (!line) {
      continue;
    }

    const parsed = JSON.parse(line) as Record<string, unknown>;
    if (typeof parsed.name !== "string") {
      throw new Error(`Profile line ${index + 1} is missing name`);
    }
    if (typeof parsed.durationMs !== "number") {
      throw new Error(`Profile line ${index + 1} is missing durationMs`);
    }

    events.push(parsed as ProfileEvent);
  }
  return events;
}

function summarizeEvents(events: readonly ProfileEvent[]): SpanSummary[] {
  const summariesByName = new Map<string, SpanSummary>();
  for (const event of events) {
    let summary = summariesByName.get(event.name);
    if (summary === undefined) {
      summary = {
        name: event.name,
        count: 0,
        errors: 0,
        totalMs: 0,
        maxMs: 0,
        durationsMs: [],
        cacheHits: 0,
        cacheMisses: 0,
      };
      summariesByName.set(event.name, summary);
    }

    summary.count += 1;
    summary.totalMs += event.durationMs;
    summary.maxMs = Math.max(summary.maxMs, event.durationMs);
    summary.durationsMs.push(event.durationMs);
    if (event.status === "error") {
      summary.errors += 1;
    }
    if (event.cacheHit === true) {
      summary.cacheHits += 1;
    } else if (event.cacheHit === false) {
      summary.cacheMisses += 1;
    }
  }

  return Array.from(summariesByName.values()).sort(
    (left, right) => right.totalMs - left.totalMs,
  );
}

function computeWallTimeMs(events: readonly ProfileEvent[]): number | null {
  const startTimes = events
    .map((event) => readEventTimeMs(event.startTime))
    .filter((timeMs) => timeMs !== null);
  const endTimes = events
    .map((event) => readEventTimeMs(event.endTime))
    .filter((timeMs) => timeMs !== null);
  if (startTimes.length === 0 || endTimes.length === 0) {
    return null;
  }

  return Math.max(...endTimes) - Math.min(...startTimes);
}

function printSummaryTable(summaries: readonly SpanSummary[]): void {
  const rows = summaries.map((summary) => {
    const sortedDurations = summary.durationsMs.toSorted(
      (left, right) => left - right,
    );
    return [
      summary.name,
      String(summary.count),
      String(summary.errors),
      formatDuration(summary.totalMs),
      formatDuration(summary.totalMs / summary.count),
      formatDuration(percentile(sortedDurations, 0.5)),
      formatDuration(percentile(sortedDurations, 0.95)),
      formatDuration(summary.maxMs),
    ];
  });

  console.log("By span");
  console.log(
    formatTable(
      ["name", "count", "errors", "total", "avg", "p50", "p95", "max"],
      rows,
    ),
  );
}

function printCacheTable(summaries: readonly SpanSummary[]): void {
  const rows = summaries
    .filter((summary) => summary.cacheHits + summary.cacheMisses > 0)
    .map((summary) => {
      const total = summary.cacheHits + summary.cacheMisses;
      return [
        summary.name,
        String(summary.cacheHits),
        String(summary.cacheMisses),
        `${((summary.cacheHits / total) * 100).toFixed(1)}%`,
      ];
    });

  console.log("Cache");
  console.log(
    rows.length === 0
      ? "(no cacheHit fields)"
      : formatTable(["name", "hit", "miss", "hit rate"], rows),
  );
}

function printSlowestEvents(events: readonly ProfileEvent[]): void {
  const rows = events
    .toSorted((left, right) => right.durationMs - left.durationMs)
    .slice(0, 15)
    .map((event) => [
      event.name,
      formatDuration(event.durationMs),
      String(event.status ?? ""),
      describeEvent(event),
    ]);

  console.log("Slowest events");
  console.log(formatTable(["name", "duration", "status", "fields"], rows));
}

function readEventTimeMs(value: unknown): number | null {
  if (typeof value !== "string") {
    return null;
  }

  const timeMs = Date.parse(value);
  return Number.isFinite(timeMs) ? timeMs : null;
}

function percentile(sortedValues: readonly number[], ratio: number): number {
  if (sortedValues.length === 0) {
    return 0;
  }

  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil(sortedValues.length * ratio) - 1),
  );
  return sortedValues[index] ?? 0;
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1000) {
    return `${durationMs.toFixed(1)}ms`;
  }
  if (durationMs < 60_000) {
    return `${(durationMs / 1000).toFixed(2)}s`;
  }

  const minutes = Math.floor(durationMs / 60_000);
  const seconds = (durationMs % 60_000) / 1000;
  return `${minutes}m${seconds.toFixed(1).padStart(4, "0")}s`;
}

function formatTable(headers: readonly string[], rows: readonly string[][]): string {
  const allRows = [headers, ...rows];
  const widths = headers.map((_, columnIndex) =>
    Math.max(...allRows.map((row) => row[columnIndex]?.length ?? 0)),
  );
  const formattedRows = allRows.map((row) =>
    row
      .map((cell, columnIndex) => cell.padEnd(widths[columnIndex] ?? 0))
      .join("  ")
      .trimEnd(),
  );
  return formattedRows.join("\n");
}

function describeEvent(event: ProfileEvent): string {
  const fields = [
    "bvid",
    "page",
    "title",
    "cacheHit",
    "segmentCount",
    "rangeCount",
    "inputCount",
  ];
  return fields
    .flatMap((field) => {
      const value = event[field];
      if (
        value === undefined ||
        value === null ||
        (typeof value === "string" && value.trim() === "")
      ) {
        return [];
      }
      return [`${field}=${formatFieldValue(value)}`];
    })
    .join(" ");
}

function formatFieldValue(value: unknown): string {
  const text = String(value).replace(/\s+/gu, " ").trim();
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}
