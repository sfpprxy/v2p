import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EmbedContentResponse,
  GoogleGenAI,
  ThinkingLevel,
} from "@google/genai";
import OpenAI from "openai";
import { profileSpan } from "./perf.js";

let googleClient: GoogleGenAI | null = null;
let openAIClient: OpenAI | null = null;

export type GoogleThinkingLevel = "MINIMAL" | "LOW" | "MEDIUM" | "HIGH";

export const DEFAULT_GEMINI_MODEL = "gemini-3-flash-preview";
export const DEFAULT_CODEX_MODEL = "gpt-5.4";
export const DEFAULT_OPENAI_MODEL = "gpt-5.4-openai";
type LlmGenerator = (model: string, contents: string) => Promise<string>;

export const LLM_MODEL_GENERATOR_MAP: Readonly<Record<string, LlmGenerator>> = {
  [DEFAULT_GEMINI_MODEL]: genGoogle,
  "gemini-3-pro-preview": genGoogle,
  "gemini-3-pro-image-preview": genGoogle,
  "gemini-2.5-pro": genGoogle,
  "gemini-2.5-flash": genGoogle,
  "gemini-2.5-flash-image": genGoogle,
  "gemini-embedding-001": genGoogle,
  [DEFAULT_CODEX_MODEL]: genCodex,
  "gpt-5.2": genCodex,
  [DEFAULT_OPENAI_MODEL]: genOpenAI,
  "gpt-5.2-openai": genOpenAI,
};

export async function gen(
  model: string | undefined,
  contents: string,
): Promise<string> {
  const resolvedModel = model?.trim() || DEFAULT_GEMINI_MODEL;
  if (resolvedModel === "") {
    throw new Error("LLM model must not be empty");
  }
  const generator = LLM_MODEL_GENERATOR_MAP[resolvedModel];
  if (generator === undefined) {
    throw new Error(
      `Unsupported LLM model: ${resolvedModel}. Add it to LLM_MODEL_GENERATOR_MAP before use.`,
    );
  }

  return profileSpan(
    "llm.gen",
    { model: resolvedModel, backend: generator.name || "anonymous" },
    async () => generator(resolvedModel, contents),
  );
}

export async function genGoogle(
  model: string,
  contents: string,
  thinkingLevel?: GoogleThinkingLevel,
): Promise<string> {
  try {
    const response = await getGoogleClient().models.generateContent({
      model,
      contents,
      config:
        thinkingLevel === undefined
          ? undefined
          : {
              thinkingConfig: {
                thinkingLevel: normalizeThinkingLevel(thinkingLevel),
              },
            },
    });

    return nonEmpty(response.text, `Empty Gemini response for model ${model}`);
  } catch (error) {
    throw new Error(`Gemini backend failed: ${getErrorMessage(error)}`);
  }
}

export async function embedGoogle(
  model: string,
  contents: string,
): Promise<EmbedContentResponse> {
  return getGoogleClient().models.embedContent({
    model,
    contents,
  });
}

async function genOpenAI(model: string, contents: string): Promise<string> {
  const openAIApiKey = nonEmpty(
    process.env.OPENAI_API_KEY?.trim(),
    "OPENAI_API_KEY is required for OpenAI requests",
  );
  if (openAIClient === null) {
    openAIClient = new OpenAI({ apiKey: openAIApiKey });
  }
  const openAIModel = model.endsWith("-openai")
    ? model.slice(0, -"-openai".length)
    : model;

  try {
    const response = await openAIClient.responses.create({
      model: openAIModel,
      input: contents,
    });

    return nonEmpty(
      response.output_text,
      `Empty OpenAI response for model ${openAIModel}`,
    );
  } catch (error) {
    throw new Error(`OpenAI backend failed: ${getErrorMessage(error)}`);
  }
}

async function genCodex(model: string, contents: string): Promise<string> {
  const tempDir = await mkdtemp(join(tmpdir(), "v2p-codex-exec-"));
  const outputPath = join(tempDir, "last-message.txt");
  const processHandle = Bun.spawn(
    [
      "codex",
      "exec",
      "--ephemeral",
      "--sandbox",
      "read-only",
      "--model",
      model,
      "--cd",
      process.cwd(),
      "--color",
      "never",
      "--output-last-message",
      outputPath,
      "-",
    ],
    {
      cwd: process.cwd(),
      stdin: new TextEncoder().encode(
        `Answer directly from the provided prompt. Do not use tools or inspect the workspace unless the prompt explicitly requires it.\n\n${contents}`,
      ),
      stderr: "pipe",
      stdout: "pipe",
    },
  );

  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      processHandle.exited,
      processHandle.stdout === null
        ? Promise.resolve("")
        : new Response(processHandle.stdout).text(),
      processHandle.stderr === null
        ? Promise.resolve("")
        : new Response(processHandle.stderr).text(),
    ]);
    if (exitCode !== 0) {
      throw new Error(
        nonEmpty(
          stderr.trim() || stdout.trim(),
          `Codex App Server response failed for model ${model}`,
        ),
      );
    }

    return nonEmpty(
      await Bun.file(outputPath).text(),
      `Empty Codex App Server response for model ${model}`,
    );
  } catch (error) {
    throw new Error(buildCodexAppServerErrorMessage(error));
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
}

function nonEmpty(value: string | null | undefined, message: string): string {
  const text = value?.trim();
  if (!text) {
    throw new Error(message);
  }
  return text;
}

function getGeminiApiKey(): string {
  return nonEmpty(
    process.env.GEMINI_API_KEY,
    "GEMINI_API_KEY is required for Gemini requests",
  );
}

function getGoogleClient(): GoogleGenAI {
  if (googleClient === null) {
    googleClient = new GoogleGenAI({ apiKey: getGeminiApiKey() });
  }
  return googleClient;
}

function normalizeThinkingLevel(
  thinkingLevel: GoogleThinkingLevel,
): ThinkingLevel {
  switch (thinkingLevel.toUpperCase() as GoogleThinkingLevel) {
    case "MINIMAL":
      return ThinkingLevel.MINIMAL;
    case "LOW":
      return ThinkingLevel.LOW;
    case "MEDIUM":
      return ThinkingLevel.MEDIUM;
    case "HIGH":
      return ThinkingLevel.HIGH;
  }
}

function buildCodexAppServerErrorMessage(error: unknown): string {
  const message = getErrorMessage(error);
  const normalizedMessage = message.toLowerCase();

  if (
    normalizedMessage.includes("enoent") &&
    normalizedMessage.includes("codex")
  ) {
    return `Codex App Server backend is unavailable: cannot find the \`codex\` runtime in PATH. Install Codex CLI or make the Codex app runtime available. Original error: ${message}`;
  }
  if (
    normalizedMessage.includes("not authenticated") ||
    normalizedMessage.includes("login") ||
    normalizedMessage.includes("api key") ||
    normalizedMessage.includes("auth")
  ) {
    return `Codex App Server backend is unavailable: Codex authentication is not configured. Sign in with the Codex app or CLI, or provide an API key. Original error: ${message}`;
  }

  return `Codex App Server backend failed: ${message}`;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
