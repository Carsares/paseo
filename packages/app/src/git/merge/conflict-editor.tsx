import { useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import {
  CHECKOUT_GIT_MAX_CONFLICT_TEXT_BYTES,
  type CheckoutGitConflictFile,
} from "@getpaseo/protocol/messages";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { useStableEvent } from "@/hooks/use-stable-event";
import { useIsLocalDaemon } from "@/hooks/use-is-local-daemon";
import { openDesktopTarget, useDesktopOpenTargets } from "@/workspace/desktop-open-targets";
import { useGitP2Copy } from "../p2-copy";
import { MergeEditor, type MergeContents } from "./editor";

const ThemedMergeEditor = withUnistyles(MergeEditor, (theme) => ({
  foreground: theme.colors.foreground,
}));

export function ConflictEditor({
  serverId,
  cwd,
  repoRoot,
  path,
  enabled,
  canWrite,
  onClose,
  onSaved,
}: {
  serverId: string;
  cwd: string;
  repoRoot: string;
  path: string;
  enabled: boolean;
  canWrite: boolean;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const copy = useGitP2Copy();
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  const local = useIsLocalDaemon(serverId);
  const targets = useDesktopOpenTargets({
    isLocalExecution: local && enabled,
    workspacePath: repoRoot,
  });
  const rebased = targets.targets.find(({ id }) => id === "rebased");
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const pending = useRef(false);
  const query = useFetchQuery({
    queryKey: ["git-merge-editor", serverId, cwd, repoRoot, path],
    dataShape: "value",
    enabled: enabled && connected && Boolean(client),
    staleTimeMs: 0,
    retry: false,
    queryFn: async () => {
      if (!client) throw new Error(t("workspace.terminal.hostDisconnected"));
      const response = await client.checkoutGitConflictInspect({
        cwd,
        targetRepoRoot: repoRoot,
        path,
        includeContents: true,
      });
      if (response.error) throw new Error(response.error);
      return response.conflicts.find((conflict) => conflict.path === path) ?? null;
    },
  });
  const live = useRef({ enabled, connected, canWrite, client, conflict: query.data });
  live.current = { enabled, connected, canWrite, client, conflict: query.data };

  const save = useStableEvent(async (conflict: CheckoutGitConflictFile, resultText: string) => {
    const current = live.current;
    if (
      pending.current ||
      !current.enabled ||
      !current.canWrite ||
      !current.connected ||
      !current.client
    )
      return;
    if (current.conflict?.conflictFingerprint !== conflict.conflictFingerprint) {
      setError(t("gitWorkbench.graph.staleConflict"));
      return;
    }
    pending.current = true;
    setSaving(true);
    setError(undefined);
    try {
      const response = await current.client.checkoutGitConflictResolve({
        cwd,
        targetRepoRoot: repoRoot,
        path,
        strategy: "mark_resolved",
        expectedConflictFingerprint: conflict.conflictFingerprint,
        resultText,
      });
      if (response.errorCode === "STALE_CONFLICT_SNAPSHOT") {
        setError(t("gitWorkbench.graph.staleConflict"));
        return;
      }
      if (!response.success) {
        setError(response.error ?? t("gitWorkbench.failed"));
        return;
      }
      onClose();
      await onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      pending.current = false;
      setSaving(false);
    }
  });

  const close = useStableEvent(() => {
    if (!pending.current) onClose();
  });

  const openRebased = useStableEvent(() => {
    if (!rebased) return;
    void openDesktopTarget({ editorId: rebased.id, workspacePath: repoRoot }).catch(
      (cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      },
    );
  });

  const status = error ?? query.error?.message;
  const conflict = query.data;
  const awaiting = query.isPending;
  return (
    <Modal visible={enabled} onRequestClose={close}>
      <View style={styles.sheet} testID="git-merge-editor">
        <View style={styles.toolbar}>
          <Text accessibilityRole="header" style={styles.title} numberOfLines={1}>
            {path}
          </Text>
          {rebased ? (
            <Button size="sm" variant="ghost" onPress={openRebased}>
              {t("gitWorkbench.graph.openRebased")}
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" onPress={close} disabled={saving}>
            {t("common.actions.cancel")}
          </Button>
        </View>
        {status ? (
          <Text accessibilityRole="alert" style={styles.notice}>
            {status}
          </Text>
        ) : null}
        {awaiting ? <Text style={styles.notice}>{t("common.loading")}</Text> : null}
        {conflict?.contents ? (
          <MergeDraft
            conflict={conflict}
            contents={conflict.contents}
            canSave={
              canWrite && enabled && connected && !saving && !query.isFetching && !query.isError
            }
            saving={saving}
            save={save}
          />
        ) : null}
        {query.isSuccess && !conflict?.contents ? (
          <Text style={styles.notice}>{copy.mergeUnavailable}</Text>
        ) : null}
      </View>
    </Modal>
  );
}

function MergeDraft({
  conflict,
  contents,
  canSave,
  saving,
  save,
}: {
  conflict: CheckoutGitConflictFile;
  contents: MergeContents;
  canSave: boolean;
  saving: boolean;
  save: (snapshot: CheckoutGitConflictFile, text: string) => Promise<void>;
}) {
  const [baseSnapshot] = useState(conflict);
  const [initialContents] = useState(contents);
  const [draft, setDraft] = useState(contents.result);
  const [editing, setEditing] = useState(false);
  const initialResult = initialContents.result;
  const keepCRLF =
    initialResult?.includes("\r\n") && !initialResult.replaceAll("\r\n", "").includes("\n");
  const changeDraft = useStableEvent((text: string) => {
    setDraft(keepCRLF ? text.replaceAll("\n", "\r\n") : text);
  });
  const { t } = useTranslation();
  const copy = useGitP2Copy();
  const stale = conflict.conflictFingerprint !== baseSnapshot.conflictFingerprint;
  const tooLarge = useMemo(
    () =>
      draft !== null &&
      new TextEncoder().encode(draft).length > CHECKOUT_GIT_MAX_CONFLICT_TEXT_BYTES,
    [draft],
  );
  const texts = useMemo(() => ({ ...initialContents, result: draft }), [initialContents, draft]);
  const { base, ours, theirs, result } = copy;
  const labels = useMemo(() => ({ base, ours, theirs, result }), [base, ours, theirs, result]);
  const toggleEdit = useStableEvent(() => {
    if (!editing && draft === null) setDraft("");
    setEditing(!editing);
  });
  const submit = useStableEvent(() => {
    if (draft !== null) void save(baseSnapshot, draft);
  });
  return (
    <>
      {stale ? (
        <Text accessibilityRole="alert" style={styles.notice}>
          {t("gitWorkbench.graph.staleConflict")}
        </Text>
      ) : null}
      {tooLarge ? (
        <Text accessibilityRole="alert" style={styles.notice}>
          {copy.mergeUnavailable}
        </Text>
      ) : null}
      <ThemedMergeEditor
        contents={texts}
        labels={labels}
        missingVersionLabel={copy.missingVersion}
        editing={editing}
        onChangeResult={changeDraft}
      />
      <View style={styles.toolbar}>
        <Button size="sm" variant="outline" disabled={saving || stale} onPress={toggleEdit}>
          {editing ? copy.previewResult : copy.editResult}
        </Button>
        <Button
          size="sm"
          disabled={!canSave || stale || tooLarge || draft === null}
          onPress={submit}
          testID="git-merge-save"
        >
          {saving ? t("common.loading") : copy.saveResult}
        </Button>
      </View>
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  sheet: { flex: 1, minHeight: 0, backgroundColor: theme.colors.background },
  toolbar: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    padding: theme.spacing[2],
  },
  title: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: "600",
  },
  notice: { color: theme.colors.foregroundMuted, padding: theme.spacing[2] },
}));
