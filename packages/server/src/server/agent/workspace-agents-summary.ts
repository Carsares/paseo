import {
  getParentAgentIdFromLabels,
  getParentAddressFromLabels,
  hasOpenAgentTab,
  isMainControlAgentLabels,
} from "@getpaseo/protocol/agent-labels";
import type { AgentAttachment, WorkspaceAgentSummaryEntry } from "@getpaseo/protocol/messages";
import type { Logger } from "pino";
import type { AgentManager, ManagedAgent } from "./agent-manager.js";
import type { AgentStorage, StoredAgentRecord } from "./agent-storage.js";
import type { AgentTimelineItem } from "./agent-sdk-types.js";
import type { WorkspaceRegistry } from "../workspace-registry.js";

type SummaryDetails = Pick<
  WorkspaceAgentSummaryEntry,
  "firstUserPrompt" | "lastAssistantSummary" | "todos" | "touchedFiles"
>;

function excerpt(text: string, limit: number): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  return trimmed.length <= limit ? trimmed : trimmed.slice(0, limit - 1) + "…";
}

function modifiedPaths(item: Extract<AgentTimelineItem, { type: "tool_call" }>): string[] {
  if (item.status !== "completed") return [];
  if (item.detail.type === "edit" || item.detail.type === "write") {
    return [item.detail.filePath];
  }
  if (item.detail.type !== "unknown") return [];
  const name = item.name
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/__|[./:]+/)
    .at(-1);
  if (
    !/^(?:(?:multi_|notebook_)?edit|(?:file_|filesystem_|fs_)?(?:write|edit|patch)|(?:edit|write|patch|create|delete|remove|move|rename)_file|write_to_file|replace_file_content|str_replace_editor|apply_patch|(?:codex_)?file_change)$/.test(
      name ?? "",
    )
  ) {
    return [];
  }
  const input = item.detail.input;
  if (!input || typeof input !== "object") return [];
  return Object.entries(input).flatMap(([key, value]) =>
    /^(?:file_?paths?|paths?|(?:old|new|source|destination)_?path)$/i.test(key)
      ? (Array.isArray(value) ? value : [value]).filter(
          (path): path is string => typeof path === "string",
        )
      : [],
  );
}

function summarizeTimeline(
  items: AgentTimelineItem[],
  parentId: string | null,
  parentServerId: string | undefined,
): SummaryDetails {
  let firstUserPrompt: string | null = null;
  let lastAssistantSummary: string | null = null;
  let todos: WorkspaceAgentSummaryEntry["todos"] = [];
  const touchedFiles = new Set<string>();
  for (const item of items) {
    switch (item.type) {
      case "user_message":
        firstUserPrompt ??= excerpt(item.text, 300);
        break;
      case "assistant_message":
        lastAssistantSummary = excerpt(item.text, 600) ?? lastAssistantSummary;
        break;
      case "todo":
        todos = item.items.slice(0, 20).map(({ text, completed }) => ({
          text: excerpt(text, 300) ?? "",
          completed,
        }));
        break;
      case "tool_call":
        if (
          parentId &&
          item.agentMessage?.event === "message" &&
          item.agentMessage.sender.id === parentId &&
          (!parentServerId || item.agentMessage.sender.serverId === parentServerId)
        ) {
          firstUserPrompt ??= excerpt(item.agentMessage.text, 300);
        }
        for (const path of modifiedPaths(item)) {
          if (touchedFiles.size >= 30) break;
          if (path.trim()) touchedFiles.add(path);
        }
    }
  }
  return { firstUserPrompt, lastAssistantSummary, todos, touchedFiles: [...touchedFiles] };
}

function buildSummaryText(entries: WorkspaceAgentSummaryEntry[]): string {
  const lines: string[] = [];
  for (const group of ["active", "closed"] as const) {
    lines.push(group === "active" ? "## Active Sessions" : "## Closed Sessions", "");
    const sessions = entries.filter((entry) => entry.stateGroup === group);
    if (!sessions.length) lines.push("None.", "");
    for (const entry of sessions) {
      const relationship =
        entry.relationship === "standalone" && entry.parentAgentId
          ? `outside Main Control tree (parent: ${entry.parentAgentId})`
          : entry.relationship;
      lines.push(
        `### ${entry.title ?? "Untitled session"}`,
        `- ID: ${entry.agentId}`,
        `- Relationship: ${relationship}`,
        `- Status: ${entry.status}${entry.archivedAt ? " (archived)" : ""}`,
        `- First prompt: ${entry.firstUserPrompt ?? "Unavailable"}`,
        `- Latest conclusion: ${entry.lastAssistantSummary ?? "Unavailable"}`,
        "- Todos:",
        ...(entry.todos.length
          ? entry.todos.map(({ text, completed }) => `  - [${completed ? "x" : " "}] ${text}`)
          : ["  - None recorded."]),
        "- Touched files:",
        ...(entry.touchedFiles.length
          ? entry.touchedFiles.map((path) => `  - ${path}`)
          : ["  - None recorded."]),
        "",
      );
    }
  }
  return lines.join("\n").trimEnd();
}

interface SummaryAgent {
  id: string;
  live?: ManagedAgent;
  record?: StoredAgentRecord;
}
type SummaryMetadata = Omit<WorkspaceAgentSummaryEntry, keyof SummaryDetails>;

function relationshipToMain(
  agentId: string,
  parent: string | null,
  main: string | undefined,
  parentByAgentId: ReadonlyMap<string, string | null>,
): SummaryMetadata["relationship"] {
  if (!main || !parent) return "standalone";
  const visited = new Set([agentId]);
  for (let ancestor: string | null = parent; ancestor && !visited.has(ancestor); ) {
    if (ancestor === main) return ancestor === parent ? "level1" : "level2";
    visited.add(ancestor);
    ancestor = parentByAgentId.get(ancestor) ?? null;
  }
  return "standalone";
}

function isActive(status: SummaryMetadata["status"], labels: Record<string, string>): boolean {
  return status === "running" || status === "initializing" || hasOpenAgentTab(labels);
}

function getSummaryModel({ live, record }: SummaryAgent): string | null {
  return (
    live?.runtimeInfo?.model ??
    record?.runtimeInfo?.model ??
    (live ?? record)?.config?.model ??
    null
  );
}

function summarizeAgentMetadata(
  entry: SummaryAgent,
  mainAgentId: string | undefined,
  parentByAgentId: ReadonlyMap<string, string | null>,
): SummaryMetadata {
  const { id, live, record } = entry;
  const agent = live ?? record!;
  const parentAgentId = parentByAgentId.get(id) ?? null;
  const status = live?.lifecycle ?? record?.lastStatus ?? "closed";
  const archivedAt = record?.archivedAt ?? null;
  return {
    agentId: id,
    title: record?.title ?? live?.config.title ?? null,
    provider: agent.provider,
    model: getSummaryModel(entry),
    relationship: relationshipToMain(id, parentAgentId, mainAgentId, parentByAgentId),
    parentAgentId,
    stateGroup: !archivedAt && isActive(status, agent.labels) ? "active" : "closed",
    status,
    archivedAt,
    updatedAt: live?.updatedAt.toISOString() ?? record!.updatedAt,
  };
}

function collectWorkspaceAgents(
  workspaceId: string,
  liveAgents: ManagedAgent[],
  records: StoredAgentRecord[],
): SummaryAgent[] {
  const agents = new Map<string, SummaryAgent>();
  for (const record of records) agents.set(record.id, { id: record.id, record });
  for (const agent of liveAgents) {
    if (agent.workspaceId === workspaceId) {
      agents.set(agent.id, { id: agent.id, live: agent, record: agents.get(agent.id)?.record });
    } else {
      agents.delete(agent.id);
    }
  }
  return Array.from(agents.values()).filter(
    ({ live, record }) =>
      !live?.internal && !record?.internal && !live?.background && !record?.background,
  );
}

function compareEntries(left: SummaryMetadata, right: SummaryMetadata): number {
  if (left.stateGroup !== right.stateGroup) return left.stateGroup === "active" ? -1 : 1;
  return right.updatedAt.localeCompare(left.updatedAt) || left.agentId.localeCompare(right.agentId);
}

export async function summarizeWorkspaceAgents({
  workspaceId,
  agentManager,
  agentStorage,
  workspaceRegistry,
  logger,
}: {
  workspaceId: string;
  agentManager: Pick<AgentManager, "listAgents" | "readTimelineForSummary">;
  agentStorage: Pick<AgentStorage, "listByWorkspaces">;
  workspaceRegistry: Pick<WorkspaceRegistry, "get">;
  logger: Logger;
}): Promise<{
  workspaceId: string;
  summaryText: string;
  attachment: Extract<AgentAttachment, { type: "text" }>;
  entries: WorkspaceAgentSummaryEntry[];
}> {
  const workspace = workspaceId.trim() && (await workspaceRegistry.get(workspaceId));
  if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`);
  const entries: WorkspaceAgentSummaryEntry[] = [];
  if (!workspace.background) {
    const records = await agentStorage.listByWorkspaces([workspaceId], { includeArchived: true });
    const agents = collectWorkspaceAgents(workspaceId, agentManager.listAgents(), records);
    const mainAgent = agents.find(
      ({ live, record }) =>
        !record?.archivedAt && isMainControlAgentLabels((live ?? record)?.labels),
    );
    const parentByAgentId = new Map(
      agents.map(({ id, live, record }) => [
        id,
        getParentAgentIdFromLabels((live ?? record)?.labels),
      ]),
    );
    for (const agent of agents) {
      if (isMainControlAgentLabels((agent.live ?? agent.record)?.labels)) continue;
      const agentId = agent.id;
      const items = await agentManager
        .readTimelineForSummary(agentId, workspaceId)
        .catch((error: unknown) => {
          logger.warn(
            { err: error, workspaceId, agentId },
            "Failed to read timeline for workspace summary",
          );
          return [];
        });
      if (items === null) continue;
      const metadata = summarizeAgentMetadata(agent, mainAgent?.id, parentByAgentId);
      const timeline = summarizeTimeline(
        items,
        metadata.parentAgentId,
        getParentAddressFromLabels((agent.live ?? agent.record)?.labels, "")?.serverId,
      );
      entries.push({
        ...metadata,
        ...timeline,
        ...(metadata.relationship === "level2"
          ? { firstUserPrompt: null, lastAssistantSummary: null, todos: [] }
          : {}),
      });
    }
    entries.sort(compareEntries);
  }
  const start = "<workspace-agents-summary>\n";
  const end = "\n</workspace-agents-summary>";
  const rawText = buildSummaryText(entries);
  const maxLength = 80_000 - start.length - end.length;
  const truncated = "\n\n[Summary truncated]";
  const summaryText =
    rawText.length > maxLength
      ? rawText.slice(0, maxLength - truncated.length) + truncated
      : rawText;
  return {
    workspaceId,
    entries,
    summaryText,
    attachment: {
      type: "text",
      mimeType: "text/plain",
      title: "Workspace sessions summary",
      text: start + summaryText + end,
    },
  };
}
