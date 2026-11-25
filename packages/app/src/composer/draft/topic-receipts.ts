import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { isMainControlAgent } from "@getpaseo/protocol/agent-labels";
import type { CreationSnapshot, WorkspaceDescriptorPayload } from "@getpaseo/protocol/messages";

export function creationSnapshotMatches(
  snapshot: CreationSnapshot | null | undefined,
  identity: Pick<CreationSnapshot, "kind" | "idempotencyKey">,
): snapshot is CreationSnapshot {
  return snapshot?.kind === identity.kind && snapshot.idempotencyKey === identity.idempotencyKey;
}

export function isUnboundTopicWorkspace(
  workspace: WorkspaceDescriptorPayload | null,
  workspaceId: string,
) {
  return (
    workspace?.id === workspaceId &&
    workspace.topic?.mainAgentId === null &&
    workspace.hasActiveMainAgent === false
  );
}

export function isRejectedBoundTopicPrompt(
  receipt: CreationSnapshot | null,
  workspace: WorkspaceDescriptorPayload | null,
  workspaceId: string,
  agentId: string,
) {
  const agent = receipt?.agent;
  return (
    receipt?.phase === "failed" &&
    receipt.failedStage === "prompt" &&
    receipt.outcomeUnknown === false &&
    !receipt.initialPromptStarted &&
    receipt.workspaceId === workspaceId &&
    workspace?.id === workspaceId &&
    !workspace.archivingAt &&
    workspace.topic?.mainAgentId === agentId &&
    agent?.id === agentId &&
    agent.workspaceId === workspaceId &&
    !agent.archivedAt &&
    isMainControlAgent(agent)
  );
}

/** A rejected attempt may be on the timeline. Only the creation receipt proves acceptance. */
export function isTopicPromptAccepted(receipt: CreationSnapshot | null | undefined) {
  return Boolean(
    receipt &&
    !receipt.outcomeUnknown &&
    (receipt.initialPromptStarted === true || receipt.phase === "prompt_started"),
  );
}

/**
 * Listen to existing creation subscriptions and refresh by key after a remount. Wave 0 exposes
 * a read-only snapshot API, but adoption of a creation's owned subscription is client-private.
 */
export function watchTopicCreation(
  client: Pick<DaemonClient, "subscribeRawMessages">,
  identity: Pick<CreationSnapshot, "kind" | "idempotencyKey">,
  refresh: (snapshot?: CreationSnapshot) => Promise<boolean>,
): () => void {
  let stopped = false;
  let running = false;
  let queued: CreationSnapshot | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    unsubscribe();
  };
  const update = async (snapshot?: CreationSnapshot) => {
    if (stopped) return;
    if (running) {
      if (snapshot && (!queued || snapshot.revision >= queued.revision)) queued = snapshot;
      return;
    }
    clearTimeout(timer);
    running = true;
    const finished = await refresh(snapshot).catch(() => false);
    running = false;
    if (stopped) return;
    if (finished) {
      stop();
    } else if (queued) {
      const next = queued;
      queued = undefined;
      void update(next);
    } else {
      timer = setTimeout(() => void update(), 4_000);
    }
  };
  const unsubscribe = client.subscribeRawMessages((message) => {
    if (
      (message.type === "workspace.create.update" || message.type === "agent.create.update") &&
      creationSnapshotMatches(message.payload, identity)
    ) {
      void update(message.payload);
    }
  });
  void update();
  return stop;
}
