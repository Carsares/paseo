import { relative, resolve, sep } from "node:path";
import type { AgentTimelineItem } from "./agent/agent-sdk-types.js";
import { gitBlobId, type FileSnapshot } from "./agent/checkpoints/snapshot.js";
import type { CheckpointStore } from "./agent/checkpoints/store.js";
import { parseDiff } from "./utils/diff-highlighter.js";

type Edit = Extract<
  Extract<AgentTimelineItem, { type: "tool_call" }>["detail"],
  { type: "edit" | "write" }
>;

function applyPatch(content: string | null, patch: string): string | null | undefined {
  // The display parser cannot represent a missing final newline. Do not infer it.
  if (patch.includes("\\ No newline at end of file") || (content && !content.endsWith("\n"))) {
    return undefined;
  }
  const source = content ? content.slice(0, -1).split("\n") : [];
  const [file, second] = parseDiff(patch.startsWith("@@") ? `checkpoint\n${patch}` : patch);
  if (!file || second || !file.hunks.length) return undefined;
  const output: string[] = [];
  let previousEnd = 0;
  for (const hunk of file.hunks) {
    const before = hunk.lines.filter((line) => line.type === "remove" || line.type === "context");
    const after = hunk.lines.filter((line) => line.type === "add" || line.type === "context");
    const start = hunk.oldCount ? hunk.oldStart - 1 : hunk.oldStart;
    if (
      start < previousEnd ||
      start > source.length ||
      before.length !== hunk.oldCount ||
      after.length !== hunk.newCount ||
      before.some((line, offset) => source[start + offset] !== line.content)
    )
      return undefined;
    output.push(...source.slice(previousEnd, start), ...after.map((line) => line.content));
    previousEnd = start + before.length;
  }
  output.push(...source.slice(previousEnd));
  if (file.isDeleted) return output.length === 0 ? null : undefined;
  return output.length ? `${output.join("\n")}\n` : "";
}

function applyEdit(content: string | null, edit: Edit): string | null | undefined {
  if (edit.type === "write") return edit.content;
  if (edit.unifiedDiff) return applyPatch(content, edit.unifiedDiff);
  if (content === null && edit.oldString === undefined) return edit.newString;
  if (content === null || !edit.oldString || edit.newString === undefined) return undefined;
  const start = content.indexOf(edit.oldString);
  if (start < 0 || start !== content.lastIndexOf(edit.oldString)) return undefined;
  return content.slice(0, start) + edit.newString + content.slice(start + edit.oldString.length);
}

function editsByPath(cwd: string, items: AgentTimelineItem[]): Map<string, Edit[]> {
  const files = new Map<string, Edit[]>();
  const recorded = new Set<string>();
  for (const item of items) {
    if (item.type !== "tool_call" || item.status !== "completed" || recorded.has(item.callId))
      continue;
    if (item.detail.type !== "write" && item.detail.type !== "edit") continue;
    recorded.add(item.callId);
    const file = relative(cwd, resolve(cwd, item.detail.filePath)).split(sep).join("/");
    const edits = files.get(file) ?? [];
    edits.push(item.detail);
    files.set(file, edits);
  }
  return files;
}

export async function verifyCheckpointAttribution(input: {
  store: CheckpointStore;
  before: FileSnapshot;
  after: FileSnapshot;
  paths: string[];
  cwd: string;
  items: AgentTimelineItem[];
}): Promise<void> {
  const { store, before, after, paths, items, cwd } = input;
  const edits = editsByPath(cwd, items);
  const previousFiles = new Map(before.files.map((file) => [file.path, file]));
  const nextFiles = new Map(after.files.map((file) => [file.path, file]));
  const previousIndex = new Map(before.index.map((file) => [file.path, file]));
  const nextIndex = new Map(after.index.map((file) => [file.path, file]));
  for (const path of paths) {
    const oldFile = previousFiles.get(path);
    const newFile = nextFiles.get(path);
    const oldStage = previousIndex.get(path);
    const newStage = nextIndex.get(path);
    const fileChanged = oldFile?.oid !== newFile?.oid || oldFile?.mode !== newFile?.mode;
    const stageChanged = oldStage?.oid !== newStage?.oid || oldStage?.mode !== newStage?.mode;
    if (!fileChanged && !stageChanged) continue;
    if (
      !(await verifiesEdits({
        store,
        oldFile,
        newFile,
        oldStage,
        newStage,
        fileChanged,
        stageChanged,
        format: before.format,
        edits: edits.get(path) ?? [],
      }))
    ) {
      throw new Error("Restore overlaps changes that cannot be attributed to an agent edit");
    }
  }
}

interface EditComparison {
  oldFile?: FileSnapshot["files"][number];
  newFile?: FileSnapshot["files"][number];
  oldStage?: FileSnapshot["index"][number];
  newStage?: FileSnapshot["index"][number];
  fileChanged: boolean;
  stageChanged: boolean;
}

function hasUnsupportedModeChange(input: EditComparison): boolean {
  const { oldFile, newFile, oldStage, newStage, stageChanged } = input;
  if (oldFile && newFile && oldFile.mode !== newFile.mode) return true;
  if (oldStage && newStage && oldStage.mode !== newStage.mode) return true;
  if (!oldFile && newFile && newFile.mode & 0o111) return true;
  return stageChanged && newStage?.mode === "100755";
}

async function verifiesEdits(
  input: EditComparison & {
    store: CheckpointStore;
    format: FileSnapshot["format"];
    edits: Edit[];
  },
) {
  const { store, oldFile, newFile, newStage, fileChanged, stageChanged, format, edits } = input;
  if (!edits.length || hasUnsupportedModeChange(input)) return false;
  const initial = oldFile && (await store.getBlob(oldFile.oid, format));
  let content = initial?.toString("utf8") ?? null;
  if (initial && (content === null || !initial.equals(Buffer.from(content)))) return false;
  const known = new Set<string | null>();
  const objectId = (value: string | null) =>
    value === null ? null : gitBlobId(Buffer.from(value), format);
  for (const edit of edits) {
    const updated = applyEdit(content, edit);
    if (updated === undefined) return false;
    content = updated;
    known.add(objectId(content));
  }
  return (
    (!fileChanged || objectId(content) === (newFile?.oid ?? null)) &&
    (!stageChanged || known.has(newStage?.oid ?? null))
  );
}
