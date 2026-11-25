import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { persist, type StateStorage } from "zustand/middleware";
import { z } from "zod";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";

const TOPIC_INBOX_READ_STORAGE_KEY = "topic-inbox-read";
const TOPIC_INBOX_READ_STORE_VERSION = 1;
const MAX_READ_ITEM_IDS = 400;
const MAX_SCOPES = 200;

const RetainedJumpTargetSchema = z.strictObject({
  agentId: z.string(),
  itemId: z.string().nullable(),
  messageId: z.string().nullable(),
  epoch: z.string().nullable(),
  seq: z.number().int().nullable(),
});

const RetainedMainConclusionSchema = z.strictObject({
  id: z.string().optional(),
  turnKey: z.string().nullable().optional(),
  timestampMs: z.number(),
  preview: z.string(),
  isError: z.boolean(),
  jumpTarget: RetainedJumpTargetSchema.nullable().optional(),
});

export type RetainedMainConclusionSnapshot = z.infer<typeof RetainedMainConclusionSchema>;

const TopicInboxReadScopeSchema = z.strictObject({
  watermarkEpoch: z.string().nullable(),
  watermarkSeq: z.number().int(),
  watermarkTimestampMs: z.number(),
  readItemIds: z.array(z.string()),
  readMainConclusionAtMs: z.number().optional(),
  lastReadMainConclusion: RetainedMainConclusionSchema.nullable().optional(),
});

export type TopicInboxReadScope = z.infer<typeof TopicInboxReadScopeSchema>;

const TopicInboxReadPersistedSchema = z.strictObject({
  scopes: z.record(z.string(), TopicInboxReadScopeSchema).optional(),
});

type TopicInboxReadPersistedState = z.infer<typeof TopicInboxReadPersistedSchema>;

export interface TopicInboxReadCandidate {
  id: string;
  epoch?: string | null;
  seq?: number | null;
  timestampMs?: number | null;
}

export interface MarkAllInboxReadSnapshot {
  epoch?: string | null;
  maxSeq?: number | null;
  maxTimestampMs?: number | null;
  itemIds?: readonly string[];
  mainConclusion?: RetainedMainConclusionSnapshot | null;
}

export interface TopicInboxReadState {
  scopes: Record<string, TopicInboxReadScope>;
  markItemRead: (
    scopeKey: string,
    itemId: string,
    mainConclusion?: RetainedMainConclusionSnapshot | null,
  ) => void;
  markAllRead: (scopeKey: string, snapshot: MarkAllInboxReadSnapshot) => void;
}

export function buildTopicInboxReadScopeKey(input: {
  serverId: string;
  workspaceId: string;
  mainAgentId: string | null;
}): string {
  return `${input.serverId}\0${input.workspaceId}\0${input.mainAgentId ?? "unbound"}`;
}

export function isTopicInboxItemRead(
  scope: TopicInboxReadScope | undefined,
  candidate: TopicInboxReadCandidate,
): boolean {
  if (!scope) return false;
  if (scope.readItemIds.includes(candidate.id)) return true;
  if (
    candidate.epoch &&
    typeof candidate.seq === "number" &&
    scope.watermarkEpoch === candidate.epoch &&
    candidate.seq <= scope.watermarkSeq
  ) {
    return true;
  }
  if (
    !candidate.epoch &&
    typeof candidate.seq !== "number" &&
    typeof candidate.timestampMs === "number" &&
    scope.watermarkTimestampMs > 0 &&
    candidate.timestampMs <= scope.watermarkTimestampMs
  ) {
    return true;
  }
  return false;
}

function appendReadIds(existing: readonly string[], incoming: readonly string[]): string[] {
  const seen = new Set<string>();
  const combined = [...existing, ...incoming];
  const dedupedReversed: string[] = [];
  for (let i = combined.length - 1; i >= 0; i -= 1) {
    const id = combined[i]!;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    dedupedReversed.push(id);
    if (dedupedReversed.length >= MAX_READ_ITEM_IDS) break;
  }
  return dedupedReversed.toReversed();
}

function boundScopes(
  scopes: Record<string, TopicInboxReadScope>,
): Record<string, TopicInboxReadScope> {
  const keys = Object.keys(scopes);
  if (keys.length <= MAX_SCOPES) return scopes;
  const kept = keys.slice(keys.length - MAX_SCOPES);
  const next: Record<string, TopicInboxReadScope> = {};
  for (const key of kept) {
    next[key] = scopes[key]!;
  }
  return next;
}

const EMPTY_SCOPE: TopicInboxReadScope = {
  watermarkEpoch: null,
  watermarkSeq: -1,
  watermarkTimestampMs: 0,
  readItemIds: [],
};

export function createTopicInboxReadStore(backingStorage: StateStorage = AsyncStorage) {
  return create<TopicInboxReadState>()(
    persist(
      (set) => ({
        scopes: {},
        markItemRead: (scopeKey, itemId, mainConclusion) =>
          set((state) => {
            const current = state.scopes[scopeKey] ?? EMPTY_SCOPE;
            const hasId = current.readItemIds.includes(itemId);
            const nextConclusionAtMs = mainConclusion
              ? Math.max(current.readMainConclusionAtMs ?? 0, mainConclusion.timestampMs)
              : current.readMainConclusionAtMs;
            if (hasId && !mainConclusion) return state;
            const nextScope: TopicInboxReadScope = {
              ...current,
              readItemIds: hasId
                ? current.readItemIds
                : appendReadIds(current.readItemIds, [itemId]),
              ...(nextConclusionAtMs !== undefined
                ? { readMainConclusionAtMs: nextConclusionAtMs }
                : {}),
              ...(mainConclusion ? { lastReadMainConclusion: mainConclusion } : {}),
            };
            return {
              scopes: boundScopes({ ...state.scopes, [scopeKey]: nextScope }),
            };
          }),
        markAllRead: (scopeKey, snapshot) =>
          set((state) => {
            const current = state.scopes[scopeKey] ?? EMPTY_SCOPE;
            const nextEpoch = snapshot.epoch ?? current.watermarkEpoch;
            let nextSeq = current.watermarkSeq;
            if (typeof snapshot.maxSeq === "number") {
              nextSeq =
                snapshot.epoch && snapshot.epoch !== current.watermarkEpoch
                  ? snapshot.maxSeq
                  : Math.max(current.watermarkSeq, snapshot.maxSeq);
            } else if (snapshot.epoch && snapshot.epoch !== current.watermarkEpoch) {
              nextSeq = -1;
            }
            const nextTimestampMs =
              typeof snapshot.maxTimestampMs === "number"
                ? Math.max(current.watermarkTimestampMs, snapshot.maxTimestampMs)
                : current.watermarkTimestampMs;
            const nextReadIds = appendReadIds(current.readItemIds, snapshot.itemIds ?? []);
            const nextConclusionAtMs = snapshot.mainConclusion
              ? Math.max(current.readMainConclusionAtMs ?? 0, snapshot.mainConclusion.timestampMs)
              : current.readMainConclusionAtMs;
            const nextLastConclusion = snapshot.mainConclusion ?? current.lastReadMainConclusion;
            const nextScope: TopicInboxReadScope = {
              watermarkEpoch: nextEpoch ?? null,
              watermarkSeq: nextSeq,
              watermarkTimestampMs: nextTimestampMs,
              readItemIds: nextReadIds,
              ...(nextConclusionAtMs !== undefined
                ? { readMainConclusionAtMs: nextConclusionAtMs }
                : {}),
              ...(nextLastConclusion ? { lastReadMainConclusion: nextLastConclusion } : {}),
            };
            return {
              scopes: boundScopes({ ...state.scopes, [scopeKey]: nextScope }),
            };
          }),
      }),
      {
        name: TOPIC_INBOX_READ_STORAGE_KEY,
        version: TOPIC_INBOX_READ_STORE_VERSION,
        storage: createValidatedPersistStorage<TopicInboxReadPersistedState>(
          backingStorage,
          TopicInboxReadPersistedSchema,
        ),
        partialize: (state) => ({ scopes: state.scopes }),
      },
    ),
  );
}

export const useTopicInboxReadStore = createTopicInboxReadStore();
