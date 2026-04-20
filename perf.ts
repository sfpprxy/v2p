import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export type ProfileFieldValue = string | number | boolean | null;
export type ProfileFields = Record<string, ProfileFieldValue | undefined>;

export interface ProfileSpan {
  set(fields: ProfileFields): void;
}

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
  status: "ok" | "error",
  startTime: Date,
  startMs: number,
  fields: ProfileFields,
): Promise<void> {
  const endTime = new Date();
  const event = {
    runId: PROFILE_RUN_ID,
    name,
    status,
    startTime: startTime.toISOString(),
    endTime: endTime.toISOString(),
    durationMs: Number((performance.now() - startMs).toFixed(3)),
    ...cleanProfileFields(fields),
  };
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

function cleanProfileFields(fields: ProfileFields): Record<string, ProfileFieldValue> {
  const cleanedFields: Record<string, ProfileFieldValue> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      cleanedFields[key] = value;
    }
  }
  return cleanedFields;
}
