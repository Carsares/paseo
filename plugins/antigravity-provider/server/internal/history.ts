import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  ProviderLaunch,
  ProviderPersistence,
  ProviderSessionConfig,
  ProviderTimelineItem,
} from "@getpaseo/plugin/server/provider";
import { historyToolItem } from "./timeline.js";

type JsonValue = ProviderPersistence["data"];

export interface HistoryEntry {
  item: ProviderTimelineItem;
  timestamp?: string;
}

interface ReadHistoryOptions {
  conversationId: string;
  launch?: ProviderLaunch;
  config: ProviderSessionConfig;
}

interface TranscriptToolCall {
  name?: unknown;
  args?: unknown;
}

interface TranscriptStep {
  step_index?: unknown;
  source?: unknown;
  type?: unknown;
  status?: unknown;
  created_at?: unknown;
  content?: unknown;
  thinking?: unknown;
  error?: unknown;
  tool_calls?: unknown;
}

const USER_REQUEST_ENVELOPE =
  /^<USER_REQUEST>\r?\n([\s\S]*)\r?\n<\/USER_REQUEST>(?:\r?\n<(?:ADDITIONAL_METADATA|USER_SETTINGS_CHANGE)>[\s\S]*)?\s*$/;
const TEMP_IMAGE_LINE = /^Attached image: .*[\\/]paseo-antigravity-images-[^\\/]+[\\/][^\r\n]+$/;
const STEP_TIMESTAMP_HEADERS = /^(?:(?:Created|Completed) At: [^\r\n]+\r?\n)+/;

export async function readHistory(options: ReadHistoryOptions): Promise<HistoryEntry[]> {
  if (!isSafeConversationId(options.conversationId)) return [];

  const logsDir = resolveTranscriptLogsDir(options.launch, options.config, options.conversationId);
  const loaded = await readTranscriptFile(logsDir);
  if (!loaded) return [];

  const steps = parseTranscriptSteps(loaded.raw);
  const entries: HistoryEntry[] = [];
  let firstUserMessage = true;

  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    const stepId = resolveStepId(step, i);
    const timestamp = validTimestamp(step.created_at);

    if (step.source === "USER_EXPLICIT" && step.type === "USER_INPUT") {
      const systemPrompt = firstUserMessage ? options.config.systemPrompt : undefined;
      if (typeof step.content === "string") {
        firstUserMessage = false;
        appendUserEntry(entries, step.content, stepId, timestamp, systemPrompt);
      }
      continue;
    }

    if (step.source === "MODEL" && step.type === "PLANNER_RESPONSE") {
      i = appendModelResponseEntries({
        entries,
        steps,
        index: i,
        stepId,
        timestamp,
        compact: loaded.compact,
      });
    }
  }

  return entries;
}

function isSafeConversationId(conversationId: string): boolean {
  return (
    conversationId.length > 0 &&
    !/[\\/:]/.test(conversationId) &&
    !conversationId.includes("\0") &&
    conversationId !== "." &&
    conversationId !== ".."
  );
}

function resolveStepId(step: TranscriptStep, fallbackIndex: number): string {
  return typeof step.step_index === "number" && Number.isFinite(step.step_index)
    ? String(step.step_index)
    : String(fallbackIndex);
}

function appendUserEntry(
  entries: HistoryEntry[],
  content: string,
  stepId: string,
  timestamp: string | undefined,
  systemPrompt: string | undefined,
): void {
  const text = extractUserMessageText(content, systemPrompt);
  if (text.length === 0) return;
  entries.push({
    item: {
      type: "user_message",
      id: `history:user:${stepId}`,
      messageId: `history:user:${stepId}`,
      text,
    },
    timestamp,
  });
}

function appendModelResponseEntries(input: {
  entries: HistoryEntry[];
  steps: readonly TranscriptStep[];
  index: number;
  stepId: string;
  timestamp: string | undefined;
  compact: boolean;
}): number {
  const { entries, steps, stepId, timestamp, compact } = input;
  const step = steps[input.index];

  if (typeof step.thinking === "string" && step.thinking.trim().length > 0) {
    entries.push({
      item: {
        type: "reasoning",
        id: `history:reasoning:${stepId}`,
        text: step.thinking.trim(),
      },
      timestamp,
    });
  }

  if (typeof step.content === "string" && step.content.length > 0) {
    entries.push({
      item: {
        type: "assistant_message",
        id: `history:assistant:${stepId}`,
        messageId: `history:assistant:${stepId}`,
        text: step.content,
      },
      timestamp,
    });
  }

  if (!Array.isArray(step.tool_calls) || step.tool_calls.length === 0) {
    return input.index;
  }

  const calls = step.tool_calls as TranscriptToolCall[];
  const { results, nextIndex } = collectGenericResults(steps, input.index, calls.length);
  for (let k = 0; k < calls.length; k += 1) {
    entries.push(buildHistoryToolEntry(calls[k], results[k], `${stepId}:${k}`, timestamp, compact));
  }
  return nextIndex;
}

function collectGenericResults(
  steps: readonly TranscriptStep[],
  startIndex: number,
  maxCount: number,
): { results: TranscriptStep[]; nextIndex: number } {
  const results: TranscriptStep[] = [];
  let cursor = startIndex;
  while (
    cursor + 1 < steps.length &&
    results.length < maxCount &&
    steps[cursor + 1].source === "MODEL" &&
    steps[cursor + 1].type === "GENERIC"
  ) {
    cursor += 1;
    results.push(steps[cursor]);
  }
  return { results, nextIndex: cursor };
}

function buildHistoryToolEntry(
  call: TranscriptToolCall | undefined,
  result: TranscriptStep | undefined,
  suffix: string,
  fallbackTimestamp: string | undefined,
  compact: boolean,
): HistoryEntry {
  const name =
    typeof call?.name === "string" && call.name.length > 0 ? call.name : "Antigravity tool";
  const parameters = normalizeToolArgs(call?.args, compact);
  const output = typeof result?.content === "string" ? stripStepTimestamps(result.content) : "";
  const errorText =
    typeof result?.error === "string" && result.error.length > 0 ? result.error : null;
  const resultStatus = typeof result?.status === "string" ? result.status : null;

  return {
    item: historyToolItem({
      id: `history:tool:${suffix}`,
      name,
      parameters,
      output,
      resultStatus,
      errorText,
    }),
    timestamp: validTimestamp(result?.created_at) ?? fallbackTimestamp,
  };
}

function resolveTranscriptLogsDir(
  launch: ProviderLaunch | undefined,
  config: ProviderSessionConfig,
  conversationId: string,
): string {
  const env = { ...(launch?.env ?? process.env), ...config.env };
  const args = launch?.args ?? [];
  const homeDir = env.HOME || env.USERPROFILE || os.homedir();
  const geminiFlag = readFlagValue(args, ["--gemini-dir", "--gemini_dir"]) ?? ".gemini";
  const geminiDir = path.resolve(homeDir, geminiFlag);
  const appDataFlag =
    readFlagValue(args, ["--app-data-dir", "--app_data_dir"]) ?? "antigravity-cli";
  const appDataDir = path.resolve(geminiDir, appDataFlag);
  return path.join(appDataDir, "brain", conversationId, ".system_generated", "logs");
}

function readFlagValue(args: readonly string[], names: readonly string[]): string | undefined {
  let found: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (names.includes(arg) && i + 1 < args.length) {
      found = args[i + 1];
      i += 1;
      continue;
    }
    const inline = names.find((name) => arg.startsWith(`${name}=`));
    if (inline) {
      found = arg.slice(inline.length + 1);
    }
  }
  return found;
}

async function readTranscriptFile(
  logsDir: string,
): Promise<{ raw: string; compact: boolean } | null> {
  try {
    return {
      raw: await readFile(path.join(logsDir, "transcript_full.jsonl"), "utf8"),
      compact: false,
    };
  } catch (error) {
    if (!isMissingFileError(error)) return null;
  }

  try {
    return {
      raw: await readFile(path.join(logsDir, "transcript.jsonl"), "utf8"),
      compact: true,
    };
  } catch {
    return null;
  }
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

function parseTranscriptSteps(raw: string): TranscriptStep[] {
  const steps: TranscriptStep[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        steps.push(parsed as TranscriptStep);
      }
    } catch {
      // Ignore malformed or mid-write trailing JSONL lines.
    }
  }
  return steps;
}

function extractUserMessageText(rawContent: string, systemPrompt: string | undefined): string {
  const match = USER_REQUEST_ENVELOPE.exec(rawContent);
  let text = match ? match[1] : rawContent;
  if (systemPrompt && text.startsWith(`${systemPrompt}\n\n`)) {
    text = text.slice(systemPrompt.length + 2);
  }

  const lines = text.split(/\r?\n/);
  let strippedAttachments = false;
  const keptLines = lines.filter((line) => {
    if (TEMP_IMAGE_LINE.test(line)) {
      strippedAttachments = true;
      return false;
    }
    return true;
  });

  if (!strippedAttachments) return text;
  const joined = keptLines.join("\n");
  return joined.trim().length > 0 ? joined : "[Attached image]";
}

function stripStepTimestamps(content: string): string {
  return content.replace(STEP_TIMESTAMP_HEADERS, "");
}

function validTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return Number.isFinite(Date.parse(value)) ? value : undefined;
}

function normalizeToolArgs(raw: unknown, decodeCompactStrings: boolean): Record<string, JsonValue> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(raw).flatMap(([key, value]) => {
      const decoded = decodeCompactStrings ? decodeCompactArgValue(value) : value;
      const json = toSafeJsonValue(decoded);
      return json === undefined ? [] : [[key, json]];
    }),
  );
}

function decodeCompactArgValue(value: unknown): unknown {
  if (typeof value !== "string" || !looksLikeEncodedJsonValue(value.trim())) {
    return value;
  }
  try {
    return JSON.parse(value.trim());
  } catch {
    return value;
  }
}

function looksLikeEncodedJsonValue(trimmed: string): boolean {
  if (trimmed === "true" || trimmed === "false" || /^-?\d+(?:\.\d+)?$/.test(trimmed)) {
    return true;
  }
  return (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  );
}

function toSafeJsonValue(value: unknown): JsonValue | undefined {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => toSafeJsonValue(entry) ?? null);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).flatMap(([key, entry]) => {
        const json = toSafeJsonValue(entry);
        return json === undefined ? [] : [[key, json]];
      }),
    );
  }
  return undefined;
}
