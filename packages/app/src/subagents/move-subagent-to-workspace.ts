import { i18n } from "@/i18n/i18next";
import type { Agent } from "@/stores/session-store";
import type { ConfirmDialogInput } from "@/utils/confirm-dialog";
import { isWorkspaceRootAgent } from "./workspace-root-policy";

export function canMoveSubagentToWorkspace(input: {
  featureEnabled: boolean;
  agent: Pick<Agent, "parentAgentId" | "workspaceId" | "archivedAt"> | null | undefined;
  parentAgent: Pick<Agent, "workspaceId"> | undefined;
}): boolean {
  if (
    !input.featureEnabled ||
    !input.agent ||
    input.agent.archivedAt ||
    !input.agent.parentAgentId
  ) {
    return false;
  }
  return !isWorkspaceRootAgent(input.agent, input.parentAgent);
}

export function resolveMoveSubagentToWorkspaceDialog(input: {
  title: Agent["title"] | null | undefined;
}): ConfirmDialogInput {
  const title = input.title?.trim();
  const label =
    title && title.toLowerCase() !== "new agent"
      ? title
      : i18n.t("subagents.moveToWorkspaceConfirmFallbackLabel");

  return {
    title: i18n.t("subagents.moveToWorkspaceConfirmTitle"),
    message: i18n.t("subagents.moveToWorkspaceConfirmMessage", { label }),
    confirmLabel: i18n.t("subagents.moveToWorkspaceConfirmAction"),
    cancelLabel: i18n.t("subagents.moveToWorkspaceCancelAction"),
    destructive: false,
  };
}

export interface MoveSubagentToWorkspaceDeps {
  getSubagent: (subagentId: string) => { title: Agent["title"] | null | undefined } | undefined;
  confirm: (input: ConfirmDialogInput) => Promise<boolean>;
  createIdempotencyKey?: () => string;
  moveAgentToWorkspace: (input: {
    serverId: string;
    agentId: string;
    idempotencyKey: string;
  }) => Promise<{ workspaceId: string }>;
  openMovedWorkspace: (input: {
    serverId: string;
    workspaceId: string;
    agentId: string;
  }) => Promise<void> | void;
  reportError: (error: unknown) => void;
}

const inFlightKeys = new Set<string>();

export async function requestMoveSubagentToWorkspace(
  input: { serverId: string; subagentId: string },
  deps: MoveSubagentToWorkspaceDeps,
): Promise<void> {
  const { serverId, subagentId } = input;
  const key = `${serverId}:${subagentId}`;
  if (inFlightKeys.has(key)) {
    return;
  }
  inFlightKeys.add(key);

  try {
    const subagent = deps.getSubagent(subagentId);
    const confirmed = await deps.confirm(
      resolveMoveSubagentToWorkspaceDialog({ title: subagent?.title }),
    );
    if (!confirmed) {
      return;
    }

    const idempotencyKey =
      deps.createIdempotencyKey?.() ??
      `move_ws_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    const { workspaceId } = await deps.moveAgentToWorkspace({
      serverId,
      agentId: subagentId,
      idempotencyKey,
    });
    await deps.openMovedWorkspace({ serverId, workspaceId, agentId: subagentId });
  } catch (error) {
    deps.reportError(error);
  } finally {
    inFlightKeys.delete(key);
  }
}
