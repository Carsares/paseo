import { useCallback, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type {
  CheckoutGitActiveAgent,
  CheckoutGitOperationState,
  CheckoutGitStashEntry,
  CheckoutGitWorkingTree,
  WorkbenchErrorCode,
} from "@getpaseo/protocol/messages";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { confirmDialog } from "@/utils/confirm-dialog";
import type { PatchAction } from "./model";
import { stagedDiffCompare } from "./use-layer-diff";

type Translate = ReturnType<typeof useTranslation>["t"];
type Client = NonNullable<ReturnType<typeof useHostRuntimeClient>>;
type MutationOptions = Parameters<Client["checkoutGitCommitCreate"]>[0];
type Target = Pick<MutationOptions, "cwd" | "targetRepoRoot">;
type WriteOptions = Target &
  Pick<MutationOptions, "expectedHeadSha" | "forceWithRunningAgents" | "requestId">;
type MutationResult = Awaited<ReturnType<Client["checkoutGitCommitCreate"]>>;

type Patch =
  | { scope: "paths"; paths: string[] }
  | { scope: "hunk"; patch: string; paths: [string] };

export type StagingAction =
  | ({ kind: PatchAction; description: string } & Patch)
  | { kind: "commit"; message: string; amend: boolean; pushAfter: boolean }
  | { kind: "stash-create"; message: string; includeUntracked: boolean; keepIndex: boolean }
  | { kind: "stash-apply"; entry: CheckoutGitStashEntry };

interface Notice {
  tone: "error" | "success";
  message: string;
  agents?: CheckoutGitActiveAgent[];
  backupRef?: string;
  operation?: CheckoutGitOperationState;
  lockOperation?: string;
}

const STASH_QUERY = "staging-stash";
const TREE_QUERY = "staging-working-tree";
const STAGED_DIFF_TIMEOUT_MS = 15_000;

export function useStaging(serverId: string, cwd: string, active: boolean, showStash: boolean) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  const cache = useQueryClient();
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const treeQuery = useFetchQuery({
    queryKey: [TREE_QUERY, serverId, cwd],
    dataShape: "value",
    staleTimeMs: 0,
    queryFn: async () => {
      if (!client) throw new Error(t("workspace.terminal.hostDisconnected"));
      return fetchWorkingTree(client, cwd, t("gitWorkbench.noRepository"));
    },
    enabled: active && connected && Boolean(client),
    refetchInterval: 5_000,
    retry: false,
  });
  const tree = treeQuery.data?.workingTree;
  const statusRequestId = treeQuery.data?.requestId;
  const repoRoot = tree?.repoRoot;
  const stashQuery = useFetchQuery({
    queryKey: [STASH_QUERY, serverId, cwd, repoRoot],
    dataShape: "value",
    staleTimeMs: 0,
    queryFn: async () => {
      if (!client || !repoRoot) throw new Error(t("workspace.terminal.hostDisconnected"));
      const result = await client.checkoutGitStashList({ cwd, targetRepoRoot: repoRoot });
      if (result.error) throw new Error(result.error);
      return result.entries;
    },
    enabled: active && connected && Boolean(client && repoRoot) && showStash,
    retry: false,
  });
  const canWrite =
    active &&
    connected &&
    Boolean(client && tree) &&
    !treeQuery.isError &&
    !treeQuery.isFetching &&
    !busy;
  const live = useRef({ active, client, connected, tree });
  live.current = { active, client, connected, tree };

  const refresh = useCallback(async () => {
    await Promise.all([
      cache.invalidateQueries({ queryKey: [TREE_QUERY, serverId, cwd] }),
      cache.invalidateQueries({ queryKey: [STASH_QUERY, serverId, cwd] }),
    ]);
  }, [cache, cwd, serverId]);

  const exclusively = useCallback(
    async <T>(run: () => Promise<T>): Promise<T | undefined> => {
      if (!canWrite || pending.current) return;
      pending.current = true;
      setBusy(true);
      setNotice(null);
      try {
        return await run();
      } catch (cause) {
        setNotice({
          tone: "error",
          message: cause instanceof Error ? cause.message : String(cause),
        });
      } finally {
        pending.current = false;
        setBusy(false);
      }
    },
    [canWrite],
  );

  const mutate = useCallback(
    (action: StagingAction, snapshot = tree, matchesDiff?: () => boolean) =>
      exclusively(async () => {
        if (!client || !snapshot || snapshot !== tree || !canRunAction(action, snapshot))
          return false;
        // Polling can replace the status ID while the displayed file list stays identical.
        // Bind the commit to the read that backed the button when it was pressed.
        let requestId: string | undefined;
        if (action.kind === "commit") {
          if (!statusRequestId) return false;
          requestId = `paseo-git-commit:${statusRequestId}:${crypto.randomUUID()}`;
        }
        const approved = await confirmAction(action, snapshot, t);
        if (!approved) return false;
        if (!sameSnapshot(live.current, client, snapshot) || matchesDiff?.() === false) {
          setNotice({ tone: "error", message: t("gitWorkbench.stale") });
          return false;
        }
        const options: WriteOptions = {
          cwd,
          targetRepoRoot: snapshot.repoRoot,
          expectedHeadSha: snapshot.headSha,
          ...(requestId ? { requestId } : {}),
          ...(approved.force ? { forceWithRunningAgents: true } : {}),
        };
        let response: MutationResult;
        try {
          response = await executeAction(client, action, options);
        } finally {
          // The host may have written even if its response was lost.
          await refresh();
        }
        setNotice(mutationNotice(response, t));
        return response.success;
      }),
    [client, cwd, exclusively, refresh, statusRequestId, t, tree],
  );

  const generate = useCallback(
    (matchesEditor: () => boolean) =>
      exclusively(async () => {
        if (!client || !tree?.staged.length) return;
        const readIndex = () => readStagedTree(client, tree, t("gitWorkbench.noDraft"));
        const reportStale = async () => {
          await refresh();
          setNotice({ tone: "error", message: t("gitWorkbench.stale") });
        };
        setGenerating(true);
        try {
          const index = await readIndex();
          if (!matchesEditor()) return;
          if (!sameSnapshot(live.current, client, tree)) return reportStale();
          const result = await client.checkoutGitCommitGenerateMessage({
            cwd,
            targetRepoRoot: tree.repoRoot,
            source: "staged",
          });
          if (!matchesEditor()) return;
          if (!sameSnapshot(live.current, client, tree)) return reportStale();
          if (result.error || !result.message)
            throw new Error(result.error ?? t("gitWorkbench.noDraft"));
          const currentIndex = await readIndex();
          if (!matchesEditor()) return;
          if (index !== currentIndex || !sameSnapshot(live.current, client, tree))
            return reportStale();
          // The staged diff pins its base commit, so it cannot detect a HEAD move.
          const { workingTree } = await fetchWorkingTree(
            client,
            cwd,
            t("gitWorkbench.noRepository"),
          );
          if (!matchesEditor()) return;
          if (
            workingTree.repoRoot !== tree.repoRoot ||
            workingTree.headSha !== tree.headSha ||
            !sameSnapshot(live.current, client, tree)
          ) {
            return reportStale();
          }
          return result.message;
        } finally {
          setGenerating(false);
        }
      }),
    [client, cwd, exclusively, refresh, t, tree],
  );

  const show = useCallback(
    async (entry: CheckoutGitStashEntry) => {
      if (!client || !connected || !repoRoot) return;
      const result = await client.checkoutGitStashShow({
        cwd,
        targetRepoRoot: repoRoot,
        stashRef: entry.sha,
      });
      if (result.error) throw new Error(result.error);
      if (result.entry?.sha !== entry.sha) throw new Error(t("gitWorkbench.staleStash"));
      return result.files;
    },
    [client, connected, cwd, repoRoot, t],
  );

  return {
    tree,
    treeQuery,
    stashQuery,
    connected,
    canWrite,
    busy,
    generating,
    notice,
    refresh,
    mutate,
    generate,
    show,
  };
}

async function fetchWorkingTree(client: Client, cwd: string, noRepository: string) {
  const { workingTree, error, requestId } = await client.checkoutGitWorkingTreeGet({ cwd });
  if (error || !workingTree) throw new Error(error ?? noRepository);
  return { workingTree, requestId };
}

async function readStagedTree(client: Client, tree: CheckoutGitWorkingTree, unavailable: string) {
  const observation = client.observeDiff({
    ...stagedDiffCompare(tree.repoRoot, tree.headSha),
    highlight: false,
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe: (() => void) | undefined;
  const result = new Promise<string>((resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(unavailable)), STAGED_DIFF_TIMEOUT_MS);
    unsubscribe = observation.subscribe({
      snapshot: (diff) => {
        if (diff.phase === "error") reject(new Error(diff.error.message));
        if (diff.phase === "ready") {
          if (diff.resolved.headSha) resolve(diff.resolved.headSha);
          else reject(new Error(unavailable));
        }
      },
      error: reject,
      update: () => {},
    });
  });
  try {
    return await result;
  } finally {
    clearTimeout(timeout);
    unsubscribe?.();
    void observation.release().catch(console.error);
  }
}

function sameSnapshot(
  live: {
    active: boolean;
    connected: boolean;
    client: Client | null | undefined;
    tree?: CheckoutGitWorkingTree;
  },
  client: Client,
  snapshot: CheckoutGitWorkingTree,
) {
  return live.active && live.connected && live.client === client && live.tree === snapshot;
}

function canRunAction(action: StagingAction, tree: CheckoutGitWorkingTree) {
  if (action.kind === "stash-create")
    return tree.operationState === "idle" && tree.conflicts.length === 0;
  if (action.kind === "stash-apply") return tree.conflicts.length === 0;
  if (action.kind !== "commit") return true;
  return (
    tree.operationState === "idle" &&
    tree.staged.length > 0 &&
    tree.conflicts.length === 0 &&
    Boolean(action.message.trim()) &&
    (!action.amend || Boolean(tree.headSha))
  );
}

function actionConfirmation(action: StagingAction, t: Translate) {
  switch (action.kind) {
    case "discard":
      return {
        destructive: true,
        message: t("gitWorkbench.confirmDiscard", { path: action.description }),
      };
    case "commit":
      if (action.amend) {
        return {
          destructive: true,
          message: t(
            action.pushAfter ? "gitWorkbench.confirmAmendPush" : "gitWorkbench.confirmAmend",
          ),
        };
      }
      return action.pushAfter
        ? { destructive: false, message: t("gitWorkbench.confirmPush") }
        : null;
    default:
      return null;
  }
}

async function confirmAction(action: StagingAction, tree: CheckoutGitWorkingTree, t: Translate) {
  const confirmation = actionConfirmation(action, t);
  const stash = action.kind === "stash-create" || action.kind === "stash-apply";
  const guardedAction = stash || Boolean(confirmation?.destructive);
  const force = guardedAction && tree.activeAgents.length > 0;
  if (!confirmation && !force) return { force: false };
  const agents = tree.activeAgents.map((agent) => agent.title || agent.agentId).join(", ");
  const message = [
    confirmation?.message,
    force ? t("gitWorkbench.confirmActive", { agents }) : null,
  ]
    .filter(Boolean)
    .join("\n\n");
  const confirmed = await confirmDialog({
    title: t("gitWorkbench.confirmTitle"),
    message,
    cancelLabel: t("common.actions.cancel"),
    confirmLabel: t("gitWorkbench.confirm"),
    destructive: confirmation?.destructive ?? false,
  });
  return confirmed ? { force } : null;
}

function executeAction(
  client: Client,
  action: StagingAction,
  options: WriteOptions,
): Promise<MutationResult> {
  switch (action.kind) {
    case "stage":
      return client.checkoutGitStageApply({ ...options, ...patchInput(action) });
    case "unstage":
      return client.checkoutGitUnstageApply({ ...options, ...patchInput(action) });
    case "discard":
      return client.checkoutGitDiscardApply({ ...options, ...patchInput(action) });
    case "commit":
      return client.checkoutGitCommitCreate({
        ...options,
        message: action.message.trim(),
        amend: action.amend,
        pushAfter: action.pushAfter,
      });
    case "stash-create":
      return client.checkoutGitStashCreate({
        ...options,
        message: action.message.trim() || undefined,
        includeUntracked: action.includeUntracked,
        keepIndex: action.keepIndex,
      });
    case "stash-apply":
      return client.checkoutGitStashApply({
        ...options,
        stashRef: action.entry.sha,
        pop: false,
      });
  }
}

function patchInput(action: Patch): Patch {
  if (action.scope === "paths") return { scope: "paths", paths: action.paths };
  return { scope: "hunk", patch: action.patch, paths: action.paths };
}

function mutationNotice(response: MutationResult, t: Translate): Notice {
  const { activeAgents: agents, backupRef, operationState: operation, lockOperation } = response;
  const result = { agents, backupRef, operation, lockOperation };
  if (!response.success) {
    const message = [errorHint(response.errorCode, t), response.error].filter(Boolean).join(" · ");
    return { ...result, tone: "error", message: message || t("gitWorkbench.failed") };
  }
  const pushFailure = response.pushError
    ? t("gitWorkbench.pushFailed", { error: response.pushError })
    : null;
  const warning = [response.error, pushFailure].filter(Boolean).join(" · ");
  if (warning) return { ...result, tone: "error", message: warning };
  return { ...result, tone: "success", message: t("gitWorkbench.saved") };
}

function errorHint(code: WorkbenchErrorCode | undefined, t: Translate) {
  switch (code) {
    case "STALE_HEAD_CONFLICT":
      return t("gitWorkbench.stale");
    case "ACTIVE_AGENT_GUARD":
      return t("gitWorkbench.activeGuard");
    case "REPO_WRITE_LOCK_TIMEOUT":
      return t("gitWorkbench.lockTimeout");
    case "PATCH_APPLY_REJECTED":
      return t("gitWorkbench.patchRejected");
    case "REBASE_CONFLICT_PAUSED":
      return t("gitWorkbench.conflicts");
    default:
      return null;
  }
}
