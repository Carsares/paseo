import type { Logger } from "pino";
import type { AgentManager, ManagedAgent } from "../../agent-manager.js";
import type { AgentStorage } from "../../agent-storage.js";
import type { AgentMessageDelivery } from "../../agent-messages/index.js";
import { buildStoredAgentPayload, toAgentPayload } from "../../agent-projections.js";
import { serializeSnapshotWithMetadata } from "../../mcp-shared.js";
import { createHostObservationResolver, type ToolHosts } from "../../host-operations/index.js";
import { openFinishObservation } from "./observation-stream.js";
import type { AgentStreamEvent } from "../../agent-sdk-types.js";
import type { FinishObservation } from "../index.js";
import { resolveReportTitle } from "../../report-title.js";
import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";

function withReportTitle(
  agentId: string,
  snapshot: AgentSnapshotPayload | null,
  liveTitle?: string | null,
): AgentSnapshotPayload | null {
  return snapshot
    ? { ...snapshot, title: resolveReportTitle(agentId, snapshot.title, liveTitle) ?? null }
    : null;
}

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
          const final = stored
            ? buildStoredAgentPayload(stored, [stored.provider], (provider, own) =>
                agentManager.effectiveOptionsFor(provider, own),
              )
            : null;
          return {
            status: stored?.lastStatus === "error" ? "error" : "idle",
            final: withReportTitle(agentId, final),
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
        const final = current
          ? await serializeSnapshotWithMetadata(agentStorage, current, input.logger)
          : null;
        return {
          status: status === "permission" || status === "error" ? status : "idle",
          final: withReportTitle(agentId, final, current?.config.title),
          lastMessage: result.lastMessage,
          error: current?.lastError ?? null,
          turnId: current?.lastTurnCompletion?.event.turnId,
        };
      },
      async observe(agentId, handler, signal, onError) {
        await input.waitForResume(agentId, signal);
        let updates = Promise.resolve();
        const publish = (
          agent: ManagedAgent,
          event: AgentStreamEvent | undefined,
          lastMessage: string | null | Promise<string | null>,
          fallbackConfigTitle?: string | null,
        ) => {
          const snapshot = toAgentPayload(agent);
          updates = Promise.all([updates, lastMessage])
            .then(async ([, message]) => {
              const stored = await agentStorage.get(agentId);
              const title = resolveReportTitle(
                agentId,
                stored?.title,
                agentManager.getAgent(agentId)?.config.title,
                fallbackConfigTitle,
                snapshot.title,
              );
              return handler({ ...snapshot, title: title ?? null }, event, message);
            })
            .catch(onError);
        };
        const publishState = (agent: ManagedAgent) => {
          const status = agent.lifecycle;
          if (status === "closed") {
            publish(
              agent,
              undefined,
              agentManager.getCompletionAssistantMessage(agentId, agent, status),
              agent.config.title,
            );
          } else if (status === "error" && agent.lastTurnCompletion?.event.type !== "turn_failed") {
            publish(agent, undefined, null, agent.config.title);
          }
        };
        signal.throwIfAborted();
        const unsubscribe = agentManager.subscribe(
          (event) => {
            if (event.type === "agent_state") {
              publishState(event.agent);
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
              if (
                completion?.event === streamEvent ||
                (completion?.event.turnId &&
                  "turnId" in streamEvent &&
                  completion.event.turnId === streamEvent.turnId &&
                  completion.event.type === streamEvent.type)
              ) {
                publish(current, streamEvent, completion.lastMessage, current.config.title);
              } else if (streamEvent.type === "permission_requested") {
                publish(
                  current,
                  streamEvent,
                  agentManager.getCompletionAssistantMessage(agentId, current, current.lifecycle),
                  current.config.title,
                );
              } else if (streamEvent.type === "permission_resolved") {
                publish(current, streamEvent, null, current.config.title);
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
