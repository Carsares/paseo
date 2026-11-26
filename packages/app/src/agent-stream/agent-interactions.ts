import {
  getPaseoToolLeafName,
  normalizeToolName,
} from "@getpaseo/protocol/tool-name-normalization";
import type { StreamItem } from "@/types/stream";
import type { AgentMessage } from "@getpaseo/protocol/agent-message";
import { isTurnBoundary } from "./turn-membership";

// Agent lifecycle and intra-workspace subagent messaging tools in the Paseo catalog.
// Permission tools and cross-workspace peer collaboration tools (`send_peer_message`,
// `list_workspaces`) stay visible so external workspace alignment is never hidden.
// Keep the persisted tool classification in the server's agent/chat-search/index.ts in sync.
const PASEO_INTERACTION_TOOLS = new Set([
  "create_agent",
  "send_agent_prompt",
  "get_agent_status",
  "get_agent_activity",
  "list_agents",
  "cancel_agent",
  "archive_agent",
  "kill_agent",
  "update_agent",
  "set_agent_mode",
]);

function isPaseoInteractionTool(name: string): boolean {
  const leaf = getPaseoToolLeafName(name);
  if (leaf !== null) return PASEO_INTERACTION_TOOLS.has(leaf);
  // OpenCode and Pi bridges register this exact prefix instead of MCP namespaces.
  const normalized = normalizeToolName(name);
  return normalized.startsWith("paseo_") && PASEO_INTERACTION_TOOLS.has(normalized.slice(6));
}

export function isAgentInteraction(item: StreamItem): boolean {
  if (item.kind === "user_message") return item.sender !== undefined;
  if (item.kind !== "tool_call") return false;
  if (item.payload.source === "orchestrator") {
    return isPaseoInteractionTool(item.payload.data.toolName);
  }
  const data = item.payload.data;
  if (data.agentMessage || data.detail.type === "sub_agent") return true;
  // Claude emits the native dispatch before the sidechain gives it sub_agent detail.
  const nativeClaudeDispatch =
    data.provider === "claude" && (data.name === "Task" || data.name === "Agent");
  return nativeClaudeDispatch || isPaseoInteractionTool(data.name);
}

export type AgentSourceStatus =
  | "message"
  | "finished"
  | "completed"
  | "blocked"
  | "error"
  | "permission-required"
  | "closed";

export interface AgentSourceInfo {
  event: AgentMessage["event"];
  sender: AgentMessage["sender"];
  text: string;
  taskId?: string;
  rootMessageId?: string;
  reportStatus?: AgentMessage["reportStatus"];
  status: AgentSourceStatus;
}

export interface AgentSourceGroup {
  firstItemId: string;
  itemCount: number;
  sources: readonly AgentSourceInfo[];
  requiresExpansion: boolean;
}

export interface AgentSourcePresentation {
  group: AgentSourceGroup;
  isGroupStart: boolean;
}

// History row revisions clone items to refresh their render identity. Keep
// presentation metadata on the row so those copies retain their source.
const sourcePresentationKey = Symbol("sourcePresentation");
const sourceGroupKey = Symbol("sourceGroup");
type SourceRow = StreamItem & {
  [sourcePresentationKey]?: AgentSourcePresentation;
  [sourceGroupKey]?: AgentSourceGroup;
};

export function getAgentMessage(item: StreamItem): AgentMessage | undefined {
  if (item.kind !== "tool_call" || item.payload.source !== "agent") return undefined;
  return item.payload.data.agentMessage;
}

export function resolveAgentSourceStatus(message: AgentMessage): AgentSourceStatus {
  if (message.event === "errored") return "error";
  if (message.event === "permission-required") return "permission-required";
  if (message.reportStatus === "blocked") return "blocked";
  if (message.reportStatus === "completed") return "completed";
  switch (message.event) {
    case "message":
      return "message";
    case "finished":
      return "finished";
    case "closed":
      return "closed";
  }
}

export function requiresAgentSourceExpansion(status: AgentSourceStatus): boolean {
  return (
    status === "message" ||
    status === "blocked" ||
    status === "error" ||
    status === "permission-required"
  );
}

function sourceInfo(message: AgentMessage): AgentSourceInfo {
  return {
    event: message.event,
    sender: message.sender,
    text: message.text,
    ...(message.taskId ? { taskId: message.taskId } : {}),
    ...(message.rootMessageId ? { rootMessageId: message.rootMessageId } : {}),
    ...(message.reportStatus ? { reportStatus: message.reportStatus } : {}),
    status: resolveAgentSourceStatus(message),
  };
}

export function agentSourceKey(source: AgentSourceInfo, fallbackServerId?: string): string {
  return JSON.stringify([
    source.sender.serverId ?? fallbackServerId,
    source.sender.id,
    source.status,
  ]);
}

function sameSourceTurn(previous: StreamItem | undefined, current: StreamItem): boolean {
  return previous?.turnId !== undefined && previous.turnId === current.turnId;
}

function makeSourceGroup(
  firstItemId: string,
  itemCount: number,
  sources: readonly AgentSourceInfo[],
): AgentSourceGroup {
  return {
    firstItemId,
    itemCount,
    sources: [...new Map(sources.map((source) => [agentSourceKey(source), source])).values()],
    requiresExpansion: sources.some((source) => requiresAgentSourceExpansion(source.status)),
  };
}

/** Builds source chips from adjacent source events without crossing a visible timeline row. */
function buildAgentSourceGroups(
  items: readonly StreamItem[],
): ReadonlyMap<string, AgentSourceGroup> {
  const groups = new Map<string, AgentSourceGroup>();
  let run: StreamItem[] = [];
  let infos: AgentSourceInfo[] = [];
  function finishRun() {
    const first = run[0];
    if (!first) return;
    const group = makeSourceGroup(first.id, run.length, infos);
    for (const item of run) groups.set(item.id, group);
    run = [];
    infos = [];
  }

  for (const item of items) {
    const message = getAgentMessage(item);
    if (!message || !sameSourceTurn(run.at(-1), item)) finishRun();
    if (!message) continue;
    run.push(item);
    infos.push(sourceInfo(message));
  }
  finishRun();
  return groups;
}

export function createAgentSourceGrouping() {
  let historySource: StreamItem[] | undefined;
  let history = buildAgentSourceGroups([]);
  let boundaryItems: StreamItem[] = [];
  let boundary = new Map<string, AgentSourceGroup>();

  return (tail: StreamItem[], head: StreamItem[]) => {
    if (historySource !== tail) {
      history = buildAgentSourceGroups(tail);
      historySource = tail;
      boundaryItems = [];
      boundary = new Map();
    }
    const live = buildAgentSourceGroups(head);
    const last = tail.at(-1);
    const first = head[0];
    const trailing = last && history.get(last.id);
    const leading = first && live.get(first.id);
    const joined =
      first && trailing && leading && sameSourceTurn(last, first)
        ? [...tail.slice(-trailing.itemCount), ...head.slice(0, leading.itemCount)]
        : [];
    if (
      joined.length !== boundaryItems.length ||
      joined.some((item, index) => item !== boundaryItems[index])
    ) {
      boundary = new Map(buildAgentSourceGroups(joined));
      boundaryItems = joined;
    }
    return { history, live, boundary };
  };
}

function hasCompletedSource(group: AgentSourceGroup): boolean {
  return group.sources.some(
    (source) => source.status === "completed" || source.status === "finished",
  );
}

/**
 * The first item id of the newest completed/finished source group inside the latest turn
 * (pass the live head before the retained tail). Stops at the turn boundary so an unread
 * human-driven turn never highlights an older subagent report from a previous turn, and
 * skips non-completed reports such as blocked/error/message rows.
 */
export function findLatestAgentSourceGroupId(
  ...lanes: ReadonlyArray<readonly StreamItem[]>
): string | null {
  let laterItem: StreamItem | null = null;
  for (const lane of lanes) {
    for (let index = lane.length - 1; index >= 0; index--) {
      const item = lane[index] as StreamItem;
      if (laterItem && isTurnBoundary(item, laterItem)) {
        return null;
      }
      const group = getAgentSourceGroup(item);
      if (group && hasCompletedSource(group)) return group.firstItemId;
      laterItem = item;
    }
  }
  return null;
}

export function setAgentSourcePresentation(
  item: StreamItem,
  presentation: AgentSourcePresentation,
): void {
  (item as SourceRow)[sourcePresentationKey] = presentation;
}

export function getAgentSourcePresentation(item: StreamItem): AgentSourcePresentation | undefined {
  return (item as SourceRow)[sourcePresentationKey];
}

export function getAgentSourceGroup(item: StreamItem): AgentSourceGroup | undefined {
  return (item as SourceRow)[sourceGroupKey] ?? getAgentSourcePresentation(item)?.group;
}

export function setAgentSourceGroup(item: StreamItem, group: AgentSourceGroup): void {
  (item as SourceRow)[sourceGroupKey] = group;
}

interface ProjectionInput {
  tail: StreamItem[];
  head: StreamItem[];
  showAgentInteractions?: boolean;
}

export interface HiddenItemIds extends Iterable<string> {
  readonly size: number;
  has(id: string): boolean;
}

interface Projection {
  tail: StreamItem[];
  head: StreamItem[];
  hiddenItemIds: HiddenItemIds;
  readingRowReplacements: ReadonlyMap<string, string>;
}

interface Segment {
  rows: StreamItem[];
  hidden: HiddenItemIds;
  replacements: ReadonlyMap<string, string>;
  trailingGap: boolean;
}

interface SegmentInput {
  source: StreamItem[];
  preceding?: StreamItem;
  trailingGap?: boolean;
}

const mergedAssistantFragmentSeqs = new WeakMap<StreamItem, readonly number[]>();

export function getMergedAssistantFragmentSeqs(item: StreamItem): readonly number[] | undefined {
  return mergedAssistantFragmentSeqs.get(item);
}

function mergeAssistantFragments(previous: StreamItem | undefined, item: StreamItem) {
  if (
    previous?.kind !== "assistant_message" ||
    item.kind !== "assistant_message" ||
    !item.messageId ||
    !item.turnId ||
    previous.messageId !== item.messageId ||
    previous.turnId !== item.turnId
  ) {
    return undefined;
  }
  const merged = {
    ...previous,
    text: previous.text + item.text,
    timelineCursor: item.timelineCursor ?? previous.timelineCursor,
  };
  const previousSeqs =
    getMergedAssistantFragmentSeqs(previous) ??
    (previous.timelineCursor ? [previous.timelineCursor.seq] : []);
  mergedAssistantFragmentSeqs.set(
    merged,
    item.timelineCursor ? [...previousSeqs, item.timelineCursor.seq] : previousSeqs,
  );
  return merged;
}

function projectSegment({ source, preceding, trailingGap = false }: SegmentInput): Segment {
  const rows: StreamItem[] = preceding ? [preceding] : [];
  const hidden = new Set<string>();
  const replacements = new Map<string, string>();
  const leadingHidden: string[] = [];
  let gap = trailingGap;
  for (const item of source) {
    const previous = rows.at(-1);
    const sourceMessage = getAgentMessage(item);
    if (isAgentInteraction(item) && !sourceMessage) {
      hidden.add(item.id);
      if (previous) replacements.set(item.id, previous.id);
      else leadingHidden.push(item.id);
      gap = true;
      continue;
    }
    const merged = gap ? mergeAssistantFragments(previous, item) : undefined;
    if (merged) {
      rows[rows.length - 1] = merged;
      replacements.set(item.id, merged.id);
    } else {
      rows.push(item);
    }
    for (const id of leadingHidden) replacements.set(id, item.id);
    leadingHidden.length = 0;
    gap = false;
  }
  // Identity matters to downstream history grouping and turn folding.
  const unchanged = !preceding && hidden.size === 0 && replacements.size === 0;
  return { rows: unchanged ? source : rows, hidden, replacements, trailingGap: gap };
}

// Views avoid copying the retained history's indexes on each streaming delta.
function unionSets(base: HiddenItemIds, extra: HiddenItemIds): HiddenItemIds {
  if (extra.size === 0) return base;
  if (base.size === 0) return extra;
  let size = base.size;
  for (const value of extra) if (!base.has(value)) size++;
  return {
    size,
    has: (value) => base.has(value) || extra.has(value),
    *[Symbol.iterator]() {
      yield* base;
      for (const value of extra) if (!base.has(value)) yield value;
    },
  };
}

function overlayMaps<K, V>(base: ReadonlyMap<K, V>, extra: ReadonlyMap<K, V>): ReadonlyMap<K, V> {
  if (extra.size === 0) return base;
  if (base.size === 0) return extra;
  let size = base.size;
  for (const key of extra.keys()) if (!base.has(key)) size++;
  const combined: ReadonlyMap<K, V> = {
    size,
    has: (key) => base.has(key) || extra.has(key),
    get: (key) => (extra.has(key) ? extra.get(key) : base.get(key)),
    *entries(): MapIterator<[K, V]> {
      for (const entry of base) if (!extra.has(entry[0])) yield entry;
      yield* extra;
      return undefined;
    },
    *keys(): MapIterator<K> {
      for (const [key] of this.entries()) yield key;
      return undefined;
    },
    *values(): MapIterator<V> {
      for (const [, value] of this.entries()) yield value;
      return undefined;
    },
    [Symbol.iterator]() {
      return this.entries();
    },
    forEach(callback, thisArg) {
      for (const [key, value] of this.entries()) callback.call(thisArg, value, key, combined);
    },
  };
  return combined;
}

const NO_HIDDEN_ITEMS: HiddenItemIds = new Set();
const NO_REPLACEMENTS: ReadonlyMap<string, string> = new Map();

function isSameProjectionInput(previous: ProjectionInput | undefined, input: ProjectionInput) {
  return (
    previous?.tail === input.tail &&
    previous.head === input.head &&
    (previous.showAgentInteractions === true) === (input.showAgentInteractions === true)
  );
}

function reuseUnchangedHead(head: StreamItem[], previous: StreamItem[] | undefined) {
  if (previous && head.length === previous.length) {
    const unchanged = head.every((row, index) => row === previous[index]);
    if (unchanged) return previous;
  }
  return head;
}

export function createAgentInteractionProjection() {
  let lastInput: ProjectionInput | undefined;
  let lastResult: Projection | undefined;
  let tailSource: StreamItem[] | undefined;
  let retained: Segment | undefined;
  let tailWithoutLast: StreamItem[] | undefined;
  let fallbackHost: string | undefined;
  let fallbackReplacements: ReadonlyMap<string, string> = NO_REPLACEMENTS;

  return (input: ProjectionInput): Projection => {
    const show = input.showAgentInteractions === true;
    if (lastResult && isSameProjectionInput(lastInput, input)) return lastResult;
    if (show) {
      lastInput = input;
      lastResult = {
        tail: input.tail,
        head: input.head,
        hiddenItemIds: NO_HIDDEN_ITEMS,
        readingRowReplacements: NO_REPLACEMENTS,
      };
      return lastResult;
    }
    if (!retained || tailSource !== input.tail) {
      retained = projectSegment({ source: input.tail });
      tailSource = input.tail;
      tailWithoutLast = undefined;
      fallbackHost = undefined;
      fallbackReplacements = NO_REPLACEMENTS;
    }
    const preceding = retained.rows.at(-1);
    const live = projectSegment({
      source: input.head,
      preceding,
      trailingGap: retained.trailingGap,
    });
    let tail = retained.rows;
    let head = live.rows;
    if (preceding && live.rows[0] === preceding) {
      head = live.rows.slice(1);
      if (live.hidden.size === 0 && live.replacements.size === 0) head = input.head;
    } else if (preceding) {
      // Keep the first fragment's identity, but move the growing merged row into
      // the live lane so deltas never invalidate the entire retained history.
      tailWithoutLast ??= retained.rows.slice(0, -1);
      tail = tailWithoutLast;
    }
    // An all-hidden history has no previous visible row. Resolve it to the first
    // visible live row once, rather than rebuilding this index on text growth.
    const firstLiveId = head[0]?.id;
    if (!preceding && fallbackHost !== firstLiveId) {
      fallbackHost = firstLiveId;
      const replacements = new Map<string, string>();
      if (firstLiveId) for (const id of retained.hidden) replacements.set(id, firstLiveId);
      fallbackReplacements = replacements;
    }
    // Hidden-only deltas must not invalidate downstream live-row work either.
    head = reuseUnchangedHead(head, lastResult?.head);
    const historyReplacements = overlayMaps(retained.replacements, fallbackReplacements);
    lastInput = input;
    lastResult = {
      tail,
      head,
      hiddenItemIds: unionSets(retained.hidden, live.hidden),
      readingRowReplacements: overlayMaps(historyReplacements, live.replacements),
    };
    return lastResult;
  };
}
