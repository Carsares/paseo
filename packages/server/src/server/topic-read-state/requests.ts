import type {
  WorkspaceTopicReadGetStateRequest,
  WorkspaceTopicReadGetStateResponse,
  WorkspaceTopicReadMarkAllRequest,
  WorkspaceTopicReadMarkAllResponse,
  WorkspaceTopicReadMarkRequest,
  WorkspaceTopicReadMarkResponse,
  WorkspaceTopicReadUpdatedMessage,
} from "@getpaseo/protocol/messages";
import type { TopicReadKey, TopicReadScope, TopicReadStateStore } from "./store.js";

export type TopicReadRequest =
  | WorkspaceTopicReadGetStateRequest
  | WorkspaceTopicReadMarkRequest
  | WorkspaceTopicReadMarkAllRequest;

type TopicReadResponse =
  | WorkspaceTopicReadGetStateResponse
  | WorkspaceTopicReadMarkResponse
  | WorkspaceTopicReadMarkAllResponse;

export interface TopicReadRequestOptions {
  store: TopicReadStateStore;
  /** Resolve only visible, active workspace/main-agent pairs for this caller. */
  resolveScopes(selector: Partial<TopicReadKey>): Promise<readonly TopicReadScope[]>;
  emitUpdated?: (message: WorkspaceTopicReadUpdatedMessage) => void;
  /** Clear only a still-current finished attention after checking the latest topics against the snapshot. */
  reconcileFinishedAttention?: (
    snapshot: WorkspaceTopicReadUpdatedMessage["payload"]["snapshot"],
  ) => Promise<void>;
  onError?: (error: unknown) => void;
}

export async function handleTopicReadRequest(
  request: TopicReadRequest,
  options: TopicReadRequestOptions,
): Promise<TopicReadResponse> {
  const { requestId, workspaceId, mainAgentId } = request;
  try {
    const resolved = await options.resolveScopes({ workspaceId, mainAgentId });
    const scopes = resolved.filter(
      (scope) =>
        (workspaceId === undefined || scope.workspaceId === workspaceId) &&
        (mainAgentId === undefined || scope.mainAgentId === mainAgentId),
    );
    switch (request.type) {
      case "workspace.topic_read.get_state.request": {
        const scope = scopes[0];
        if (!scope) return errorResponse(request, "Workspace topic scope is unavailable.");
        const snapshot = await options.store.getState(scope);
        return {
          type: "workspace.topic_read.get_state.response",
          payload: { requestId, snapshot, error: null },
        };
      }
      case "workspace.topic_read.mark.request": {
        const scope = scopes[0];
        if (!scope) return errorResponse(request, "Workspace topic scope is unavailable.");
        const mutation = await options.store.mark(scope, request);
        await publishMutation(options, mutation, request.mode === "read");
        return {
          type: "workspace.topic_read.mark.response",
          payload: { requestId, snapshot: mutation.snapshot, error: null },
        };
      }
      case "workspace.topic_read.mark_all.request": {
        if (scopes.length === 0 && (workspaceId !== undefined || mainAgentId !== undefined)) {
          return errorResponse(request, "Workspace topic scope is unavailable.");
        }
        const snapshots = [];
        for (const scope of scopes) {
          const mutation = await options.store.markAll(scope, request);
          await publishMutation(options, mutation, true);
          snapshots.push(mutation.snapshot);
        }
        return {
          type: "workspace.topic_read.mark_all.response",
          payload: { requestId, snapshots, error: null },
        };
      }
    }
  } catch (error) {
    options.onError?.(error);
    return errorResponse(request, "Could not access workspace topic read state.");
  }
}

async function publishMutation(
  options: TopicReadRequestOptions,
  mutation: Awaited<ReturnType<TopicReadStateStore["mark"]>>,
  shouldReconcileAttention: boolean,
): Promise<void> {
  const { snapshot } = mutation;
  try {
    if (mutation.changed)
      options.emitUpdated?.({ type: "workspace.topic_read.updated", payload: { snapshot } });
    if (mutation.applied && shouldReconcileAttention) {
      await options.reconcileFinishedAttention?.(snapshot);
    }
  } catch (error) {
    options.onError?.(error);
  }
}

function errorResponse(request: TopicReadRequest, error: string): TopicReadResponse {
  const { requestId } = request;
  switch (request.type) {
    case "workspace.topic_read.get_state.request":
      return {
        type: "workspace.topic_read.get_state.response",
        payload: { requestId, snapshot: null, error },
      };
    case "workspace.topic_read.mark.request":
      return {
        type: "workspace.topic_read.mark.response",
        payload: { requestId, snapshot: null, error },
      };
    case "workspace.topic_read.mark_all.request":
      return {
        type: "workspace.topic_read.mark_all.response",
        payload: { requestId, snapshots: [], error },
      };
  }
}
