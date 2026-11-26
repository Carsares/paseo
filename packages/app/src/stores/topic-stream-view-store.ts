import AsyncStorage from "@react-native-async-storage/async-storage";
import type {
  TopicReplyRouteMode,
  WorkspaceTodoItem,
  WorkspaceTodoSourceRef,
} from "@getpaseo/protocol/messages";
import { create } from "zustand";
import { persist, type StateStorage } from "zustand/middleware";
import { z } from "zod";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";

export type TopicStreamViewMode = "topics" | "timeline";

export interface ReturnTopicAnchor {
  serverId: string;
  workspaceId: string;
  mainAgentId: string;
  topicKey: string;
  taskId?: string;
  rootMessageId?: string;
  promptPreview: string;
  scrollOffset?: number;
}

export interface ActiveTopicReplyTarget {
  topicKey: string;
  taskId?: string;
  rootMessageId?: string;
  leadAgentId?: string;
  leadTitle?: string;
  promptPreview: string;
  routeMode: TopicReplyRouteMode;
  /** Stable idempotency key bound to the current draft submission intent until acknowledged or edited. */
  pendingClientMessageId?: string;
  pendingSubmissionSignature?: string;
}

export interface PendingTopicScrollTarget {
  topicKey: string;
  taskId?: string;
  rootMessageId?: string;
  requestId: number;
  highlight?: boolean;
}

export interface TodoEditorRequest {
  serverId: string;
  workspaceId: string;
  existingTodo?: WorkspaceTodoItem;
  initialTitle?: string;
  initialNote?: string;
  source?: WorkspaceTodoSourceRef | null;
}

const TOPIC_STREAM_VIEW_STORAGE_KEY = "topic-stream-view";
const TOPIC_STREAM_VIEW_STORE_VERSION = 1;
const MAX_PERSISTED_AGENT_KEYS = 200;

const TopicStreamViewPersistedSchema = z.strictObject({
  viewModeByAgentKey: z.record(z.string(), z.enum(["topics", "timeline"])).optional(),
  unreadOnlyByAgentKey: z.record(z.string(), z.boolean()).optional(),
});

type TopicStreamViewPersistedState = z.infer<typeof TopicStreamViewPersistedSchema>;

export function buildTopicAgentKey(serverId: string, agentId: string): string {
  return `${serverId}:${agentId}`;
}

export function buildTopicDisclosureKey(agentKey: string, topicKey: string): string {
  return `${agentKey}\0${topicKey}`;
}

function boundRecord<T>(
  record: Record<string, T>,
  maxKeys = MAX_PERSISTED_AGENT_KEYS,
): Record<string, T> {
  const keys = Object.keys(record);
  if (keys.length <= maxKeys) return record;
  const kept = keys.slice(keys.length - maxKeys);
  const next: Record<string, T> = {};
  for (const key of kept) {
    next[key] = record[key]!;
  }
  return next;
}

let nextScrollRequestId = 1;

export interface TopicStreamViewState {
  viewModeByAgentKey: Record<string, TopicStreamViewMode>;
  unreadOnlyByAgentKey: Record<string, boolean>;
  expandedProcessByTopicKey: Record<string, boolean>;
  expandedHistoryByTopicKey: Record<string, boolean>;
  returnTopicAnchorByAgentKey: Record<string, ReturnTopicAnchor>;
  activeReplyTopicByAgentKey: Record<string, ActiveTopicReplyTarget | null>;
  pendingScrollTopicByAgentKey: Record<string, PendingTopicScrollTarget | null>;
  todoEditorRequest: TodoEditorRequest | null;

  setViewMode: (agentKey: string, mode: TopicStreamViewMode) => void;
  setUnreadOnly: (agentKey: string, unreadOnly: boolean) => void;
  toggleUnreadOnly: (agentKey: string) => void;
  setProcessExpanded: (disclosureKey: string, expanded: boolean) => void;
  setHistoryExpanded: (disclosureKey: string, expanded: boolean) => void;
  setReturnTopicAnchor: (subagentKey: string, anchor: ReturnTopicAnchor | null) => void;
  setActiveReplyTopic: (agentKey: string, target: ActiveTopicReplyTarget | null) => void;
  setActiveReplyRouteMode: (agentKey: string, routeMode: TopicReplyRouteMode) => void;
  setActiveReplySubmissionIntent: (
    agentKey: string,
    submissionSignature: string | undefined,
    clientMessageId: string | undefined,
  ) => void;
  requestScrollToTopic: (
    agentKey: string,
    topicKey: string,
    highlight?: boolean,
    refs?: { taskId?: string; rootMessageId?: string },
  ) => number;
  acknowledgeScrollToTopic: (agentKey: string, requestId: number) => void;
  openTodoEditor: (request: TodoEditorRequest) => void;
  closeTodoEditor: () => void;
}

export function createTopicStreamViewStore(backingStorage: StateStorage = AsyncStorage) {
  return create<TopicStreamViewState>()(
    persist(
      (set) => ({
        viewModeByAgentKey: {},
        unreadOnlyByAgentKey: {},
        expandedProcessByTopicKey: {},
        expandedHistoryByTopicKey: {},
        returnTopicAnchorByAgentKey: {},
        activeReplyTopicByAgentKey: {},
        pendingScrollTopicByAgentKey: {},
        todoEditorRequest: null,

        setViewMode: (agentKey, mode) =>
          set((state) => {
            if (state.viewModeByAgentKey[agentKey] === mode) return state;
            return {
              viewModeByAgentKey: boundRecord({
                ...state.viewModeByAgentKey,
                [agentKey]: mode,
              }),
            };
          }),

        setUnreadOnly: (agentKey, unreadOnly) =>
          set((state) => {
            if ((state.unreadOnlyByAgentKey[agentKey] ?? false) === unreadOnly) return state;
            return {
              unreadOnlyByAgentKey: boundRecord({
                ...state.unreadOnlyByAgentKey,
                [agentKey]: unreadOnly,
              }),
            };
          }),

        toggleUnreadOnly: (agentKey) =>
          set((state) => ({
            unreadOnlyByAgentKey: boundRecord({
              ...state.unreadOnlyByAgentKey,
              [agentKey]: !(state.unreadOnlyByAgentKey[agentKey] ?? false),
            }),
          })),

        setProcessExpanded: (disclosureKey, expanded) =>
          set((state) => {
            if ((state.expandedProcessByTopicKey[disclosureKey] ?? false) === expanded) {
              return state;
            }
            return {
              expandedProcessByTopicKey: {
                ...state.expandedProcessByTopicKey,
                [disclosureKey]: expanded,
              },
            };
          }),

        setHistoryExpanded: (disclosureKey, expanded) =>
          set((state) => {
            if ((state.expandedHistoryByTopicKey[disclosureKey] ?? false) === expanded) {
              return state;
            }
            return {
              expandedHistoryByTopicKey: {
                ...state.expandedHistoryByTopicKey,
                [disclosureKey]: expanded,
              },
            };
          }),

        setReturnTopicAnchor: (subagentKey, anchor) =>
          set((state) => {
            const next = { ...state.returnTopicAnchorByAgentKey };
            if (anchor) {
              next[subagentKey] = anchor;
            } else {
              delete next[subagentKey];
            }
            return { returnTopicAnchorByAgentKey: next };
          }),

        setActiveReplyTopic: (agentKey, target) =>
          set((state) => ({
            activeReplyTopicByAgentKey: {
              ...state.activeReplyTopicByAgentKey,
              [agentKey]: target,
            },
          })),

        setActiveReplyRouteMode: (agentKey, routeMode) =>
          set((state) => {
            const current = state.activeReplyTopicByAgentKey[agentKey];
            if (!current || current.routeMode === routeMode) return state;
            return {
              activeReplyTopicByAgentKey: {
                ...state.activeReplyTopicByAgentKey,
                [agentKey]: {
                  ...current,
                  routeMode,
                  pendingClientMessageId: undefined,
                  pendingSubmissionSignature: undefined,
                },
              },
            };
          }),

        setActiveReplySubmissionIntent: (agentKey, submissionSignature, clientMessageId) =>
          set((state) => {
            const current = state.activeReplyTopicByAgentKey[agentKey];
            if (!current) return state;
            if (
              current.pendingSubmissionSignature === submissionSignature &&
              current.pendingClientMessageId === clientMessageId
            ) {
              return state;
            }
            return {
              activeReplyTopicByAgentKey: {
                ...state.activeReplyTopicByAgentKey,
                [agentKey]: {
                  ...current,
                  pendingSubmissionSignature: submissionSignature,
                  pendingClientMessageId: clientMessageId,
                },
              },
            };
          }),

        requestScrollToTopic: (agentKey, topicKey, highlight = true, refs) => {
          const requestId = nextScrollRequestId++;
          set((state) => ({
            pendingScrollTopicByAgentKey: {
              ...state.pendingScrollTopicByAgentKey,
              [agentKey]: {
                topicKey,
                ...(refs?.taskId ? { taskId: refs.taskId } : {}),
                ...(refs?.rootMessageId ? { rootMessageId: refs.rootMessageId } : {}),
                requestId,
                highlight,
              },
            },
          }));
          return requestId;
        },

        acknowledgeScrollToTopic: (agentKey, requestId) =>
          set((state) => {
            const current = state.pendingScrollTopicByAgentKey[agentKey];
            if (!current || current.requestId !== requestId) return state;
            return {
              pendingScrollTopicByAgentKey: {
                ...state.pendingScrollTopicByAgentKey,
                [agentKey]: null,
              },
            };
          }),

        openTodoEditor: (request) => set({ todoEditorRequest: request }),
        closeTodoEditor: () => set({ todoEditorRequest: null }),
      }),
      {
        name: TOPIC_STREAM_VIEW_STORAGE_KEY,
        version: TOPIC_STREAM_VIEW_STORE_VERSION,
        storage: createValidatedPersistStorage<TopicStreamViewPersistedState>(
          backingStorage,
          TopicStreamViewPersistedSchema,
        ),
        partialize: (state) => ({
          viewModeByAgentKey: state.viewModeByAgentKey,
          unreadOnlyByAgentKey: state.unreadOnlyByAgentKey,
        }),
      },
    ),
  );
}

export const useTopicStreamViewStore = createTopicStreamViewStore();
