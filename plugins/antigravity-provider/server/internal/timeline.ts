import type {
  ProviderPersistence,
  ProviderTimelineItem,
  ProviderToolCallDetail,
} from "@getpaseo/plugin/server/provider";

type JsonValue = ProviderPersistence["data"];

const COMMAND_EXIT_CODE = /(?:^|\n)Command exited with code (-?\d+)\./;
const CREATED_SUBAGENT_JSON = /Created the following subagent:\r?\n(\{[\s\S]*?\r?\n\})/;

export interface HistoryToolInput {
  id: string;
  name: string;
  parameters: Record<string, JsonValue>;
  output: string;
  resultStatus: string | null;
  errorText: string | null;
}

export function historyToolItem(
  input: HistoryToolInput,
): Extract<ProviderTimelineItem, { type: "tool_call" }> {
  const { id, name, parameters, output, resultStatus, errorText } = input;
  const detail = parametersToolDetail(name, parameters, output, errorText);
  const base = { type: "tool_call" as const, id, callId: id, name, detail };

  if (resultStatus === null || resultStatus === "RUNNING") {
    return { ...base, status: "canceled", error: null };
  }
  if (resultStatus === "ERROR" || resultStatus === "INVALID") {
    return {
      ...base,
      status: "failed",
      error: errorText || output || "Antigravity tool failed",
    };
  }
  if (detail.type === "shell" && typeof detail.exitCode === "number" && detail.exitCode !== 0) {
    return {
      ...base,
      status: "failed",
      error: `Command exited with code ${detail.exitCode}`,
    };
  }
  return { ...base, status: "completed", error: null };
}

function parametersToolDetail(
  name: string,
  parameters: Record<string, JsonValue>,
  output: string,
  errorMessage: string | null,
): ProviderToolCallDetail {
  return (
    shellToolDetail(name, parameters, output) ??
    fileToolDetail(name, parameters, output) ??
    searchOrSubagentDetail(name, parameters, output) ?? {
      type: "unknown",
      input: parameters,
      output: errorMessage || output,
    }
  );
}

function shellToolDetail(
  name: string,
  parameters: Record<string, JsonValue>,
  output: string,
): ProviderToolCallDetail | null {
  if ((name !== "run_command" && name !== "bash") || typeof parameters.CommandLine !== "string") {
    return null;
  }
  const cwd = readString(parameters.Cwd);
  const exitMatch = COMMAND_EXIT_CODE.exec(output);
  const exitCode = exitMatch ? Number(exitMatch[1]) : undefined;
  return {
    type: "shell",
    command: parameters.CommandLine,
    ...(cwd ? { cwd } : {}),
    output,
    ...(exitCode !== undefined && Number.isFinite(exitCode) ? { exitCode } : {}),
  };
}

function fileToolDetail(
  name: string,
  parameters: Record<string, JsonValue>,
  output: string,
): ProviderToolCallDetail | null {
  const filePath =
    readString(parameters.AbsolutePath) ??
    readString(parameters.TargetFile) ??
    readString(parameters.Path);
  if (filePath === undefined) return null;

  if (name === "view_file" || name === "read_file") {
    return buildReadDetail(filePath, parameters, output);
  }
  if (name === "write_to_file" || name === "write_file") {
    const content = readString(parameters.Content);
    return { type: "write", filePath, ...(content !== undefined ? { content } : {}) };
  }
  if (
    name === "replace_file_content" ||
    name === "multi_replace_file_content" ||
    name === "edit_file"
  ) {
    return buildEditDetail(filePath, parameters);
  }
  return null;
}

function buildReadDetail(
  filePath: string,
  parameters: Record<string, JsonValue>,
  output: string,
): ProviderToolCallDetail {
  const startLine = readPositiveInt(parameters.StartLine);
  const endLine = readPositiveInt(parameters.EndLine);
  const limit =
    startLine !== undefined && endLine !== undefined && endLine >= startLine
      ? endLine - startLine + 1
      : undefined;
  return {
    type: "read",
    filePath,
    content: output,
    ...(startLine !== undefined ? { offset: startLine } : {}),
    ...(limit !== undefined ? { limit } : {}),
  };
}

function buildEditDetail(
  filePath: string,
  parameters: Record<string, JsonValue>,
): ProviderToolCallDetail {
  const oldString = readString(parameters.Target);
  const newString = readString(parameters.Replacement);
  return {
    type: "edit",
    filePath,
    ...(oldString !== undefined ? { oldString } : {}),
    ...(newString !== undefined ? { newString } : {}),
  };
}

function searchOrSubagentDetail(
  name: string,
  parameters: Record<string, JsonValue>,
  output: string,
): ProviderToolCallDetail | null {
  if (name === "search_web" && typeof parameters.query === "string") {
    return {
      type: "search",
      query: parameters.query,
      toolName: "web_search",
      ...(output ? { content: output } : {}),
    };
  }
  if (name === "invoke_subagent") {
    const subAgentType = readString(parameters.TypeName);
    const description = readString(parameters.Prompt) ?? readString(parameters.Role);
    const parsedSubagent = parseCreatedSubagentOutput(output);
    return {
      type: "sub_agent",
      ...(subAgentType ? { subAgentType } : {}),
      ...(description ? { description } : {}),
      ...(parsedSubagent.childSessionId ? { childSessionId: parsedSubagent.childSessionId } : {}),
      log: parsedSubagent.log ?? "",
    };
  }
  return null;
}

function readString(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readPositiveInt(value: JsonValue | undefined): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : undefined;
}

function parseCreatedSubagentOutput(output: string): {
  childSessionId?: string;
  log?: string;
} {
  const match = CREATED_SUBAGENT_JSON.exec(output);
  if (!match) return {};
  try {
    const parsed: unknown = JSON.parse(match[1]);
    if (typeof parsed !== "object" || parsed === null) return {};
    const record = parsed as Record<string, unknown>;
    return {
      childSessionId:
        typeof record.conversationId === "string" && record.conversationId.length > 0
          ? record.conversationId
          : undefined,
      log: typeof record.logAbsoluteUri === "string" ? record.logAbsoluteUri : undefined,
    };
  } catch {
    return {};
  }
}
