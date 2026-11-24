import { useFetchQuery } from "@/data/query";
import { useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { CheckoutGitConflictFile, CheckoutGitRepo } from "@getpaseo/protocol/messages";
import { GraphSheet } from "../graph/sheet";
import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/select-field";
import { createQuoteAttachment } from "@/attachments/quote";
import { dispatchComposerAgentMessage } from "@/composer/actions";
import { createMessageSubmissionWriter } from "@/composer/submission/writer";
import { useStableEvent } from "@/hooks/use-stable-event";
import { confirmDialog } from "@/utils/confirm-dialog";
import { usePaneContext } from "@/panels/pane-context";
import { useGraphRecipients } from "../graph/recipients";
import { errorMessage, GraphMessage, styles } from "../graph/ui";
import { buildConflictQuote } from "./delegation";
import type { RebaseResult } from "./plan-sheet";
import { isRebasePaused, type RebaseSnapshot } from "./snapshot";
import { useLiveEnabled } from "./use-live-enabled";
import { refreshVisibleConflict, type RebaseWorkingTree } from "./use-working-tree";

type Strategy = Parameters<DaemonClient["checkoutGitConflictResolve"]>[0]["strategy"];
type Act = Parameters<DaemonClient["checkoutGitRebaseAct"]>[0]["action"];
const conflictChoices = ["ours", "theirs", "both"] as const;
const sides = ["base", "ours", "theirs"] as const;

export function ConflictSheet({
  cwd,
  client,
  repo,
  enabled,
  snapshot,
  workingTree,
  onClose,
  onResult,
  onChangedWhileHidden,
}: {
  cwd: string;
  client: DaemonClient;
  repo: CheckoutGitRepo;
  enabled: boolean;
  snapshot: RebaseSnapshot | null;
  workingTree: RebaseWorkingTree;
  onClose: () => void;
  onResult: (result: RebaseResult, action: Exclude<Act, "undo">) => void;
  onChangedWhileHidden: () => void;
}) {
  const { t } = useTranslation();
  const { serverId } = usePaneContext();
  const target = { cwd, targetRepoRoot: repo.repoRoot };
  const [path, setPath] = useState<string | null>(null);
  const [recipientId, setRecipientId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error: boolean }>();
  const [stale, setStale] = useState(false);
  const pending = useRef(false);
  const liveEnabled = useLiveEnabled(enabled);
  const recipient = useGraphRecipients(enabled);
  // The client has session roles, but no effective write grants for an individual repository.
  const available = recipient.recipients.filter(({ isMain }) => isMain);
  const selectedRecipient = available.find(({ id }) => id === recipientId) ?? available[0];

  const {
    files,
    file,
    activePath,
    rebaseId,
    readError,
    refreshing,
    initialId,
    changed,
    refresh,
    branch,
  } = useConflictSnapshot({
    client,
    cwd,
    serverId,
    repo,
    enabled,
    workingTree,
    path,
    liveEnabled,
  });
  const blocked = [!enabled, busy, refreshing, stale, changed, !!readError, !initialId].some(
    Boolean,
  );
  const ready = !blocked && !!rebaseId;

  async function run(operation: () => Promise<void>) {
    if (pending.current || !liveEnabled.current) return;
    pending.current = true;
    setBusy(true);
    setNotice(undefined);
    try {
      await operation();
    } catch (error) {
      if (liveEnabled.current) setNotice({ text: errorMessage(error), error: true });
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  function resolve(focusedFile: CheckoutGitConflictFile, strategy: Strategy, hunkIndex?: number) {
    if (!ready || !rebaseId) return;
    return run(async () => {
      const result = await client.checkoutGitConflictResolve({
        ...target,
        path: focusedFile.path,
        strategy,
        hunkIndex,
        expectedConflictFingerprint: focusedFile.conflictFingerprint,
      });
      if (!liveEnabled.current) {
        if (result.success) onChangedWhileHidden();
        return;
      }
      await refresh();
      if (!liveEnabled.current && result.success) onChangedWhileHidden();
      if (result.errorCode === "STALE_CONFLICT_SNAPSHOT")
        throw new Error(t("gitWorkbench.graph.staleConflict"));
      if (!result.success) throw new Error(result.error ?? t("gitWorkbench.graph.rebaseFailed"));
    });
  }

  function act(action: Exclude<Act, "undo">) {
    if (!ready || !rebaseId) return;
    return run(async () => {
      if (action !== "continue") {
        const approved = await confirmDialog({
          title: t("gitWorkbench.graph.confirmAction", {
            action: t(`gitWorkbench.graph.${action}`),
            repo: repo.displayName,
          }),
          message: t(
            action === "abort"
              ? "gitWorkbench.graph.confirmAbort"
              : "gitWorkbench.graph.confirmSkip",
          ),
          confirmLabel: t(`gitWorkbench.graph.${action}`),
          destructive: true,
        });
        if (!approved || !liveEnabled.current) return;
      }
      const result = await client.checkoutGitRebaseAct({
        ...target,
        action,
        expectedRebaseId: rebaseId,
      });
      if (result.errorCode === "STALE_REBASE_INSTANCE") {
        if (liveEnabled.current) setStale(true);
        throw new Error(t("gitWorkbench.graph.staleRebase"));
      }
      if (result.errorCode === "REBASE_CONFLICT_PAUSED") {
        if (liveEnabled.current) await refresh();
        onResult(result, action);
        return;
      }
      if (!result.success) throw new Error(result.error ?? t("gitWorkbench.graph.rebaseFailed"));
      onResult(result, action);
    });
  }

  function delegate(focusedFile: CheckoutGitConflictFile, bindMain: boolean) {
    if (!ready || !rebaseId) return;
    return run(async () => {
      const metadata = snapshot?.rebaseId === rebaseId ? snapshot : null;
      const quote = buildConflictQuote({
        targetRepoRoot: repo.repoRoot,
        branch: metadata?.branch ?? branch,
        backupRef: metadata?.backupRef ?? null,
        plannedSteps: metadata?.plannedSteps ?? null,
        rebaseId,
        file: focusedFile,
      });
      const label = focusedFile.path;
      if (bindMain) {
        await recipient.appendDraft(
          { quote, label },
          null,
          t("gitWorkbench.graph.delegateMainPrompt"),
        );
        if (liveEnabled.current) onClose();
        return;
      }
      if (!selectedRecipient) return;
      await dispatchComposerAgentMessage({
        client,
        agentId: selectedRecipient.id,
        text: t("gitWorkbench.graph.delegateMainPrompt"),
        attachments: [createQuoteAttachment({ text: quote, label })],
        encodeImages: async () => [],
        submission: createMessageSubmissionWriter(serverId),
      });
      setNotice({ text: t("gitWorkbench.graph.delegated"), error: false });
    });
  }

  const close = useStableEvent(() => {
    if (!pending.current) onClose();
  });
  const refreshFiles = useStableEvent(() => void run(refresh));
  const abort = useStableEvent(() => void act("abort"));
  const skip = useStableEvent(() => void act("skip"));
  const continueRebase = useStableEvent(() => void act("continue"));
  const onResolve = useStableEvent((strategy: Strategy, hunkIndex?: number) => {
    if (file) void resolve(file, strategy, hunkIndex);
  });
  const onBind = useStableEvent(() => {
    if (file) void delegate(file, true);
  });
  const onDelegate = useStableEvent(() => {
    if (file) void delegate(file, false);
  });
  const title = t("gitWorkbench.graph.conflicts");
  const header = useMemo(() => ({ title }), [title]);
  const canRefresh = enabled && !busy && !refreshing;
  const hasFiles = files.length > 0;
  const footer = useMemo(
    () => (
      <ConflictActions
        ready={ready}
        canRefresh={canRefresh}
        hasFiles={hasFiles}
        onRefresh={refreshFiles}
        onAbort={abort}
        onSkip={skip}
        onContinue={continueRebase}
      />
    ),
    [ready, canRefresh, hasFiles, refreshFiles, abort, skip, continueRebase],
  );

  return (
    <GraphSheet
      visible
      header={header}
      testID="git-rebase-conflicts"
      onClose={close}
      desktopMaxWidth={820}
      snapPoints={CONFLICT_SNAP_POINTS}
      scrollable
      footer={footer}
    >
      <View style={styles.stack}>
        <Text style={styles.heading}>{repo.displayName}</Text>
        <ConflictStatus
          refreshing={refreshing}
          noFiles={files.length === 0}
          awaitingId={!rebaseId}
          changed={changed || stale}
          notice={notice}
          readError={readError}
        />
        {activePath ? (
          <ConflictFilePicker path={activePath} files={files} onChange={setPath} disabled={busy} />
        ) : null}
        {file ? (
          <ConflictFile file={file} disabled={!ready} onResolve={onResolve}>
            <DelegationControls
              available={available}
              selected={selectedRecipient}
              unbound={recipient.unbound}
              disabled={!ready}
              onChange={setRecipientId}
              onBind={onBind}
              onDelegate={onDelegate}
            />
          </ConflictFile>
        ) : null}
      </View>
    </GraphSheet>
  );
}

const CONFLICT_SNAP_POINTS = ["90%"];

function useConflictSnapshot({
  client,
  cwd,
  serverId,
  repo,
  enabled,
  workingTree,
  path,
  liveEnabled,
}: {
  client: DaemonClient;
  cwd: string;
  serverId: string;
  repo: CheckoutGitRepo;
  enabled: boolean;
  workingTree: RebaseWorkingTree;
  path: string | null;
  liveEnabled: { current: boolean };
}) {
  const [initialId, setInitialId] = useState<string | null>(null);
  const target = { cwd, targetRepoRoot: repo.repoRoot };
  const paths = workingTree.data?.conflicts;
  const selectedPath = selectConflictPath(paths, path);
  const read = workingTree.data;
  const pausedHere = read?.repoRoot === repo.repoRoot && isRebasePaused(read.operationState);
  const inspectPath = selectedPath ?? undefined;
  const canInspect = enabled && pausedHere && workingTree.isSuccess && inspectPath !== undefined;
  const inspect = useInspectConflict(client, target, serverId, canInspect, inspectPath);
  const { files, activePath, file } = readConflictSelection(
    paths ?? inspect.data,
    inspect.data,
    path,
  );
  const rebaseId = pausedHere ? (read.rebaseId ?? null) : null;
  const refreshing = workingTree.isFetching || inspect.isFetching;
  if (initialId === null && rebaseId && !refreshing) setInitialId(rebaseId);
  const differentInstance = initialId !== null && rebaseId !== initialId;
  const readError = [workingTree.error, inspect.error].find(Boolean) ?? null;
  const readConflict = useStableEvent(async () => {
    if (inspect.isEnabled) await inspect.refetch();
  });
  const refresh = useStableEvent(() =>
    refreshVisibleConflict(liveEnabled, workingTree.refetch, readConflict),
  );

  return {
    files,
    file,
    activePath,
    rebaseId,
    readError,
    refreshing,
    initialId,
    changed: differentInstance,
    refresh,
    branch: workingTree.data?.currentBranch ?? repo.currentBranch,
  };
}

interface ConflictTarget {
  cwd: string;
  targetRepoRoot: string;
}

function useInspectConflict(
  client: DaemonClient,
  target: ConflictTarget,
  serverId: string,
  enabled: boolean,
  inspectPath?: string,
) {
  return useFetchQuery({
    dataShape: "value",
    staleTimeMs: 0,
    queryKey: ["git-rebase-conflicts", serverId, target.cwd, target.targetRepoRoot, inspectPath],
    enabled,
    queryFn: async () => {
      const result = await client.checkoutGitConflictInspect({ ...target, path: inspectPath });
      if (result.error) throw new Error(result.error);
      return result.conflicts;
    },
    retry: false,
  });
}

function readConflictSelection(
  paths: readonly { path: string }[] | undefined,
  inspected: readonly CheckoutGitConflictFile[] | undefined,
  path: string | null,
) {
  const activePath = selectConflictPath(paths, path);
  return {
    files: paths ?? [],
    activePath,
    file: inspected?.find((entry) => entry.path === activePath),
  };
}

function selectConflictPath(
  paths: readonly { path: string }[] | undefined,
  current: string | null,
) {
  return paths?.some((entry) => entry.path === current) ? current : (paths?.[0]?.path ?? null);
}

function ConflictActions({
  ready,
  canRefresh,
  hasFiles,
  onRefresh,
  onAbort,
  onSkip,
  onContinue,
}: {
  ready: boolean;
  canRefresh: boolean;
  hasFiles: boolean;
  onRefresh: () => void;
  onAbort: () => void;
  onSkip: () => void;
  onContinue: () => void;
}) {
  const { t } = useTranslation();
  return (
    <View style={styles.wrap}>
      <Button variant="outline" disabled={!canRefresh} onPress={onRefresh}>
        {t("gitWorkbench.graph.refresh")}
      </Button>
      <Button variant="ghost" disabled={!ready} onPress={onAbort}>
        {t("gitWorkbench.graph.abort")}
      </Button>
      <Button variant="ghost" disabled={!ready} onPress={onSkip}>
        {t("gitWorkbench.graph.skip")}
      </Button>
      <Button disabled={!ready || hasFiles} onPress={onContinue}>
        {t("gitWorkbench.graph.continue")}
      </Button>
    </View>
  );
}

function ConflictStatus({
  refreshing,
  noFiles,
  awaitingId,
  changed,
  notice,
  readError,
}: {
  refreshing: boolean;
  noFiles: boolean;
  awaitingId: boolean;
  changed: boolean;
  notice?: { text: string; error: boolean };
  readError: Error | null;
}) {
  const { t } = useTranslation();
  return (
    <>
      {refreshing ? <GraphMessage>{t("gitWorkbench.graph.loading")}</GraphMessage> : null}
      {readError ? <GraphMessage error>{errorMessage(readError)}</GraphMessage> : null}
      {notice ? <GraphMessage error={notice.error}>{notice.text}</GraphMessage> : null}
      {changed ? <GraphMessage error>{t("gitWorkbench.graph.staleRebase")}</GraphMessage> : null}
      {awaitingId && !refreshing ? (
        <GraphMessage>{t("gitWorkbench.graph.noRebaseId")}</GraphMessage>
      ) : null}
      {noFiles && !refreshing && !readError ? (
        <GraphMessage>{t("gitWorkbench.graph.noConflicts")}</GraphMessage>
      ) : null}
    </>
  );
}

function ConflictFilePicker({
  path,
  files,
  disabled,
  onChange,
}: {
  path: string;
  files: readonly { path: string }[];
  disabled: boolean;
  onChange: (path: string) => void;
}) {
  const { t } = useTranslation();
  const label = t("gitWorkbench.graph.files");
  const display = useMemo(() => ({ label: path }), [path]);
  return (
    <SelectField
      label={label}
      placeholder={label}
      emptyText={t("gitWorkbench.graph.noConflicts")}
      value={path}
      selectedDisplay={display}
      options={files.map((item) => ({ id: item.path, value: item.path, label: item.path }))}
      onChange={onChange}
      disabled={disabled}
    />
  );
}

type Resolve = (strategy: Strategy, hunkIndex?: number) => void;

function ConflictFile({
  file,
  disabled,
  onResolve,
  children,
}: {
  file: CheckoutGitConflictFile;
  disabled: boolean;
  onResolve: Resolve;
  children: React.ReactNode;
}) {
  return (
    <>
      <View style={styles.wrap}>
        <ResolutionButton strategy="mark_resolved" disabled={disabled} onResolve={onResolve} />
        {file.hunks.length === 0 ? (
          <>
            <ResolutionButton strategy="ours" disabled={disabled} onResolve={onResolve} />
            <ResolutionButton strategy="theirs" disabled={disabled} onResolve={onResolve} />
          </>
        ) : null}
      </View>
      {children}
      {file.hunks.map((hunk) => (
        <ConflictHunk key={hunk.index} hunk={hunk} disabled={disabled} onResolve={onResolve} />
      ))}
    </>
  );
}

function ConflictHunk({
  hunk,
  disabled,
  onResolve,
}: {
  hunk: CheckoutGitConflictFile["hunks"][number];
  disabled: boolean;
  onResolve: Resolve;
}) {
  const { t } = useTranslation();
  return (
    <View style={[styles.stack, styles.rowBorder]}>
      {sides.map((side) => (
        <View key={side}>
          <Text style={styles.heading}>{t(`gitWorkbench.graph.${side}`)}</Text>
          <Text selectable style={styles.text}>
            {hunk[side] ?? t("gitWorkbench.graph.noContent")}
          </Text>
        </View>
      ))}
      <View style={styles.wrap}>
        {conflictChoices.map((strategy) => (
          <ResolutionButton
            key={strategy}
            strategy={strategy}
            disabled={disabled}
            index={hunk.index}
            onResolve={onResolve}
          />
        ))}
      </View>
    </View>
  );
}

function ResolutionButton({
  strategy,
  disabled,
  index,
  onResolve,
}: {
  strategy: Strategy;
  disabled: boolean;
  index?: number;
  onResolve: Resolve;
}) {
  const { t } = useTranslation();
  const press = useStableEvent(() => onResolve(strategy, index));
  const label = strategy === "mark_resolved" ? "markResolved" : strategy;
  return (
    <Button variant="outline" disabled={disabled} onPress={press}>
      {t(`gitWorkbench.graph.${label}`)}
    </Button>
  );
}

type Recipient = ReturnType<typeof useGraphRecipients>["recipients"][number];

function DelegationControls({
  available,
  selected,
  unbound,
  disabled,
  onChange,
  onBind,
  onDelegate,
}: {
  available: Recipient[];
  selected?: Recipient;
  unbound: boolean;
  disabled: boolean;
  onChange: (id: string) => void;
  onBind: () => void;
  onDelegate: () => void;
}) {
  const { t } = useTranslation();
  const display = useMemo(() => (selected ? { label: selected.title } : null), [selected]);
  const label = t("gitWorkbench.graph.recipient");
  return (
    <>
      {unbound ? (
        <Button variant="outline" disabled={disabled} onPress={onBind}>
          {t("gitWorkbench.graph.bindMain")}
        </Button>
      ) : null}
      {selected ? (
        <View style={styles.wrap}>
          <SelectField
            field={false}
            label={label}
            placeholder={label}
            emptyText={t("gitWorkbench.graph.noRecipient")}
            value={selected.id}
            selectedDisplay={display}
            options={available.map(({ id, title }) => ({ id, value: id, label: title }))}
            onChange={onChange}
            disabled={disabled}
          />
          <Button disabled={disabled} onPress={onDelegate}>
            {t("gitWorkbench.graph.delegate")}
          </Button>
        </View>
      ) : null}
    </>
  );
}
