import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { DiffState } from "@getpaseo/client";
import type { WorkspaceDurableItemEvidence } from "@getpaseo/protocol/messages";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeConnectionStatus } from "@/runtime/host-runtime";
import { useWorkspaceDirectory } from "@/stores/session-store-hooks";
import { decodeUtf8 } from "@/utils/decode-utf8";
import { isAbsolutePath } from "@/utils/path";
import { isWorkspaceRootPath, resolveWorkspaceFilePaths } from "@/workspace/file-open";
import { getOnlineDurableItemsClient } from "./queries";

const PREVIEW_BYTES = 64 * 1024;
const COPY = "topicWorkbench.durableItems";

function getPreviewTarget(workspaceRoot: string | null, evidence: WorkspaceDurableItemEvidence) {
  if (!workspaceRoot) return null;
  const cwd = evidence.type === "git" ? evidence.repoRoot : workspaceRoot;
  if (
    evidence.type === "git" &&
    (!isAbsolutePath(cwd) ||
      (!isWorkspaceRootPath({ path: cwd, workspaceRoot }) &&
        !resolveWorkspaceFilePaths({ path: cwd, workspaceRoot })?.relativePath))
  ) {
    return null;
  }
  const path = resolveWorkspaceFilePaths({ path: evidence.path, workspaceRoot: cwd })?.relativePath;
  return path && path === evidence.path ? { cwd, path } : null;
}

type PreviewTarget = NonNullable<ReturnType<typeof getPreviewTarget>>;
type Preview =
  | { kind: "text"; text: string; shortened: boolean }
  | { kind: "noDiff" | "noTextDiff" | "tooLarge" | "fileTooLarge" | "unsupported" };

async function readFilePreview(serverId: string, target: PreviewTarget): Promise<Preview> {
  const client = getOnlineDurableItemsClient(serverId);
  if (!client) throw new Error("Evidence host is offline");
  const file = await client
    .readFile(target.cwd, target.path, undefined, PREVIEW_BYTES)
    .catch((error: unknown) => {
      // The existing file-read RPC reports the size limit as a message.
      if (error instanceof Error && error.message === "File is too large to display") return null;
      throw error;
    });
  if (!file) return { kind: "fileTooLarge" };
  if (file.kind !== "text") return { kind: "unsupported" };
  const shortened = file.bytes.length > PREVIEW_BYTES;
  return { kind: "text", text: decodeUtf8(file.bytes.subarray(0, PREVIEW_BYTES)), shortened };
}

async function readGitPreview(
  serverId: string,
  target: PreviewTarget,
  layer: "staged" | "unstaged",
): Promise<Preview> {
  const client = getOnlineDurableItemsClient(serverId);
  if (!client) throw new Error("Evidence host is offline");
  const { cwd, path } = target;
  // The diff service resolves HEAD to the empty tree before the first commit.
  const diff = await client.readDiff(
    layer === "staged"
      ? { cwd, base: { kind: "rev", rev: "HEAD" }, head: { kind: "index" } }
      : { cwd, base: { kind: "index" }, head: { kind: "worktree" } },
  );
  return previewDiffFile(diff, path);
}

function previewDiffFile(diff: DiffState, path: string): Preview {
  if (diff.phase !== "ready") throw new Error("Evidence diff unavailable");
  const file = diff.files.find((entry) => entry.path === path);
  if (file?.status === "too_large" || (!file && diff.diffTooLarge)) return { kind: "tooLarge" };
  if (file?.status === "binary") return { kind: "unsupported" };
  if (!file) return { kind: "noDiff" };
  if (!file.hunks.length) return { kind: "noTextDiff" };
  let text = "";
  for (const hunk of file.hunks) {
    text += `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@\n`;
    for (const line of hunk.lines) {
      if (line.type === "header") continue;
      const prefix = { add: "+", remove: "-", context: " " }[line.type];
      text += `${prefix}${line.content}\n`;
      if (text.length > PREVIEW_BYTES) {
        return { kind: "text", text: text.slice(0, PREVIEW_BYTES), shortened: true };
      }
    }
  }
  return { kind: "text", text, shortened: false };
}

type PreviewKind = "file" | "staged" | "unstaged";
const previewHeadings = {
  file: "currentFile",
  staged: "currentStagedDiff",
  unstaged: "currentUnstagedDiff",
} as const;

function CurrentEvidencePreview({
  serverId,
  workspaceId,
  target,
  kind,
}: {
  serverId: string;
  workspaceId: string;
  target: PreviewTarget | null;
  kind: PreviewKind;
}) {
  const { t } = useTranslation();
  const online = useHostRuntimeConnectionStatus(serverId) === "online";
  const active = useRetainedPanelActive();
  const result = useFetchQuery({
    queryKey: ["durable-item-evidence", serverId, workspaceId, kind, target?.cwd, target?.path],
    dataShape: "value",
    enabled: active && online && target !== null,
    staleTimeMs: 0,
    retry: false,
    gcTime: 0,
    queryFn: () => {
      if (!target) throw new Error("Evidence path unavailable");
      return kind === "file"
        ? readFilePreview(serverId, target)
        : readGitPreview(serverId, target, kind);
    },
  });
  return (
    <View style={styles.preview} testID={`durable-item-${kind}-preview`}>
      <Text style={styles.heading}>{t(`${COPY}.${previewHeadings[kind]}`)}</Text>
      <EvidencePreview
        online={online}
        pending={result.isFetching}
        data={result.isSuccess && !result.isFetching ? result.data : undefined}
      />
    </View>
  );
}

export function DurableItemEvidenceDetails({
  serverId,
  workspaceId,
  evidence,
}: {
  serverId: string;
  workspaceId: string;
  evidence: WorkspaceDurableItemEvidence;
}) {
  const { t } = useTranslation();
  const workspaceRoot = useWorkspaceDirectory(serverId, workspaceId);
  const target = getPreviewTarget(workspaceRoot, evidence);
  const fields =
    evidence.type === "file"
      ? [{ label: t(`${COPY}.fileFingerprint`), value: evidence.fingerprint }]
      : [
          { label: t(`${COPY}.repoRoot`), value: evidence.repoRoot },
          {
            label: t(`${COPY}.gitHead`),
            value: evidence.headSha ?? t(`${COPY}.noGitHead`),
          },
          { label: t(`${COPY}.gitFingerprint`), value: evidence.blobOrIndexFingerprint },
        ];
  return (
    <View style={styles.fields} testID="durable-item-evidence-details">
      <Text style={styles.heading}>{t(`${COPY}.recordedEvidence`)}</Text>
      {fields.map(({ label, value }) => (
        <View key={label}>
          <Text style={styles.meta}>{label}</Text>
          <Text selectable style={styles.monospace}>
            {value}
          </Text>
        </View>
      ))}
      {evidence.type === "file" ? (
        <CurrentEvidencePreview
          serverId={serverId}
          workspaceId={workspaceId}
          target={target}
          kind="file"
        />
      ) : (
        <>
          <CurrentEvidencePreview
            serverId={serverId}
            workspaceId={workspaceId}
            target={target}
            kind="staged"
          />
          <CurrentEvidencePreview
            serverId={serverId}
            workspaceId={workspaceId}
            target={target}
            kind="unstaged"
          />
        </>
      )}
    </View>
  );
}

function EvidencePreview({
  online,
  pending,
  data,
}: {
  online: boolean;
  pending: boolean;
  data: Preview | undefined;
}) {
  const { t } = useTranslation();
  if (online && data?.kind === "text") {
    return (
      <>
        <Text selectable style={styles.monospace}>
          {data.text || t(`${COPY}.emptyFile`)}
        </Text>
        {data.shortened ? <Text style={styles.meta}>{t(`${COPY}.previewShortened`)}</Text> : null}
      </>
    );
  }
  const message = !online
    ? "offline"
    : (data?.kind ?? (pending ? "previewLoading" : "previewUnavailable"));
  return <Text style={styles.meta}>{t(`${COPY}.${message}`)}</Text>;
}

const styles = StyleSheet.create((theme) => ({
  fields: {
    gap: theme.spacing[2],
    padding: theme.spacing[2],
  },
  preview: { gap: theme.spacing[1] },
  heading: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  meta: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  monospace: {
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
  },
}));
