import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  WorkspaceCreateRequestSchema,
  WorkspaceInitialAgentSchema,
} from "@getpaseo/protocol/messages";
import { z } from "zod";
import { MAX_WORKSPACE_BATCH_MODELS } from "@/composer/agent-controls/model-sheet-flow";
import { isWeb } from "@/constants/platform";

const targetSchema = z.object({
  serverId: z.string().min(1),
  projectId: z.string().min(1),
  sourceDirectory: z.string().min(1),
  directory: z.string().min(1),
  isolation: z.enum(["local", "worktree", "existing"]),
});
const attemptSchema = z.object({
  workspaceId: z.string(),
  agentId: z.string(),
  kind: z.enum(["workspace", "agent"]),
  placement: WorkspaceCreateRequestSchema.pick({ source: true, title: true, metadata: true }),
});
const modelSchema = z.object({
  provider: z.string(),
  providerLabel: z.string(),
  modelId: z.string(),
  modelLabel: z.string(),
});

const fixedPlacementSchema = attemptSchema.shape.placement.extend({
  source: WorkspaceCreateRequestSchema.shape.source.options[1].extend({
    action: z.literal("branch-off"),
    refName: z.string().min(1),
    startPoint: z.string().min(1),
    worktreeSlug: z.string().min(1),
    branchName: z.string().min(1),
  }),
});

const batchItemSchema = z.object({
  model: modelSchema,
  config: WorkspaceInitialAgentSchema.shape.config,
  placement: fixedPlacementSchema,
  workspaceId: z.string(),
  agentId: z.string(),
  recoveryAgentId: z.string(),
  clientMessageId: z.string(),
  attemptKind: attemptSchema.shape.kind,
  stage: z.enum(["queued", "sending", "retryable", "unconfirmed", "succeeded"]),
  agentReady: z.boolean().optional(),
  promptConfirmed: z.boolean().optional(),
  error: z.string().optional(),
});

const batchSchema = z.object({
  message: WorkspaceInitialAgentSchema.pick({
    initialPrompt: true,
    images: true,
    attachments: true,
    metadata: true,
  }),
  items: z.array(batchItemSchema).min(2).max(MAX_WORKSPACE_BATCH_MODELS),
});

const draftSchema = z.object({
  target: targetSchema,
  attempt: attemptSchema.optional(),
  models: z.array(modelSchema).min(1).max(MAX_WORKSPACE_BATCH_MODELS).optional(),
  batch: batchSchema.optional(),
});

export type MainDraftTarget = z.infer<typeof targetSchema>;
export type MainDraftAttempt = z.infer<typeof attemptSchema>;
export type MainDraft = z.infer<typeof draftSchema>;
export type MainDraftBatch = z.infer<typeof batchSchema>;
export type MainDraftBatchItem = z.infer<typeof batchItemSchema>;

export function sameMainDraftTarget(left: MainDraftTarget, right: MainDraftTarget) {
  return (
    left.serverId === right.serverId &&
    left.projectId === right.projectId &&
    left.sourceDirectory === right.sourceDirectory &&
    left.directory === right.directory &&
    left.isolation === right.isolation
  );
}

export function restoreMainDraftAtTarget(draft: MainDraft | null, target: MainDraftTarget | null) {
  return draft && target && sameMainDraftTarget(draft.target, target) ? draft : null;
}

const storageKey = (id: string) => `paseo:new-workspace-main:${id}`;
const writes = new Map<string, Promise<void>>();
const batchListeners = new Map<string, Set<(draft: MainDraft | null) => void>>();

function withDraftLock<T>(key: string, run: () => Promise<T>): Promise<T> {
  const locks = isWeb ? globalThis.navigator?.locks : undefined;
  return locks ? locks.request(key, run) : run();
}

export function canCoordinateMainDraftWindows(): boolean {
  return !isWeb || Boolean(globalThis.navigator?.locks);
}

export function withMainDraftOperation<T>(id: string, run: () => Promise<T>): Promise<T> {
  return withDraftLock(`${storageKey(id)}:operation`, run);
}

export function subscribeToMainDraftBatch(id: string, listener: (draft: MainDraft | null) => void) {
  const listeners = batchListeners.get(id) ?? new Set();
  listeners.add(listener);
  batchListeners.set(id, listeners);
  const browser = isWeb && typeof window !== "undefined" ? window : undefined;
  const onStorage = (event: StorageEvent) => {
    if (event.key !== storageKey(id)) return;
    if (event.newValue === null) {
      if (parseMainDraft(event.oldValue)?.batch) listener(null);
    } else {
      const draft = parseMainDraft(event.newValue);
      if (draft?.batch) listener(draft);
    }
  };
  browser?.addEventListener("storage", onStorage);
  return () => {
    browser?.removeEventListener("storage", onStorage);
    listeners.delete(listener);
    if (listeners.size === 0) batchListeners.delete(id);
  };
}

function parseMainDraft(raw: string | null): MainDraft | null {
  return raw === null ? null : draftSchema.parse(JSON.parse(raw));
}

export async function readMainDraft(id: string): Promise<MainDraft | null> {
  await writes.get(id);
  return parseMainDraft(await AsyncStorage.getItem(storageKey(id)));
}

export function writeMainDraft(
  id: string,
  draft: MainDraft | null,
  options?: { finishBatch?: boolean },
): Promise<void> {
  const key = storageKey(id);
  const write = (writes.get(id) ?? Promise.resolve())
    .catch(() => undefined)
    .then(() =>
      withDraftLock(key, async () => {
        const previous = parseMainDraft(await AsyncStorage.getItem(key));
        if (previous?.batch && !draft?.batch && !options?.finishBatch) {
          for (const listener of batchListeners.get(id) ?? []) listener(previous);
          return;
        }
        if (!draft) {
          await AsyncStorage.removeItem(key);
          if (previous?.batch) {
            for (const listener of batchListeners.get(id) ?? []) listener(null);
          }
          return;
        }
        await AsyncStorage.setItem(key, JSON.stringify(draft));
        // An active submission may outlive a screen remounted at another breakpoint.
        if (draft.batch) {
          for (const listener of batchListeners.get(id) ?? []) listener(draft);
        }
      }),
    );
  writes.set(id, write);
  const release = () => {
    if (writes.get(id) === write) writes.delete(id);
  };
  void write.then(release, release);
  return write;
}
