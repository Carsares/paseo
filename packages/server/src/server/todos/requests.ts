import type {
  WorkspaceTodoDeleteRequest,
  WorkspaceTodoDeleteResponse,
  WorkspaceTodoListRequest,
  WorkspaceTodoListResponse,
  WorkspaceTodoSetStatusRequest,
  WorkspaceTodoSetStatusResponse,
  WorkspaceTodoUpdatedMessage,
  WorkspaceTodoUpsertRequest,
  WorkspaceTodoUpsertResponse,
} from "@getpaseo/protocol/messages";
import { TodoStoreError, type WorkspaceTodoStore } from "./store.js";

export type TodoRequest =
  | WorkspaceTodoListRequest
  | WorkspaceTodoUpsertRequest
  | WorkspaceTodoSetStatusRequest
  | WorkspaceTodoDeleteRequest;

type TodoResponse =
  | WorkspaceTodoListResponse
  | WorkspaceTodoUpsertResponse
  | WorkspaceTodoSetStatusResponse
  | WorkspaceTodoDeleteResponse;

export interface TodoRequestOptions {
  store: WorkspaceTodoStore;
  /** Resolve only active workspaces visible to this caller. */
  resolveWorkspaceIds(workspaceId: string | undefined): Promise<readonly string[]>;
  emitUpdated?: (message: WorkspaceTodoUpdatedMessage) => void;
  onError?: (error: unknown) => void;
}

export async function handleTodoRequest(
  request: TodoRequest,
  options: TodoRequestOptions,
): Promise<TodoResponse> {
  const { requestId, workspaceId: requestedWorkspaceId } = request;
  try {
    const visible = await options.resolveWorkspaceIds(requestedWorkspaceId);
    if (requestedWorkspaceId !== undefined && !visible.includes(requestedWorkspaceId)) {
      return errorResponse(request, "workspace_unavailable");
    }

    switch (request.type) {
      case "workspace.todo.list.request": {
        const workspaceIds = request.workspaceId === undefined ? visible : [request.workspaceId];
        const items = await options.store.list({
          workspaceIds,
          statusFilter: request.statusFilter,
        });
        return { type: "workspace.todo.list.response", payload: { requestId, items, error: null } };
      }
      case "workspace.todo.upsert.request": {
        const item = await options.store.upsert(request);
        publishUpdated(options, { workspaceId: item.workspaceId, item });
        return {
          type: "workspace.todo.upsert.response",
          payload: { requestId, item, error: null },
        };
      }
      case "workspace.todo.set_status.request": {
        const item = await options.store.setStatus(request);
        publishUpdated(options, { workspaceId: item.workspaceId, item });
        return {
          type: "workspace.todo.set_status.response",
          payload: { requestId, item, error: null },
        };
      }
      case "workspace.todo.delete.request": {
        const deleted = await options.store.delete(request);
        const { workspaceId, todoId } = request;
        if (deleted) publishUpdated(options, { workspaceId, item: null, deletedTodoId: todoId });
        return {
          type: "workspace.todo.delete.response",
          payload: { requestId, todoId, deleted, error: null },
        };
      }
    }
  } catch (error) {
    if (error instanceof TodoStoreError) return errorResponse(request, error.code);
    options.onError?.(error);
    return errorResponse(request, "todo_storage_error");
  }
}

function publishUpdated(
  options: TodoRequestOptions,
  payload: WorkspaceTodoUpdatedMessage["payload"],
): void {
  try {
    options.emitUpdated?.({ type: "workspace.todo.updated", payload });
  } catch (error) {
    options.onError?.(error);
  }
}

function errorResponse(request: TodoRequest, error: string): TodoResponse {
  const { requestId } = request;
  switch (request.type) {
    case "workspace.todo.list.request":
      return { type: "workspace.todo.list.response", payload: { requestId, items: [], error } };
    case "workspace.todo.upsert.request":
      return { type: "workspace.todo.upsert.response", payload: { requestId, item: null, error } };
    case "workspace.todo.set_status.request":
      return {
        type: "workspace.todo.set_status.response",
        payload: { requestId, item: null, error },
      };
    case "workspace.todo.delete.request":
      return {
        type: "workspace.todo.delete.response",
        payload: { requestId, todoId: request.todoId, deleted: false, error },
      };
  }
}
