import { useCallback, useMemo } from "react";
import { useQuery, useQueryClient, type Query } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useStableEvent } from "@/hooks/use-stable-event";
import type { OpenFileDisposition } from "@/workspace/file-open";
import { openExternalUrl } from "@/utils/open-external-url";
import { formatFileLinkTooltipPath } from "./tooltip-path";
import type { InlinePathTarget } from "./parse";
import {
  getLookupConnection,
  useAssistantFileLinkResolverContext,
  type AssistantFileLinkLookupScope,
  type AssistantFileLinkResolverContextValue,
  type AssistantFileLinkResolverConfig,
} from "./provider";
import {
  classifyForResolution,
  fetchFileLinkMatches,
  UnresolvedFileLinkError,
  type AssistantFileLinkResolution,
  type AssistantFileLinkSource,
  type AssistantFileLinkContext,
} from "./resolver";

export interface UseFileLinkResult {
  target: InlinePathTarget | null;
  tooltipPath: string | null;
  tooltipDetail: string | null;
  onHoverIn: () => void;
  onPress: () => void;
  open: (source: AssistantFileLinkSource, disposition: OpenFileDisposition) => void;
}

export interface AssistantFileLinkActions {
  open(source: AssistantFileLinkSource, disposition: OpenFileDisposition): void;
  canOpen(source: AssistantFileLinkSource): boolean;
  canResolveFile(source: AssistantFileLinkSource): boolean;
}

type FileLinkLookup = Extract<AssistantFileLinkResolution, { kind: "needsLookup" }>;
type FileLinkMatches = Awaited<ReturnType<typeof fetchFileLinkMatches>>;
const LOOKUP_FRESHNESS_MS = 45_000;
const DISABLED_QUERY_KEY = ["assistantFileLink", null, null, null, null] as const;
const connectionIds = new WeakMap<object, number>();
let nextConnectionId = 0;

function getConnectionId(connection: object) {
  let id = connectionIds.get(connection);
  if (id === undefined) {
    id = ++nextConnectionId;
    connectionIds.set(connection, id);
  }
  return id;
}

function lookupOptions(scope: AssistantFileLinkLookupScope, resolution: FileLinkLookup | null) {
  const { client, connection, serverId, workspaceRoot } = scope;
  const listDirectory = client?.listDirectory?.bind(client);
  return {
    queryKey:
      resolution && connection
        ? ([
            "assistantFileLink",
            serverId ?? null,
            workspaceRoot ?? null,
            resolution.ambiguousQuery,
            getConnectionId(connection),
          ] as const)
        : DISABLED_QUERY_KEY,
    queryFn: async () => {
      if (!resolution || !client || !connection)
        throw new UnresolvedFileLinkError(resolution?.token ?? "");
      const matches = await fetchFileLinkMatches({
        ambiguousQuery: resolution.ambiguousQuery,
        workspaceRoot,
        getDirectorySuggestions: (input) => client.getDirectorySuggestions(input),
        isDirectory: listDirectory
          ? async (cwd, path) => {
              try {
                await listDirectory(cwd, path);
                return true;
              } catch {
                return false;
              }
            }
          : undefined,
      });
      if (!matches.exactDirectory && !matches.paths.length) {
        throw new UnresolvedFileLinkError(resolution.token);
      }
      return matches;
    },
    retry: 0,
    staleTime: (query: Query<FileLinkMatches>) =>
      resolution && query.state.data && selectLookupTarget(resolution, query.state.data).target
        ? LOOKUP_FRESHNESS_MS
        : 0,
    networkMode: "always" as const,
  };
}

function selectLookupTarget(resolution: FileLinkLookup, matches: FileLinkMatches) {
  if (matches.exactDirectory && resolution.keepDirectTarget && !resolution.target.lineStart) {
    return { target: resolution.target, multiple: false };
  }
  if (resolution.exactOnly) {
    const path = matches.paths[0];
    return {
      target: path === resolution.target.path.replace(/\\/g, "/") ? resolution.target : null,
      multiple: false,
    };
  }
  const path = matches.paths[0];
  return {
    target: path ? { ...resolution.target, path } : null,
    multiple: matches.paths.length > 1,
  };
}

export function useFileLink(source: AssistantFileLinkSource): UseFileLinkResult {
  const { t } = useTranslation();
  const context = useAssistantFileLinkResolverContext();
  const queryClient = useQueryClient();
  const stableSource = useStableSource(source);
  const { scope } = context;
  const { workspaceRoot, relativePathBase } = scope;
  const resolution = useMemo(
    () =>
      classifyForResolution(stableSource, {
        workspaceRoot,
        relativePathBase,
      }),
    [stableSource, workspaceRoot, relativePathBase],
  );
  const options = lookupOptions(scope, resolution.kind === "needsLookup" ? resolution : null);
  const query = useQuery({ ...options, enabled: false });

  const open = useStableEvent(
    (nextSource: AssistantFileLinkSource, disposition: OpenFileDisposition) => {
      openAssistantFileLink({
        source: nextSource,
        disposition,
        context,
        queryClient,
        formatNoFileFoundMessage: (token) => t("common.errors.noFileFound", { token }),
      });
    },
  );

  const onHoverIn = useStableEvent(() => {
    if (resolution.kind === "needsLookup" && scope.connection) {
      void queryClient.prefetchQuery(options);
    }
  });

  const onPress = useStableEvent(() => {
    open(stableSource, "preferred");
  });

  const { target, multiple } = useMemo(() => {
    if (resolution.kind === "resolved") {
      return {
        target: resolution.value.kind === "file" ? resolution.value.target : null,
        multiple: false,
      };
    }
    return query.isSuccess && !query.isFetching
      ? selectLookupTarget(resolution, query.data)
      : { target: null, multiple: false };
  }, [query.data, query.isFetching, query.isSuccess, resolution]);

  let tooltipPath = target ? formatFileLinkTooltipPath({ target, workspaceRoot }) : null;
  let tooltipDetail: string | null = null;
  if (resolution.kind === "needsLookup") {
    if (scope.connection && query.isFetching) {
      tooltipPath = resolution.token;
      tooltipDetail = t("assistantFileLink.searching");
    } else if (!target) {
      tooltipPath = resolution.token;
      tooltipDetail = t("assistantFileLink.unconfirmed");
    } else if (multiple) {
      tooltipDetail = t("assistantFileLink.opensFirst");
    }
  }
  return useMemo(
    () => ({ target, tooltipPath, tooltipDetail, onHoverIn, onPress, open }),
    [target, tooltipPath, tooltipDetail, onHoverIn, onPress, open],
  );
}

export function useAssistantFileLinkActions(): AssistantFileLinkActions {
  const context = useAssistantFileLinkResolverContext();
  const actionLink = useFileLink(ACTION_LINK_SOURCE);

  const open = useStableEvent(
    (source: AssistantFileLinkSource, disposition: OpenFileDisposition) => {
      actionLink.open(source, disposition);
    },
  );
  const canOpen = useCallback(
    (source: AssistantFileLinkSource) =>
      canOpenAssistantFileLink(source, context.configRef.current),
    [context.configRef],
  );
  const canResolveFile = useCallback(
    (source: AssistantFileLinkSource) =>
      canResolveAssistantFileLinkToFile(source, context.configRef.current),
    [context.configRef],
  );

  return useMemo(() => ({ open, canOpen, canResolveFile }), [open, canOpen, canResolveFile]);
}

// Markdown lookups can finish before the workspace opener receives the target.
const latestFileOpen = new WeakMap<
  NonNullable<AssistantFileLinkResolverConfig["onOpenWorkspaceFile"]>,
  symbol
>();

function openAssistantFileLink(input: {
  source: AssistantFileLinkSource;
  disposition: OpenFileDisposition;
  context: AssistantFileLinkResolverContextValue;
  queryClient: ReturnType<typeof useQueryClient>;
  formatNoFileFoundMessage: (token: string) => string;
}): void {
  const capturedConfig = input.context.configRef.current;
  const connection = getLookupConnection(capturedConfig.client);
  const capturedResolution = classifyForResolution(input.source, {
    workspaceRoot: capturedConfig.workspaceRoot,
    relativePathBase: capturedConfig.relativePathBase,
  });

  const opener = capturedConfig.onOpenWorkspaceFile;
  const fileOpen = Symbol();
  if (
    opener &&
    (capturedResolution.kind === "needsLookup" || capturedResolution.value.kind === "file")
  ) {
    latestFileOpen.set(opener, fileOpen);
  }
  if (capturedResolution.kind === "resolved") {
    void dispatchResolvedLink({
      resolution: capturedResolution,
      disposition: input.disposition,
      capturedServerId: capturedConfig.serverId,
      capturedWorkspaceRoot: capturedConfig.workspaceRoot,
      context: input.context,
    });
    return;
  }

  const run = async () => {
    let target: InlinePathTarget | null = null;
    if (connection) {
      try {
        const matches = await input.queryClient.fetchQuery(
          lookupOptions({ ...capturedConfig, connection }, capturedResolution),
        );
        target = selectLookupTarget(capturedResolution, matches).target;
      } catch {
        // An unconfirmed direct link can still be opened at its original location.
      }
    }
    const current = input.context.configRef.current;
    if (
      current.relativePathBase !== capturedConfig.relativePathBase ||
      current.client !== capturedConfig.client ||
      getLookupConnection(current.client) !== connection
    )
      return;
    if (opener && latestFileOpen.get(opener) !== fileOpen) return;
    if (!target && capturedResolution.keepDirectTarget) target = capturedResolution.target;
    if (target) {
      await dispatchFileTarget({
        target: { ...target, workspaceLookupComplete: true },
        disposition: input.disposition,
        capturedServerId: capturedConfig.serverId,
        capturedWorkspaceRoot: capturedConfig.workspaceRoot,
        context: input.context,
      });
    } else {
      await dispatchUnresolvedError({
        noFileFoundMessage: input.formatNoFileFoundMessage(capturedResolution.token),
        capturedServerId: capturedConfig.serverId,
        capturedWorkspaceRoot: capturedConfig.workspaceRoot,
        context: input.context,
      });
    }
  };

  void run();
}

function canOpenAssistantFileLink(
  source: AssistantFileLinkSource,
  context: AssistantFileLinkContext,
): boolean {
  const resolution = classifyForResolution(source, context);
  return resolution.kind === "needsLookup" || resolution.value.kind !== "ignored";
}

function canResolveAssistantFileLinkToFile(
  source: AssistantFileLinkSource,
  context: AssistantFileLinkContext,
): boolean {
  const resolution = classifyForResolution(source, context);
  return resolution.kind === "needsLookup" || resolution.value.kind === "file";
}

function useStableSource(source: AssistantFileLinkSource): AssistantFileLinkSource {
  const { href, text, title, markup, sourceInfo, sourceType } = source;
  return useMemo(
    () => ({ href, text, title, markup, sourceInfo, sourceType }),
    [href, text, title, markup, sourceInfo, sourceType],
  );
}

async function dispatchResolvedLink(input: {
  resolution: Extract<AssistantFileLinkResolution, { kind: "resolved" }>;
  disposition: OpenFileDisposition;
  capturedServerId?: string;
  capturedWorkspaceRoot?: string;
  context: AssistantFileLinkResolverContextValue;
}) {
  const { value } = input.resolution;
  if (value.kind === "file") {
    await dispatchFileTarget({
      target: value.target,
      disposition: input.disposition,
      capturedServerId: input.capturedServerId,
      capturedWorkspaceRoot: input.capturedWorkspaceRoot,
      context: input.context,
    });
    return;
  }
  if (value.kind === "external") {
    await dispatchExternalUrl({
      url: value.url,
      capturedServerId: input.capturedServerId,
      capturedWorkspaceRoot: input.capturedWorkspaceRoot,
      context: input.context,
    });
  }
}

async function dispatchFileTarget(input: {
  target: InlinePathTarget;
  disposition: OpenFileDisposition;
  capturedServerId?: string;
  capturedWorkspaceRoot?: string;
  context: AssistantFileLinkResolverContextValue;
}) {
  const current = input.context.configRef.current;
  if (
    current.serverId !== input.capturedServerId ||
    current.workspaceRoot !== input.capturedWorkspaceRoot
  ) {
    return;
  }
  current.onOpenWorkspaceFile?.(input.target, input.disposition);
}

async function dispatchExternalUrl(input: {
  url: string;
  capturedServerId?: string;
  capturedWorkspaceRoot?: string;
  context: AssistantFileLinkResolverContextValue;
}) {
  const current = input.context.configRef.current;
  if (
    current.serverId !== input.capturedServerId ||
    current.workspaceRoot !== input.capturedWorkspaceRoot
  ) {
    return;
  }
  await openExternalUrl(input.url);
}

async function dispatchUnresolvedError(input: {
  noFileFoundMessage: string;
  capturedServerId?: string;
  capturedWorkspaceRoot?: string;
  context: AssistantFileLinkResolverContextValue;
}) {
  const current = input.context.configRef.current;
  if (
    current.serverId !== input.capturedServerId ||
    current.workspaceRoot !== input.capturedWorkspaceRoot
  ) {
    return;
  }
  current.toast?.show(input.noFileFoundMessage, {
    variant: "error",
    testID: "assistant-file-link-not-found-toast",
  });
}

const ACTION_LINK_SOURCE: AssistantFileLinkSource = {
  href: "",
};
