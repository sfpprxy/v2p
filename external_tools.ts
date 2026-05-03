import { $ } from "bun";

export async function ensureExternalToolsAvailable(
  toolNames: readonly string[],
): Promise<void> {
  const missingTools: string[] = [];

  for (const toolName of toolNames) {
    const result =
      process.platform === "win32"
        ? await $`where.exe ${toolName}`.nothrow().quiet()
        : await $`which ${toolName}`.nothrow().quiet();
    if (result.exitCode !== 0) {
      missingTools.push(toolName);
    }
  }

  if (missingTools.length === 0) {
    return;
  }

  throw new Error(
    `Missing required external tool${missingTools.length === 1 ? "" : "s"}: ${missingTools.join(", ")}`,
  );
}

export function buildExternalCommandErrorMessage(
  toolName: string,
  error: unknown,
): string {
  const stderr =
    error instanceof Error && "stderr" in error && typeof error.stderr === "string"
      ? error.stderr.trim()
      : "";
  const stdout =
    error instanceof Error && "stdout" in error && typeof error.stdout === "string"
      ? error.stdout.trim()
      : "";
  const message = error instanceof Error ? error.message.trim() : String(error).trim();

  return stderr || stdout || message || `${toolName} command failed`;
}
