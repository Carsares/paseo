import { relative, resolve, sep } from "node:path";
import { unquoteGitPath } from "../utils/git-quoted-path.js";
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

function emptyAdditionPath(section: string): string | undefined {
  const lines = section.split("\n");
  if (lines.length !== 3 || lines[1] !== "--- /dev/null" || !lines[2]?.startsWith("+++ b/")) {
    return undefined;
  }
  const path = lines[2].slice("+++ b/".length);
  return path && lines[0] === `diff --git a/${path} b/${path}` ? path : undefined;
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

function checkpointPath(cwd: string, path: string): string {
  return relative(cwd, resolve(cwd, path)).split(sep).join("/");
}

function patchSectionPath(section: string): string | undefined {
  const [header, ...lines] = section.split("\n");
  const firstHunk = lines.findIndex((line) => line.startsWith("@@ "));
  if (firstHunk < 0) return emptyAdditionPath(section);
  const metadata = lines.slice(0, firstHunk);
  const oldPaths = metadata.filter((line) => line.startsWith("--- "));
  const newPaths = metadata.filter((line) => line.startsWith("+++ "));
  if (oldPaths.length !== 1 || newPaths.length !== 1) return undefined;
  const oldPath = unquoteGitPath(oldPaths[0]!.slice(4).replace(/\t$/, ""));
  const newPath = unquoteGitPath(newPaths[0]!.slice(4).replace(/\t$/, ""));
  const path = oldPath.startsWith("a/") ? oldPath.slice(2) : newPath.slice(2);
  if (
    !path ||
    (oldPath !== `a/${path}` && oldPath !== "/dev/null") ||
    (newPath !== `b/${path}` && newPath !== "/dev/null") ||
    (oldPath === "/dev/null" && newPath === "/dev/null")
  )
    return undefined;

  const labels = header!.slice("diff --git ".length);
  if (labels === `a/${path} b/${path}`) return path;
  // Quoted Git paths can contain escaped bytes or spaces. Both labels must
  // identify this exact file; a rename or an ambiguous section is insufficient.
  const quoted =
    labels.match(/^("(?:\\.|[^"\\])*") (.+)$/) ?? labels.match(/^(.+) ("(?:\\.|[^"\\])*")$/);
  return quoted &&
    unquoteGitPath(quoted[1]!) === `a/${path}` &&
    unquoteGitPath(quoted[2]!) === `b/${path}`
    ? path
    : undefined;
}

function expandEdit(cwd: string, edit: Edit): [string, Edit][] {
  const path = checkpointPath(cwd, edit.filePath);
  const patch = edit.type === "edit" ? edit.unifiedDiff : undefined;
  if (!patch) return [[path, edit]];
  if (
    /^\.\.\.\[(?:truncated(?: \d+ chars)?|\d+ more files omitted)\]/m.test(patch) ||
    /…\[truncated [\d.]+ (?:B|KB|MB)\]$/.test(patch)
  )
    return [];
  const sections = patch.split(/\n(?=diff --git )/);
  if (sections.length === 1 && !emptyAdditionPath(patch)) return [[path, edit]];
  if (edit.type !== "edit") return [];

  const expanded = new Map<string, Edit>();
  for (const section of sections) {
    if (!section.startsWith("diff --git ")) return [];
    const file = patchSectionPath(section);
    if (!file || checkpointPath(cwd, file) !== file || file === ".." || file.startsWith("../"))
      return [];
    if (expanded.has(file) || (expanded.size === 0 && file !== path)) return [];
    expanded.set(file, { ...edit, filePath: file, unifiedDiff: section });
  }
  return [...expanded];
}

function editsByPath(cwd: string, items: AgentTimelineItem[]): Map<string, Edit[]> {
  const files = new Map<string, Edit[]>();
  const recorded = new Set<string>();
  for (const item of items) {
    if (item.type !== "tool_call" || item.status !== "completed" || recorded.has(item.callId))
      continue;
    if (item.detail.type !== "write" && item.detail.type !== "edit") continue;
    recorded.add(item.callId);
    for (const [file, edit] of expandEdit(cwd, item.detail)) {
      const edits = files.get(file) ?? [];
      edits.push(edit);
      files.set(file, edits);
    }
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

function isEmptyAddition(edit: Edit): boolean {
  return edit.type === "edit" && !!edit.unifiedDiff && !!emptyAdditionPath(edit.unifiedDiff);
}

function applyCheckpointEdit(
  content: string | null,
  edit: Edit,
  emptyAdditionConfirmed: boolean,
): string | null | undefined {
  if (isEmptyAddition(edit)) return emptyAdditionConfirmed && content === null ? "" : undefined;
  return applyEdit(content, edit);
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
  const emptyAdditionConfirmed = !oldFile && newFile?.oid === objectId("");
  for (const edit of edits) {
    const updated = applyCheckpointEdit(content, edit, emptyAdditionConfirmed);
    if (updated === undefined) return false;
    content = updated;
    known.add(objectId(content));
  }
  return (
    (!fileChanged || objectId(content) === (newFile?.oid ?? null)) &&
    (!stageChanged || known.has(newStage?.oid ?? null))
  );
}
