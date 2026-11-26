import { posix, win32 } from "node:path";
import type {
  WorkspaceTaskFileConflict,
  WorkspaceTaskFileConflictPeer,
} from "@getpaseo/protocol/messages";
import { getRelativePathInsideRoot, looksLikeDefiniteWindowsPath } from "../../../utils/path.js";
import type { AgentTimelineItem } from "../agent-sdk-types.js";
import type { WorkspaceTask } from "./index.js";

export const TASK_TOUCHED_FILE_LIMIT = 64;
const MAX_CONFLICT_PEERS = 16;
const MAX_PATH_LENGTH = 4096;
const terminalStatuses = new Set<WorkspaceTask["status"]>(["completed", "deferred", "canceled"]);

export function isActiveWorkspaceTask(task: Pick<WorkspaceTask, "status">): boolean {
  return !terminalStatuses.has(task.status);
}

type ToolCall = Extract<AgentTimelineItem, { type: "tool_call" }>;

const patchTools = new Set([
  "apply_patch",
  "apply_diff",
  "patch",
  "codex_file_change",
  "file_change",
]);
const writeTools = new Set([
  ...patchTools,
  "edit",
  "write",
  "multi_edit",
  "multiedit",
  "notebook_edit",
  "write_to_file",
  "replace_file_content",
  "str_replace_editor",
  "str_replace_based_edit_tool",
  "write_file",
  "edit_file",
  "patch_file",
  "create_file",
  "delete_file",
  "remove_file",
  "move_file",
  "rename_file",
  "file_write",
  "file_edit",
  "file_patch",
  "filesystem_write",
  "filesystem_edit",
  "fs_write",
  "fs_edit",
]);
const editorCommands = new Set(["create", "str_replace", "insert", "undo_edit"]);
const commandEditors = new Set(["str_replace_editor", "str_replace_based_edit_tool"]);
const readOrShellTools = new Set([
  "read",
  "read_file",
  "view",
  "view_file",
  "list_files",
  "glob",
  "grep",
  "rg",
  "bash",
  "shell",
  "terminal",
  "exec",
  "exec_command",
  "run_command",
]);

export function isNormalizedTouchedFile(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= MAX_PATH_LENGTH &&
    !path.includes("\\") &&
    !/^[a-z]:/i.test(path) &&
    !path.includes("\0") &&
    path
      .split("/")
      .every((part) => part && part !== "." && part !== ".." && part.toLowerCase() !== ".git")
  );
}

function normalizeTouchedFile(
  path: string,
  workspaceCwd: string,
  executionCwd: string,
): string | null {
  if (!path.trim() || path.length > MAX_PATH_LENGTH || path.includes("\0")) return null;
  if (path.split(/[\\/]/).some((part) => part.toLowerCase() === ".git")) return null;
  const windows = looksLikeDefiniteWindowsPath(workspaceCwd);
  if (!windows && looksLikeDefiniteWindowsPath(path)) return null;
  const root = workspaceCwd.replaceAll("\\", "/");
  const cwd = executionCwd.replaceAll("\\", "/");
  const candidate = path.replaceAll("\\", "/");
  const platform = windows ? win32 : posix;
  if (!platform.isAbsolute(root) || !platform.isAbsolute(cwd) || /^[a-z]:(?!\/)/i.test(candidate))
    return null;
  const absolute = platform.resolve(cwd, candidate);
  const relative = getRelativePathInsideRoot(root, absolute)?.replaceAll("\\", "/");
  if (!relative || !isNormalizedTouchedFile(relative)) return null;
  if (windows && relative.split("/").some((part) => /[:]|[. ]$/.test(part))) return null;
  return windows ? relative.toLowerCase() : relative;
}

function addRecent(paths: Set<string>, path: string): void {
  if (paths.has(path)) return;
  paths.add(path);
  if (paths.size > TASK_TOUCHED_FILE_LIMIT) {
    const oldest = paths.values().next();
    if (!oldest.done) paths.delete(oldest.value);
  }
}

export function mergeTouchedFiles(
  previous: readonly string[],
  incoming: Iterable<string>,
): string[] {
  const merged = new Set(previous);
  for (const path of incoming) if (isNormalizedTouchedFile(path)) addRecent(merged, path);
  return [...merged];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function* structuredPaths(value: unknown): Iterable<string> {
  const pathFields = [
    "filePath",
    "file_path",
    "path",
    "oldPath",
    "old_path",
    "newPath",
    "new_path",
    "sourcePath",
    "source_path",
    "destinationPath",
    "destination_path",
    "movePath",
    "move_path",
  ];
  if (typeof value === "string") {
    yield value;
    return;
  }
  if (!isRecord(value)) return;
  for (const field of pathFields) {
    const path = value[field];
    if (typeof path === "string") yield path;
  }
}

function* patchPaths(patch: string): Iterable<string> {
  let gitHeader = false;
  let beforeHunk = true;
  for (const line of patch.split(/\r?\n/)) {
    const directive = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/.exec(line);
    if (directive) {
      yield directive[1];
      continue;
    }
    if (line.startsWith("diff --git ")) {
      gitHeader = true;
      beforeHunk = true;
      continue;
    }
    if (line.startsWith("@@")) beforeHunk = false;
    if (!gitHeader || !beforeHunk) continue;
    const header = /^(?:--- a\/|\+\+\+ b\/|rename (?:from|to) )([^\t]+)(?:\t.*)?$/.exec(line);
    if (header) yield header[1];
  }
}

function* unknownToolPaths(input: unknown, output: unknown, name: string): Iterable<string> {
  const args = isRecord(input) ? input : null;
  yield* structuredPaths(args);
  if (name === "move_file" || name === "rename_file") {
    if (typeof args?.source === "string") yield args.source;
    if (typeof args?.destination === "string") yield args.destination;
  }
  if (args) {
    for (const field of ["paths", "filePaths", "file_paths", "edits", "files", "changes"]) {
      const entries = args[field];
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) yield* structuredPaths(entry);
    }
  }
  if (patchTools.has(name)) yield* unknownPatchPaths(input, args, output);
}

function* unknownPatchPaths(
  input: unknown,
  args: Record<string, unknown> | null,
  output: unknown,
): Iterable<string> {
  const result = isRecord(output) ? output : null;
  if (Array.isArray(result?.files)) {
    for (const entry of result.files) yield* structuredPaths(entry);
  }
  for (const patch of [input, args?.patch, args?.patchText, args?.unifiedDiff]) {
    if (typeof patch === "string") yield* patchPaths(patch);
  }
}

function* modifiedPaths(item: ToolCall): Generator<string> {
  if (item.status !== "completed" || item.agentMessage) return;
  const leaf =
    item.name
      .trim()
      .split(/__|[./:]+/)
      .at(-1) ?? "";
  const name = leaf.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
  if (readOrShellTools.has(name)) return;
  const detail = item.detail;
  if (detail.type === "write") {
    yield detail.filePath;
  } else if (detail.type === "edit") {
    const hasEdit = detail.oldString || detail.newString !== undefined || detail.unifiedDiff;
    if (commandEditors.has(name) && !hasEdit) return;
    yield detail.filePath;
    if (patchTools.has(name) && detail.unifiedDiff) yield* patchPaths(detail.unifiedDiff);
  } else if (detail.type === "unknown" && writeTools.has(name)) {
    if (commandEditors.has(name)) {
      const command = isRecord(detail.input) ? detail.input.command : undefined;
      if (typeof command !== "string" || !editorCommands.has(command)) return;
    }
    yield* unknownToolPaths(detail.input, detail.output, name);
  }
}

export function extractModifiedPathsFromToolCall(
  item: ToolCall,
  workspaceCwd: string,
  executionCwd = workspaceCwd,
): string[] {
  return normalizeModifiedPaths(modifiedPaths(item), workspaceCwd, executionCwd);
}

function normalizeModifiedPaths(
  rawPaths: Iterable<string>,
  workspaceCwd: string,
  executionCwd: string,
): string[] {
  const paths = new Set<string>();
  for (const raw of rawPaths) {
    const path = normalizeTouchedFile(raw, workspaceCwd, executionCwd);
    if (path) addRecent(paths, path);
  }
  return [...paths];
}

export function prepareModifiedPathsFromToolCall(item: ToolCall, executionCwd: string) {
  const paths = modifiedPaths(item);
  const first = paths.next();
  if (first.done) return undefined;
  function* candidates() {
    yield first.value;
    yield* paths;
  }
  return (workspaceCwd: string) => normalizeModifiedPaths(candidates(), workspaceCwd, executionCwd);
}

export function extractModifiedPathsFromTimelineItems(
  items: readonly AgentTimelineItem[],
  workspaceCwd: string,
  executionCwd = workspaceCwd,
): string[] {
  let paths: string[] = [];
  for (const item of items) {
    if (item.type !== "tool_call") continue;
    const modified = extractModifiedPathsFromToolCall(item, workspaceCwd, executionCwd);
    if (modified.length) paths = mergeTouchedFiles(paths, modified);
  }
  return paths;
}

export function computeWorkspaceTaskFileConflicts(
  tasks: readonly WorkspaceTask[],
): Map<string, WorkspaceTaskFileConflict[]> {
  const owners = new Map<string, WorkspaceTaskFileConflictPeer[]>();
  const conflicts = new Map<string, WorkspaceTaskFileConflict[]>();
  for (const task of tasks) {
    if (!isActiveWorkspaceTask(task) || !task.touchedFiles?.length) continue;
    const peer: WorkspaceTaskFileConflictPeer = {
      taskId: task.taskId,
      title: task.title,
      leadAgentId: task.leadAgentId,
      status: task.status,
    };
    for (const path of new Set(task.touchedFiles.slice(-TASK_TOUCHED_FILE_LIMIT))) {
      const group = owners.get(path);
      if (group) group.push(peer);
      else owners.set(path, [peer]);
    }
  }
  for (const [path, group] of owners) {
    if (group.length < 2) continue;
    const candidates = group.slice(0, MAX_CONFLICT_PEERS + 1);
    for (const { taskId } of group) {
      const conflict = {
        path,
        peers: candidates.filter((peer) => peer.taskId !== taskId).slice(0, MAX_CONFLICT_PEERS),
      };
      const existing = conflicts.get(taskId);
      if (existing) existing.push(conflict);
      else conflicts.set(taskId, [conflict]);
    }
  }
  return conflicts;
}
