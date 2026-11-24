import { useCallback, useRef, useState } from "react";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useTranslation } from "react-i18next";
import { useHostFeature } from "@/runtime/host-features";
import { getHostRuntimeStore, useHostRuntimeConnectionStatus } from "@/runtime/host-runtime";

export interface WorkspaceDeferralTarget {
  serverId: string;
  workspaceId: string;
}

export function useWorkspaceDeferralSupport(serverId: string) {
  return useHostFeature(serverId, "workspaceDeferral");
}

export function useDeferralOperation(serverId: string) {
  const { t } = useTranslation();
  const supported = useWorkspaceDeferralSupport(serverId);
  const online = useHostRuntimeConnectionStatus(serverId) === "online";
  const inFlight = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    async (
      operation: (client: DaemonClient) => Promise<void>,
      onError?: (error: string) => void,
    ) => {
      if (inFlight.current) return;
      const client = getHostRuntimeStore().getClient(serverId);
      if (!online || !client || client.getConnectionState().status !== "connected") {
        const message = t("sidebar.workspace.deferral.offline");
        setError(message);
        onError?.(message);
        return;
      }
      inFlight.current = true;
      setPending(true);
      setError(null);
      try {
        await operation(client);
      } catch (cause) {
        const message =
          cause instanceof Error ? cause.message : t("sidebar.workspace.deferral.error");
        setError(message);
        onError?.(message);
      } finally {
        inFlight.current = false;
        setPending(false);
      }
    },
    [online, serverId, t],
  );

  return { supported, online, pending, error, run };
}
