import { useMemo, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { CheckoutGitCommitDetail, CheckoutGitLogCommit } from "@getpaseo/protocol/messages";
import { GraphSheet } from "./sheet";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/select-field";
import { useFetchQuery } from "@/data/query";
import { commitFileDiffQueryOptions } from "@/git/commit-file-diff-query";
import { DiffDocument } from "@/git/diff-document";
import {
  buildDiffTree,
  compressSingleChildChains,
  flattenDiffTree,
  type DiffTreeRow,
} from "@/git/diff-tree";
import { StyleSheet } from "react-native-unistyles";
import { useStableEvent } from "@/hooks/use-stable-event";
import { useAppSettings } from "@/hooks/use-settings";
import { usePaneContext } from "@/panels/pane-context";
import { useGraphRecipients } from "./recipients";
import { errorMessage, GraphMessage, styles } from "./ui";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useBlockMobilePanelOpenGestures } from "@/mobile-panels/provider";

export function CommitDetail({
  client,
  cwd,
  commit,
  enabled: ownerEnabled,
  onDiff,
}: {
  client: DaemonClient;
  cwd: string;
  commit: CheckoutGitLogCommit;
  enabled: boolean;
  onDiff: (path: string) => void;
}) {
  const { t } = useTranslation();
  const active = useRetainedPanelActive();
  const enabled = ownerEnabled && active;
  const { serverId } = usePaneContext();
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [recipientId, setRecipientId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string>();
  const [quoting, setQuoting] = useState(false);
  const query = useFetchQuery({
    dataShape: "value",
    immutableWhen: () => true,
    queryKey: ["git-graph-detail", serverId, cwd, commit.repoRoot, commit.sha],
    enabled,
    queryFn: async () => {
      const result = await client.checkoutGitCommitGetDetail({
        cwd,
        targetRepoRoot: commit.repoRoot,
        sha: commit.sha,
      });
      if (result.error || !result.detail)
        throw new Error(result.error ?? t("gitWorkbench.graph.selectCommit"));
      return result.detail;
    },

    retry: false,
  });
  const detail = query.data;
  const tree = useMemo(
    () =>
      detail
        ? compressSingleChildChains(
            buildDiffTree(
              detail.files.map((file) => ({
                path: file.path,
                oldPath: file.oldPath,
                isNew: file.status === "added",
                isDeleted: file.status === "deleted",
                additions: file.additions ?? 0,
                deletions: file.deletions ?? 0,
                status: "ok",
              })),
            ),
          )
        : null,
    [detail],
  );
  const rows = useMemo(() => (tree ? flattenDiffTree(tree, collapsed) : []), [tree, collapsed]);
  const recipient = useGraphRecipients(enabled && !!detail);
  const selected =
    recipient.recipients.find(({ id }) => id === recipientId) ?? recipient.recipients[0];

  async function quote(commitDetail: CheckoutGitCommitDetail, agentId: string | null) {
    setQuoting(true);
    setNotice(undefined);
    try {
      const text = JSON.stringify(
        {
          targetRepoRoot: commit.repoRoot,
          sha: commitDetail.sha,
          subject: commitDetail.subject,
          body: commitDetail.body.slice(0, 3000),
          files: commitDetail.files.slice(0, 50).map(({ path, status }) => ({ path, status })),
          filesTruncated: commitDetail.filesTruncated || commitDetail.files.length > 50,
        },
        null,
        2,
      );
      if (
        !(await recipient.appendDraft(
          { quote: text, label: commitDetail.subject || commitDetail.sha.slice(0, 8) },
          agentId,
        ))
      ) {
        throw new Error(t("gitWorkbench.graph.reviewFailed"));
      }
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setQuoting(false);
    }
  }

  const reload = useStableEvent(() => void query.refetch());
  const bind = useStableEvent(() => {
    if (detail) void quote(detail, null);
  });
  const quoteToRecipient = useStableEvent(() => {
    if (detail && selected) void quote(detail, selected.id);
  });
  const toggleFolder = useStableEvent((path: string) => {
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  });
  const recipientDisplay = useMemo(() => (selected ? { label: selected.title } : null), [selected]);

  if (query.error)
    return (
      <View style={styles.stack}>
        <GraphMessage error>{errorMessage(query.error)}</GraphMessage>
        <Button variant="outline" disabled={!enabled || query.isFetching} onPress={reload}>
          {t("gitWorkbench.graph.refresh")}
        </Button>
      </View>
    );
  if (!detail)
    return (
      <View style={styles.stack}>
        <GraphMessage>{t("gitWorkbench.graph.loading")}</GraphMessage>
      </View>
    );
  return (
    <ScrollView style={styles.fill} nestedScrollEnabled>
      <View style={styles.stack}>
        <Text accessibilityRole="header" style={styles.heading}>
          {t("gitWorkbench.graph.files")}
        </Text>
        {rows.map((row) => (
          <ChangeRow
            key={row.kind === "folder" ? row.dirPath : row.file.path}
            row={row}
            collapsed={row.kind === "folder" && collapsed.has(row.dirPath)}
            disabled={!enabled}
            onToggle={toggleFolder}
            onDiff={onDiff}
          />
        ))}
        {detail.filesTruncated ? (
          <GraphMessage>{t("gitWorkbench.graph.filesTruncated")}</GraphMessage>
        ) : null}
      </View>
      <View style={[styles.stack, styles.rowBorder]}>
        <Text style={styles.heading} selectable>
          {detail.subject}
        </Text>
        <Text style={styles.muted} selectable>
          {detail.author.name} · {detail.author.date} · {detail.sha}
        </Text>
        {detail.body ? (
          <Text style={styles.text} selectable>
            {detail.body}
          </Text>
        ) : null}
        {notice ? <GraphMessage error>{notice}</GraphMessage> : null}
        {recipient.unbound ? (
          <Button variant="outline" disabled={!enabled || quoting} onPress={bind}>
            {t("gitWorkbench.graph.bindMain")}
          </Button>
        ) : null}
        {selected ? (
          <View style={styles.wrap}>
            <SelectField
              field={false}
              label={t("gitWorkbench.graph.recipient")}
              placeholder={t("gitWorkbench.graph.recipient")}
              emptyText={t("gitWorkbench.graph.noRecipient")}
              value={selected.id}
              selectedDisplay={recipientDisplay}
              options={recipient.recipients.map(({ id, title }) => ({
                id,
                value: id,
                label: title,
              }))}
              onChange={setRecipientId}
              disabled={quoting}
            />
            <Button variant="outline" disabled={!enabled || quoting} onPress={quoteToRecipient}>
              {t("gitWorkbench.graph.reviewQuote")}
            </Button>
          </View>
        ) : null}
      </View>
    </ScrollView>
  );
}

const EXPANDED = { expanded: true };
const COLLAPSED = { expanded: false };
const DIFF_SNAP_POINTS = ["90%"];
const commitMode = { kind: "commit" } as const;

const localStyles = StyleSheet.create(() => ({
  changeRow: (depth: number) => ({ alignSelf: "flex-start", marginStart: 12 * depth }),
}));

function ChangeRow({
  row,
  collapsed,
  disabled,
  onToggle,
  onDiff,
}: {
  row: DiffTreeRow;
  collapsed: boolean;
  disabled: boolean;
  onToggle: (path: string) => void;
  onDiff: (path: string) => void;
}) {
  const { t } = useTranslation();
  const press = useStableEvent(() =>
    row.kind === "folder" ? onToggle(row.dirPath) : onDiff(row.file.path),
  );
  if (row.kind === "folder") {
    return (
      <Button
        variant="ghost"
        accessibilityState={collapsed ? COLLAPSED : EXPANDED}
        style={localStyles.changeRow(row.depth)}
        onPress={press}
      >
        {collapsed ? "▸" : "▾"} {row.displayName}
      </Button>
    );
  }
  return (
    <Button
      variant="ghost"
      disabled={disabled}
      accessibilityLabel={`${t("gitWorkbench.graph.openDiff")}: ${row.file.path}`}
      style={localStyles.changeRow(row.depth)}
      onPress={press}
    >
      {row.file.path.split("/").at(-1)}
    </Button>
  );
}

interface CommitFileSheetProps {
  client: DaemonClient;
  commit: CheckoutGitLogCommit;
  path: string;
  enabled: boolean;
  onClose: () => void;
}

export function CommitFileSheet({ onClose, ...props }: CommitFileSheetProps) {
  const { tabId } = usePaneContext();
  const { commit, path } = props;
  const header = useMemo(() => ({ title: path }), [path]);
  return (
    <GraphSheet
      visible
      workspacePageKey={JSON.stringify(["git-file", tabId, commit.repoRoot, commit.sha, path])}
      header={header}
      onClose={onClose}
      scrollable={false}
      desktopMaxWidth={980}
      desktopHeight="80%"
      snapPoints={DIFF_SNAP_POINTS}
    >
      <CommitFileBody {...props} />
    </GraphSheet>
  );
}

function CommitFileBody({
  client,
  commit,
  path,
  enabled: ownerEnabled,
}: Omit<CommitFileSheetProps, "onClose">) {
  const { t } = useTranslation();
  const { serverId } = usePaneContext();
  const { settings } = useAppSettings();
  const compact = useIsCompactFormFactor();
  const active = useRetainedPanelActive();
  const enabled = ownerEnabled && active;
  useBlockMobilePanelOpenGestures(enabled && compact);
  const query = useFetchQuery(
    commitFileDiffQueryOptions({
      serverId,
      client,
      enabled,
      cwd: commit.repoRoot,
      sha: commit.sha,
      path,
    }),
  );
  const files = useMemo(() => (query.data?.file ? [query.data.file] : []), [query.data?.file]);
  const displayPreferences = useMemo(
    () => ({
      layout: "unified" as const,
      wrapLines: compact,
      codeFontSize: settings.codeFontSize,
      monoFontFamily: settings.monoFontFamily,
    }),
    [compact, settings.codeFontSize, settings.monoFontFamily],
  );
  let message = t(query.isPending ? "gitWorkbench.graph.loading" : "gitWorkbench.graph.emptyDiff");
  if (query.error) message = errorMessage(query.error);
  return files.length ? (
    <DiffDocument files={files} mode={commitMode} displayPreferences={displayPreferences} />
  ) : (
    <View style={styles.stack}>
      <GraphMessage error={!!query.error}>{message}</GraphMessage>
    </View>
  );
}
