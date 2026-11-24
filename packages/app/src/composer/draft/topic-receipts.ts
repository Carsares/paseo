import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { CreationSnapshot } from "@getpaseo/protocol/messages";

export function creationSnapshotMatches(
  snapshot: CreationSnapshot | null | undefined,
  identity: Pick<CreationSnapshot, "kind" | "idempotencyKey">,
): snapshot is CreationSnapshot {
  return snapshot?.kind === identity.kind && snapshot.idempotencyKey === identity.idempotencyKey;
}

/** A timeline match is positive evidence only. An absent or truncated page cannot prove rejection. */
export async function readTopicPromptReceipt(
  client: Pick<DaemonClient, "fetchAgentTimeline">,
  agentId: string,
  clientMessageId: string,
): Promise<"recorded" | "not-found" | "unavailable"> {
  try {
    const page = await client.fetchAgentTimeline(agentId, { direction: "tail", limit: 100 });
    if (page.error || page.agentId !== agentId) return "unavailable";
    return page.entries.some(
      ({ item }) =>
        item.type === "user_message" &&
        (item.clientMessageId === clientMessageId || item.messageId === clientMessageId),
    )
      ? "recorded"
      : "not-found";
  } catch {
    return "unavailable";
  }
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
