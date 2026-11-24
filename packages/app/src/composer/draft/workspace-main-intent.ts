import type { TFunction } from "i18next";
import type { WorkspaceDraftTabSetup } from "@/workspace-tabs/model";
import { getOrCreateClientId } from "@/utils/client-id";

export type WorkspaceMainBlock = "unsupported" | "occupied" | "unknown";

type WorkspaceMainTarget =
  | { kind: "workspace"; workspaceId: string }
  | {
      kind: "new";
      projectId: string;
      directory: string;
      isolation: "local" | "worktree" | "existing";
    };

export function workspaceMainDraftKey(input: {
  draftId: string;
  serverId: string;
  target: WorkspaceMainTarget | null;
}): string | null {
  const { draftId, serverId, target } = input;
  if (!draftId || !serverId || !target) return null;
  const targetKey =
    target.kind === "workspace"
      ? [target.kind, target.workspaceId]
      : [target.kind, target.projectId, target.directory, target.isolation];
  return JSON.stringify([draftId, serverId, ...targetKey]);
}

function topicFirstQuestionDraftPrefix(serverId: string, workspaceId: string): string {
  return `topic-first-question:${JSON.stringify([serverId, workspaceId])}:`;
}

export function topicFirstQuestionDraftId(
  serverId: string,
  workspaceId: string,
  clientId: string,
): string {
  return topicFirstQuestionDraftPrefix(serverId, workspaceId) + clientId;
}

export async function resolveTopicFirstQuestionDraftId(
  serverId: string,
  workspaceId: string,
): Promise<string> {
  return topicFirstQuestionDraftId(serverId, workspaceId, await getOrCreateClientId());
}

export function isTopicFirstQuestionDraft(
  draftId: string,
  serverId: string,
  workspaceId: string,
): boolean {
  const prefix = topicFirstQuestionDraftPrefix(serverId, workspaceId);
  return draftId.startsWith(prefix) && draftId.length > prefix.length;
}

export function canChooseWorkspaceMain(input: {
  setup?: WorkspaceDraftTabSetup | null;
  isTerminal?: boolean;
  isHandoff?: boolean;
}): boolean {
  return !(
    input.isTerminal ||
    input.isHandoff ||
    input.setup?.parentAgentId?.trim() ||
    input.setup?.forkFrom ||
    input.setup?.restoreChatHistory
  );
}

export function workspaceMainBlock(input: {
  supportsCreateAsMain: boolean;
  target: { kind: "new" } | { kind: "workspace"; hasActiveMainAgent?: boolean };
}): WorkspaceMainBlock | null {
  if (!input.supportsCreateAsMain) return "unsupported";
  if (input.target.kind === "new" || input.target.hasActiveMainAgent === false) return null;
  return input.target.hasActiveMainAgent === true ? "occupied" : "unknown";
}

export function workspaceMainErrorBlock(error: unknown): WorkspaceMainBlock | null {
  const code = typeof error === "object" && error && "code" in error ? error.code : undefined;
  if (code === "workspace_main_exists") return "occupied";
  if (code === "AGENT_CREATE_AS_MAIN_UNSUPPORTED") return "unsupported";
  return null;
}

export function workspaceMainBlockMessage(t: TFunction, block: WorkspaceMainBlock): string {
  switch (block) {
    case "unsupported":
      return t("agentControls.workspaceMain.unsupported");
    case "occupied":
      return t("agentControls.workspaceMain.occupied");
    case "unknown":
      return t("agentControls.workspaceMain.unknown");
  }
}
