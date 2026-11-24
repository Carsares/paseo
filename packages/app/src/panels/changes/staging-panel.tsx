import { useCallback, useMemo, useRef, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import type {
  CheckoutGitFile,
  CheckoutGitStashEntry,
  CheckoutGitWorkingTree,
} from "@getpaseo/protocol/messages";
import { Check, Minus, MoreHorizontal } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { EditingTextInput, type EditingTextInputHandle } from "@/components/ui/text-input";
import { PressHighlight } from "@/components/ui/press-highlight";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { StagingDiffPane } from "@/git/diff-pane";
import { fileSelection, type StagingLayer } from "@/git/staging/model";
import { useStaging } from "@/git/staging/use-staging";

type Tab = "commit" | "stash";
interface Selection {
  layer: StagingLayer;
  path: string;
}
type Staging = ReturnType<typeof useStaging>;

const Checked = withUnistyles(Check, (theme) => ({ color: theme.colors.foreground }));
const More = withUnistyles(MoreHorizontal, (theme) => ({ color: theme.colors.foregroundMuted }));
const Mixed = withUnistyles(Minus, (theme) => ({ color: theme.colors.foreground }));

export function StagingPanel({
  serverId,
  workspaceId,
  cwd,
  active,
  onOpenComparison,
}: {
  serverId: string;
  workspaceId: string;
  cwd: string;
  active: boolean;
  onOpenComparison: () => void;
}) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>("commit");
  const [selection, setSelection] = useState<Selection | null>(null);
  const staging = useStaging(serverId, cwd, active, tab === "stash");
  const { tree, treeQuery, connected, busy, refresh, mutate, canWrite } = staging;
  const onTabChange = useCallback(
    (value: Tab) => {
      if (busy) return;
      setSelection(null);
      setTab(value);
    },
    [busy],
  );
  const refreshPanel = useCallback(() => void refresh(), [refresh]);
  const leaveDiff = useCallback(() => setSelection(null), []);
  const showLoading = !tree && connected && !treeQuery.isError;
  return (
    <View style={styles.container}>
      <View style={styles.toolbar}>
        <SegmentedControl<Tab>
          size="sm"
          value={tab}
          onValueChange={onTabChange}
          options={[
            { value: "commit", label: t("gitWorkbench.commitTab") },
            { value: "stash", label: t("gitWorkbench.stashTab") },
          ]}
        />
        <Button
          size="sm"
          variant="ghost"
          disabled={!connected || busy || treeQuery.isFetching}
          onPress={refreshPanel}
        >
          {t("gitWorkbench.refresh")}
        </Button>
      </View>
      <StagingStatus staging={staging} />
      {showLoading ? <Text style={styles.summary}>{t("common.loading")}</Text> : null}
      {tree && tab === "stash" ? (
        <StashPanel key={"stash:" + tree.repoRoot} staging={staging} />
      ) : null}
      {tree && tab === "commit" && selection ? (
        <View
          style={styles.container}
          key={JSON.stringify([tree.repoRoot, selection.layer, selection.path])}
        >
          <View style={styles.toolbar}>
            <Button size="sm" variant="ghost" onPress={leaveDiff}>
              {t("gitWorkbench.backToChanges")}
            </Button>
            <Text style={styles.muted}>{t("gitWorkbench." + selection.layer)}</Text>
          </View>
          <StagingDiffPane
            serverId={serverId}
            workspaceId={workspaceId}
            tree={tree}
            active={active}
            layer={selection.layer}
            path={selection.path}
            canWrite={canWrite}
            mutate={mutate}
          />
        </View>
      ) : null}
      {tree && tab === "commit" && !selection ? (
        <ScrollView style={styles.container} contentContainerStyle={styles.list}>
          {tree.conflicts.length > 0 ? (
            <View style={styles.section}>
              <Text accessibilityRole="header" style={styles.error}>
                {t("gitWorkbench.conflicts")}
              </Text>
              {tree.conflicts.map(({ path, status }) => (
                <Text key={path} style={styles.text}>
                  {path} · {status}
                </Text>
              ))}
            </View>
          ) : null}
          <ChangeSection
            tree={tree}
            layer="staged"
            disabled={!canWrite}
            onSelect={setSelection}
            mutate={mutate}
          />
          <ChangeSection
            tree={tree}
            layer="unstaged"
            disabled={!canWrite}
            onSelect={setSelection}
            mutate={mutate}
          />
          <View style={styles.actions}>
            <Button size="sm" variant="ghost" onPress={onOpenComparison}>
              {t("gitWorkbench.openComparison")}
            </Button>
          </View>
        </ScrollView>
      ) : null}
      {tree ? (
        <CommitForm key={"commit:" + tree.repoRoot} staging={staging} hidden={tab !== "commit"} />
      ) : null}
    </View>
  );
}

function StagingStatus({ staging }: { staging: Staging }) {
  const { t } = useTranslation();
  const { tree, treeQuery, connected, notice } = staging;
  const agents = notice?.agents ?? tree?.activeAgents ?? [];
  return (
    <View accessibilityLiveRegion="polite" style={styles.summary}>
      {!connected ? (
        <Text style={styles.muted}>{t("workspace.terminal.hostDisconnected")}</Text>
      ) : null}
      {treeQuery.isError ? <Text style={styles.error}>{treeQuery.error.message}</Text> : null}
      {tree ? (
        <Text numberOfLines={1} style={styles.muted}>
          {tree.currentBranch ||
            t(tree.headSha ? "gitWorkbench.detachedHead" : "gitWorkbench.unbornHead")}
          {tree.operationState !== "idle"
            ? " · " + t("gitWorkbench.operation." + tree.operationState)
            : ""}
        </Text>
      ) : null}
      {agents.length > 0 ? (
        <Text style={styles.muted} numberOfLines={2}>
          {t("gitWorkbench.activeAgents", {
            agents: agents.map((agent) => agent.title || agent.agentId).join(", "),
          })}
        </Text>
      ) : null}
      {notice ? (
        <Text selectable style={notice.tone === "error" ? styles.error : styles.muted}>
          {[
            notice.message,
            notice.lockOperation,
            notice.backupRef,
            notice.operation && notice.operation !== "idle"
              ? t("gitWorkbench.operation." + notice.operation)
              : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </Text>
      ) : null}
    </View>
  );
}

function ChangeSection({
  tree,
  layer,
  disabled,
  onSelect,
  mutate,
}: {
  tree: CheckoutGitWorkingTree;
  layer: StagingLayer;
  disabled: boolean;
  onSelect: (selection: Selection) => void;
  mutate: Staging["mutate"];
}) {
  const { t } = useTranslation();
  const files: CheckoutGitFile[] =
    layer === "staged"
      ? tree.staged
      : [...tree.unstaged, ...tree.untracked.map((path) => ({ path, status: "added" as const }))];
  const conflicts = new Set(tree.conflicts.map(({ path }) => path));
  const movable = files.filter(
    ({ path, oldPath }) => !conflicts.has(path) && (!oldPath || !conflicts.has(oldPath)),
  );
  const kind = layer === "staged" ? "unstage" : "stage";
  const change = useCallback(
    (items: CheckoutGitFile[]) => {
      const paths = [
        ...new Set(
          items.flatMap(({ path, oldPath, status }) =>
            oldPath && status === "renamed" ? [oldPath, path] : [path],
          ),
        ),
      ];
      if (paths.length) void mutate({ kind, scope: "paths", paths, description: "" });
    },
    [kind, mutate],
  );
  const moveSection = useCallback(() => change(movable), [change, movable]);
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeading}>
        <Text accessibilityRole="header" style={styles.text}>
          {t("gitWorkbench." + layer)} · {files.length}
        </Text>
        <Button
          size="sm"
          variant="ghost"
          disabled={disabled || !movable.length}
          onPress={moveSection}
        >
          {t(layer === "staged" ? "gitWorkbench.unstageSection" : "gitWorkbench.stageSection")}
        </Button>
      </View>
      {files.length === 0 ? <Text style={styles.muted}>{t("gitWorkbench.noFiles")}</Text> : null}
      {files.map((file) => (
        <ChangeRow
          key={file.path}
          file={file}
          checked={fileSelection(tree, layer, file.path)}
          layer={layer}
          disabled={
            disabled ||
            conflicts.has(file.path) ||
            Boolean(file.oldPath && conflicts.has(file.oldPath))
          }
          change={change}
          onSelect={onSelect}
          mutate={mutate}
        />
      ))}
    </View>
  );
}

function ChangeRow({
  file,
  checked,
  layer,
  disabled,
  change,
  onSelect,
  mutate,
}: {
  file: CheckoutGitFile;
  checked: boolean | "mixed";
  layer: StagingLayer;
  disabled: boolean;
  change: (files: CheckoutGitFile[]) => void;
  onSelect: (selection: Selection) => void;
  mutate: Staging["mutate"];
}) {
  const { t } = useTranslation();
  const name = file.oldPath ? file.oldPath + " → " + file.path : file.path;
  const label = t("gitWorkbench.selectionLabel", {
    action: t(layer === "staged" ? "gitWorkbench.unstage" : "gitWorkbench.stage"),
    path: name,
  });
  const moveFile = useCallback(() => change([file]), [change, file]);
  const selectFile = useCallback(
    () => onSelect({ layer, path: file.path }),
    [file.path, layer, onSelect],
  );
  const discardFile = useCallback(
    () =>
      void mutate({
        kind: "discard",
        scope: "paths",
        paths: [file.path],
        description: name,
      }),
    [file.path, mutate, name],
  );
  return (
    <View style={styles.fileRow}>
      <CheckControl checked={checked} disabled={disabled} label={label} onPress={moveFile} />
      <PressHighlight
        accessibilityRole="button"
        style={styles.pathButton}
        highlightStyle={styles.highlight}
        onPress={selectFile}
      >
        <Text style={styles.text} numberOfLines={2}>
          {name}
        </Text>
      </PressHighlight>
      {layer === "unstaged" ? (
        <DropdownMenu compactMode="sheet">
          <DropdownMenuTrigger
            style={styles.actionTrigger}
            disabled={disabled || file.status === "renamed"}
            accessibilityLabel={t("gitWorkbench.fileActions", { path: name })}
          >
            <More size={16} />
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem onSelect={discardFile}>{t("gitWorkbench.discard")}</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </View>
  );
}

function CheckControl({
  checked,
  disabled,
  label,
  onPress,
  showLabel = false,
}: {
  checked: boolean | "mixed";
  disabled?: boolean;
  label: string;
  onPress: () => void;
  showLabel?: boolean;
}) {
  const accessibilityState = useMemo(() => ({ checked, disabled }), [checked, disabled]);
  const style = [styles.checkControl, disabled ? styles.disabled : null];
  let mark = null;
  if (checked === "mixed") mark = <Mixed size={14} />;
  else if (checked) mark = <Checked size={14} />;
  return (
    <PressHighlight
      accessibilityRole="checkbox"
      accessibilityLabel={label}
      accessibilityState={accessibilityState}
      aria-checked={checked}
      disabled={disabled}
      onPress={onPress}
      style={style}
      highlightStyle={styles.highlight}
    >
      <View style={styles.checkBox}>{mark}</View>
      {showLabel ? <Text style={styles.text}>{label}</Text> : null}
    </PressHighlight>
  );
}

function CommitForm({ staging, hidden }: { staging: Staging; hidden: boolean }) {
  const { t } = useTranslation();
  const [message, setMessage] = useState("");
  const input = useRef<EditingTextInputHandle>(null);
  const editVersion = useRef(0);
  const [amend, setAmend] = useState(false);
  const canAmend = Boolean(staging.tree?.headSha);
  const canCommit =
    staging.canWrite &&
    staging.tree?.operationState === "idle" &&
    Boolean(staging.tree.staged.length) &&
    !staging.tree.conflicts.length;
  const { mutate, generate: generateMessage } = staging;
  const submit = useCallback(
    async (pushAfter: boolean) => {
      if (await mutate({ kind: "commit", message, amend: canAmend && amend, pushAfter })) {
        input.current?.reset();
        setMessage("");
        setAmend(false);
      }
    },
    [amend, canAmend, message, mutate],
  );
  const toggleAmend = useCallback(() => setAmend((value) => !value), []);
  const commit = useCallback(() => void submit(false), [submit]);
  const push = useCallback(() => void submit(true), [submit]);
  const edit = useCallback((text: string) => {
    editVersion.current += 1;
    setMessage(text);
  }, []);
  const generate = useCallback(async () => {
    const editor = input.current;
    if (!editor) return;
    const version = editVersion.current;
    const text = editor.getText();
    const matchesEditor = () =>
      input.current === editor && editVersion.current === version && editor.getText() === text;
    const draft = await generateMessage(matchesEditor);
    if (!draft || !matchesEditor()) return;
    editor.replaceText(draft);
    setMessage(draft);
  }, [generateMessage]);
  const style = [styles.form, hidden ? styles.hidden : null];
  return (
    <View style={style}>
      <EditingTextInput
        ref={input}
        style={styles.input}
        accessibilityLabel={t("gitWorkbench.commitMessage")}
        placeholder={t("gitWorkbench.commitMessage")}
        multiline
        onChangeText={edit}
        editable={!staging.busy || staging.generating}
      />
      <View style={styles.actions}>
        <CheckControl
          checked={canAmend && amend}
          label={t("gitWorkbench.amend")}
          disabled={!canAmend || staging.busy}
          onPress={toggleAmend}
          showLabel
        />
        <Button size="md" variant="ghost" disabled={!canCommit} onPress={generate}>
          {t("gitWorkbench.generate")}
        </Button>
      </View>
      <View style={styles.actions}>
        <Button size="md" disabled={!canCommit || !message.trim()} onPress={commit}>
          {t(amend && canAmend ? "gitWorkbench.amendCommit" : "gitWorkbench.commitStaged")}
        </Button>
        <Button size="md" variant="outline" disabled={!canCommit || !message.trim()} onPress={push}>
          {t("gitWorkbench.commitPush")}
        </Button>
      </View>
    </View>
  );
}

interface StashDetail {
  sha: string;
  files?: CheckoutGitFile[];
  error?: string;
}

function StashPanel({ staging }: { staging: Staging }) {
  const { t } = useTranslation();
  const [message, setMessage] = useState("");
  const input = useRef<EditingTextInputHandle>(null);
  const [includeUntracked, setIncludeUntracked] = useState(false);
  const [keepIndex, setKeepIndex] = useState(false);
  const [detail, setDetail] = useState<StashDetail | null>(null);
  const { stashQuery, canWrite, tree, show: showStash, mutate } = staging;
  const canStash =
    canWrite &&
    tree?.operationState === "idle" &&
    Boolean(
      tree?.staged.length || tree?.unstaged.length || (includeUntracked && tree?.untracked.length),
    ) &&
    !tree?.conflicts.length;
  const show = useCallback(
    async (entry: CheckoutGitStashEntry) => {
      if (detail?.sha === entry.sha) {
        setDetail(null);
        return;
      }
      setDetail({ sha: entry.sha });
      try {
        const files = await showStash(entry);
        setDetail((current) => (current?.sha === entry.sha ? { sha: entry.sha, files } : current));
      } catch (cause) {
        const error = cause instanceof Error ? cause.message : String(cause);
        setDetail((current) => (current?.sha === entry.sha ? { sha: entry.sha, error } : current));
      }
    },
    [detail?.sha, showStash],
  );
  const toggleIncludeUntracked = useCallback(() => setIncludeUntracked((value) => !value), []);
  const toggleKeepIndex = useCallback(() => setKeepIndex((value) => !value), []);
  const create = useCallback(async () => {
    if (await mutate({ kind: "stash-create", message, includeUntracked, keepIndex })) {
      input.current?.reset();
      setMessage("");
    }
  }, [includeUntracked, keepIndex, message, mutate]);
  return (
    <>
      <ScrollView style={styles.container} contentContainerStyle={styles.list}>
        {stashQuery.isError ? <Text style={styles.error}>{stashQuery.error.message}</Text> : null}
        {stashQuery.isLoading ? <Text style={styles.muted}>{t("common.loading")}</Text> : null}
        {stashQuery.data?.length === 0 ? (
          <Text style={styles.muted}>{t("gitWorkbench.noStash")}</Text>
        ) : null}
        {stashQuery.data?.length ? (
          <Text style={styles.muted}>{t("gitWorkbench.stashRetained")}</Text>
        ) : null}
        {stashQuery.data?.map((entry) => (
          <StashEntryRow
            entry={entry}
            key={entry.stashRef + entry.sha}
            detail={detail?.sha === entry.sha ? detail : null}
            canApply={canWrite && !tree?.conflicts.length}
            connected={staging.connected}
            show={show}
            mutate={staging.mutate}
          />
        ))}
      </ScrollView>
      <View style={styles.form}>
        <EditingTextInput
          ref={input}
          style={styles.input}
          accessibilityLabel={t("gitWorkbench.stashMessage")}
          placeholder={t("gitWorkbench.stashMessage")}
          onChangeText={setMessage}
          editable={!staging.busy}
        />
        <View style={styles.actions}>
          <CheckControl
            checked={includeUntracked}
            label={t("gitWorkbench.includeUntracked")}
            disabled={staging.busy}
            onPress={toggleIncludeUntracked}
            showLabel
          />
          <CheckControl
            checked={keepIndex}
            label={t("gitWorkbench.keepIndex")}
            disabled={staging.busy}
            onPress={toggleKeepIndex}
            showLabel
          />
        </View>
        <Button size="md" disabled={!canStash} onPress={create}>
          {t("gitWorkbench.createStash")}
        </Button>
      </View>
    </>
  );
}

function StashEntryRow({
  entry,
  detail,
  canApply,
  connected,
  show,
  mutate,
}: {
  entry: CheckoutGitStashEntry;
  detail: StashDetail | null;
  canApply: boolean;
  connected: boolean;
  show: (entry: CheckoutGitStashEntry) => Promise<void>;
  mutate: Staging["mutate"];
}) {
  const { t } = useTranslation();
  const showFiles = useCallback(() => void show(entry), [entry, show]);
  const apply = useCallback(() => void mutate({ kind: "stash-apply", entry }), [entry, mutate]);
  return (
    <View style={styles.section}>
      <Text style={styles.text}>{entry.message || entry.stashRef}</Text>
      <Text style={styles.muted}>
        {entry.stashRef}
        {entry.branch ? " · " + entry.branch : ""}
      </Text>
      <View style={styles.actions}>
        <Button size="md" variant="ghost" disabled={!connected} onPress={showFiles}>
          {t("gitWorkbench.showStash")}
        </Button>
        <Button size="md" variant="ghost" disabled={!canApply} onPress={apply}>
          {t("gitWorkbench.applyStash")}
        </Button>
      </View>
      {detail ? <StashFiles detail={detail} /> : null}
    </View>
  );
}

function StashFiles({ detail }: { detail: StashDetail }) {
  const { t } = useTranslation();
  if (detail.error) return <Text style={styles.error}>{detail.error}</Text>;
  if (!detail.files) return <Text style={styles.muted}>{t("common.loading")}</Text>;
  if (!detail.files.length) return <Text style={styles.muted}>{t("gitWorkbench.noFiles")}</Text>;
  return detail.files.map(({ path, oldPath }) => (
    <Text style={styles.muted} key={path}>
      {oldPath ? oldPath + " → " : ""}
      {path}
    </Text>
  ));
}

const styles = StyleSheet.create((theme) => ({
  container: { flex: 1, minHeight: 0 },
  toolbar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    padding: theme.spacing[2],
    borderBottomWidth: 1,
    borderColor: theme.colors.border,
  },
  summary: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
    color: theme.colors.foregroundMuted,
  },
  list: { padding: theme.spacing[2], gap: theme.spacing[3] },
  section: {
    padding: theme.spacing[2],
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.md,
  },
  sectionHeading: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    flexWrap: "wrap",
  },
  fileRow: { flexDirection: "row", alignItems: "center", minHeight: 44, gap: theme.spacing[1] },
  hidden: { display: "none" },
  input: {
    minHeight: 36,
    color: theme.colors.foreground,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: theme.borderRadius.md,
    padding: theme.spacing[2],
    fontSize: theme.fontSize.sm,
  },
  actionTrigger: { minWidth: 44, minHeight: 44, alignItems: "center", justifyContent: "center" },
  highlight: { backgroundColor: theme.colors.surface2 },
  pathButton: { flex: 1, minHeight: 44, justifyContent: "center" },
  checkControl: {
    paddingHorizontal: theme.spacing[1],
    minWidth: 44,
    minHeight: 44,
    alignItems: "center",
    flexDirection: "row",
    gap: theme.spacing[2],
  },
  checkBox: {
    width: 18,
    height: 18,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.sm,
  },
  disabled: { opacity: 0.45 },
  text: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  muted: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.sm },
  form: {
    padding: theme.spacing[2],
    gap: theme.spacing[1],
    borderTopWidth: 1,
    borderColor: theme.colors.border,
  },
  actions: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: theme.spacing[1] },
}));
