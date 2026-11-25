import { planTimelineTailFetch } from "@/timeline/timeline-sync-plan";
import { createElement, useCallback, useMemo, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useIsMutating, useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/contexts/toast-context";
import { useFetchQuery, useReplicaQuery } from "@/data/query";
import { useHostFeature } from "@/runtime/host-features";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { RewindMode } from "./use-rewind-capabilities";
import { useRewindComposerRestore } from "./composer-restore";
import { useSessionStore } from "@/stores/session-store";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useCheckpointCopy } from "@/git/diff-checkpoint-copy";
import { invalidateCheckoutGitQueriesForClient } from "@/git/query-keys";
import { rewindCheckpointQueryKey } from "@/hooks/use-rewind-checkpoint";
import {
  RewindFileLookupRetry,
  RewindFileRetry,
  UnconfirmedRewindFileNotice,
} from "./rewind-file-retry";

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

const pendingFilesKey = (serverId?: string, agentId?: string) =>
  ["agent-rewind-pending-files", serverId, agentId] as const;
const knownPendingKey = (serverId?: string, agentId?: string) =>
  ["agent-rewind-known-pending-files", serverId, agentId] as const;
type PendingFiles = Awaited<ReturnType<DaemonClient["getPendingAgentRewindFiles"]>>;
type FileRecovery = Awaited<ReturnType<DaemonClient["getAgentRewindFileRecovery"]>>;
type KnownPending = PendingFiles[number] & { detail: string | null };

export function useRewindAgentMutation(input: UseRewindAgentMutationInput): {
  rewindAgent: (input: RewindAgentInput) => Promise<void>;
  retryFiles: (operationId: string) => Promise<void>;
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
  const { serverId, agentId, cwd } = input;
  const refreshCheckout = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: rewindCheckpointQueryKey({ serverId }).slice(0, 2),
    });
    if (serverId && cwd) void invalidateCheckoutGitQueriesForClient(queryClient, { serverId, cwd });
  }, [cwd, queryClient, serverId]);
  const refreshPendingFiles = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: pendingFilesKey(serverId, agentId) });
  }, [agentId, queryClient, serverId]);
  const retryFiles = useCallback(
    async (operationId: string) => {
      const client = serverId && useSessionStore.getState().sessions[serverId]?.client;
      if (!client || !agentId) throw new Error(t("common.errors.daemonClientUnavailable"));
      if (queryClient.isMutating({ mutationKey, exact: true }) > 0) {
        throw new Error(copy.rewindInProgress);
      }
      const retryMutation = queryClient.getMutationCache().build(queryClient, {
        mutationKey,
        mutationFn: async () => {
          const result = await client.retryAgentRewindFiles({ agentId, operationId });
          if (!result.ok || result.operation?.status !== "files_restored") {
            throw new Error(result.error ?? copy.fileRewindFailed);
          }
          const key = pendingFilesKey(serverId, agentId);
          await queryClient.cancelQueries({ queryKey: key, exact: true });
          queryClient.setQueryData<FileRecovery>(
            key,
            (recovery) =>
              recovery && {
                ...recovery,
                pendingFiles: recovery.pendingFiles.filter(
                  (file) => file.operationId !== operationId,
                ),
              },
          );
          queryClient.setQueryData<KnownPending[]>(knownPendingKey(serverId, agentId), (files) =>
            files?.filter((file) => file.operationId !== operationId),
          );
        },
        onSettled: () => {
          refreshCheckout();
          refreshPendingFiles();
        },
      });
      await retryMutation.execute(undefined);
      toast.show(copy.filesRestored, { variant: "success" });
    },
    [
      agentId,
      copy,
      mutationKey,
      queryClient,
      refreshCheckout,
      refreshPendingFiles,
      serverId,
      t,
      toast,
    ],
  );
  const { mutateAsync } = useMutation({
    mutationKey,
    mutationFn: async ({ mode, checkpointId, rewoundText }: RewindAgentInput) => {
      const { client, messageId } = input;
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
      if (operation?.status === "files_pending") {
        if (client.supportsPendingRewindFiles()) {
          const { operationId, conversationRewound } = operation;
          queryClient.setQueryData<KnownPending[]>(knownPendingKey(serverId, agentId), (files) => [
            ...(files ?? []).filter((file) => file.operationId !== operationId),
            { operationId, conversationRewound, detail: response.error },
          ]);
          if (conversationRewound) await refreshConversation();
          return;
        }
        if (operation.conversationRewound) await refreshConversation();
        // COMPAT(rewindPendingFiles): added in v0.18.0, remove the toast after 2027-06-01.
        toast.show(
          createElement(RewindFileRetry, {
            conversationRewound: operation.conversationRewound,
            detail: response.error,
            retry: () => retryFiles(operation.operationId),
          }),
          { variant: "warning", durationMs: null, testID: "rewind-files-pending" },
        );
        return;
      }
      if (operation?.conversationRewound) await refreshConversation();
      if (!response.ok || operation?.status !== "files_restored") {
        throw new Error(response.error ?? t("rewind.errors.failed"));
      }
    },
    onSettled: (_result, _error, { mode }) => {
      if (mode !== "conversation") refreshPendingFiles();
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
    retryFiles,
    isPending,
  };
}

export function usePendingRewindFileRecovery(
  input: UseRewindAgentMutationInput & { enabled: boolean },
) {
  const { serverId, agentId, client } = input;
  const supported = useHostFeature(serverId, "rewindPendingFiles");
  const enabled = input.enabled && supported && Boolean(agentId && client);
  const known = useReplicaQuery<KnownPending[]>({
    queryKey: knownPendingKey(serverId, agentId),
    pushEvent: "agent.rewind.checkpoint.restore.response",
  });
  const pending = useFetchQuery({
    queryKey: pendingFilesKey(serverId, agentId),
    dataShape: "value",
    staleTimeMs: 0,
    enabled,
    queryFn: async ({ signal }) => {
      if (!client || !agentId) throw new Error("Pending file restores are unavailable");
      signal.throwIfAborted();
      const recovery = await client.getAgentRewindFileRecovery(agentId);
      signal.throwIfAborted();
      return recovery;
    },
    retry: false,
  });
  const { retryFiles } = useRewindAgentMutation(input);
  if (!enabled) return null;
  const files = new Map<string, KnownPending>();
  for (const file of pending.data?.pendingFiles ?? []) {
    files.set(file.operationId, { ...file, detail: null });
  }
  for (const file of known.data ?? []) files.set(file.operationId, file);
  const unconfirmed = pending.data?.unconfirmedFileRewinds ?? [];
  for (const { operationId } of unconfirmed) files.delete(operationId);
  const notices: ReactElement[] = [...files.values()].map(
    ({ operationId, conversationRewound, detail }) =>
      createElement(RewindFileRetry, {
        key: operationId,
        conversationRewound,
        detail,
        retry: () => retryFiles(operationId),
      }),
  );
  for (const { operationId } of unconfirmed) {
    notices.push(createElement(UnconfirmedRewindFileNotice, { key: operationId }));
  }
  if (pending.isError) {
    notices.push(
      createElement(RewindFileLookupRetry, {
        key: "pending-files-lookup",
        pending: pending.isFetching,
        retry: () => void pending.refetch(),
      }),
    );
  }
  return notices;
}
