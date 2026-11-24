import { useCallback, useState } from "react";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { AgentCapabilityFlags } from "@getpaseo/protocol/agent-types";
import { useIsCompactFormFactor } from "@/constants/layout";
import { selectCheckpointDiff } from "@/git/working-diff-comparison";
import { useRewindCheckpoint } from "@/hooks/use-rewind-checkpoint";
import { useSettings } from "@/hooks/use-settings";
import { useSessionStore } from "@/stores/session-store";
import { useWorkspaceDirectory } from "@/stores/session-store-hooks";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { openWorkspaceChanges } from "@/workspace-tabs/open-supporting-view";
import { RewindMenu } from "./rewind-menu";
import type { RewindMode } from "./use-rewind-capabilities";
import { useRewindAgentMutation } from "./use-rewind-agent-mutation";

interface MessageRewindMenuProps {
  serverId?: string;
  agentId?: string;
  messageId: string;
  capabilities: AgentCapabilityFlags;
  client?: DaemonClient | null;
  rewoundText: string;
}

export function MessageRewindMenu({
  serverId,
  agentId,
  messageId,
  capabilities,
  client,
  rewoundText,
}: MessageRewindMenuProps) {
  const [open, setOpen] = useState(false);
  const checkpoint = useRewindCheckpoint({ serverId, agentId, messageId, enabled: open });
  const workspaceId = useSessionStore((state) => {
    const session = serverId ? state.sessions[serverId] : undefined;
    if (!agentId || !session) return null;
    return (session.agents.get(agentId) ?? session.agentDetails.get(agentId))?.workspaceId ?? null;
  });
  const cwd = useWorkspaceDirectory(serverId ?? null, workspaceId);
  const preferences = useSettings((settings) => settings.openInSidePane);
  const isCompact = useIsCompactFormFactor();
  const { rewindAgent, isPending } = useRewindAgentMutation({
    serverId,
    agentId,
    messageId,
    client,
    cwd,
  });
  const handleViewChanges = useCallback(() => {
    if (!serverId || !workspaceId || !cwd || !agentId) return;
    selectCheckpointDiff({
      serverId,
      workspaceId,
      cwd,
      selection: { target: { agentId, messageId }, range: "turn" },
    });
    openWorkspaceChanges({
      isCompact,
      workspaceKey: buildWorkspaceTabPersistenceKey({ serverId, workspaceId }),
      preferences,
    });
  }, [agentId, cwd, isCompact, messageId, preferences, serverId, workspaceId]);
  const checkpointId = checkpoint.target?.checkpointId;
  const handleRewind = useCallback(
    (input: { mode: RewindMode; rewoundText: string }) => rewindAgent({ ...input, checkpointId }),
    [checkpointId, rewindAgent],
  );
  return (
    <RewindMenu
      capabilities={capabilities}
      checkpoint={open ? checkpoint : undefined}
      isPending={isPending}
      onOpenChange={setOpen}
      onRewind={handleRewind}
      onViewChanges={checkpoint.supported && workspaceId && cwd ? handleViewChanges : undefined}
      rewoundText={rewoundText}
    />
  );
}
