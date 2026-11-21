import {
  getMainPriorModeIdFromLabels,
  getParentAddressFromLabels,
  getParentAgentIdFromLabels,
  isMainControlAgentLabels,
  isExplicitParentReportingLabels,
  MAIN_PRIOR_MODE_ID_LABEL,
  PARENT_AGENT_ID_LABEL,
  PARENT_REPORTING_LABEL,
  PARENT_SERVER_ID_LABEL,
  resolveAgentHierarchyDepth,
  WORKSPACE_ROLE_LABEL,
} from "@getpaseo/protocol/agent-labels";
import type { ProviderPaseoToolsPolicy } from "@getpaseo/protocol/provider-config";
import type { AgentPermissionRequest, AgentSessionConfig } from "./agent-sdk-types.js";
import { OpenCodeProviderOptionsSchema } from "./providers/opencode/options.js";

export const MAX_SUBAGENT_DEPTH = 2;
export const MAIN_CONTROL_WRITE_DENIAL = "Main Control agents are read-only.";
export const MAIN_CONTROL_PROMPT_HEADER = "[Workspace Main Control Instructions]";

export function mainControlPromptEnd(agentId: string): string {
  return `\n[/Workspace Main Control Instructions: ${agentId}]`;
}

export function stripMainControlPromptHeader(text: string, agentId: string): string {
  if (!text.startsWith(MAIN_CONTROL_PROMPT_HEADER + "\n")) return text;
  const delimiter = mainControlPromptEnd(agentId);
  const end = text.indexOf(delimiter);
  if (end === -1) return text;
  return text.slice(end + delimiter.length).replace(/^\n\n/, "");
}
/** Absolute depth supplied by the parent host when it creates a remote child. */
export const REMOTE_HIERARCHY_DEPTH_LABEL = "paseo.remote-hierarchy-depth";
export const RESERVED_HIERARCHY_LABELS = [
  PARENT_AGENT_ID_LABEL,
  PARENT_SERVER_ID_LABEL,
  PARENT_REPORTING_LABEL,
  WORKSPACE_ROLE_LABEL,
  MAIN_PRIOR_MODE_ID_LABEL,
  REMOTE_HIERARCHY_DEPTH_LABEL,
] as const;

export function hasReservedHierarchyLabels(labels?: Record<string, string>): boolean {
  return !!labels && RESERVED_HIERARCHY_LABELS.some((label) => Object.hasOwn(labels, label));
}

export const RESERVED_HIERARCHY_LABELS_ERROR =
  "Change agent hierarchy through the workspace controls.";

export interface HierarchyAgent {
  id: string;
  labels?: Record<string, string>;
  archivedAt?: string | null;
  title?: string | null;
  lifecycle?: string;
}

type ReadAgent = (id: string) => HierarchyAgent | null | undefined;
type ListActiveAgents = () => Iterable<HierarchyAgent>;

export async function readAgentHierarchyPath(
  agentId: string,
  readAgent: (id: string) => Promise<HierarchyAgent | null | undefined>,
): Promise<ReadonlyMap<string, HierarchyAgent>> {
  const agents = new Map<string, HierarchyAgent>();
  let id: string | null = agentId;
  while (id && !agents.has(id)) {
    const agent = await readAgent(id);
    if (!agent) break;
    agents.set(id, agent);
    id = getParentAgentIdFromLabels(agent.labels);
  }
  return agents;
}

function readLocalParentId(labels: HierarchyAgent["labels"], serverId?: string): string | null {
  if (serverId === undefined) return getParentAgentIdFromLabels(labels);
  const parent = getParentAddressFromLabels(labels, serverId);
  return parent?.serverId === serverId ? parent.agentId : null;
}

export function computeAgentDepth(
  agentId: string,
  readAgent: ReadAgent,
  serverId?: string,
): number {
  let remoteParentDepth = 0;
  const depth = resolveAgentHierarchyDepth(agentId, (id) => {
    const labels = readAgent(id)?.labels;
    const parentId = getParentAgentIdFromLabels(labels);
    if (parentId && serverId !== undefined && !readLocalParentId(labels, serverId)) {
      remoteParentDepth =
        labels?.[REMOTE_HIERARCHY_DEPTH_LABEL] === String(MAX_SUBAGENT_DEPTH)
          ? MAX_SUBAGENT_DEPTH
          : 1;
      return null;
    }
    if (parentId && labels?.[REMOTE_HIERARCHY_DEPTH_LABEL] === String(MAX_SUBAGENT_DEPTH)) {
      // The declared remote child is already Level-2. Count its parent hop and
      // add the remaining hop, regardless of whether that parent exists locally.
      remoteParentDepth = 1;
    }
    return parentId;
  });
  return depth + remoteParentDepth;
}

export function readLocalSubtreeDepths(
  rootAgentId: string,
  agents: Iterable<HierarchyAgent>,
  serverId?: string,
): ReadonlyMap<string, number> {
  const children = new Map<string, string[]>();
  for (const agent of agents) {
    const parentId = readLocalParentId(agent.labels, serverId);
    if (!parentId || agent.archivedAt) continue;
    const siblings = children.get(parentId);
    if (siblings) siblings.push(agent.id);
    else children.set(parentId, [agent.id]);
  }
  const depths = new Map<string, number>();
  const pending = [{ id: rootAgentId, depth: 0 }];
  while (pending.length) {
    const { id, depth } = pending.pop()!;
    if (depths.has(id)) continue;
    depths.set(id, depth);
    for (const childId of children.get(id) ?? []) {
      pending.push({ id: childId, depth: depth + 1 });
    }
  }
  return depths;
}

export function computeMaxSubtreeDepth(
  rootAgentId: string,
  listActiveAgents: ListActiveAgents,
  serverId?: string,
): number {
  let maxDepth = 0;
  for (const depth of readLocalSubtreeDepths(rootAgentId, listActiveAgents(), serverId).values()) {
    maxDepth = Math.max(maxDepth, depth);
  }
  return maxDepth;
}

export function validateCanSpawnChild(parentAgent: HierarchyAgent, readAgent: ReadAgent): void {
  if (parentAgent.archivedAt) throw new Error("Archived agents cannot spawn subagents.");
  if (computeAgentDepth(parentAgent.id, readAgent) >= MAX_SUBAGENT_DEPTH) {
    throw new Error(
      "Level-2 subagents cannot spawn nested subagents (maximum hierarchy depth is 3 tiers: Main -> Level-1 -> Level-2).",
    );
  }
}

export function validateSetAgentParent({
  agent,
  parentAgent,
  readAgent,
  listActiveAgents,
  serverId,
}: {
  agent: HierarchyAgent;
  parentAgent: HierarchyAgent;
  readAgent: ReadAgent;
  listActiveAgents: ListActiveAgents;
  serverId?: string;
}): void {
  if (agent.id === parentAgent.id) throw new Error("An agent cannot be its own parent.");
  if (agent.archivedAt || parentAgent.archivedAt) {
    throw new Error("Cannot reparent an archived agent or attach to an archived parent.");
  }
  if (isMainControlAgentLabels(agent.labels)) {
    throw new Error("Disable Main Control before attaching this agent to a parent.");
  }
  const seen = new Set<string>();
  let ancestorId: string | null = parentAgent.id;
  while (ancestorId) {
    if (ancestorId === agent.id || seen.has(ancestorId)) {
      throw new Error("This parent relationship would create or join a cycle.");
    }
    seen.add(ancestorId);
    ancestorId = readLocalParentId(readAgent(ancestorId)?.labels, serverId);
  }
  if (
    computeAgentDepth(parentAgent.id, readAgent, serverId) +
      1 +
      computeMaxSubtreeDepth(agent.id, listActiveAgents, serverId) >
    MAX_SUBAGENT_DEPTH
  ) {
    throw new Error(
      "This parent relationship would exceed the maximum hierarchy depth of 3 tiers.",
    );
  }
}

export function validateSingleHopOrchestration({
  callerAgentId,
  targetAgentId,
  readAgent,
}: {
  callerAgentId: string;
  targetAgentId: string;
  readAgent: ReadAgent;
}): void {
  const target = readAgent(targetAgentId);
  if (
    requiresSingleHopOrchestration(callerAgentId, readAgent) &&
    getParentAgentIdFromLabels(target?.labels) !== callerAgentId
  ) {
    throw new Error(
      "You can only manage your direct subagents. Coordinate through your direct child.",
    );
  }
}

export function requiresSingleHopOrchestration(
  callerAgentId: string,
  readAgent: ReadAgent,
): boolean {
  return (
    isMainControlAgentLabels(readAgent(callerAgentId)?.labels) ||
    computeAgentDepth(callerAgentId, readAgent) === 1
  );
}

const MAIN_CONTROL_DISABLED_TOOLS = [
  "archive_workspace",
  "create_schedule",
  "update_schedule",
  "resume_schedule",
  "run_schedule_once",
  "create_workspace",
  "create_terminal",
  "send_terminal_keys",
  "kill_terminal",
  "start_workspace_script",
  "stop_workspace_script",
];
const MAIN_CONTROL_CLAUDE_DENIED_TOOLS = ["Edit", "MultiEdit", "Write", "NotebookEdit", "Bash"];
const OPENCODE_NON_WRITE_PERMISSIONS = [
  "read",
  "glob",
  "grep",
  "list",
  "task",
  "external_directory",
  "question",
  "webfetch",
  "websearch",
  "codesearch",
  "repo_clone",
  "repo_overview",
  "lsp",
  "doom_loop",
  "skill",
] as const;

export function resolveInheritedHierarchyMode(
  mode: string | null | undefined,
  labels: HierarchyAgent["labels"],
): string | null | undefined {
  return isMainControlAgentLabels(labels) && mode === "read-only"
    ? getMainPriorModeIdFromLabels(labels)
    : mode;
}

const LEVEL_TWO_DISABLED_TOOLS = [
  "create_agent",
  "archive_workspace",
  "create_schedule",
  "update_schedule",
  "resume_schedule",
  "run_schedule_once",
  "send_agent_prompt",
  "update_agent",
  "cancel_agent",
  "archive_agent",
  "kill_agent",
];

export function applyHierarchyPaseoToolPolicy(
  policy: ProviderPaseoToolsPolicy | undefined,
  labels: HierarchyAgent["labels"],
  depth: number,
): ProviderPaseoToolsPolicy | undefined {
  const disabledTools = [
    ...(isMainControlAgentLabels(labels) ? MAIN_CONTROL_DISABLED_TOOLS : []),
    ...(depth >= MAX_SUBAGENT_DEPTH ? LEVEL_TWO_DISABLED_TOOLS : []),
  ];
  if (disabledTools.length === 0) return policy;
  return {
    ...policy,
    disabledTools: [...new Set([...(policy?.disabledTools ?? []), ...disabledTools])],
  };
}

function resolveOpenCodePermissionRules(rawPermission: unknown): Record<string, unknown> {
  if (typeof rawPermission === "string") {
    return Object.fromEntries(OPENCODE_NON_WRITE_PERMISSIONS.map((name) => [name, rawPermission]));
  }
  if (rawPermission && typeof rawPermission === "object" && !Array.isArray(rawPermission)) {
    return rawPermission as Record<string, unknown>;
  }
  return {};
}

export function applyMainControlReadOnlyConfig(
  config: AgentSessionConfig,
  labels: HierarchyAgent["labels"],
  provider = config.provider,
): AgentSessionConfig {
  if (!isMainControlAgentLabels(labels)) return config;
  if (provider === "pi") {
    return {
      ...config,
      providerOptions: { ...config.providerOptions, mainControlReadOnly: true },
    };
  }
  if (provider === "codex") {
    return {
      ...config,
      modeId: "read-only",
      providerOptions: {
        ...config.providerOptions,
        sandbox_mode: "read-only",
        approval_policy: "never",
      },
    };
  }
  if (provider === "claude") {
    const existing = config.providerOptions?.disallowedTools;
    return {
      ...config,
      providerOptions: {
        ...config.providerOptions,
        disallowedTools: [
          ...new Set([
            ...(Array.isArray(existing) ? existing : []),
            ...MAIN_CONTROL_CLAUDE_DENIED_TOOLS,
          ]),
        ],
      },
    };
  }
  if (provider === "opencode") {
    const parsed = OpenCodeProviderOptionsSchema.safeParse(config.providerOptions ?? {});
    const rawPermission = parsed.success
      ? parsed.data.permission
      : config.providerOptions?.permission;
    const rules = resolveOpenCodePermissionRules(rawPermission);
    return {
      ...config,
      providerOptions: {
        ...config.providerOptions,
        auto_accept: false,
        permission: {
          ...rules,
          edit: "deny",
          bash: "deny",
          todowrite: "deny",
        },
      },
    };
  }
  if (config.providerOptions?.auto_accept === true) {
    return {
      ...config,
      providerOptions: {
        ...config.providerOptions,
        auto_accept: false,
      },
    };
  }
  return config;
}

export function isMainControlWritePermissionBlocked(
  request: Pick<AgentPermissionRequest, "kind" | "name" | "detail">,
): boolean {
  if (
    request.detail?.type === "edit" ||
    request.detail?.type === "write" ||
    request.detail?.type === "shell"
  ) {
    return true;
  }
  if (request.kind !== "tool") return false;
  const name = request.name
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .replace(/[-\s]+/g, "_")
    .toLowerCase()
    .split(/__|[./:]+/)
    .at(-1);
  return /^(?:(?:multi_|notebook_)?edit|(?:file_|filesystem_|fs_)?(?:edit|write|patch)|(?:edit|write|patch|create|delete|remove|move|rename)_file|write_to_file|(?:multi_)?replace_file_content|replace|str_replace_editor|apply_patch|(?:codex_)?file_change|bash|shell|exec|run_command|execute_command|run_terminal_cmd|todo_?write)(?:_tool)?$/.test(
    name ?? "",
  );
}

export function buildHierarchyAppendSystemPrompt({
  agent,
  serverId = "self",
  readAgent,
  listActiveAgents,
}: {
  agent: HierarchyAgent;
  readAgent: ReadAgent;
  listActiveAgents: ListActiveAgents;
  serverId?: string;
}): string {
  const parentAddress = getParentAddressFromLabels(agent.labels, serverId);
  const parent = parentAddress?.serverId === serverId ? readAgent(parentAddress.agentId) : null;
  const canReport =
    parentAddress &&
    (parentAddress.serverId !== serverId ||
      (parent && !parent.archivedAt && parent.id !== agent.id));
  let contract: string[] = [];
  let childRole: string | undefined;
  if (isMainControlAgentLabels(agent.labels)) {
    contract = [
      "Role: Workspace Main Control Coordinator. Work strictly read-only. Do not modify files or run builds that alter the workspace.",
      'For each task you delegate, use create_agent with parentReporting: "explicit" to create exactly one Level-1 lead. Keep workspace edits in the delegated sessions.',
      "Coordinate through that lead with send_agent_prompt and update_agent. Wait for the lead to call report_to_parent with the final outcome or a blocking question that needs your decision.",
      "Summarize the lead's report for the user.",
      "Use summarize_workspace_agents to review active and closed workspace sessions, tasks, and touched files. Cross-check uncommitted changes with read-only git status and git diff when summarizing workspace state.",
    ];
    childRole = "Level-1";
  } else if (
    parent &&
    !parent.archivedAt &&
    isMainControlAgentLabels(parent.labels) &&
    computeAgentDepth(agent.id, readAgent, serverId) === 1
  ) {
    contract = [
      `Role: Level-1 Module Lead (Flexible Mode) under Main Control Agent ${parent.id}.`,
      "Refine the task's requirements, edge cases, and file boundaries. Complete and verify small changes yourself. Delegate substantive implementation and independent verification to Level-2 Sub-Agents with create_agent.",
    ];
    childRole = "Level-2";
  }
  if (
    !isMainControlAgentLabels(agent.labels) &&
    canReport &&
    isExplicitParentReportingLabels(agent.labels)
  ) {
    contract.push(
      "Call report_to_parent once all verification is complete, with a concise outcome and changed files. If you need a decision from your parent to proceed, use report_to_parent with status blocked and the question.",
    );
  }
  if (!childRole) return contract.join("\n");
  const children = [...listActiveAgents()]
    .filter((child) => {
      const address = getParentAddressFromLabels(child.labels, serverId);
      return !child.archivedAt && address?.serverId === serverId && address.agentId === agent.id;
    })
    .sort((left, right) => left.id.localeCompare(right.id, "en"))
    .map(({ id, title, lifecycle }) => ({
      id,
      title: title ?? null,
      status: lifecycle ?? "closed",
    }));
  return [...contract, `Direct ${childRole} children: ${JSON.stringify(children)}`].join("\n");
}
