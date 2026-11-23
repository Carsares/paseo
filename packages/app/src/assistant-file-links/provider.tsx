import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useSyncExternalStore,
  type MutableRefObject,
  type ReactNode,
} from "react";
import React from "react";
import type { ToastApi } from "@/components/toast-host";
import type { OpenFileDisposition } from "@/workspace/file-open";
import type { InlinePathTarget } from "./parse";
import type { AssistantFileLinkContext, GetDirectorySuggestions } from "./resolver";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";

export interface AssistantFileLinkDaemonClient extends Partial<
  Pick<DaemonClient, "getConnectionState" | "subscribeConnectionStatus">
> {
  readFile?: DaemonClient["readFile"];
  listDirectory?: (cwd: string, path: string) => Promise<unknown>;
  getDirectorySuggestions: GetDirectorySuggestions;
}

export interface AssistantFileLinkResolverConfig {
  client?: AssistantFileLinkDaemonClient | null;
  serverId?: string;
  workspaceRoot?: string;
  relativePathBase?: string;
  onOpenWorkspaceFile?: (target: InlinePathTarget, disposition: OpenFileDisposition) => void;
  toast?: ToastApi | null;
}

export interface AssistantFileLinkResolverProviderProps extends AssistantFileLinkResolverConfig {
  children: ReactNode;
}

export interface AssistantFileLinkResolverContextValue {
  configRef: MutableRefObject<AssistantFileLinkResolverConfig>;
  scope: AssistantFileLinkLookupScope;
}

export interface AssistantFileLinkLookupScope extends AssistantFileLinkContext {
  client?: AssistantFileLinkDaemonClient | null;
  serverId?: string;
  connection: object | null;
}

export function getLookupConnection(client: AssistantFileLinkDaemonClient | null | undefined) {
  const state = client?.getConnectionState?.();
  if (!state) return client ?? null;
  return state.status === "connected" ? state : null;
}

const AssistantFileLinkResolverContext =
  createContext<AssistantFileLinkResolverContextValue | null>(null);

export function useAssistantFileLinkEnvironmentBridge() {
  const value = useContext(AssistantFileLinkResolverContext);
  return useCallback(
    (children: ReactNode) => (
      <AssistantFileLinkResolverContext.Provider value={value}>
        {children}
      </AssistantFileLinkResolverContext.Provider>
    ),
    [value],
  );
}

export function AssistantFileLinkResolverProvider({
  client,
  serverId,
  workspaceRoot,
  relativePathBase,
  onOpenWorkspaceFile,
  toast,
  children,
}: AssistantFileLinkResolverProviderProps) {
  const configRef = useRef<AssistantFileLinkResolverConfig>({
    client,
    serverId,
    workspaceRoot,
    relativePathBase,
    onOpenWorkspaceFile,
    toast,
  });
  configRef.current = {
    client,
    serverId,
    workspaceRoot,
    relativePathBase,
    onOpenWorkspaceFile,
    toast,
  };

  const subscribe = useCallback(
    (notify: () => void) => client?.subscribeConnectionStatus?.(notify) ?? (() => {}),
    [client],
  );
  const getConnection = useCallback(() => getLookupConnection(client), [client]);
  const connection = useSyncExternalStore(subscribe, getConnection, getConnection);
  const scope = useMemo(
    () => ({ client, serverId, workspaceRoot, relativePathBase, connection }),
    [client, serverId, workspaceRoot, relativePathBase, connection],
  );
  const value = useMemo(() => ({ configRef, scope }), [scope]);

  return (
    <AssistantFileLinkResolverContext.Provider value={value}>
      {children}
    </AssistantFileLinkResolverContext.Provider>
  );
}

export function useAssistantFileLinkResolverContext(): AssistantFileLinkResolverContextValue {
  const context = useContext(AssistantFileLinkResolverContext);
  return context ?? EMPTY_CONTEXT;
}

export type { AssistantFileLinkContext };

const EMPTY_CONTEXT: AssistantFileLinkResolverContextValue = {
  configRef: { current: {} },
  scope: { connection: null },
};

export function useAssistantFileLinkEnvironment() {
  return useAssistantFileLinkResolverContext().configRef.current;
}
