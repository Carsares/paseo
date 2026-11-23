import AsyncStorage from "@react-native-async-storage/async-storage";
import { WorkspaceCreateRequestSchema } from "@getpaseo/protocol/messages";
import { z } from "zod";

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
const draftSchema = z.object({ target: targetSchema, attempt: attemptSchema.optional() });

export type MainDraftTarget = z.infer<typeof targetSchema>;
export type MainDraftAttempt = z.infer<typeof attemptSchema>;
export type MainDraft = z.infer<typeof draftSchema>;

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

export async function readMainDraft(id: string): Promise<MainDraft | null> {
  await writes.get(id);
  const raw = await AsyncStorage.getItem(storageKey(id));
  return raw === null ? null : draftSchema.parse(JSON.parse(raw));
}

export function writeMainDraft(id: string, draft: MainDraft | null): Promise<void> {
  const write = (writes.get(id) ?? Promise.resolve())
    .catch(() => undefined)
    .then(() =>
      draft
        ? AsyncStorage.setItem(storageKey(id), JSON.stringify(draft))
        : AsyncStorage.removeItem(storageKey(id)),
    );
  writes.set(id, write);
  const release = () => {
    if (writes.get(id) === write) writes.delete(id);
  };
  void write.then(release, release);
  return write;
}
