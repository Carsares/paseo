import type { normalizeWorkspaceDescriptor } from "@/stores/session-store";
import type { MessagePayload } from "@/composer/types";
import type { AgentAttachment } from "@getpaseo/protocol/messages";
import type { CreateWorkspaceRequestOptions } from "@getpaseo/client/internal/daemon-client";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";

export function isEmptyWorkspaceSubmission(payload: MessagePayload): boolean {
  return !payload.text.trim() && payload.attachments.length === 0;
}

export interface CreateEmptyWorkspaceInput {
  payload: MessagePayload;
  ensureWorkspace: (input: EnsureNewWorkspaceRequest) => Promise<{
    workspace: ReturnType<typeof normalizeWorkspaceDescriptor>;
    mainAgent?: { id: string } | null;
  }>;
  serverId: string;
  navigate: (serverId: string, workspaceId: string, mainAgentId?: string) => void;
}

export interface EnsureNewWorkspaceRequest {
  cwd: string;
  prompt: string;
  attachments: AgentAttachment[];
  withInitialAgent: boolean;
  mainAgent?: CreateWorkspaceRequestOptions["mainAgent"];
}

export function resolveEmptyWorkspaceMainProvider(input: {
  selectedProvider: string | null;
  preferredProvider?: string;
  entries: readonly Pick<ProviderSnapshotEntry, "provider" | "enabled" | "status">[];
}): string | undefined {
  const { selectedProvider, preferredProvider, entries } = input;
  if (entries.length === 0) return selectedProvider || preferredProvider;
  const available = entries.filter(
    (entry) => entry.enabled && (entry.status === "ready" || entry.status === "loading"),
  );
  return (
    available.find((entry) => entry.provider === selectedProvider)?.provider ??
    available.find((entry) => entry.provider === preferredProvider)?.provider ??
    available.find((entry) => entry.status === "ready")?.provider ??
    available[0]?.provider
  );
}

export async function runCreateEmptyWorkspace(input: CreateEmptyWorkspaceInput): Promise<void> {
  const { payload, ensureWorkspace, serverId, navigate } = input;
  const result = await ensureWorkspace({
    cwd: payload.cwd,
    prompt: "",
    attachments: [],
    withInitialAgent: false,
  });
  navigate(serverId, result.workspace.id, result.mainAgent?.id);
}
