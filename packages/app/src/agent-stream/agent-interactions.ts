import {
  getPaseoToolLeafName,
  normalizeToolName,
} from "@getpaseo/protocol/tool-name-normalization";
import type { StreamItem } from "@/types/stream";

// Agent lifecycle and messaging tools in the Paseo catalog. Permission tools stay visible.
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
    if (isAgentInteraction(item)) {
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
