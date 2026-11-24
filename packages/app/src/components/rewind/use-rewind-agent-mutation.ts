import { planTimelineTailFetch } from "@/timeline/timeline-sync-plan";
import { createElement, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useIsMutating, useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/contexts/toast-context";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { RewindMode } from "./use-rewind-capabilities";
import { useRewindComposerRestore } from "./composer-restore";
import { useSessionStore } from "@/stores/session-store";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useCheckpointCopy } from "@/git/diff-checkpoint-copy";
import { invalidateCheckoutGitQueriesForClient } from "@/git/query-keys";
import { rewindCheckpointQueryKey } from "@/hooks/use-rewind-checkpoint";
import { RewindFileRetry } from "./rewind-file-retry";

interface UseRewindAgentMutationInput {
  serverId?: string;
  agentId?: string;
  messageId?: string;
  client?: DaemonClient | null;
  cwd?: string | null;
}

interface RewindAgentInput {
  mode: RewindMode;
  rewoundText: string;
  checkpointId?: string;
}

export function useRewindAgentMutation(input: UseRewindAgentMutationInput): {
  rewindAgent: (input: RewindAgentInput) => Promise<void>;
  isPending: boolean;
} {
  const toast = useToast();
  const { t } = useTranslation();
  const copy = useCheckpointCopy();
  const composerRestore = useRewindComposerRestore();
  const queryClient = useQueryClient();
  const mutationKey = useMemo(
    () => ["agent-rewind", input.serverId, input.agentId],
    [input.serverId, input.agentId],
  );
  const isPending = useIsMutating({ mutationKey, exact: true }) > 0;
  const { mutateAsync } = useMutation({
    mutationKey,
    mutationFn: async ({ mode, checkpointId, rewoundText }: RewindAgentInput) => {
      const { client, serverId, agentId, messageId, cwd } = input;
      if (!client || !serverId || !agentId || !messageId) {
        throw new Error(t("common.errors.daemonClientUnavailable"));
      }
      const refreshConversation = async () => {
        const cursor = useSessionStore
          .getState()
          .sessions[serverId]?.agentTimelineCursor.get(agentId);
        try {
          await getHostRuntimeStore().fetchAgentTimeline(serverId, agentId, {
            ...planTimelineTailFetch(),
            ...(cursor ? { cursor: { epoch: cursor.epoch, seq: cursor.endSeq } } : {}),
          });
        } catch {
          // The daemon already rewound chat. A timeline refresh failure cannot undo it.
        }
        composerRestore?.completeRewind(rewoundText);
      };
      const refreshCheckout = () => {
        void queryClient.invalidateQueries({
          queryKey: rewindCheckpointQueryKey({ serverId }).slice(0, 2),
        });
        if (cwd) void invalidateCheckoutGitQueriesForClient(queryClient, { serverId, cwd });
      };
      if (mode === "conversation") {
        await client.rewindAgent(agentId, messageId, "conversation");
        await refreshConversation();
        return;
      }
      if (!checkpointId) throw new Error(copy.checkpointMissing);

      const response = await client.restoreAgentRewindCheckpoint({
        agentId,
        messageId,
        checkpointId,
        mode,
      });
      const { operation } = response;
      refreshCheckout();
      if (operation?.conversationRewound) await refreshConversation();
      if (operation?.status === "files_pending") {
        toast.show(
          createElement(RewindFileRetry, {
            conversationRewound: operation.conversationRewound,
            detail: response.error,
            retry: async () => {
              const currentClient = useSessionStore.getState().sessions[serverId]?.client;
              if (!currentClient) throw new Error(t("common.errors.daemonClientUnavailable"));
              if (queryClient.isMutating({ mutationKey, exact: true }) > 0) {
                throw new Error(copy.rewindInProgress);
              }
              const retryMutation = queryClient.getMutationCache().build(queryClient, {
                mutationKey,
                mutationFn: () =>
                  currentClient.retryAgentRewindFiles({
                    agentId,
                    operationId: operation.operationId,
                  }),
              });
              const result = await retryMutation.execute(undefined);
              refreshCheckout();
              if (!result.ok || result.operation?.status !== "files_restored") {
                throw new Error(result.error ?? copy.fileRewindFailed);
              }
              toast.show(copy.filesRestored, { variant: "success" });
            },
          }),
          { variant: "warning", durationMs: null, testID: "rewind-files-pending" },
        );
        return;
      }
      if (!response.ok || operation?.status !== "files_restored") {
        throw new Error(response.error ?? t("rewind.errors.failed"));
      }
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : t("rewind.errors.failed"));
    },
  });

  const rewindAgent = useCallback(
    async (rewindInput: RewindAgentInput) => {
      if (queryClient.isMutating({ mutationKey, exact: true }) > 0) {
        return;
      }
      await mutateAsync(rewindInput);
    },
    [mutateAsync, mutationKey, queryClient],
  );

  return {
    rewindAgent,
    isPending,
  };
}
