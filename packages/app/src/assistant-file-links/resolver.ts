import {
  classifyAssistantFileLink,
  isFileLookingAssistantToken,
  type AssistantFileLinkClassification,
  type InlinePathTarget,
} from "./parse";
import { i18n } from "@/i18n/i18next";
import { isAbsolutePath } from "@/utils/path";

export interface AssistantFileLinkSource {
  href: string;
  text?: string;
  title?: string;
  markup?: string;
  sourceInfo?: string;
  sourceType?: "inline-code";
}

export interface AssistantFileLinkContext {
  workspaceRoot?: string;
  relativePathBase?: string;
}

export interface DirectorySuggestionEntry {
  path: string;
  kind: "file" | "directory";
}

export interface DirectorySuggestionResult {
  entries: DirectorySuggestionEntry[];
  error: string | null;
}

export type GetDirectorySuggestions = (input: {
  query: string;
  cwd: string;
  includeFiles: true;
  includeDirectories: false;
  matchMode: "suffix";
  limit: number;
}) => Promise<DirectorySuggestionResult>;

export type ResolvedAssistantFileLink =
  | { kind: "external"; url: string }
  | { kind: "file"; target: InlinePathTarget }
  | { kind: "ignored" };

export type AssistantFileLinkResolution =
  | { kind: "resolved"; value: ResolvedAssistantFileLink }
  | {
      kind: "needsLookup";
      ambiguousQuery: string;
      token: string;
      target: InlinePathTarget;
      keepDirectTarget?: true;
      exactOnly?: true;
    };

export interface FetchDaemonResolutionInput {
  ambiguousQuery: string;
  token: string;
  target: InlinePathTarget;
  workspaceRoot?: string;
  getDirectorySuggestions: GetDirectorySuggestions;
}

export class UnresolvedFileLinkError extends Error {
  constructor(readonly token: string) {
    super(i18n.t("common.errors.noFileFound", { token }));
    this.name = "UnresolvedFileLinkError";
  }
}

export async function fetchDaemonResolution({
  ambiguousQuery,
  token,
  target,
  workspaceRoot,
  getDirectorySuggestions,
}: FetchDaemonResolutionInput): Promise<InlinePathTarget> {
  const { paths } = await fetchFileLinkMatches({
    ambiguousQuery,
    workspaceRoot,
    getDirectorySuggestions,
    limit: 1,
  });
  const path = paths[0];
  if (!path) throw new UnresolvedFileLinkError(token);
  return { ...target, path };
}

export async function fetchFileLinkMatches({
  ambiguousQuery,
  workspaceRoot,
  getDirectorySuggestions,
  isDirectory,
  limit = 2,
}: Pick<
  FetchDaemonResolutionInput,
  "ambiguousQuery" | "workspaceRoot" | "getDirectorySuggestions"
> & {
  isDirectory?: (cwd: string, path: string) => Promise<boolean>;
  limit?: 1 | 2;
}): Promise<{ paths: string[]; exactDirectory: boolean }> {
  const trimmedRoot = workspaceRoot?.trim();
  if (!trimmedRoot) return { paths: [], exactDirectory: false };

  const suggestions = await getDirectorySuggestions({
    query: ambiguousQuery,
    cwd: trimmedRoot,
    includeFiles: true,
    includeDirectories: false,
    matchMode: "suffix",
    limit,
  }).catch(() => ({ entries: [], error: "Unavailable" }));
  const files = suggestions.error
    ? []
    : suggestions.entries.filter((entry) => entry.kind === "file");
  const directPath = ambiguousQuery.replace(/^\.\//, "");
  // A dotted folder can have the same name as a file elsewhere. Preserve the
  // existing preference for the exact directory on direct links without lines.
  const exactDirectory =
    isDirectory && ambiguousQuery.includes("/") && files[0]?.path !== directPath
      ? await isDirectory(trimmedRoot, directPath)
      : false;
  return {
    paths: files.map((entry) => joinWorkspacePath(trimmedRoot, entry.path)),
    exactDirectory,
  };
}

/** Qualify inferred nested files and explicit workspace-relative destinations for exact lookup. */
function nestedRelativeLookupQuery(
  target: InlinePathTarget,
  workspaceRoot: string | undefined,
  explicitLink = false,
): string | null {
  const root = workspaceRoot?.trim();
  if (
    !root ||
    isAbsoluteInlineCodeToken(target.raw) ||
    /^~(?:[\\/]|$)/.test(target.raw) ||
    /[\\/](?:#.*)?$/.test(target.raw)
  ) {
    return null;
  }
  const normalizedRoot = root.replace(/\\/g, "/").replace(/\/+$/, "");
  const normalizedPath = target.path.replace(/\\/g, "/");
  const prefix = `${normalizedRoot}/`;
  if (!normalizedPath.startsWith(prefix)) {
    return null;
  }
  const relative = normalizedPath.slice(prefix.length);
  if (
    !explicitLink &&
    (!relative.includes("/") || !isFileLookingAssistantToken(encodeURI(relative)))
  ) {
    return null;
  }
  // The daemon probes exact files for path queries before ranking suffixes.
  return relative.includes("/") ? relative : `./${relative}`;
}

/** When a markdown link points at workspaceRoot/schema/x.md and that file is
 * missing, ask the same suffix lookup bare names already use. An exact hit
 * stays on that path. A suffix hit such as repo-a/schema/x.md replaces it.
 * Lookup failure keeps the original target.
 */
export async function resolveMissingNestedRelativeFile(input: {
  target: InlinePathTarget;
  workspaceRoot?: string;
  getDirectorySuggestions: GetDirectorySuggestions;
}): Promise<InlinePathTarget> {
  const query = nestedRelativeLookupQuery(input.target, input.workspaceRoot);
  if (!query) {
    return input.target;
  }
  try {
    return await fetchDaemonResolution({
      ambiguousQuery: query,
      token: input.target.raw,
      target: input.target,
      workspaceRoot: input.workspaceRoot,
      getDirectorySuggestions: input.getDirectorySuggestions,
    });
  } catch {
    return input.target;
  }
}

export function classifyForResolution(
  source: AssistantFileLinkSource,
  context: AssistantFileLinkContext,
): AssistantFileLinkResolution {
  const tokenInfo = getAssistantFileLinkTokenInfo(source);
  const token = tokenInfo.token.trim();
  if (!token) {
    return { kind: "resolved", value: { kind: "ignored" } };
  }

  const explicitLink = source.sourceType !== "inline-code" && !isLinkifiedSource(source);
  const classification = classifyAssistantFileLink(token, {
    workspaceRoot: context.workspaceRoot,
    decodeHref: tokenInfo.fromHref,
    explicitLink,
    relativePathBase: context.relativePathBase,
  });
  if (!classification) {
    return { kind: "resolved", value: { kind: "ignored" } };
  }
  if (classification.kind === "external") {
    return { kind: "resolved", value: { kind: "external", url: classification.raw } };
  }
  if (
    classification.kind === "directFile" &&
    !shouldResolveDirectFileThroughSuggestions({
      context,
      source,
      token,
      target: classification.target,
    })
  ) {
    const query = nestedRelativeLookupQuery(
      classification.target,
      context.workspaceRoot,
      explicitLink,
    );
    if (query) {
      const exactOnly =
        !!context.relativePathBase ||
        !nestedRelativeLookupQuery(classification.target, context.workspaceRoot);
      return {
        kind: "needsLookup",
        ambiguousQuery: query,
        token,
        target: classification.target,
        keepDirectTarget: true,
        ...(exactOnly ? { exactOnly: true } : {}),
      };
    }
    return { kind: "resolved", value: { kind: "file", target: classification.target } };
  }

  const workspaceRoot = context.workspaceRoot?.trim();
  if (!workspaceRoot) {
    return { kind: "resolved", value: { kind: "ignored" } };
  }

  return {
    kind: "needsLookup",
    ambiguousQuery: getAmbiguousSuggestionQuery(classification.target, workspaceRoot),
    token,
    target: classification.target,
  };
}

export function getAssistantFileLinkToken(source: AssistantFileLinkSource): string {
  return getAssistantFileLinkTokenInfo(source).token;
}

// Markdown link hrefs are percent-encoded by the renderer; inline-code and
// linkified text are raw file paths that must not be decoded.
function getAssistantFileLinkTokenInfo(source: AssistantFileLinkSource): {
  token: string;
  fromHref: boolean;
} {
  if (source.sourceType === "inline-code") {
    return { token: source.text?.trim() || source.href, fromHref: false };
  }
  if (isLinkifiedSource(source)) {
    const text = source.text?.trim();
    if (text && isFileLookingAssistantToken(text)) {
      return { token: text, fromHref: false };
    }
  }

  return { token: source.href, fromHref: true };
}

export function getAmbiguousSuggestionQuery(
  target: InlinePathTarget,
  workspaceRoot: string,
): string {
  const normalizedRoot = workspaceRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  const normalizedPath = target.path.replace(/\\/g, "/");
  const prefix = `${normalizedRoot}/`;
  if (normalizedPath.startsWith(prefix)) {
    return normalizedPath.slice(prefix.length);
  }

  const lastSlash = normalizedPath.lastIndexOf("/");
  return lastSlash >= 0 ? normalizedPath.slice(lastSlash + 1) : normalizedPath;
}

export function shouldResolveDirectFileThroughSuggestions(input: {
  context: AssistantFileLinkContext;
  source: AssistantFileLinkSource;
  token: string;
  target: InlinePathTarget;
}): boolean {
  if (input.source.sourceType !== "inline-code") {
    return false;
  }

  if (isAbsoluteInlineCodeToken(input.token)) {
    return false;
  }

  const workspaceRoot = input.context.workspaceRoot?.trim();
  if (!workspaceRoot) {
    return false;
  }

  const normalizedRoot = workspaceRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  const normalizedPath = input.target.path.replace(/\\/g, "/");
  return normalizedPath.startsWith(`${normalizedRoot}/`);
}

function isAbsoluteInlineCodeToken(token: string): boolean {
  return isAbsolutePath(token) || token.toLowerCase().startsWith("file://");
}

function isLinkifiedSource(source: AssistantFileLinkSource): boolean {
  return source.markup === "linkify" || source.sourceInfo === "auto";
}

function joinWorkspacePath(workspaceRoot: string, relativePath: string): string {
  const root = workspaceRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  const child = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
  return `${root}/${child}`;
}

export type { AssistantFileLinkClassification };
