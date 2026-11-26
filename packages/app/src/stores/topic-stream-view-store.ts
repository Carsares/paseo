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

export interface ActiveTopicDecisionContext {
  kind: "task_blocking_question";
  taskId?: string;
  question: string;
  /** Generation UUID locked when the user began composing this decision reply. */
  blockingQuestionGeneration?: string;
  /** Inline conflict message shown when the server rejects a stale blocking question generation. */
  staleNotice?: string;
}

export interface ActiveTopicReplyTarget {
  topicKey: string;
  taskId?: string;
  rootMessageId?: string;
  leadAgentId?: string;
  leadTitle?: string;
  promptPreview: string;
  routeMode: TopicReplyRouteMode;
  decisionContext?: ActiveTopicDecisionContext;
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

export interface TopicDecisionDraftMeta {
  taskId?: string;
  /** Blocking question generation UUID locked when the user authored this draft. */
  blockingQuestionGeneration?: string;
  /** Generation explicitly rejected as stale by the server (permits adopting a newer non-empty generation). */
  acknowledgedStaleGeneration?: string;
  /** Stable idempotency key bound to the current draft submission intent. */
  pendingClientMessageId?: string;
  pendingSubmissionKey?: string;
}

export interface ActiveTopicDecisionTargetMatch {
  topicKey: string;
  taskId?: string;
  decisionKind: ActiveTopicDecisionContext["kind"];
  decisionTaskId?: string;
  blockingQuestionGeneration?: string;
}

export interface RefreshActiveDecisionContextUpdate {
  expectedTarget: ActiveTopicDecisionTargetMatch;
  question?: string;
  blockingQuestionGeneration?: string;
  staleNotice: string;
}

export interface TopicStreamViewState {
  viewModeByAgentKey: Record<string, TopicStreamViewMode>;
  unreadOnlyByAgentKey: Record<string, boolean>;
  expandedProcessByTopicKey: Record<string, boolean>;
  expandedHistoryByTopicKey: Record<string, boolean>;
  expandedConflictsByTopicKey: Record<string, boolean>;
  decisionDraftByTopicKey: Record<string, string>;
  decisionDraftMetaByTopicKey: Record<string, TopicDecisionDraftMeta>;
  returnTopicAnchorByAgentKey: Record<string, ReturnTopicAnchor>;
  activeReplyTopicByAgentKey: Record<string, ActiveTopicReplyTarget | null>;
  pendingScrollTopicByAgentKey: Record<string, PendingTopicScrollTarget | null>;
  todoEditorRequest: TodoEditorRequest | null;

  setViewMode: (agentKey: string, mode: TopicStreamViewMode) => void;
  setUnreadOnly: (agentKey: string, unreadOnly: boolean) => void;
  toggleUnreadOnly: (agentKey: string) => void;
  setProcessExpanded: (disclosureKey: string, expanded: boolean) => void;
  setHistoryExpanded: (disclosureKey: string, expanded: boolean) => void;
  setConflictsExpanded: (disclosureKey: string, expanded: boolean) => void;
  setDecisionDraft: (
    disclosureKey: string,
    text: string,
    meta?: {
      taskId?: string;
      blockingQuestionGeneration?: string;
      forceGeneration?: boolean;
    },
  ) => void;
  setDecisionDraftSubmissionIntent: (
    disclosureKey: string,
    submissionKey: string,
    clientMessageId: string,
  ) => void;
  acknowledgeStaleDecisionDraft: (
    disclosureKey: string,
    expected: {
      taskId?: string;
      submittedGeneration?: string;
    },
    next: {
      latestBlockingQuestionGeneration?: string;
      hasLatestTask?: boolean;
    },
  ) => void;
  setReturnTopicAnchor: (subagentKey: string, anchor: ReturnTopicAnchor | null) => void;
  setActiveReplyTopic: (agentKey: string, target: ActiveTopicReplyTarget | null) => void;
  clearActiveReplyTopicIfMatches: (
    agentKey: string,
    expected: {
      topicKey: string;
      taskId?: string;
      decisionKind?: ActiveTopicDecisionContext["kind"];
      decisionTaskId?: string;
      blockingQuestionGeneration?: string;
    },
  ) => void;
  setActiveReplyRouteMode: (agentKey: string, routeMode: TopicReplyRouteMode) => void;
  setActiveReplySubmissionIntent: (
    agentKey: string,
    submissionSignature: string | undefined,
    clientMessageId: string | undefined,
    expectedTopicKey?: string,
  ) => void;
  refreshActiveDecisionContext: (
    agentKey: string,
    update: RefreshActiveDecisionContextUpdate,
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

function matchesActiveReplyTarget(
  current: ActiveTopicReplyTarget | null | undefined,
  expected: {
    topicKey: string;
    taskId?: string;
    decisionKind?: ActiveTopicDecisionContext["kind"];
    decisionTaskId?: string;
    blockingQuestionGeneration?: string;
  },
): current is ActiveTopicReplyTarget {
  if (!current) return false;
  if (current.topicKey !== expected.topicKey || current.taskId !== expected.taskId) return false;
  if (expected.decisionKind === undefined) {
    return current.decisionContext === undefined;
  }
  return (
    current.decisionContext?.kind === expected.decisionKind &&
    current.decisionContext?.taskId === expected.decisionTaskId &&
    current.decisionContext?.blockingQuestionGeneration === expected.blockingQuestionGeneration
  );
}

function resolveNextDraftGeneration(input: {
  trimmedText: string;
  previousGeneration?: string;
  acknowledgedStale?: string;
  incomingGeneration?: string;
  forceGeneration?: boolean;
}): string | undefined {
  if (!input.trimmedText) return undefined;
  if (input.forceGeneration) return input.incomingGeneration;
  const canAdoptNewerAfterStale =
    Boolean(input.previousGeneration) &&
    input.acknowledgedStale === input.previousGeneration &&
    Boolean(input.incomingGeneration) &&
    input.incomingGeneration !== input.previousGeneration;
  if (canAdoptNewerAfterStale) return input.incomingGeneration;
  return input.previousGeneration ?? input.incomingGeneration;
}

function resolveSubmissionIntentFields(
  prevMeta: TopicDecisionDraftMeta | undefined,
  trimmedText: string,
  unchangedGeneration: boolean,
  forceGeneration?: boolean,
): Pick<TopicDecisionDraftMeta, "pendingClientMessageId" | "pendingSubmissionKey"> {
  const previousKey = prevMeta?.pendingSubmissionKey;
  if (forceGeneration || !unchangedGeneration || !previousKey?.endsWith(`\0${trimmedText}`)) {
    return { pendingClientMessageId: undefined, pendingSubmissionKey: undefined };
  }
  return {
    pendingClientMessageId: prevMeta?.pendingClientMessageId,
    pendingSubmissionKey: previousKey,
  };
}

function resolveNextDecisionDraftMeta(
  prevMeta: TopicDecisionDraftMeta | undefined,
  trimmedText: string,
  meta?: {
    taskId?: string;
    blockingQuestionGeneration?: string;
    forceGeneration?: boolean;
  },
): TopicDecisionDraftMeta {
  const prevTaskId = prevMeta?.taskId;
  const incomingTaskId = meta?.taskId;
  const sameTask = !prevTaskId || !incomingTaskId || prevTaskId === incomingTaskId;
  const previousGeneration = sameTask ? prevMeta?.blockingQuestionGeneration : undefined;
  const acknowledgedStale = sameTask ? prevMeta?.acknowledgedStaleGeneration : undefined;
  const nextGeneration = resolveNextDraftGeneration({
    trimmedText,
    previousGeneration,
    acknowledgedStale,
    incomingGeneration: meta?.blockingQuestionGeneration,
    forceGeneration: meta?.forceGeneration,
  });
  const unchangedGeneration = nextGeneration === previousGeneration;
  const intent = resolveSubmissionIntentFields(
    prevMeta,
    trimmedText,
    unchangedGeneration,
    meta?.forceGeneration,
  );

  return {
    taskId: incomingTaskId ?? (sameTask ? prevTaskId : undefined),
    blockingQuestionGeneration: nextGeneration,
    acknowledgedStaleGeneration: unchangedGeneration ? acknowledgedStale : undefined,
    ...intent,
  };
}

function matchesStaleDraftTarget(
  currentMeta: TopicDecisionDraftMeta | undefined,
  expected: { taskId?: string; submittedGeneration?: string },
): boolean {
  if (currentMeta?.taskId && expected.taskId && currentMeta.taskId !== expected.taskId) {
    return false;
  }
  if (
    currentMeta?.blockingQuestionGeneration &&
    expected.submittedGeneration &&
    currentMeta.blockingQuestionGeneration !== expected.submittedGeneration
  ) {
    return false;
  }
  return true;
}

function buildAcknowledgedStaleDraftMeta(
  currentMeta: TopicDecisionDraftMeta | undefined,
  expected: { taskId?: string; submittedGeneration?: string },
  next: { latestBlockingQuestionGeneration?: string; hasLatestTask?: boolean },
): TopicDecisionDraftMeta {
  const taskId = expected.taskId ?? currentMeta?.taskId;
  const nextGeneration = next.latestBlockingQuestionGeneration?.trim() || undefined;
  if (nextGeneration) {
    return {
      ...currentMeta,
      taskId,
      blockingQuestionGeneration: nextGeneration,
      acknowledgedStaleGeneration: undefined,
      pendingClientMessageId: undefined,
      pendingSubmissionKey: undefined,
    };
  }
  const lockedGeneration = currentMeta?.blockingQuestionGeneration ?? expected.submittedGeneration;
  // When the server returned a latest task with no active blocking question generation,
  // keep the previous generation locked so retries can never degrade to versionless.
  if (next.hasLatestTask) {
    return {
      ...currentMeta,
      taskId,
      blockingQuestionGeneration: lockedGeneration,
      acknowledgedStaleGeneration: undefined,
    };
  }
  return {
    ...currentMeta,
    taskId,
    blockingQuestionGeneration: lockedGeneration,
    acknowledgedStaleGeneration: lockedGeneration,
    pendingClientMessageId: undefined,
    pendingSubmissionKey: undefined,
  };
}

export function createTopicStreamViewStore(backingStorage: StateStorage = AsyncStorage) {
  return create<TopicStreamViewState>()(
    persist(
      (set) => ({
        viewModeByAgentKey: {},
        unreadOnlyByAgentKey: {},
        expandedProcessByTopicKey: {},
        expandedHistoryByTopicKey: {},
        expandedConflictsByTopicKey: {},
        decisionDraftByTopicKey: {},
        decisionDraftMetaByTopicKey: {},
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

        setConflictsExpanded: (disclosureKey, expanded) =>
          set((state) => {
            if ((state.expandedConflictsByTopicKey[disclosureKey] ?? false) === expanded) {
              return state;
            }
            return {
              expandedConflictsByTopicKey: {
                ...state.expandedConflictsByTopicKey,
                [disclosureKey]: expanded,
              },
            };
          }),

        setDecisionDraft: (disclosureKey, text, meta) =>
          set((state) => {
            const currentText = state.decisionDraftByTopicKey[disclosureKey] ?? "";
            const nextDrafts = { ...state.decisionDraftByTopicKey };
            const nextMetas = { ...state.decisionDraftMetaByTopicKey };
            if (text.length === 0) {
              if (!(disclosureKey in nextDrafts) && !(disclosureKey in nextMetas)) return state;
              delete nextDrafts[disclosureKey];
              delete nextMetas[disclosureKey];
              return {
                decisionDraftByTopicKey: nextDrafts,
                decisionDraftMetaByTopicKey: nextMetas,
              };
            }
            const prevMeta = currentText.trim()
              ? state.decisionDraftMetaByTopicKey[disclosureKey]
              : undefined;
            const nextMeta = resolveNextDecisionDraftMeta(prevMeta, text.trim(), meta);
            nextDrafts[disclosureKey] = text;
            nextMetas[disclosureKey] = nextMeta;
            return {
              decisionDraftByTopicKey: nextDrafts,
              decisionDraftMetaByTopicKey: nextMetas,
            };
          }),

        setDecisionDraftSubmissionIntent: (disclosureKey, submissionKey, clientMessageId) =>
          set((state) => {
            const currentText = state.decisionDraftByTopicKey[disclosureKey] ?? "";
            const prevMeta = currentText
              ? state.decisionDraftMetaByTopicKey[disclosureKey]
              : undefined;
            if (
              prevMeta?.pendingSubmissionKey === submissionKey &&
              prevMeta?.pendingClientMessageId === clientMessageId
            ) {
              return state;
            }
            return {
              decisionDraftMetaByTopicKey: {
                ...state.decisionDraftMetaByTopicKey,
                [disclosureKey]: {
                  ...prevMeta,
                  pendingSubmissionKey: submissionKey,
                  pendingClientMessageId: clientMessageId,
                },
              },
            };
          }),

        acknowledgeStaleDecisionDraft: (disclosureKey, expected, next) =>
          set((state) => {
            const currentText = state.decisionDraftByTopicKey[disclosureKey] ?? "";
            if (!currentText.trim()) return state;
            const currentMeta = state.decisionDraftMetaByTopicKey[disclosureKey];
            if (!matchesStaleDraftTarget(currentMeta, expected)) return state;
            return {
              decisionDraftMetaByTopicKey: {
                ...state.decisionDraftMetaByTopicKey,
                [disclosureKey]: buildAcknowledgedStaleDraftMeta(currentMeta, expected, next),
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

        clearActiveReplyTopicIfMatches: (agentKey, expected) =>
          set((state) => {
            const current = state.activeReplyTopicByAgentKey[agentKey];
            if (!matchesActiveReplyTarget(current, expected)) return state;
            return {
              activeReplyTopicByAgentKey: {
                ...state.activeReplyTopicByAgentKey,
                [agentKey]: null,
              },
            };
          }),

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

        setActiveReplySubmissionIntent: (
          agentKey,
          submissionSignature,
          clientMessageId,
          expectedTopicKey,
        ) =>
          set((state) => {
            const current = state.activeReplyTopicByAgentKey[agentKey];
            if (!current) return state;
            if (expectedTopicKey && current.topicKey !== expectedTopicKey) return state;
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

        refreshActiveDecisionContext: (agentKey, update) =>
          set((state) => {
            const current = state.activeReplyTopicByAgentKey[agentKey];
            if (
              !matchesActiveReplyTarget(current, update.expectedTarget) ||
              !current.decisionContext
            ) {
              return state;
            }
            const nextGeneration = update.blockingQuestionGeneration?.trim() || undefined;
            if (!nextGeneration) {
              // No valid new blocking question generation exists: keep the original generation
              // locked and preserve submission intent so we never downgrade to versionless submit.
              return {
                activeReplyTopicByAgentKey: {
                  ...state.activeReplyTopicByAgentKey,
                  [agentKey]: {
                    ...current,
                    decisionContext: {
                      ...current.decisionContext,
                      staleNotice: update.staleNotice,
                    },
                  },
                },
              };
            }
            return {
              activeReplyTopicByAgentKey: {
                ...state.activeReplyTopicByAgentKey,
                [agentKey]: {
                  ...current,
                  pendingClientMessageId: undefined,
                  pendingSubmissionSignature: undefined,
                  decisionContext: {
                    ...current.decisionContext,
                    question: update.question ?? current.decisionContext.question,
                    blockingQuestionGeneration: nextGeneration,
                    staleNotice: update.staleNotice,
                  },
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
