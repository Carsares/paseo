import {
  CHECKOUT_GIT_MAX_PATCH_BYTES,
  type CheckoutGitWorkingTree,
  type ParsedDiffFile,
} from "@getpaseo/protocol/messages";

export type StagingLayer = "staged" | "unstaged";
export type PatchAction = "stage" | "unstage" | "discard";

export function fileSelection(
  tree: CheckoutGitWorkingTree,
  layer: StagingLayer,
  path: string,
): boolean | "mixed" {
  const staged = tree.staged.some((file) => file.path === path);
  const unstaged =
    tree.unstaged.some((file) => file.path === path) || tree.untracked.includes(path);
  if (staged && unstaged) return "mixed";
  return layer === "staged";
}

export function quotePatchPath(path: string): string {
  // Git reads C-style quoted UTF-8 bytes, with octal escapes outside printable ASCII.
  const escaped = Array.from(new TextEncoder().encode(path), (byte) => {
    if (byte === 34 || byte === 92) return "\\" + String.fromCharCode(byte);
    if (byte >= 32 && byte < 127) return String.fromCharCode(byte);
    return "\\" + byte.toString(8).padStart(3, "0");
  }).join("");
  return '"' + escaped + '"';
}

export function buildHunkPatch(file: ParsedDiffFile, hunkIndex: number): string | null {
  const hunk = file.hunks[hunkIndex];
  if (
    !hunk ||
    file.oldPath ||
    file.isNew ||
    file.isDeleted ||
    (file.status && file.status !== "ok") ||
    !file.path ||
    file.path.split("/").some((part) => part === "" || part === ".." || part === ".")
  ) {
    return null;
  }
  const lines = hunk.lines.filter((line) => line.type !== "header");
  const oldCount = lines.filter((line) => line.type !== "add").length;
  const newCount = lines.filter((line) => line.type !== "remove").length;
  if (oldCount !== hunk.oldCount || newCount !== hunk.newCount) return null;
  if (hunkIndex === file.hunks.length - 1) {
    // ParsedDiffFile omits Git's no-newline marker. The final context line
    // proves the changes end before EOF, but may itself lack a newline.
    if (lines.at(-1)?.type !== "context") return null;
    lines.pop();
  }
  if (
    !lines.some((line) => line.type === "context") ||
    !lines.some((line) => line.type !== "context")
  )
    return null;
  const prefix = { add: "+", remove: "-", context: " ", header: "" } as const;
  const oldPath = quotePatchPath("a/" + file.path);
  const newPath = quotePatchPath("b/" + file.path);
  const patch = [
    "diff --git " + oldPath + " " + newPath,
    "--- " + oldPath,
    "+++ " + newPath,
    "@@ -" +
      hunk.oldStart +
      "," +
      lines.filter((line) => line.type !== "add").length +
      " +" +
      hunk.newStart +
      "," +
      lines.filter((line) => line.type !== "remove").length +
      " @@",
    ...lines.map((line) => prefix[line.type] + line.content),
    "",
  ].join("\n");
  return new TextEncoder().encode(patch).length <= CHECKOUT_GIT_MAX_PATCH_BYTES ? patch : null;
}
