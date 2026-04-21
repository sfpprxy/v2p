import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export type ProfileFieldValue = string | number | boolean | null;
export type ProfileFields = Record<string, ProfileFieldValue | undefined>;
export type ProfileFieldMap = Record<string, ProfileFieldValue>;
export type ProfileEventStatus = "ok" | "error";

export interface ProfileSpan {
  set(fields: ProfileFields): void;
}

interface ProfileEventBase {
  runId: string;
  name: string;
  status: ProfileEventStatus;
  startTime: string;
  endTime: string;
  durationMs: number;
  fields: ProfileFieldMap;
}

export interface ProfileEventOk extends ProfileEventBase {
  status: "ok";
}

export interface ProfileEventError extends ProfileEventBase {
  status: "error";
  error: string;
}

export type ProfileEvent = ProfileEventOk | ProfileEventError;

const PROFILE_ENABLED_VALUES = new Set(["1", "true", "yes", "on"]);
const PROFILE_RUN_ID =
  process.env.V2P_PROFILE_RUN_ID?.trim() ||
  new Date().toISOString().replace(/[.:]/gu, "-");
const PROFILE_OUTPUT_PATH = resolve(
  process.env.V2P_PROFILE_PATH?.trim() ||
    resolve(import.meta.dir, "output", "profiles", `${PROFILE_RUN_ID}.jsonl`),
);

let profileWriteQueue: Promise<void> = Promise.resolve();

export function getProfileOutputPath(): string | null {
  return isProfileEnabled() ? PROFILE_OUTPUT_PATH : null;
}

export async function profileSpan<T>(
  name: string,
  fields: ProfileFields,
  run: (span: ProfileSpan) => Promise<T>,
): Promise<T> {
  if (!isProfileEnabled()) {
    return run(disabledProfileSpan);
  }

  const startTime = new Date();
  const startMs = performance.now();
  const spanFields: ProfileFields = { ...fields };
  const span: ProfileSpan = {
    set(nextFields) {
      Object.assign(spanFields, nextFields);
    },
  };

  try {
    const result = await run(span);
    await writeProfileEvent(name, "ok", startTime, startMs, spanFields);
    return result;
  } catch (error) {
    await writeProfileEvent(name, "error", startTime, startMs, {
      ...spanFields,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

function isProfileEnabled(): boolean {
  return PROFILE_ENABLED_VALUES.has(
    (process.env.V2P_PROFILE?.trim() ?? "").toLowerCase(),
  );
}

const disabledProfileSpan: ProfileSpan = {
  set() {},
};

async function writeProfileEvent(
  name: string,
  status: ProfileEventStatus,
  startTime: Date,
  startMs: number,
  fields: ProfileFields,
): Promise<void> {
  const endTime = new Date();
  const baseEvent = {
    runId: PROFILE_RUN_ID,
    name,
    startTime: startTime.toISOString(),
    endTime: endTime.toISOString(),
    durationMs: Number((performance.now() - startMs).toFixed(3)),
    fields: cleanProfileFields(fields),
  };
  const event =
    status === "ok"
      ? ({
          ...baseEvent,
          status: "ok",
        } satisfies ProfileEventOk)
      : ({
          ...baseEvent,
          status: "error",
          error: String(fields.error),
        } satisfies ProfileEventError);
  const line = `${JSON.stringify(event)}\n`;

  profileWriteQueue = profileWriteQueue
    .catch(() => {})
    .then(async () => {
      await mkdir(dirname(PROFILE_OUTPUT_PATH), { recursive: true });
      await appendFile(PROFILE_OUTPUT_PATH, line);
    })
    .catch((error) => {
      console.warn(
        `[profile:write-error] ${error instanceof Error ? error.message : String(error)}`,
      );
    });

  await profileWriteQueue;
}

function cleanProfileFields(fields: ProfileFields): ProfileFieldMap {
  const cleanedFields: ProfileFieldMap = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      cleanedFields[key] = value;
    }
  }
  return cleanedFields;
}
