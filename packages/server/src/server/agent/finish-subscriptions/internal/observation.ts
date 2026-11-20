import type { Logger } from "pino";
import type { AgentManager } from "../../agent-manager.js";
import type { AgentStorage } from "../../agent-storage.js";
import type { AgentMessageDelivery } from "../../agent-messages/index.js";
import { buildStoredAgentPayload, toAgentPayload } from "../../agent-projections.js";
import { serializeSnapshotWithMetadata } from "../../mcp-shared.js";
import { createHostObservationResolver, type ToolHosts } from "../../host-operations/index.js";
import { openFinishObservation } from "./observation-stream.js";
import type { AgentStreamEvent } from "../../agent-sdk-types.js";
import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import type { FinishObservation } from "../index.js";

export function createFinishObservation(input: {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  /** A child chosen for restart recovery reports its state only after its resume was sent. */
  waitForResume(agentId: string, signal: AbortSignal): Promise<void>;
  messages(): AgentMessageDelivery;
  hosts(): ToolHosts;
  serverId: string;
  logger: Logger;
}): FinishObservation {
  const { agentManager, agentStorage } = input;
  const resolver = createHostObservationResolver({
    serverId: input.serverId,
    hosts: input.hosts,
    local: {
      async wait(agentId, signal) {
        await input.waitForResume(agentId, signal);
        await input.messages().waitForDispatch(agentId, signal);
        signal.throwIfAborted();
        const live = agentManager.getAgent(agentId);
        if (!live) {
          const stored = await agentStorage.get(agentId);
          return {
            status: stored?.lastStatus === "error" ? "error" : "idle",
            final: stored
              ? buildStoredAgentPayload(stored, [stored.provider], (provider, own) =>
                  agentManager.effectiveOptionsFor(provider, own),
                )
              : null,
            lastMessage: await agentManager.getCompletionAssistantMessage(
              agentId,
              null,
              stored?.lastStatus ?? "idle",
              stored?.lastError,
            ),
            error: stored?.lastError ?? null,
          };
        }
        const result = await agentManager.waitForAgentEvent(agentId, {
          signal,
          waitForActive: true,
          completionResponse: true,
        });
        const current = result.completionSnapshot;
        const status = result.permission ? "permission" : result.status;
        return {
          status: status === "permission" || status === "error" ? status : "idle",
          final: current
            ? await serializeSnapshotWithMetadata(agentStorage, current, input.logger)
            : null,
          lastMessage: result.lastMessage,
          error: current?.lastError ?? null,
        };
      },
      async observe(agentId, handler, signal, onError) {
        await input.waitForResume(agentId, signal);
        const stored = await agentStorage.get(agentId);
        let updates = Promise.resolve();
        const publish = (
          snapshot: AgentSnapshotPayload,
          event: AgentStreamEvent | undefined,
          lastMessage: string | null | Promise<string | null>,
        ) => {
          updates = Promise.all([updates, lastMessage])
            .then(([, message]) => handler(snapshot, event, message))
            .catch(onError);
        };
        signal.throwIfAborted();
        const unsubscribe = agentManager.subscribe(
          (event) => {
            if (event.type === "agent_state") {
              const status = event.agent.lifecycle;
              if (status === "closed") {
                publish(
                  toAgentPayload(event.agent, { title: stored?.title }),
                  undefined,
                  agentManager.getCompletionAssistantMessage(agentId, event.agent, status),
                );
              } else if (
                status === "error" &&
                event.agent.lastTurnCompletion?.event.type !== "turn_failed"
              ) {
                publish(toAgentPayload(event.agent, { title: stored?.title }), undefined, null);
              }
              return;
            }
            if (event.type === "agent_stream") {
              const streamEvent = event.event;
              if (
                streamEvent.type !== "turn_completed" &&
                streamEvent.type !== "turn_failed" &&
                streamEvent.type !== "turn_canceled" &&
                streamEvent.type !== "permission_requested" &&
                streamEvent.type !== "permission_resolved"
              )
                return;
              const current = agentManager.getAgent(agentId);
              if (!current) return;
              const completion = current.lastTurnCompletion;
              const snapshot = toAgentPayload(current, { title: stored?.title });
              if (completion?.event === streamEvent) {
                publish(snapshot, streamEvent, completion.lastMessage);
              } else if (streamEvent.type === "permission_requested") {
                publish(
                  snapshot,
                  streamEvent,
                  agentManager.getCompletionAssistantMessage(agentId, current, current.lifecycle),
                );
              } else if (streamEvent.type === "permission_resolved") {
                publish(snapshot, streamEvent, null);
              }
            }
          },
          { agentId, replayState: false },
        );
        const stop = () => unsubscribe();
        signal.addEventListener("abort", stop, { once: true });
        return async () => {
          signal.removeEventListener("abort", stop);
          unsubscribe();
        };
      },
    },
  });
  return { open: (record, signal) => openFinishObservation(resolver, record, signal) };
}
