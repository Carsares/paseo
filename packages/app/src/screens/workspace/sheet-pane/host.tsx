import React, { createContext, useCallback, useContext, type ReactNode } from "react";
import invariant from "tiny-invariant";
import { NavigationContext, NavigationRouteContext } from "expo-router/react-navigation";
import { useAssistantFileLinkEnvironmentBridge } from "@/assistant-file-links";
import { useForgeShorthandBridge } from "@/git/forge-shorthand";
import { useComposerEditingEnvironmentBridge } from "@/composer/editing-session";
import { RetainedPanelActivity, useRetainedPanelActive } from "@/components/retained-panel";
import { useMobilePanelsBridge } from "@/mobile-panels/provider";
import type { ContextBridge } from "@/components/ui/isolated-bottom-sheet-modal";
import { useDiffDocumentWorkspaceCacheBridge } from "@/git/diff-document/workspace-cache";
import { HostRouteProvider, useHostRouteServerId } from "@/navigation/host-route-context";
import type { WorkspacePaneContentModel } from "@/screens/workspace/workspace-pane-content";
import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";
import { useResidentDialogBridge } from "@/subagents/resident-dialog";
import {
  WorkspaceSheetStackBridge,
  WorkspaceSheetStackProvider,
  useWorkspaceSheetPages,
} from "./stack-provider";

/** What a sheet pane needs from the workspace it shows a tab of. */
export interface SheetPaneHost {
  workspaceKey: string;
  serverId: string;
  workspaceId: string;
  isWorkspaceFocused: boolean;
  /** The pane content for a sheet's tab. Closing the tab from inside it runs `closeCurrentTab`. */
  buildContent: (
    tab: WorkspaceTabDescriptor,
    closeCurrentTab: () => void,
  ) => WorkspacePaneContentModel;
}

const SheetPaneHostContext = createContext<SheetPaneHost | null>(null);

/** `null` while there is no workspace to show sheets for. */
export function SheetPaneHostProvider({
  value,
  children,
}: {
  value: SheetPaneHost | null;
  children: ReactNode;
}) {
  return (
    <SheetPaneHostContext.Provider value={value}>
      <WorkspaceSheetStackProvider workspaceKey={value?.workspaceKey ?? null}>
        {children}
      </WorkspaceSheetStackProvider>
    </SheetPaneHostContext.Provider>
  );
}

/** The host of the workspace the caller is in, or null while there is none. */
export function useSheetPaneHostIfAny(): SheetPaneHost | null {
  return useContext(SheetPaneHostContext);
}

export function useSheetPaneHost(): SheetPaneHost {
  const host = useSheetPaneHostIfAny();
  invariant(host, "SheetPaneHostProvider is required");
  return host;
}

/**
 * Carries a sheet pane's environment across the portal into the app overlay host: the workspace
 * host, and the environment of the built-in panels. Pane identity is supplied by the pane itself.
 */
export function useSheetPaneBridge(): ContextBridge {
  const host = useSheetPaneHost();
  const stack = useWorkspaceSheetPages();
  const mobilePanels = useMobilePanelsBridge();
  const editing = useComposerEditingEnvironmentBridge();
  const cache = useDiffDocumentWorkspaceCacheBridge();
  const files = useAssistantFileLinkEnvironmentBridge();
  const forgeShorthand = useForgeShorthandBridge();
  const residentDialog = useResidentDialogBridge();
  const active = useRetainedPanelActive();
  const serverId = useHostRouteServerId();
  const navigation = useContext(NavigationContext);
  const route = useContext(NavigationRouteContext);
  return useCallback(
    (children) => {
      const content = mobilePanels(editing(cache(files(forgeShorthand(residentDialog(children))))));
      return (
        <SheetPaneHostContext.Provider value={host}>
          <WorkspaceSheetStackBridge value={stack}>
            <NavigationContext.Provider value={navigation}>
              <NavigationRouteContext.Provider value={route}>
                <RetainedPanelActivity active={active}>
                  {serverId ? (
                    <HostRouteProvider serverId={serverId}>{content}</HostRouteProvider>
                  ) : (
                    content
                  )}
                </RetainedPanelActivity>
              </NavigationRouteContext.Provider>
            </NavigationContext.Provider>
          </WorkspaceSheetStackBridge>
        </SheetPaneHostContext.Provider>
      );
    },
    [
      host,
      stack,
      mobilePanels,
      editing,
      cache,
      files,
      forgeShorthand,
      residentDialog,
      active,
      serverId,
      navigation,
      route,
    ],
  );
}
