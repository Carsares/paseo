import { useFetchQuery } from "@/data/query";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ScrollView, Text, View, type LayoutChangeEvent } from "react-native";
import { GitFork } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type {
  CheckoutGitLogCommit,
  CheckoutGitRepo,
  CheckoutGitRepoRefs,
} from "@getpaseo/protocol/messages";
import { GraphSheet } from "./sheet";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useStableEvent } from "@/hooks/use-stable-event";
import { useIsLocalDaemon } from "@/hooks/use-is-local-daemon";
import { useBlockMobilePanelOpenGestures } from "@/mobile-panels/provider";
import { usePaneContext } from "@/panels/pane-context";
import { definePanel } from "@/panels/panel-registry";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useGitGraphConflictIntent } from "@/screens/workspace/topic-header/git-graph-intent";
import { useWorkspaceDirectory } from "@/stores/session-store-hooks";
import { confirmDialog } from "@/utils/confirm-dialog";
import { openDesktopTarget, useDesktopOpenTargets } from "@/workspace/desktop-open-targets";
import { ConflictSheet } from "../rebase/conflict-sheet";
import { PlanSheet, type RebaseResult } from "../rebase/plan-sheet";
import {
  isRebasePaused,
  recordRebaseSnapshot,
  recoverPausedRebaseSnapshot,
  selectCompletedUndo,
  type RebaseSnapshot,
} from "../rebase/snapshot";
import { useRebaseWorkingTree, type RebaseWorkingTree } from "../rebase/use-working-tree";
import { useGraphLog } from "./use-log";
import { CommitList } from "./commit-list";
import { CommitDetail, CommitFileSheet } from "./detail";
import { commitKey } from "./lanes";
import { compileFilters, emptyFilters, graphLayout, type GraphFilters } from "./model";
import { RefBrowser } from "./refs";
import { referenceGroups } from "./ref-model";
import { errorMessage, GraphInput, GraphMessage, RepoDot, styles } from "./ui";
import { useLiveEnabled } from "../rebase/use-live-enabled";
import { useRebaseSurfaces, type RebaseSurfaceState } from "../rebase/use-rebase-surfaces";

const EMPTY_REPOS: CheckoutGitRepo[] = [];
const EMPTY_REFS: CheckoutGitRepoRefs[] = [];
const DETAILS_SNAP = ["85%"];
const SELECTED = { selected: true };
const UNSELECTED = { selected: false };
function GitGraphPanel() {
  const { t } = useTranslation();
  const { serverId, workspaceId } = usePaneContext();
  const cwd = useWorkspaceDirectory(serverId, workspaceId);
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  // COMPAT(checkoutGitGraphV1): added in v0.18.0, remove after 2027-06-01 once daemon floor >= v0.18.0.
  const graph = useHostFeature(serverId, "checkoutGitGraphV1");
  // COMPAT(checkoutGitMultiRepoV1): added in v0.18.0, remove after 2027-06-01 once daemon floor >= v0.18.0.
  const multiRepo = useHostFeature(serverId, "checkoutGitMultiRepoV1");
  // COMPAT(checkoutGitRebaseV1): added in v0.18.0, remove after 2027-06-01 once daemon floor >= v0.18.0.
  const rebase = useHostFeature(serverId, "checkoutGitRebaseV1");
  const staging = useHostFeature(serverId, "checkoutGitStagingV1");

  if (!graph || !multiRepo || !client || !cwd) {
    let message = t("gitWorkbench.graph.graphUpgrade");
    if (!connected || !client) message = t("gitWorkbench.graph.disconnected");
    else if (!cwd) message = t("panels.diff.directoryMissing");
    return (
      <View style={styles.stack}>
        <GraphMessage>{message}</GraphMessage>
      </View>
    );
  }
  return (
    <GraphWorkbench
      key={JSON.stringify([serverId, cwd])}
      client={client}
      cwd={cwd}
      connected={connected}
      rebase={rebase && staging}
    />
  );
}

function GraphWorkbench({
  client,
  cwd,
  connected,
  rebase,
}: {
  client: DaemonClient;
  cwd: string;
  connected: boolean;
  rebase: boolean;
}) {
  const { serverId, tabId } = usePaneContext();
  const active = useRetainedPanelActive();
  const compact = useIsCompactFormFactor();
  const enabled = active && connected;
  const [width, setWidth] = useState(0);
  const layout = graphLayout(width);
  const narrow = layout === "narrow";
  const [focus, setFocus] = useState<string | null>(null);
  const [filterDraft, setFilterDraft] = useState(emptyFilters);
  const [filter, setFilter] = useState(emptyFilters);
  const compiledFilters = compileFilters(filter);
  const invalidDates = !compileFilters(filterDraft);
  const [selectedCommit, setSelectedCommit] = useState<CheckoutGitLogCommit | null>(null);
  const [file, setFile] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [notice, setNotice] = useState<string>();
  const [scrollingFilters, setScrollingFilters] = useState(false);
  useBlockMobilePanelOpenGestures(active && compact && scrollingFilters);

  const { discover, refs, repos, repo, roots, references, log, refLabels } = useGraphData({
    client,
    serverId,
    cwd,
    revision,
    enabled,
    focus,
    compiledFilters,
  });

  const clearSelection = useStableEvent(() => {
    setFile(null);
    setSelectedCommit(null);
  });

  function chooseRepo(repoRoot: string | null) {
    setFocus(repoRoot);
    setFilterDraft((previous) => ({ ...previous, branchFilter: "" }));
    setFilter((previous) => ({ ...previous, branchFilter: "" }));
    clearSelection();
    setNotice(undefined);
  }

  const focusRef = useStableEvent((repoRoot: string, branchFilter: string) => {
    setFocus(repoRoot);
    const next = { ...filter, branchFilter };
    setFilter(next);
    setFilterDraft(next);
    clearSelection();
    setNotice(undefined);
  });

  const refresh = useStableEvent(() => setRevision((value) => value + 1));
  const { surface, openSurface, closeSurface, reportSurfaceResult, reportHiddenConflictChange } =
    useRebaseSurfaces(enabled && rebase, repo, refresh);

  const { snapshot, undoing, recordResult, undo, workingTree } = useRebaseOperations({
    client,
    cwd,
    repo,
    serverId,
    action: surface?.kind,
    revision,
    enabled: enabled && rebase,
    references: freshRead(refs) ? references : EMPTY_REFS,
    repoFresh: freshRead(discover),
    refresh,
    clearSelection,
    setNotice,
  });
  const selectCommit = useStableEvent((commit: CheckoutGitLogCommit) => {
    setFile(null);
    setSelectedCommit(commit);
  });
  const onApply = useStableEvent(() => {
    setFilter(filterDraft);
    clearSelection();
  });
  const onClear = useStableEvent(() => {
    setFilterDraft(emptyFilters);
    setFilter(emptyFilters);
    clearSelection();
  });
  const onLayout = useStableEvent((event: LayoutChangeEvent) => {
    const next = event.nativeEvent.layout.width;
    if (next > 0) setWidth(next);
  });
  const choose = useStableEvent(chooseRepo);
  useConflictNavigationIntent({
    tabId,
    active,
    enabled,
    rebase,
    revision,
    discover,
    repos,
    refresh,
    chooseRepo: choose,
    openSurface,
  });
  const touchStart = useStableEvent(() => setScrollingFilters(true));
  const touchEnd = useStableEvent(() => setScrollingFilters(false));
  const closeFile = useStableEvent(() => setFile(null));
  const surfaceResult = useStableEvent(
    (
      source: RebaseSurfaceState,
      result: RebaseResult,
      steps?: number,
      aborted: boolean = false,
    ) => {
      if (source.repo.repoRoot !== result.repoRoot) return;
      recordResult(source, result, steps, aborted);
      reportSurfaceResult(source, isRebasePaused(result.operationState), steps !== undefined);
    },
  );

  const selectedDetail = roots.includes(selectedCommit?.repoRoot ?? "") ? selectedCommit : null;
  const referencesPicker = useMemo(
    () =>
      layout === "wide" ? null : (
        <RefBrowser repos={repos} refs={references} focusRef={focusRef} inline={false} />
      ),
    [layout, repos, references, focusRef],
  );
  const readError = [discover.error, refs.error, log.error].find(Boolean);
  const { repoActions, ontoOptions } = useRepoChrome({
    repo,
    serverId,
    active,
    enabled,
    rebase,
    undoing,
    discovering: discover.isFetching,
    references,
    snapshot,
    openSurface,
    setNotice,
    undo,
  });
  const activeSurface = active && rebase ? surface : null;
  const toolbar = (
    <RepoToolbar
      repos={repos}
      focus={focus}
      choose={choose}
      disabled={undoing}
      onRefresh={refresh}
      refreshing={[!enabled, undoing, discover.isFetching, refs.isFetching, log.isFetching].some(
        Boolean,
      )}
      touchStart={touchStart}
      touchEnd={touchEnd}
    />
  );
  const logContent = (
    <GraphLog
      log={log}
      narrow={narrow}
      selected={selectedDetail}
      refLabels={refLabels}
      connected={connected}
      enabled={enabled}
      discovering={discover.isFetching}
      repositoryMissing={discover.isSuccess && repos.length === 0}
      error={readError}
      onSelect={selectCommit}
    />
  );

  return (
    <View style={styles.fill} onLayout={onLayout} testID={`git-graph-${layout}`}>
      {toolbar}
      {repoActions}
      <GraphNotices connected={connected} notice={notice} />
      <View style={[styles.fill, styles.columns]}>
        {layout === "wide" ? (
          <View style={styles.referencesColumn}>
            <RefBrowser repos={repos} refs={references} focusRef={focusRef} inline />
          </View>
        ) : null}
        <View style={[styles.fill, layout === "wide" && styles.paneBorder]}>
          <Filters
            value={filterDraft}
            invalidDates={invalidDates}
            onChange={setFilterDraft}
            onApply={onApply}
            onClear={onClear}
            refs={referencesPicker}
          />
          {logContent}
        </View>
        <DetailSurfaces
          client={client}
          cwd={cwd}
          selectedDetail={selectedDetail}
          file={file}
          enabled={enabled}
          active={active}
          narrow={narrow}
          onDiff={setFile}
          clearSelection={clearSelection}
          closeFile={closeFile}
        />
      </View>
      {activeSurface ? (
        <RebaseSurface
          key={activeSurface.id}
          client={client}
          cwd={cwd}
          surface={activeSurface}
          enabled={enabled}
          ontoOptions={ontoOptions}
          snapshot={snapshot ?? null}
          workingTree={workingTree}
          onClose={closeSurface}
          onResult={surfaceResult}
          onChangedWhileHidden={reportHiddenConflictChange}
        />
      ) : null}
    </View>
  );
}

function freshRead(query: { isSuccess: boolean; isFetching: boolean; isPlaceholderData: boolean }) {
  return query.isSuccess && !query.isFetching && !query.isPlaceholderData;
}

function useConflictNavigationIntent({
  tabId,
  active,
  enabled,
  rebase,
  revision,
  discover,
  repos,
  refresh,
  chooseRepo,
  openSurface,
}: {
  tabId: string;
  active: boolean;
  enabled: boolean;
  rebase: boolean;
  revision: number;
  discover: {
    isSuccess: boolean;
    isFetching: boolean;
    isPlaceholderData: boolean;
    isError: boolean;
  };
  repos: readonly CheckoutGitRepo[];
  refresh: () => void;
  chooseRepo: (repoRoot: string | null) => void;
  openSurface: (repo: CheckoutGitRepo, kind: RebaseSurfaceState["kind"]) => void;
}) {
  const { intent, consumeIntent } = useGitGraphConflictIntent(tabId);
  const pendingRef = useRef<{ intentId: number; requiredRevision: number } | null>(null);

  useEffect(() => {
    if (!intent || !active || !enabled) return;
    if (pendingRef.current?.intentId !== intent.id) {
      if (discover.isFetching && !discover.isSuccess) {
        pendingRef.current = { intentId: intent.id, requiredRevision: revision };
      } else {
        pendingRef.current = { intentId: intent.id, requiredRevision: revision + 1 };
        refresh();
      }
      return;
    }
    if (revision < pendingRef.current.requiredRevision) return;
    if (discover.isError && !discover.isFetching) {
      pendingRef.current = null;
      consumeIntent(intent.id);
      return;
    }
    if (!freshRead(discover)) return;

    pendingRef.current = null;
    consumeIntent(intent.id);
    const targetRepo = repos.find((entry) => entry.repoRoot === intent.repoRoot);
    if (!targetRepo) return;
    chooseRepo(targetRepo.repoRoot);
    if (rebase && isRebasePaused(targetRepo.operationState)) {
      openSurface(targetRepo, "conflicts");
    }
  }, [
    active,
    chooseRepo,
    consumeIntent,
    discover,
    enabled,
    intent,
    openSurface,
    rebase,
    refresh,
    repos,
    revision,
  ]);
}

function GraphNotices({ connected, notice }: { connected: boolean; notice?: string }) {
  const { t } = useTranslation();
  if (connected && !notice) return null;
  return (
    <View style={styles.stack}>
      {!connected ? <GraphMessage>{t("gitWorkbench.graph.disconnected")}</GraphMessage> : null}
      {notice ? <GraphMessage error>{notice}</GraphMessage> : null}
    </View>
  );
}

function useRepoChrome({
  repo,
  serverId,
  active,
  enabled,
  rebase,
  undoing,
  discovering,
  references,
  snapshot,
  openSurface,
  setNotice,
  undo,
}: {
  repo: CheckoutGitRepo | null;
  serverId: string;
  active: boolean;
  enabled: boolean;
  rebase: boolean;
  undoing: boolean;
  discovering: boolean;
  references: CheckoutGitRepoRefs[];
  snapshot?: RebaseSnapshot;
  openSurface: (repo: CheckoutGitRepo, kind: RebaseSurfaceState["kind"]) => void;
  setNotice: (notice?: string) => void;
  undo: (repo: CheckoutGitRepo, saved: RebaseSnapshot) => Promise<void>;
}) {
  const local = useIsLocalDaemon(serverId);
  const desktopTargets = useDesktopOpenTargets({
    isLocalExecution: active && local && !!repo,
    workspacePath: repo?.repoRoot,
  });
  const rebased = desktopTargets.targets.find(({ id }) => id === "rebased");
  const ontoOptions = references
    .filter(({ repoRoot }) => repoRoot === repo?.repoRoot)
    .flatMap((item) =>
      referenceGroups(item).flatMap(({ entries }) => entries.map(({ ref }) => ref)),
    );

  const onUndo = useStableEvent(() => {
    if (repo && snapshot) void undo(repo, snapshot);
  });
  const onOpenExternal = useStableEvent(() => {
    if (repo && rebased)
      void openDesktopTarget({ editorId: rebased.id, workspacePath: repo.repoRoot }).catch(
        (error: unknown) => setNotice(errorMessage(error)),
      );
  });
  const paused = isRebasePaused(repo?.operationState);
  const openRebase = useStableEvent(() => {
    if (repo) openSurface(repo, paused ? "conflicts" : "plan");
  });
  const busy = !enabled || undoing || discovering;
  const repoActions = repo ? (
    <RepoActions
      repo={repo}
      paused={paused}
      disabled={busy}
      rebase={rebase}
      canUndo={!!snapshot?.backupRef}
      onUndo={onUndo}
      onOpenExternal={rebased ? onOpenExternal : undefined}
      onOpenRebase={openRebase}
    />
  ) : null;
  return { repoActions, ontoOptions };
}

function useRebaseOperations({
  client,
  cwd,
  repo,
  serverId,
  action,
  revision,
  enabled,
  references,
  repoFresh,
  refresh,
  clearSelection,
  setNotice,
}: {
  client: DaemonClient;
  cwd: string;
  repo: CheckoutGitRepo | null;
  serverId: string;
  action: RebaseSurfaceState["kind"] | undefined;
  revision: number;
  enabled: boolean;
  references: CheckoutGitRepoRefs[];
  repoFresh: boolean;
  refresh: () => void;
  clearSelection: () => void;
  setNotice: (notice?: string) => void;
}) {
  const { t } = useTranslation();
  const [snapshots, setSnapshots] = useState<Record<string, RebaseSnapshot>>({});
  const [undoing, setUndoing] = useState(false);
  const undoPending = useRef(false);
  const lastResultSurface = useRef(new Map<string, number>());
  const liveEnabled = useLiveEnabled(enabled);
  const sessionSnapshot = repo ? snapshots[repo.repoRoot] : undefined;
  const readPausedSnapshot = isRebasePaused(repo?.operationState) || action === "conflicts";
  const workingTree = useRebaseWorkingTree({
    client,
    cwd,
    repoRoot: repo?.repoRoot,
    serverId,
    enabled: enabled && (readPausedSnapshot || !!sessionSnapshot?.completedHeadSha),
    revision,
  });
  const tree = workingTree.isSuccess && !workingTree.isFetching ? workingTree.data : undefined;
  const snapshot = selectRebaseSnapshot(
    repo,
    repoFresh,
    readPausedSnapshot,
    tree,
    references,
    sessionSnapshot,
  );
  const isCurrentUndo = useStableEvent(
    (target: CheckoutGitRepo, saved: RebaseSnapshot) =>
      repo?.repoRoot === target.repoRoot &&
      snapshot?.rebaseId === saved.rebaseId &&
      snapshot.backupRef === saved.backupRef &&
      snapshot.branch === saved.branch &&
      snapshot.completedHeadSha === saved.completedHeadSha,
  );
  function recordResult(
    source: RebaseSurfaceState,
    result: RebaseResult,
    plannedSteps?: number,
    aborted = false,
  ) {
    const repoRoot = source.repo.repoRoot;
    const last = lastResultSurface.current.get(repoRoot);
    if (last !== undefined && source.id < last) return;
    lastResultSurface.current.set(repoRoot, source.id);
    if (aborted) {
      setSnapshots((current) => {
        const next = { ...current };
        if (next[repoRoot]?.rebaseId === result.rebaseId) delete next[repoRoot];
        return next;
      });
    } else if (result.rebaseId) {
      const rebaseId = result.rebaseId;
      const completedHeadSha =
        result.success && result.operationState === "idle"
          ? (result.newHeadSha ?? undefined)
          : undefined;
      setSnapshots((current) => ({
        ...current,
        [repoRoot]: recordRebaseSnapshot(
          { rebaseId, backupRef: result.backupRef, completedHeadSha },
          source.kind === "plan" ? source.repo.currentBranch : null,
          plannedSteps,
          current[repoRoot],
        ),
      }));
    }
  }

  async function undo(target: CheckoutGitRepo, saved: RebaseSnapshot) {
    if (!saved.backupRef || undoPending.current || !liveEnabled.current) return;
    undoPending.current = true;
    setUndoing(true);
    setNotice(undefined);
    try {
      const approved = await confirmDialog({
        title: t("gitWorkbench.graph.confirmAction", {
          action: t("gitWorkbench.graph.undo"),
          repo: target.displayName,
        }),
        message: t("gitWorkbench.graph.confirmUndo", { backup: saved.backupRef }),
        confirmLabel: t("gitWorkbench.graph.undo"),
        destructive: true,
      });
      if (!approved || !liveEnabled.current || !isCurrentUndo(target, saved)) return;
      const result = await client.checkoutGitRebaseAct({
        cwd,
        targetRepoRoot: target.repoRoot,
        action: "undo",
        expectedRebaseId: saved.rebaseId,
        backupRef: saved.backupRef,
      });
      if (result.errorCode === "STALE_REBASE_INSTANCE") {
        setSnapshots((current) => {
          const next = { ...current };
          if (next[target.repoRoot]?.rebaseId === saved.rebaseId) delete next[target.repoRoot];
          return next;
        });
        if (liveEnabled.current) refresh();
        throw new Error(t("gitWorkbench.graph.staleRebase"));
      }
      if (!result.success) throw new Error(result.error ?? t("gitWorkbench.graph.rebaseFailed"));
      setSnapshots((current) => {
        const next = { ...current };
        if (next[target.repoRoot]?.rebaseId === saved.rebaseId) delete next[target.repoRoot];
        return next;
      });
      if (liveEnabled.current) {
        clearSelection();
        refresh();
      }
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      undoPending.current = false;
      setUndoing(false);
    }
  }

  return { snapshot, undoing, recordResult, undo, workingTree };
}

function selectRebaseSnapshot(
  repo: CheckoutGitRepo | null,
  repoFresh: boolean,
  readPausedSnapshot: boolean,
  tree: RebaseWorkingTree["data"],
  references: CheckoutGitRepoRefs[],
  sessionSnapshot: RebaseSnapshot | undefined,
) {
  if (!repo) return;
  if (readPausedSnapshot) {
    return recoverPausedRebaseSnapshot(repo.repoRoot, tree, references, sessionSnapshot);
  }
  if (sessionSnapshot?.completedHeadSha) {
    if (!repoFresh) return;
    return selectCompletedUndo(repo.repoRoot, tree, references, sessionSnapshot);
  }
}

function useGraphData({
  client,
  serverId,
  cwd,
  revision,
  enabled,
  focus,
  compiledFilters,
}: {
  client: DaemonClient;
  serverId: string;
  cwd: string;
  revision: number;
  enabled: boolean;
  focus: string | null;
  compiledFilters: ReturnType<typeof compileFilters>;
}) {
  const discover = useFetchQuery({
    dataShape: "list",
    staleTimeMs: 0,
    queryKey: ["git-graph-discover", serverId, cwd, revision],
    enabled,
    queryFn: async () => {
      const result = await client.checkoutGitReposDiscover({
        cwd,
        maxDepth: 2,
        includeWorktrees: true,
      });
      if (result.error) throw new Error(result.error);
      return result.repos;
    },
    retry: false,
    refetchOnWindowFocus: false,
  });
  const repos = discover.data ?? EMPTY_REPOS;
  const repo =
    repos.find(({ repoRoot }) => repoRoot === focus) ??
    (focus === null && repos.length === 1 ? repos[0] : null);
  const roots = useMemo(
    () =>
      focus
        ? repos.filter(({ repoRoot }) => repoRoot === focus).map(({ repoRoot }) => repoRoot)
        : repos.map(({ repoRoot }) => repoRoot),
    [focus, repos],
  );
  const allRoots = useMemo(() => repos.map(({ repoRoot }) => repoRoot), [repos]);
  const refs = useFetchQuery({
    dataShape: "list",
    staleTimeMs: 0,
    queryKey: ["git-graph-refs", serverId, cwd, allRoots, revision],
    enabled: enabled && allRoots.length > 0,
    queryFn: async () => {
      const result = await client.checkoutGitRefsList({
        cwd,
        repoRoots: allRoots,
        includeBackups: true,
      });
      if (result.error) throw new Error(result.error);
      return result.refs;
    },
    retry: false,
    refetchOnWindowFocus: false,
  });
  const references = refs.data ?? EMPTY_REFS;
  const log = useGraphLog({
    client,
    serverId,
    cwd,
    roots,
    filters: compiledFilters,
    revision,
    enabled,
  });
  const refLabels = useMemo(() => {
    const labels = new Map<string, string>();
    for (const info of references) {
      for (const group of referenceGroups(info)) {
        for (const entry of group.entries) {
          const key = commitKey({ repoRoot: info.repoRoot, sha: entry.sha });
          const label = labels.get(key);
          labels.set(key, label ? `${label}, ${entry.name}` : entry.name);
        }
      }
    }
    return labels;
  }, [references]);

  return { discover, refs, repos, repo, roots, references, log, refLabels };
}

function DetailSurfaces({
  client,
  cwd,
  selectedDetail,
  file,
  enabled,
  active,
  narrow,
  onDiff,
  clearSelection,
  closeFile,
}: {
  client: DaemonClient;
  cwd: string;
  selectedDetail: CheckoutGitLogCommit | null;
  file: string | null;
  enabled: boolean;
  active: boolean;
  narrow: boolean;
  onDiff: (path: string) => void;
  clearSelection: () => void;
  closeFile: () => void;
}) {
  const { t } = useTranslation();
  const detail = selectedDetail ? (
    <CommitDetail
      key={commitKey(selectedDetail)}
      client={client}
      cwd={cwd}
      commit={selectedDetail}
      enabled={enabled && !file}
      onDiff={onDiff}
    />
  ) : (
    <View style={styles.stack}>
      <GraphMessage>{t("gitWorkbench.graph.selectCommit")}</GraphMessage>
    </View>
  );
  const drawerTitle = selectedDetail?.subject || t("gitWorkbench.graph.files");
  const drawerHeader = useMemo(() => ({ title: drawerTitle }), [drawerTitle]);
  return (
    <>
      {narrow ? null : <View style={[styles.paneBorder, styles.detailColumn]}>{detail}</View>}
      {active && narrow && selectedDetail && !file ? (
        <GraphSheet
          visible
          header={drawerHeader}
          onClose={clearSelection}
          scrollable={false}
          desktopHeight="80%"
          snapPoints={DETAILS_SNAP}
        >
          {detail}
        </GraphSheet>
      ) : null}
      {active && selectedDetail && file ? (
        <CommitFileSheet
          key={file}
          client={client}
          commit={selectedDetail}
          path={file}
          enabled={enabled}
          onClose={closeFile}
        />
      ) : null}
    </>
  );
}

function RebaseSurface({
  client,
  cwd,
  surface,
  enabled,
  ontoOptions,
  snapshot,
  workingTree,
  onClose,
  onResult,
  onChangedWhileHidden,
}: {
  client: DaemonClient;
  cwd: string;
  surface: RebaseSurfaceState;
  enabled: boolean;
  ontoOptions: string[];
  snapshot: RebaseSnapshot | null;
  workingTree: RebaseWorkingTree;
  onClose: (source: RebaseSurfaceState) => void;
  onResult: (
    source: RebaseSurfaceState,
    result: RebaseResult,
    steps?: number,
    aborted?: boolean,
  ) => void;
  onChangedWhileHidden: () => void;
}) {
  const { repo, kind } = surface;
  const close = useStableEvent(() => onClose(surface));
  const planResult = useStableEvent((result: RebaseResult, steps: number) =>
    onResult(surface, result, steps),
  );
  const conflictResult = useStableEvent((result: RebaseResult, action: string) =>
    onResult(surface, result, undefined, action === "abort" && result.success),
  );
  return (
    <>
      {kind === "plan" ? (
        <PlanSheet
          key={repo.repoRoot}
          client={client}
          cwd={cwd}
          repo={repo}
          enabled={enabled}
          ontoOptions={ontoOptions}
          onClose={close}
          onResult={planResult}
        />
      ) : null}
      {kind === "conflicts" ? (
        <ConflictSheet
          key={repo.repoRoot}
          client={client}
          cwd={cwd}
          repo={repo}
          enabled={enabled}
          snapshot={snapshot}
          workingTree={workingTree}
          onClose={close}
          onResult={conflictResult}
          onChangedWhileHidden={onChangedWhileHidden}
        />
      ) : null}
    </>
  );
}

function RepoToolbar({
  repos,
  focus,
  choose,
  disabled,
  onRefresh,
  refreshing,
  touchStart,
  touchEnd,
}: {
  repos: CheckoutGitRepo[];
  focus: string | null;
  choose: (root: string | null) => void;
  disabled: boolean;
  onRefresh: () => void;
  refreshing: boolean;
  touchStart: () => void;
  touchEnd: () => void;
}) {
  const { t } = useTranslation();
  return (
    <View style={styles.bar}>
      <ScrollView
        horizontal
        keyboardShouldPersistTaps="handled"
        onTouchStart={touchStart}
        onTouchEnd={touchEnd}
        onTouchCancel={touchEnd}
      >
        <View style={styles.row}>
          <RepoChip
            name={t("gitWorkbench.graph.allRepos")}
            root={null}
            selected={focus === null}
            disabled={disabled}
            choose={choose}
          />
          {repos.map((item) => (
            <RepoChip
              key={item.repoId}
              name={item.displayName}
              root={item.repoRoot}
              selected={focus === item.repoRoot}
              disabled={disabled}
              choose={choose}
            />
          ))}
        </View>
      </ScrollView>
      <Button size="sm" variant="ghost" disabled={refreshing} onPress={onRefresh}>
        {t("gitWorkbench.graph.refresh")}
      </Button>
    </View>
  );
}

function RepoChip({
  root,
  name,
  selected,
  disabled,
  choose,
}: {
  root: string | null;
  name: string;
  selected: boolean;
  disabled: boolean;
  choose: (root: string | null) => void;
}) {
  const press = useStableEvent(() => choose(root));
  return (
    <Button
      size="sm"
      variant={selected ? "secondary" : "ghost"}
      accessibilityState={selected ? SELECTED : UNSELECTED}
      disabled={disabled}
      onPress={press}
    >
      <View style={styles.row}>
        {root ? <RepoDot root={root} /> : null}
        <Text style={styles.text}>{name}</Text>
      </View>
    </Button>
  );
}

function RepoActions({
  repo,
  paused,
  disabled,
  rebase,
  canUndo,
  onOpenRebase,
  onUndo,
  onOpenExternal,
}: {
  repo: CheckoutGitRepo;
  paused: boolean;
  disabled: boolean;
  rebase: boolean;
  canUndo: boolean;
  onOpenRebase: () => void;
  onUndo: () => void;
  onOpenExternal?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <View style={[styles.bar, styles.wrap]}>
      <Text style={styles.muted}>{repo.currentBranch ?? repo.headSha?.slice(0, 8)}</Text>
      {rebase ? (
        <Button
          size="sm"
          variant="outline"
          disabled={
            disabled ||
            (!paused && (repo.operationState !== "idle" || !repo.currentBranch || !repo.headSha))
          }
          onPress={onOpenRebase}
        >
          {t(paused ? "gitWorkbench.graph.resumeRebase" : "gitWorkbench.graph.rebase")}
        </Button>
      ) : (
        <GraphMessage>{t("gitWorkbench.graph.rebaseUpgrade")}</GraphMessage>
      )}
      {rebase && canUndo ? (
        <Button size="sm" variant="ghost" disabled={disabled} onPress={onUndo}>
          {t("gitWorkbench.graph.undo")}
        </Button>
      ) : null}
      {onOpenExternal ? (
        <Button size="sm" variant="ghost" onPress={onOpenExternal}>
          {t("gitWorkbench.graph.openRebased")}
        </Button>
      ) : null}
    </View>
  );
}

function GraphLog({
  log,
  selected,
  refLabels,
  narrow,
  connected,
  enabled,
  discovering,
  repositoryMissing,
  error,
  onSelect,
}: {
  log: ReturnType<typeof useGraphLog>;
  selected: CheckoutGitLogCommit | null;
  refLabels: ReadonlyMap<string, string>;
  narrow: boolean;
  connected: boolean;
  enabled: boolean;
  discovering: boolean;
  repositoryMissing: boolean;
  error: Error | null | undefined;
  onSelect: (commit: CheckoutGitLogCommit) => void;
}) {
  const { t } = useTranslation();
  let emptyMessage: string | null = null;
  if (discovering || log.isFetching) emptyMessage = t("gitWorkbench.graph.loading");
  else if (!error && connected)
    emptyMessage = t(
      repositoryMissing ? "gitWorkbench.noRepository" : "gitWorkbench.graph.noCommits",
    );
  return (
    <>
      {error ? (
        <View style={styles.stack}>
          <GraphMessage error>{errorMessage(error)}</GraphMessage>
        </View>
      ) : null}
      {log.commits.length ? (
        <CommitList
          commits={log.commits}
          selectedKey={selected ? commitKey(selected) : null}
          onSelect={onSelect}
          hasMore={log.hasNextPage}
          narrow={narrow}
          refLabels={refLabels}
        />
      ) : (
        <View style={[styles.fill, styles.stack]}>
          {emptyMessage ? <GraphMessage>{emptyMessage}</GraphMessage> : null}
        </View>
      )}
      {log.last ? (
        <View style={[styles.bar, styles.rowBorder]}>
          <Text style={[styles.muted, styles.fill]}>
            {t("gitWorkbench.graph.pageSummary", {
              count: log.commits.length,
              size: Math.ceil(log.last.approxBytes / 1024),
            })}
          </Text>
          {log.hasNextPage ? (
            <Button
              size="sm"
              variant="outline"
              disabled={!enabled || log.isFetching}
              onPress={log.fetchNextPage}
            >
              {t("gitWorkbench.graph.loadMore")}
            </Button>
          ) : null}
        </View>
      ) : null}
    </>
  );
}

const fields = [
  ["branchFilter", "branch"],
  ["authorFilter", "author"],
  ["textQuery", "search"],
  ["since", "since"],
  ["until", "until"],
] as const;
const flags = ["regex", "matchCase"] as const;
const EXPANDED = { expanded: true };
const COLLAPSED = { expanded: false };

function Filters({
  value,
  invalidDates,
  onChange,
  onApply,
  onClear,
  refs,
}: {
  value: GraphFilters;
  invalidDates: boolean;
  onChange: (value: GraphFilters) => void;
  onApply: () => void;
  onClear: () => void;
  refs: ReactNode;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const toggle = useStableEvent(() => setExpanded((open) => !open));
  const update = useStableEvent(<K extends keyof GraphFilters>(field: K, next: GraphFilters[K]) =>
    onChange({ ...value, [field]: next }),
  );
  return (
    <View>
      <View style={styles.bar}>
        {refs}
        <Button
          size="sm"
          variant="ghost"
          accessibilityState={expanded ? EXPANDED : COLLAPSED}
          onPress={toggle}
        >
          {t("gitWorkbench.graph.filters")}
        </Button>
        <Button size="sm" variant="ghost" onPress={onClear}>
          {t("gitWorkbench.graph.clear")}
        </Button>
      </View>
      {expanded ? (
        <View style={styles.stack}>
          <View style={styles.wrap}>
            {fields.map(([field, label]) => (
              <FilterField
                key={field}
                field={field}
                label={t(`gitWorkbench.graph.${label}`)}
                value={value[field]}
                update={update}
                onApply={invalidDates ? undefined : onApply}
              />
            ))}
          </View>
          <View style={styles.wrap}>
            {flags.map((field) => (
              <FilterFlag
                key={field}
                field={field}
                label={t(`gitWorkbench.graph.${field}`)}
                value={value[field]}
                update={update}
              />
            ))}
            <Button size="sm" variant="outline" disabled={invalidDates} onPress={onApply}>
              {t("gitWorkbench.graph.filter")}
            </Button>
          </View>
          {invalidDates ? (
            <GraphMessage error>{t("gitWorkbench.graph.invalidDates")}</GraphMessage>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function FilterField({
  field,
  label,
  value,
  update,
  onApply,
}: {
  field: (typeof fields)[number][0];
  label: string;
  value: string;
  update: (field: (typeof fields)[number][0], value: string) => void;
  onApply?: () => void;
}) {
  const onChangeText = useStableEvent((next: string) => update(field, next));
  return (
    <GraphInput
      accessibilityLabel={label}
      placeholder={label}
      value={value}
      onChangeText={onChangeText}
      onSubmitEditing={onApply}
      autoCapitalize="none"
    />
  );
}

function FilterFlag({
  field,
  label,
  value,
  update,
}: {
  field: (typeof flags)[number];
  label: string;
  value: boolean;
  update: (field: (typeof flags)[number], value: boolean) => void;
}) {
  const onValueChange = useStableEvent((next: boolean) => update(field, next));
  return (
    <View style={styles.row}>
      <Text style={styles.text}>{label}</Text>
      <Switch value={value} accessibilityLabel={label} onValueChange={onValueChange} />
    </View>
  );
}

export const gitGraphPanelRegistration = definePanel("git_graph", {
  component: GitGraphPanel,
  presentation: {
    label: (t) => t("gitWorkbench.graphTitle"),
    subtitle: (t) => t("gitWorkbench.graphTitle"),
    tooltip: (t) => t("gitWorkbench.graphTitle"),
    icon: GitFork,
  },
});
