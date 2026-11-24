import {
  AdaptiveWorkspaceChrome,
  type WorkspaceCompactHeaderTabs,
} from "./adaptive-workspace-chrome";
import { planTimelineTailFetch } from "@/timeline/timeline-sync-plan";
import { selectHostFeature, useHostFeature } from "@/runtime/host-features";
import {
  AssistantFileLinkResolverProvider,
  createInlinePathOpener,
  type AssistantFileLinkResolverProviderProps,
  type InlinePathTarget,
} from "@/assistant-file-links";
import { useFileExplorerActions } from "@/hooks/use-file-explorer-actions";
import { useWindowLayout, resolveWorkspaceActionPlacement } from "@/window-layout";
import { revealWorkspaceTab } from "@/workspace-tabs/navigation";
import { ExplorerSidebarDock } from "@/screens/workspace/explorer-sidebar";
import { ForgeShorthandProvider } from "@/git/forge-shorthand";
import { ExplorerFrame } from "./explorer-sidebar/frame";
import { WorkspaceTabDragScope } from "@/components/workspace-tab-drag-scope";
import {
  WorkspaceComposerEditingSessionsProvider,
  useComposerTabFullscreen,
} from "@/composer/editing-session";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import {
  isTopicFirstQuestionDraft,
  resolveTopicFirstQuestionDraftId,
} from "@/composer/draft/workspace-main-intent";
import {
  getUnboundTopicWorkspace,
  TopicEmptyState,
  TopicQuestionResume,
  useTopicWorkspace,
} from "@/panels/topic-empty-state";
import { WorkspaceTopicUpgradeDialog } from "@/workspace/upgrade-to-topic/dialog";
import { canOfferTopicUpgrade } from "@/workspace/upgrade-to-topic/model";
import { SheetHostScope } from "@/components/ui/isolated-bottom-sheet-modal";
import type { JsonValue } from "@getpaseo/protocol/agent-types";
import { getOpenAgentTabLabel, isMainControlAgent } from "@getpaseo/protocol/agent-labels";
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ContextType,
  type ReactElement,
  type ReactNode,
} from "react";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { useIsFocused } from "expo-router/react-navigation";
import { BackHandler, Text, View } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter, type Href } from "expo-router";
import * as Clipboard from "expo-clipboard";
import { useTranslation } from "react-i18next";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";
import { SidebarMenuToggle } from "@/components/headers/sidebar-menu-toggle";
import { ScreenHeader } from "@/components/headers/screen-header";
import { MenuHeader } from "@/components/headers/menu-header";
import { FloatingHeaderLayout } from "@/components/floating-header";
import { StreamTopOverlayProvider, supportsStreamTopOverlay } from "@/agent-stream/top-overlay";
import {
  CompactWorkspaceHeader,
  MobileWorkspaceTabSwitcher,
} from "@/screens/workspace/compact-workspace-header";
import { WorkspaceHeaderProjectRow } from "@/screens/workspace/workspace-header-project-row";
import { ScreenTitle } from "@/components/headers/screen-title";
import {
  FloatingPanelPortalHost,
  FloatingPanelPortalHostNameProvider,
} from "@/components/ui/floating-panel-portal";
import { SplitContainer } from "@/components/split-container";
import { RetainedPanel } from "@/components/retained-panel";
import { WorkspaceActions } from "@/git/workspace-actions";
import { WorkspaceOpenInEditorButton } from "@/workspace/open-in-editor/button";
import { WorkspaceScriptsButton, useWorkspaceScriptActions } from "@/screens/workspace/scripts";
import { ImportSessionSheet } from "@/components/import-session-sheet";
import { useNavigateToImportedAgent } from "@/hooks/use-import-session";
import { useToast } from "@/contexts/toast-context";
import { useOpenOutsideWorkspaceFolder } from "@/workspace/open-in-file-manager/outside-folder";
import { getOrCreateClientId } from "@/utils/client-id";
import { selectIsAgentListOpen, usePanelStore } from "@/stores/panel-store";
import { toggleDesktopSidebarsWithCheckoutIntent } from "@/utils/desktop-sidebar-toggle";
import {
  isExplorerSidebarOpen,
  openExplorerSidebarView,
  toggleExplorerSidebar,
  useIsExplorerSidebarOpen,
} from "@/workspace-tabs/explorer-sidebar";
import {
  openPreferredWorkspacePreview,
  openPreferredWorkspaceTarget,
  openWorkspaceTargetBeside,
} from "@/workspace-tabs/open-beside";
import { openWorkspacePullRequest } from "@/workspace-tabs/open-supporting-view";
import { traceInstant } from "@/performance/native-trace";
import {
  useSessionStore,
  type Agent,
  type SessionState,
  type WorkspaceDescriptor,
} from "@/stores/session-store";
import {
  canDismissPaneInLayout,
  collectAllTabs,
  DEFAULT_PANE_ID,
  findPaneById,
  findPaneContainingTab,
  getFocusedBrowserId,
  FOCUSED_PANE_PLACEMENT,
  selectExplorerSidebarPaneId,
  selectPaneFocusSuspended,
  type WorkspaceLayout,
  type SheetTab,
  type WorkspaceTabPlacement,
  useWorkspaceLayoutStore,
  usePendingWorkspaceOpen,
  useWorkspaceLayoutStoreHydrated,
} from "@/stores/workspace-layout-store";
import {
  buildWorkspaceTabPersistenceKey,
  type WorkspaceTab,
  type WorkspaceTabTarget,
} from "@/workspace-tabs/model";
import { useSettings } from "@/hooks/use-settings";
import { useFormPreferences } from "@/hooks/use-form-preferences";
import { buildMainSubagentTabDraftSetup } from "@/hooks/use-fork-agent";
import { isDraftTabSubmitting, revealCreatedDraftAgentTab } from "@/composer/draft/workspace-tab";
import { useKeyboardActionHandler } from "@/hooks/use-keyboard-action-handler";
import { buildWorkspaceKeyboardHandlerId } from "@/keyboard/handler-id";
import type {
  KeyboardActionDefinition,
  WorkspacePanelTarget,
} from "@/keyboard/keyboard-action-dispatcher";
import { useCreateFlowStore } from "@/stores/create-flow-store";
import { normalizeWorkspaceTabTarget, workspaceTabTargetsEqual } from "@/workspace-tabs/identity";
import { useVisibleAgentIds } from "./visible-agent-ids";
import {
  getHostRuntimeStore,
  useHostRuntimeClient,
  useHostRuntimeIsConnected,
  useHostRuntimeSnapshot,
  useHosts,
} from "@/runtime/host-runtime";
import { prefetchProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import {
  shouldSeedWorkspaceSetupTab,
  shouldShowWorkspaceSetup,
  useWorkspaceSetupStore,
} from "@/stores/workspace-setup-store";
import { useWorkspace } from "@/stores/session-store-hooks";
import type { CheckoutStatusPayload } from "@/git/use-status-query";
import { confirmDialog } from "@/utils/confirm-dialog";
import { useArchiveAgent } from "@/hooks/use-archive-agent";
import { useWorkspaceArchiveUndoRunning } from "@/workspace/archive-undo";
import { useStableEvent } from "@/hooks/use-stable-event";
import { removeResidentBrowserWebview } from "@/desktop/browser/resident-webviews";
import { createWorkspaceBrowser, useBrowserStore } from "@/desktop/browser/store";
import { getDesktopHost } from "@/desktop/host";
import { buildProviderCommand } from "@/utils/provider-command-templates";
import { generateDraftId } from "@/stores/draft-keys";
import { resolveWorkspaceRouteId } from "@/utils/workspace-identity";
import { clearSubagentOpenTabLabel } from "@/subagents/open-tab-labels";
import { ResidentDialogProvider } from "@/subagents/resident-dialog";
import { getSideChatOpenTabLabel } from "@/subagents/open-tab-labels";
import { useOpenAgentTabLabels } from "@/subagents/use-open-agent-tab-labels";
import {
  canAdoptTabUnderMainAgent,
  createWorkspaceHierarchyTabStateSelector,
  findWorkspaceMainAgentId,
  hasUnarchivedWorkspaceDescendants,
  isWorkspaceRootAgent,
} from "@/subagents/main-control-tree/select-tree";
import {
  getWorkspaceBulkCloseTargets,
  getWorkspaceTabHierarchyLabels,
  isWorkspaceMainTab,
  pinWorkspaceMainTabIds,
  WorkspaceMainTabContext,
} from "./workspace-tab-menu";
import { WorkspaceTabPresentationResolver } from "@/screens/workspace/workspace-tab-presentation";
import {
  useWorkspaceTabRename,
  WorkspaceTabRenameModal,
} from "@/screens/workspace/use-workspace-tab-rename";
import {
  WorkspaceDesktopTabsRow,
  useWorkspaceNewTabKeyboardAction,
  type WorkspaceDesktopTabRowItem,
} from "@/screens/workspace/workspace-desktop-tabs-row";
import { useDesktopBrowserNewTabRequests } from "@/desktop/browser/new-tab-requests";
import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";
import { useWorkspaceExplorerControls } from "@/screens/workspace/workspace-explorer-toggle";
import { WindowChromeRegion, WindowChromeSafeArea } from "@/utils/desktop-window";
import {
  resolveWorkspaceHeaderRenderState,
  type WorkspaceHeaderCheckoutState,
} from "@/screens/workspace/workspace-header-source";
import {
  resolveWorkspaceRouteState,
  type WorkspaceRouteState,
} from "@/screens/workspace/workspace-route-state";
import { renderWorkspaceRouteGate } from "@/screens/workspace/workspace-route-state-views";
import { useWorkspaceRecovery } from "@/workspace-recovery/use-workspace-recovery";
import type { WorkspaceRecoveryModel } from "@/workspace-recovery/model";
import {
  buildWorkspaceTabSnapshot,
  createWorkspaceAgentVisibilitySelector,
  workspaceAgentVisibilityEqual,
} from "@/workspace-tabs/agent-visibility";
import { deriveWorkspacePaneState } from "@/screens/workspace/workspace-pane-state";
import {
  buildWorkspacePaneContentModel,
  WorkspacePaneContent,
  type WorkspacePaneContentModel,
} from "@/screens/workspace/workspace-pane-content";
import { useMountedTabSet } from "@/screens/workspace/use-mounted-tab-set";
import { ensurePanelsRegistered } from "@/panels/register-panels";
import { SheetPaneHostProvider, type SheetPaneHost } from "@/screens/workspace/sheet-pane";
import { SheetTabs } from "@/screens/workspace/sheet-tabs";
import type { PaneHost } from "@/panels/panel-manifest";
import { WorkspaceFocusProvider } from "@/workspace/focus";
import { DiffDocumentWorkspaceCacheProvider } from "@/git/diff-document/workspace-cache";
import { buildNewAgentTabTarget, type NewTabSelection } from "@/workspace-tabs/new-tab";
import {
  NewTabLauncherProvider,
  type NewTabLauncher,
  type WorkspaceTabLaunchDestination,
} from "@/workspace-tabs/launcher";
import type { TerminalTabDestination } from "@/screens/workspace/terminals/use-workspace-terminals";
import {
  buildBulkCloseConfirmationMessage,
  type BulkCloseConfirmationLabels,
  classifyBulkClosableTabs,
  closeBulkWorkspaceTabs,
  hasDestructiveBulkCloseTabs,
} from "@/screens/workspace/workspace-bulk-close";
import {
  CompactWorkspaceRebaseConflictAction,
  createGitGraphNavigationIntentStore,
  GitGraphNavigationIntentProvider,
  TopicHeaderBar,
  type GitGraphNavigationIntentStore,
} from "@/screens/workspace/topic-header";
import {
  selectWorkspaceTeamSummary,
  TeamDirectoryShellProvider,
  WorkspaceTeamDirectory,
  type TeamDirectoryMemberNode,
} from "@/subagents/team-directory";
import { useContainerWidthBelow } from "@/hooks/use-container-width";
import { PressHighlight } from "@/components/ui/press-highlight";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import type { AgentAddress } from "@getpaseo/protocol/addresses";
import type { WorkspaceDescriptorPayload } from "@getpaseo/protocol/messages";
import {
  discardSideChatIfEmpty,
  isSideChat,
  resolveCloseAgentTabPolicy,
} from "@/subagents/close-tab-policy";
import {
  getPanelInstanceAttributes,
  useModifiedPanelTabIds,
} from "@/panels/panel-instance-attributes";
import { findAdjacentPane } from "@/utils/split-navigation";
import { supportsDesktopPaneSplits, useIsCompactFormFactor } from "@/constants/layout";
import { getIsElectron, isNative, isWeb } from "@/constants/platform";
import { buildHostRootRoute, buildSettingsHostRoute } from "@/utils/host-routes";
import { useWorkspaceTerminals } from "@/screens/workspace/terminals/use-workspace-terminals";
import type { TerminalProfile } from "@getpaseo/protocol/messages";
import {
  WorkspaceHeaderMenuDesktop,
  WorkspaceHeaderMenuMobile,
} from "@/screens/workspace/workspace-header-menu";
import { PluginHeaderButtons } from "@/plugins";
import {
  createWorkspaceFileTabTarget,
  normalizeWorkspaceFileLocation,
  type OpenFileDisposition,
  type WorkspaceFileLocation,
  type WorkspaceFileOpenRequest,
} from "@/workspace/file-open";
import { RenderProfile } from "@/utils/render-profiler";
import { useWorkspaceCheckoutStatus } from "@/screens/workspace/use-workspace-checkout-status";
import { useWorkspacePullRequestDiscovery } from "@/panels/pull-request";

const NO_SHEETS: readonly SheetTab[] = [];
const WORKSPACE_FLOATING_PANEL_PORTAL_HOST_PREFIX = "workspace-floating-panels";
const EMPTY_UI_TABS: WorkspaceTab[] = [];
const EMPTY_WORKSPACE_SCRIPTS: WorkspaceDescriptor["scripts"] = [];
const EMPTY_PINNED_AGENT_IDS = new Set<string>();
const EMPTY_SET = new Set<string>();

function getWorkspaceSetupStatus(workspace: WorkspaceDescriptor | null | undefined) {
  return workspace?.setupStatus ?? null;
}

function getWorkspaceScripts(
  workspaceDescriptor: WorkspaceDescriptor | null | undefined,
): WorkspaceDescriptor["scripts"] {
  return workspaceDescriptor?.scripts ?? EMPTY_WORKSPACE_SCRIPTS;
}

interface WorkspaceFileLocationFields {
  path: string | null;
  lineStart?: number;
  lineEnd?: number;
}

function getWorkspaceFileLocationFields(
  tab: WorkspaceTabDescriptor | null,
): WorkspaceFileLocationFields {
  const target = tab?.target;
  if (target?.kind !== "file") {
    return { path: null };
  }
  return { path: target.path, lineStart: target.lineStart, lineEnd: target.lineEnd };
}

function buildWorkspaceFileLocation(
  fields: WorkspaceFileLocationFields,
): WorkspaceFileLocation | null {
  if (fields.path === null) {
    return null;
  }
  return { path: fields.path, lineStart: fields.lineStart, lineEnd: fields.lineEnd };
}

const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);

const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

interface WorkspaceScreenProps {
  serverId: string;
  workspaceId: string;
  isRouteFocused?: boolean;
}

type WorkspaceScreenContentProps = WorkspaceScreenProps & {
  isRouteFocused: boolean;
};

function trimNonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function useSyncWorkspaceActiveBrowser(input: {
  workspaceLayout: WorkspaceLayout | null;
  isRouteFocused: boolean;
  workspaceId: string;
}) {
  const focusedBrowserId = useMemo(
    () => getFocusedBrowserId(input.workspaceLayout),
    [input.workspaceLayout],
  );

  useEffect(() => {
    if (!getIsElectron()) {
      return;
    }
    void getDesktopHost()?.browser?.setWorkspaceActiveBrowser?.({
      workspaceId: input.workspaceId,
      browserId: focusedBrowserId,
    });
  }, [focusedBrowserId, input.workspaceId]);
}

function WorkspaceDocumentTitleEffect({
  label,
  titleState,
}: {
  label: string;
  titleState: "ready" | "loading";
}) {
  const { t } = useTranslation();
  useEffect(() => {
    if (isNative || typeof document === "undefined") {
      return;
    }
    const resolvedLabel = label.trim();
    document.title =
      titleState === "loading"
        ? t("workspace.tabs.loading")
        : resolvedLabel || t("workspace.tabs.fallback.workspace");
  }, [label, titleState, t]);

  return null;
}

interface MobileMountedTabSlotProps {
  tabDescriptor: WorkspaceTabDescriptor;
  isVisible: boolean;
  isWorkspaceFocused: boolean;
  isPaneFocused: boolean;
  paneId: string | null;
  onFocusPane: (paneId: string) => void;
  buildPaneContentModel: (input: {
    paneId: string | null;
    tab: WorkspaceTabDescriptor;
  }) => WorkspacePaneContentModel;
}

const MobileMountedTabSlot = memo(function MobileMountedTabSlot({
  tabDescriptor,
  isVisible,
  isWorkspaceFocused,
  isPaneFocused,
  paneId,
  onFocusPane,
  buildPaneContentModel,
}: MobileMountedTabSlotProps) {
  const content = useMemo(
    () =>
      buildPaneContentModel({
        paneId,
        tab: tabDescriptor,
      }),
    [buildPaneContentModel, paneId, tabDescriptor],
  );
  const handleTouch = useCallback(() => {
    if (paneId) onFocusPane(paneId);
    return false;
  }, [onFocusPane, paneId]);

  return (
    <RenderProfile id={`MobileMountedTabSlot:${tabDescriptor.kind}:${tabDescriptor.tabId}`}>
      <RetainedPanel active={isVisible} style={styles.mobileMountedTabSlot}>
        <View style={styles.mobileMountedTabSlot} onStartShouldSetResponderCapture={handleTouch}>
          <WorkspacePaneContent
            content={content}
            isWorkspaceFocused={isWorkspaceFocused}
            isPaneFocused={isPaneFocused}
          />
        </View>
      </RetainedPanel>
    </RenderProfile>
  );
});

function useStableTabDescriptorMap(tabDescriptors: WorkspaceTabDescriptor[]) {
  const cacheRef = useRef(new Map<string, WorkspaceTabDescriptor>());
  const tabDescriptorMap = useMemo(() => {
    const next = new Map<string, WorkspaceTabDescriptor>();
    for (const tabDescriptor of tabDescriptors) {
      const cachedDescriptor = cacheRef.current.get(tabDescriptor.tabId);
      if (
        cachedDescriptor &&
        cachedDescriptor.key === tabDescriptor.key &&
        cachedDescriptor.kind === tabDescriptor.kind &&
        cachedDescriptor.state === tabDescriptor.state &&
        workspaceTabTargetsEqual(cachedDescriptor.target, tabDescriptor.target)
      ) {
        next.set(tabDescriptor.tabId, cachedDescriptor);
        continue;
      }
      next.set(tabDescriptor.tabId, tabDescriptor);
    }
    return next;
  }, [tabDescriptors]);
  useEffect(() => {
    cacheRef.current = tabDescriptorMap;
  }, [tabDescriptorMap]);

  return tabDescriptorMap;
}

export const WorkspaceScreen = memo(function WorkspaceScreen({
  serverId,
  workspaceId,
  isRouteFocused,
}: WorkspaceScreenProps) {
  // Every reader of the panel registry renders inside the workspace screen, so it registers the
  // panels before any of them renders. A reader importing the registration instead would import
  // every panel, and the panels render readers.
  ensurePanelsRegistered();
  const navigationFocused = useIsFocused();
  useEffect(() => {
    traceInstant("paseo.workspace.mount", { serverId, workspaceId });
    return () => {
      traceInstant("paseo.workspace.unmount", { serverId, workspaceId });
    };
  }, [serverId, workspaceId]);
  return (
    <WorkspaceScreenContent
      serverId={serverId}
      workspaceId={workspaceId}
      isRouteFocused={isRouteFocused ?? navigationFocused}
    />
  );
});

interface UseCloseTabsResult {
  closingTabIds: Set<string>;
  closeTab: (tabId: string, action: () => Promise<void>) => Promise<void>;
}

function useCloseTabs(): UseCloseTabsResult {
  const pendingRef = useRef(new Set<string>());
  const [closingTabIds, setClosingTabIds] = useState<Set<string>>(EMPTY_SET);

  const closeTab = useCallback(async (tabId: string, action: () => Promise<void>) => {
    const normalized = tabId.trim();
    if (!normalized || pendingRef.current.has(normalized)) {
      return;
    }
    pendingRef.current.add(normalized);
    setClosingTabIds(new Set(pendingRef.current));
    try {
      await action();
    } finally {
      pendingRef.current.delete(normalized);
      setClosingTabIds(new Set(pendingRef.current));
    }
  }, []);

  return { closingTabIds, closeTab };
}

interface WorkspaceHeaderTitleBarProps {
  isLoading: boolean;
  title: string;
  subtitle: string;
  isSubtitleDistinct: boolean;
  currentBranchName: string | null;
  normalizedServerId: string;
  showWorkspaceSetup: boolean;
  importAgentDisabled: boolean;
  copyPathDisabled: boolean;
  onOpenImportSheet: () => void;
  onCopyWorkspacePath: () => void;
  onCopyBranchName: () => void;
  onOpenSetupTab: () => void;
  onUpgradeToTopic?: () => void;
}

function WorkspaceHeaderTitleBar({
  isLoading,
  title,
  subtitle,
  isSubtitleDistinct,
  currentBranchName,
  normalizedServerId,
  showWorkspaceSetup,
  importAgentDisabled,
  copyPathDisabled,
  onOpenImportSheet,
  onCopyWorkspacePath,
  onCopyBranchName,
  onOpenSetupTab,
  onUpgradeToTopic,
}: WorkspaceHeaderTitleBarProps) {
  const actionsInBar = resolveWorkspaceActionPlacement(useWindowLayout()) === "vertical-bar";
  return (
    <View style={styles.headerTitleContainer}>
      {isLoading ? (
        <View style={styles.headerTitleTextGroup}>
          <View style={styles.headerTitleSkeleton} />
        </View>
      ) : (
        <View style={styles.headerTitleTextGroup}>
          <ScreenTitle testID="workspace-header-title">{title}</ScreenTitle>
          <WorkspaceHeaderProjectRow
            subtitle={subtitle}
            isSubtitleDistinct={isSubtitleDistinct}
            serverId={normalizedServerId}
          />
        </View>
      )}
      {actionsInBar ? null : (
        <View style={styles.compactHeaderMenuCluster}>
          <WorkspaceHeaderMenuDesktop
            currentBranchName={currentBranchName}
            showWorkspaceSetup={showWorkspaceSetup}
            importAgentDisabled={importAgentDisabled}
            copyPathDisabled={copyPathDisabled}
            onOpenImportSheet={onOpenImportSheet}
            onCopyWorkspacePath={onCopyWorkspacePath}
            onCopyBranchName={onCopyBranchName}
            onOpenSetupTab={onOpenSetupTab}
            onUpgradeToTopic={onUpgradeToTopic}
          />
        </View>
      )}
    </View>
  );
}

type PaneDirection = "left" | "right" | "up" | "down";

function parsePaneDirection(actionId: string): PaneDirection | null {
  const direction = actionId.split(".").pop();
  if (direction === "left" || direction === "right" || direction === "up" || direction === "down") {
    return direction;
  }
  return null;
}

function resolveAgentTabCloseKind(
  agent: Parameters<typeof resolveCloseAgentTabPolicy>[0] | undefined,
  isTopicWorkspace: boolean,
) {
  if (agent) return resolveCloseAgentTabPolicy(agent, { isTopicWorkspace }).kind;
  return isTopicWorkspace ? "layout-only" : null;
}

function useWorkspaceTeamDirectoryState(input: {
  serverId: string;
  workspaceId: string;
  client: ReturnType<typeof useHostRuntimeClient>;
  isRouteFocused: boolean;
  isConnected: boolean;
  isMobile: boolean;
  mainAgentId: string | null;
  desktopFocusModeEnabled: boolean;
}) {
  const { workspace: topicWorkspace } = useTopicWorkspace({
    serverId: input.serverId,
    workspaceId: input.workspaceId,
    client: input.client,
    enabled: input.isRouteFocused && input.isConnected && Boolean(input.workspaceId),
  });
  const isTopicWorkspace = Boolean(topicWorkspace?.topic);
  const { isBelow: isNarrowDesktopCenter, onLayout: onCenterColumnLayout } = useContainerWidthBelow(
    780,
    { initialIsBelow: false },
  );
  const [wideTeamDirectoryOpen, setWideTeamDirectoryOpen] = useState(true);
  const [overlayTeamDirectoryOpen, setOverlayTeamDirectoryOpen] = useState(false);
  const hasShellTeamWorkbench = !input.isMobile && (isTopicWorkspace || Boolean(input.mainAgentId));
  const isTeamDirectoryOverlay = isNarrowDesktopCenter;
  const isTeamDirectoryVisible =
    hasShellTeamWorkbench &&
    !input.desktopFocusModeEnabled &&
    (isTeamDirectoryOverlay ? overlayTeamDirectoryOpen : wideTeamDirectoryOpen);
  const toggleTeamDirectory = useCallback(() => {
    if (isTeamDirectoryOverlay) {
      setOverlayTeamDirectoryOpen((current) => !current);
    } else {
      setWideTeamDirectoryOpen((current) => !current);
    }
  }, [isTeamDirectoryOverlay]);
  const hideTeamDirectory = useCallback(() => {
    if (isTeamDirectoryOverlay) {
      setOverlayTeamDirectoryOpen(false);
    } else {
      setWideTeamDirectoryOpen(false);
    }
  }, [isTeamDirectoryOverlay]);
  const showTeamDirectory = useCallback(() => {
    if (isTeamDirectoryOverlay) {
      setOverlayTeamDirectoryOpen(true);
    } else {
      setWideTeamDirectoryOpen(true);
    }
  }, [isTeamDirectoryOverlay]);
  const teamDirectoryShellValue = useMemo(
    () => ({
      isOwnedByWorkspaceShell: hasShellTeamWorkbench,
      isDirectoryVisible: isTeamDirectoryVisible,
      toggleDirectory: toggleTeamDirectory,
    }),
    [hasShellTeamWorkbench, isTeamDirectoryVisible, toggleTeamDirectory],
  );
  const serverAgentsMap = useSessionStore((state) => state.sessions[input.serverId]?.agents);
  const teamSummary = useMemo(
    () =>
      selectWorkspaceTeamSummary({
        serverId: input.serverId,
        workspaceId: input.workspaceId,
        mainAgentId: input.mainAgentId,
        agents: serverAgentsMap,
      }),
    [input.mainAgentId, input.serverId, input.workspaceId, serverAgentsMap],
  );

  return {
    topicWorkspace,
    isTopicWorkspace,
    onCenterColumnLayout,
    hasShellTeamWorkbench,
    isTeamDirectoryOverlay,
    isTeamDirectoryVisible,
    toggleTeamDirectory,
    hideTeamDirectory,
    showTeamDirectory,
    teamDirectoryShellValue,
    teamSummary,
  };
}

function useWorkspaceTeamDirectoryActions(input: {
  serverId: string;
  workspaceId: string;
  persistenceKey: string | null;
  lastMainPaneId: string | null;
  isTeamDirectoryOverlay: boolean;
  hideTeamDirectory: () => void;
  showTeamDirectory: () => void;
  openInSidePane: Parameters<typeof openPreferredWorkspaceTarget>[0]["preferences"];
  gitGraphIntentStore: GitGraphNavigationIntentStore;
  openWorkspaceTabFocused: (
    workspaceKey: string,
    target: WorkspaceTabTarget,
    placement?: WorkspaceTabPlacement,
  ) => void;
}) {
  const {
    serverId,
    workspaceId,
    persistenceKey,
    lastMainPaneId,
    isTeamDirectoryOverlay,
    hideTeamDirectory,
    showTeamDirectory,
    openInSidePane,
    gitGraphIntentStore,
    openWorkspaceTabFocused,
  } = input;
  const handleOpenGitGraph = useCallback(
    (conflictRepoRoot?: string | null) => {
      if (!persistenceKey) return;
      const layout = useWorkspaceLayoutStore.getState();
      const existing = layout
        .getWorkspaceTabs(persistenceKey)
        .find((tab) => tab.target.kind === "git_graph");
      let targetTabId: string | null = null;
      if (existing) {
        revealWorkspaceTab(persistenceKey, existing.tabId);
        targetTabId = existing.tabId;
      } else {
        openWorkspaceTabFocused(
          persistenceKey,
          { kind: "git_graph" },
          lastMainPaneId ? { mode: "pane", paneId: lastMainPaneId } : FOCUSED_PANE_PLACEMENT,
        );
        targetTabId =
          useWorkspaceLayoutStore
            .getState()
            .getWorkspaceTabs(persistenceKey)
            .find((tab) => tab.target.kind === "git_graph")?.tabId ?? null;
      }
      if (conflictRepoRoot && targetTabId) {
        gitGraphIntentStore.submitConflictIntent({
          tabId: targetTabId,
          repoRoot: conflictRepoRoot,
        });
      }
    },
    [gitGraphIntentStore, lastMainPaneId, openWorkspaceTabFocused, persistenceKey],
  );

  const handleFocusAttentionAgent = useCallback(
    (agentId: string | null) => {
      if (agentId && persistenceKey) {
        openWorkspaceTabFocused(
          persistenceKey,
          { kind: "agent", agentId },
          lastMainPaneId ? { mode: "pane", paneId: lastMainPaneId } : FOCUSED_PANE_PLACEMENT,
        );
        return;
      }
      showTeamDirectory();
    },
    [lastMainPaneId, openWorkspaceTabFocused, persistenceKey, showTeamDirectory],
  );

  const handleOpenDirectoryAgent = useCallback(
    (node: TeamDirectoryMemberNode) => {
      if (isTeamDirectoryOverlay) hideTeamDirectory();
      if (node.isArchived) {
        navigateToAgent({
          serverId: node.serverId,
          workspaceId: node.serverId === serverId ? workspaceId : undefined,
          agentId: node.agentId,
          pin: true,
          asTab: true,
        });
        return;
      }
      const liveAgent = useSessionStore
        .getState()
        .sessions[node.serverId]?.agents.get(node.agentId);
      if (
        node.serverId !== serverId ||
        (liveAgent?.workspaceId && liveAgent.workspaceId !== workspaceId)
      ) {
        navigateToAgent({ serverId: node.serverId, agentId: node.agentId, asTab: true });
        return;
      }
      if (!persistenceKey) return;
      openWorkspaceTabFocused(
        persistenceKey,
        { kind: "agent", agentId: node.agentId },
        lastMainPaneId ? { mode: "pane", paneId: lastMainPaneId } : FOCUSED_PANE_PLACEMENT,
      );
    },
    [
      hideTeamDirectory,
      isTeamDirectoryOverlay,
      lastMainPaneId,
      openWorkspaceTabFocused,
      persistenceKey,
      serverId,
      workspaceId,
    ],
  );

  const handleOpenDirectoryAgentBeside = useCallback(
    (address: AgentAddress) => {
      if (isTeamDirectoryOverlay) hideTeamDirectory();
      if (address.serverId === serverId && persistenceKey) {
        openWorkspaceTargetBeside({
          workspaceKey: persistenceKey,
          target: { kind: "agent", agentId: address.agentId },
        });
        return;
      }
      navigateToAgent({ serverId: address.serverId, agentId: address.agentId, asTab: true });
    },
    [hideTeamDirectory, isTeamDirectoryOverlay, persistenceKey, serverId],
  );

  const handleOpenProviderSubrun = useCallback(
    (parentAgentId: string, subagentId: string) => {
      if (isTeamDirectoryOverlay) hideTeamDirectory();
      if (!persistenceKey) return;
      openPreferredWorkspaceTarget({
        workspaceKey: persistenceKey,
        target: { kind: "provider_subagent", parentAgentId, subagentId },
        source: "subagents",
        preferences: openInSidePane,
      });
    },
    [hideTeamDirectory, isTeamDirectoryOverlay, openInSidePane, persistenceKey],
  );

  return {
    handleOpenGitGraph,
    handleFocusAttentionAgent,
    handleOpenDirectoryAgent,
    handleOpenDirectoryAgentBeside,
    handleOpenProviderSubrun,
  };
}

function useWorkspaceTopicUpgrade({
  client,
  isConnected,
  isRouteFocused,
  serverId,
  workspaceId,
  cachedWorkspace,
  hostWorkspace,
  supportsTopic,
}: Parameters<typeof canOfferTopicUpgrade>[0] & {
  client: ReturnType<typeof useHostRuntimeClient>;
  isRouteFocused: boolean;
  serverId: string;
  workspaceId: string;
}) {
  const queryClient = useQueryClient();
  const scopeKey = JSON.stringify([serverId, workspaceId]);
  const [openScope, setOpenScope] = useState<string | null>(null);
  const open = useCallback(() => setOpenScope(scopeKey), [scopeKey]);
  const close = useCallback(() => {
    setOpenScope((current) => (current === scopeKey ? null : current));
  }, [scopeKey]);
  const onUpgraded = useCallback(() => {
    close();
    void queryClient.invalidateQueries({
      queryKey: ["topic-empty-workspace", serverId, workspaceId],
      exact: true,
    });
  }, [close, queryClient, serverId, workspaceId]);
  useEffect(() => {
    setOpenScope((current) => (isRouteFocused && current === scopeKey ? current : null));
  }, [isRouteFocused, scopeKey]);
  const canOpen = canOfferTopicUpgrade({
    cachedWorkspace,
    hostWorkspace,
    isConnected,
    supportsTopic,
  });
  return {
    onUpgradeToTopic: canOpen && client && isRouteFocused ? open : undefined,
    dialog:
      isRouteFocused && openScope === scopeKey ? (
        <WorkspaceTopicUpgradeDialog
          key={scopeKey}
          client={isConnected ? client : null}
          workspaceId={workspaceId}
          onClose={close}
          onUpgraded={onUpgraded}
        />
      ) : null,
  };
}

function WorkspaceTopicHeaderSlot({
  enabled,
  topicWorkspace,
  ...props
}: Omit<Parameters<typeof TopicHeaderBar>[0], "topic"> & {
  enabled: boolean;
  topicWorkspace: WorkspaceDescriptorPayload | null | undefined;
}) {
  if (!enabled) return null;
  return <TopicHeaderBar {...props} topic={topicWorkspace?.topic} />;
}

function WorkspaceShellProviders({
  persistenceKey,
  sheetPaneHost,
  mainTabContext,
  teamDirectoryShellValue,
  gitGraphIntentStore,
  workspaceDescriptor,
  client,
  serverId,
  workspaceDirectory,
  openMarkdownPath,
  toast,
  children,
}: {
  persistenceKey: string | null;
  sheetPaneHost: Parameters<typeof WorkspaceContentProviders>[0]["sheetPaneHost"];
  mainTabContext: Parameters<typeof WorkspaceContentProviders>[0]["mainTab"];
  teamDirectoryShellValue: Parameters<typeof TeamDirectoryShellProvider>[0]["value"];
  gitGraphIntentStore: GitGraphNavigationIntentStore;
  workspaceDescriptor: WorkspaceDescriptor | null;
  client: ReturnType<typeof useHostRuntimeClient>;
  serverId: string;
  workspaceDirectory: string | null;
  openMarkdownPath: Parameters<typeof WorkspaceMarkdownLinks>[0]["onOpenWorkspaceFile"];
  toast: Parameters<typeof WorkspaceMarkdownLinks>[0]["toast"];
  children: ReactNode;
}) {
  return (
    <WorkspaceContentProviders
      key={persistenceKey}
      workspaceKey={persistenceKey}
      sheetPaneHost={sheetPaneHost}
      mainTab={mainTabContext}
    >
      <TeamDirectoryShellProvider value={teamDirectoryShellValue}>
        <GitGraphNavigationIntentProvider store={gitGraphIntentStore}>
          <WorkspaceMarkdownLinks
            workspace={workspaceDescriptor}
            client={client}
            serverId={serverId}
            workspaceRoot={workspaceDirectory ?? undefined}
            onOpenWorkspaceFile={openMarkdownPath}
            toast={toast}
          >
            {children}
          </WorkspaceMarkdownLinks>
        </GitGraphNavigationIntentProvider>
      </TeamDirectoryShellProvider>
    </WorkspaceContentProviders>
  );
}

function WorkspaceDesktopBody({
  isTeamDirectoryVisible,
  isTeamDirectoryOverlay,
  hideLabel,
  serverId,
  workspaceId,
  mainAgentId,
  isTopicWorkspace,
  focusedAgentId,
  focusedProviderSubagentId,
  onHideDirectory,
  onOpenAgent,
  onOpenAgentBeside,
  onOpenProviderSubrun,
  onAskFirstQuestion,
  topicEmptyContent,
  desktopContent,
}: {
  isTeamDirectoryVisible: boolean;
  isTeamDirectoryOverlay: boolean;
  hideLabel: string;
  serverId: string;
  workspaceId: string;
  mainAgentId: string | null;
  isTopicWorkspace: boolean;
  focusedAgentId: string | null;
  focusedProviderSubagentId: string | null;
  onHideDirectory: () => void;
  onOpenAgent: (node: TeamDirectoryMemberNode) => void;
  onOpenAgentBeside: (address: AgentAddress) => void;
  onOpenProviderSubrun: (parentAgentId: string, subagentId: string) => void;
  onAskFirstQuestion?: () => void;
  topicEmptyContent: ReactNode;
  desktopContent: ReactNode;
}) {
  return (
    <View style={styles.workspaceBodyRow}>
      {isTeamDirectoryVisible && isTeamDirectoryOverlay ? (
        <PressHighlight
          style={styles.teamDirectoryOverlayBackdrop}
          accessibilityRole="button"
          accessibilityLabel={hideLabel}
          onPress={onHideDirectory}
        />
      ) : null}
      {isTeamDirectoryVisible ? (
        <WorkspaceTeamDirectory
          serverId={serverId}
          workspaceId={workspaceId}
          mainAgentId={mainAgentId}
          isTopicWorkspace={isTopicWorkspace}
          focusedAgentId={focusedAgentId}
          focusedProviderSubagentId={focusedProviderSubagentId}
          overlay={isTeamDirectoryOverlay}
          onHide={onHideDirectory}
          onOpenAgent={onOpenAgent}
          onOpenAgentBeside={onOpenAgentBeside}
          onOpenProviderSubrun={onOpenProviderSubrun}
          onAskFirstQuestion={isTopicWorkspace ? onAskFirstQuestion : undefined}
        />
      ) : null}
      <View style={styles.workspaceMainArea}>
        <TopicEmptyContentContext value={topicEmptyContent}>
          {desktopContent}
        </TopicEmptyContentContext>
      </View>
    </View>
  );
}

function CompactWorkspaceTeamDirectory({
  close,
  onOpenAgent,
  onOpenAgentBeside,
  onOpenProviderSubrun,
  onAskFirstQuestion,
  ...directory
}: Omit<Parameters<typeof WorkspaceTeamDirectory>[0], "inSheet" | "onHide" | "overlay"> & {
  close: () => void;
}) {
  const openAgent = useCallback(
    (node: TeamDirectoryMemberNode) => {
      close();
      onOpenAgent(node);
    },
    [close, onOpenAgent],
  );
  const openAgentBeside = useCallback(
    (address: AgentAddress) => {
      close();
      onOpenAgentBeside(address);
    },
    [close, onOpenAgentBeside],
  );
  const openProviderSubrun = useCallback(
    (parentAgentId: string, subagentId: string) => {
      close();
      onOpenProviderSubrun(parentAgentId, subagentId);
    },
    [close, onOpenProviderSubrun],
  );
  const askFirstQuestion = useCallback(() => {
    close();
    onAskFirstQuestion?.();
  }, [close, onAskFirstQuestion]);
  return (
    <WorkspaceTeamDirectory
      {...directory}
      inSheet
      onHide={close}
      onOpenAgent={openAgent}
      onOpenAgentBeside={openAgentBeside}
      onOpenProviderSubrun={openProviderSubrun}
      onAskFirstQuestion={onAskFirstQuestion ? askFirstQuestion : undefined}
    />
  );
}

const TopicEmptyContentContext = createContext<ReactNode>(null);

function TopicEmptyTabContent() {
  return useContext(TopicEmptyContentContext);
}

function useUnboundTopicContent(input: {
  topicWorkspace: WorkspaceDescriptorPayload | null | undefined;
  canOpenDraft: boolean;
  hasHydratedLayout: boolean;
  hasHydratedAgents: boolean;
  mainAgentId: string | null;
  descriptor: WorkspaceDescriptor | null;
  layout: WorkspaceLayout | null;
  explorerPaneId: string | null;
  tabs: WorkspaceTab[];
  onAsk: () => void;
}) {
  const { layout, explorerPaneId, tabs, onAsk } = input;
  const mainTabs = useMemo(() => {
    const explorerTabIds =
      layout && explorerPaneId ? findPaneById(layout.root, explorerPaneId)?.tabIds : undefined;
    return explorerTabIds?.length
      ? tabs.filter((tab) => !explorerTabIds.includes(tab.tabId))
      : tabs;
  }, [explorerPaneId, layout, tabs]);
  const hasActiveMainAgent = input.descriptor?.hasActiveMainAgent;
  const canShow =
    input.canOpenDraft &&
    Boolean(input.descriptor?.workspaceDirectory) &&
    input.hasHydratedLayout &&
    input.hasHydratedAgents &&
    !input.mainAgentId &&
    hasActiveMainAgent !== true &&
    mainTabs.every((tab) => tab.target.kind === "new_tab");
  const topic = canShow ? getUnboundTopicWorkspace(input.topicWorkspace, hasActiveMainAgent) : null;
  const content = useMemo(
    () => (topic ? <TopicEmptyState workspace={topic} onAsk={onAsk} /> : null),
    [onAsk, topic],
  );
  return {
    content,
    placeholderTabId: content ? mainTabs[0]?.tabId : undefined,
    withoutTab: content !== null && mainTabs.length === 0,
  };
}

interface RenderWorkspaceContentInput {
  topicEmptyContent: ReactNode;
  topicPlaceholderTabId: string | undefined;
  isMissingWorkspaceDirectory: boolean;
  activeTabDescriptor: WorkspaceTabDescriptor | null;
  hasHydratedAgents: boolean;
  hasLoadedTerminals: boolean;
  mountedFocusedPaneTabIds: string[];
  focusedPaneTabDescriptorMap: Map<string, WorkspaceTabDescriptor>;
  isRouteFocused: boolean;
  focusedPaneId: string | null;
  paneFocusSuspended: boolean;
  onFocusPane: (paneId: string) => void;
  buildMobilePaneContentModel: (input: {
    paneId: string | null;
    tab: WorkspaceTabDescriptor;
  }) => WorkspacePaneContentModel;
}

function renderWorkspaceContent(input: RenderWorkspaceContentInput): React.ReactNode {
  const {
    topicEmptyContent,
    topicPlaceholderTabId,
    isMissingWorkspaceDirectory,
    activeTabDescriptor,
    hasHydratedAgents,
    hasLoadedTerminals,
    mountedFocusedPaneTabIds,
    focusedPaneTabDescriptorMap,
    isRouteFocused,
    focusedPaneId,
    paneFocusSuspended,
    onFocusPane,
    buildMobilePaneContentModel,
  } = input;

  if (isMissingWorkspaceDirectory) {
    return (
      <View style={styles.emptyState}>
        <Text style={styles.emptyStateText}>
          Workspace directory is missing. Reload workspace data before opening tabs.
        </Text>
      </View>
    );
  }
  if (
    topicEmptyContent &&
    (!activeTabDescriptor || activeTabDescriptor.tabId === topicPlaceholderTabId)
  ) {
    return topicEmptyContent;
  }
  if (!activeTabDescriptor && (!hasHydratedAgents || !hasLoadedTerminals)) {
    return (
      <View style={styles.emptyState}>
        <ThemedLoadingSpinner uniProps={mutedColorMapping} />
      </View>
    );
  }
  if (!activeTabDescriptor) {
    return (
      <View style={styles.emptyState}>
        <Text style={styles.emptyStateText}>
          No tabs are available yet. Use New tab to create an agent or terminal.
        </Text>
      </View>
    );
  }
  return mountedFocusedPaneTabIds.map((tabId) => {
    const tabDescriptor = focusedPaneTabDescriptorMap.get(tabId);
    if (!tabDescriptor) {
      return null;
    }
    return (
      <MobileMountedTabSlot
        key={tabId}
        tabDescriptor={tabDescriptor}
        isVisible={isRouteFocused && tabId === activeTabDescriptor.tabId}
        isWorkspaceFocused={isRouteFocused}
        isPaneFocused={!paneFocusSuspended && tabId === activeTabDescriptor.tabId}
        paneId={focusedPaneId}
        onFocusPane={onFocusPane}
        buildPaneContentModel={buildMobilePaneContentModel}
      />
    );
  });
}

interface WorkspaceHeaderFields {
  isWorkspaceHeaderLoading: boolean;
  workspaceHeaderTitle: string;
  workspaceHeaderSubtitle: string;
  isWorkspaceHeaderSubtitleDistinct: boolean;
  isGitCheckout: boolean;
  currentBranchName: string | null;
}

function buildWorkspaceHeaderCheckoutState(input: {
  isCheckoutStatusLoading: boolean;
  isError: boolean;
  data: CheckoutStatusPayload | undefined;
}): WorkspaceHeaderCheckoutState {
  if (input.isCheckoutStatusLoading) {
    return { kind: "pending" };
  }
  if (input.isError || !input.data) {
    return { kind: "error" };
  }
  return {
    kind: "ready",
    checkout: {
      isGit: input.data.isGit,
      currentBranch: input.data.currentBranch,
    },
  };
}

function deriveWorkspaceHeaderFields(input: {
  workspace: WorkspaceDescriptor | null;
  checkoutState: WorkspaceHeaderCheckoutState;
}): WorkspaceHeaderFields {
  const renderState = resolveWorkspaceHeaderRenderState(input);
  if (renderState.kind !== "ready") {
    return {
      isWorkspaceHeaderLoading: true,
      workspaceHeaderTitle: "",
      workspaceHeaderSubtitle: "",
      isWorkspaceHeaderSubtitleDistinct: false,
      isGitCheckout: false,
      currentBranchName: null,
    };
  }
  return {
    isWorkspaceHeaderLoading: false,
    workspaceHeaderTitle: renderState.title,
    workspaceHeaderSubtitle: renderState.subtitle,
    isWorkspaceHeaderSubtitleDistinct: renderState.isSubtitleDistinct,
    isGitCheckout: renderState.isGitCheckout,
    currentBranchName: renderState.currentBranchName,
  };
}

function getHostDisplayName(host: { label?: string | null } | null, fallback: string): string {
  const trimmed = host?.label?.trim();
  return trimmed ? trimmed : fallback;
}

function useWorkspaceRouteActions(normalizedServerId: string): {
  handleRetryHost: () => void;
  handleManageHost: () => void;
  handleDismissMissingWorkspace: () => void;
} {
  const router = useRouter();
  const handleRetryHost = useCallback(() => {
    if (!normalizedServerId) {
      return;
    }
    void getHostRuntimeStore().runProbeCycleNow(normalizedServerId);
  }, [normalizedServerId]);
  const handleManageHost = useCallback(() => {
    if (!normalizedServerId) {
      return;
    }
    router.push(buildSettingsHostRoute(normalizedServerId) as Href);
  }, [normalizedServerId, router]);
  const handleDismissMissingWorkspace = useCallback(() => {
    if (router.canGoBack()) {
      router.back();
      return;
    }
    if (normalizedServerId) {
      router.replace(buildHostRootRoute(normalizedServerId) as Href);
      return;
    }
    router.replace("/" as Href);
  }, [normalizedServerId, router]);

  return {
    handleRetryHost,
    handleManageHost,
    handleDismissMissingWorkspace,
  };
}

function useResolvedWorkspaceRouteState(input: {
  serverId: string;
  workspace: WorkspaceDescriptor | null;
  hasHydratedWorkspaces: boolean;
  recovery: WorkspaceRecoveryModel;
}): WorkspaceRouteState {
  const hosts = useHosts();
  const host = useMemo(
    () => hosts.find((entry) => entry.serverId === input.serverId) ?? null,
    [hosts, input.serverId],
  );
  const hostSnapshot = useHostRuntimeSnapshot(input.serverId);
  const hostName = useMemo(() => getHostDisplayName(host, input.serverId), [host, input.serverId]);
  return useMemo(
    () =>
      resolveWorkspaceRouteState({
        hostName,
        connectionStatus: hostSnapshot?.connectionStatus ?? "connecting",
        lastError: hostSnapshot?.lastError ?? null,
        workspace: input.workspace,
        hasHydratedWorkspaces: input.hasHydratedWorkspaces,
        recovery: input.recovery,
      }),
    [
      hostName,
      hostSnapshot?.connectionStatus,
      hostSnapshot?.lastError,
      input.workspace,
      input.hasHydratedWorkspaces,
      input.recovery,
    ],
  );
}

function shouldInspectWorkspaceRecovery(
  hasHydratedWorkspaces: boolean,
  workspace: WorkspaceDescriptor | null,
  pendingOpenTarget: WorkspaceTabTarget | null,
): boolean {
  return pendingOpenTarget?.kind === "agent" && hasHydratedWorkspaces && workspace === null;
}

function WorkspaceScreenGateFrame({ children }: { children: ReactNode }) {
  return (
    <>
      <MenuHeader />
      <View style={styles.centerContent}>{children}</View>
    </>
  );
}

function WorkspaceContentProviders({
  children,
  workspaceKey,
  sheetPaneHost,
  mainTab,
}: {
  children: ReactNode;
  workspaceKey: string | null;
  sheetPaneHost: SheetPaneHost | null;
  mainTab: ContextType<typeof WorkspaceMainTabContext>;
}) {
  return (
    <WorkspaceFocusProvider workspaceKey={workspaceKey}>
      <DiffDocumentWorkspaceCacheProvider>
        <SheetPaneHostProvider value={sheetPaneHost}>
          <WorkspaceMainTabContext.Provider value={mainTab}>
            <ResidentDialogProvider>{children}</ResidentDialogProvider>
          </WorkspaceMainTabContext.Provider>
        </SheetPaneHostProvider>
      </DiffDocumentWorkspaceCacheProvider>
    </WorkspaceFocusProvider>
  );
}

function WorkspacePanelSurface({
  launcher,
  children,
  tabIds,
  workspaceKey,
}: {
  workspaceKey: string;
  launcher: NewTabLauncher;
  children: ReactNode;
  tabIds: readonly string[];
}) {
  const isCompact = useIsCompactFormFactor();
  return (
    <WorkspaceComposerEditingSessionsProvider workspaceKey={workspaceKey} tabIds={tabIds}>
      <NewTabLauncherProvider value={launcher}>
        <SheetHostScope enabled={!isCompact}>
          <View style={styles.threePaneRow}>{children}</View>
        </SheetHostScope>
      </NewTabLauncherProvider>
    </WorkspaceComposerEditingSessionsProvider>
  );
}

function renderWorkspaceScreenGateShell(input: {
  gate: ReactNode;
  workspaceKey: string | null;
}): ReactElement | null {
  if (!input.gate) {
    return null;
  }

  return (
    <WorkspaceFocusProvider workspaceKey={input.workspaceKey}>
      <View style={styles.container}>
        <View style={styles.threePaneRow}>
          <View style={styles.centerColumn}>
            <WorkspaceScreenGateFrame>{input.gate}</WorkspaceScreenGateFrame>
          </View>
        </View>
      </View>
    </WorkspaceFocusProvider>
  );
}

function WorkspaceDocumentTitleEffectSlot({
  tab,
  serverId,
  workspaceId,
  isRouteFocused,
}: {
  tab: WorkspaceTabDescriptor | null;
  serverId: string;
  workspaceId: string;
  isRouteFocused: boolean;
}) {
  if (!isRouteFocused || !isWeb || !tab) {
    return null;
  }

  return (
    <WorkspaceTabPresentationResolver tab={tab} serverId={serverId} workspaceId={workspaceId}>
      {(presentation) => (
        <WorkspaceDocumentTitleEffect
          label={presentation.label}
          titleState={presentation.titleState}
        />
      )}
    </WorkspaceTabPresentationResolver>
  );
}

/**
 * The header floats over a conversation's timeline. A draft and the agent it creates share one
 * timeline, so their surfaces match and the timeline does not move when the tab retargets.
 */
function floatsHeaderOverContent(activeTab: WorkspaceTabDescriptor | null): boolean {
  return supportsStreamTopOverlay && (activeTab?.kind === "agent" || activeTab?.kind === "draft");
}

/** A fullscreen composer covers the compact header; the column lays out without it. */
function resolveCompactHeaderLayout(input: {
  header: ReactNode;
  activeTab: WorkspaceTabDescriptor | null;
  composerFullscreen: boolean;
}): { header: ReactNode; floating: boolean } {
  if (input.composerFullscreen) return { header: null, floating: false };
  return { header: input.header, floating: floatsHeaderOverContent(input.activeTab) };
}

function shouldShowWorkspaceScreenHeader(input: {
  isFocusModeEnabled: boolean;
  isMobile: boolean;
}): boolean {
  return !input.isFocusModeEnabled || input.isMobile;
}

/**
 * A pane the user acted inside owns the tab: it opens there, and an existing tab
 * moves there. No pane means the open has no opinion beyond the focused pane.
 */
function paneLocalPlacement(paneId: string | null | undefined): WorkspaceTabPlacement {
  return paneId ? { mode: "pane", paneId } : FOCUSED_PANE_PLACEMENT;
}

interface WorkspaceTerminalTabActionsInput {
  persistenceKey: string | null;
  openWorkspaceTabFocused: (
    workspaceKey: string,
    target: WorkspaceTabTarget,
    placement?: WorkspaceTabPlacement,
  ) => string | null;
  replaceWorkspaceTabTarget: (
    workspaceKey: string,
    tabId: string,
    target: WorkspaceTabTarget,
  ) => string | null;
  labels: {
    workspacePathUnavailable: string;
    terminalQueued: string;
  };
  toast: {
    error: (message: string) => void;
    show: (message: string) => void;
  };
}

interface WorkspaceTerminalTabActions {
  handleTerminalCreated: (input: {
    terminalId: string;
    destination: TerminalTabDestination;
  }) => void;
  handleScriptTerminalSelected: (terminalId: string) => void;
  handleWorkspacePathUnavailable: () => void;
  handleTerminalCreateQueued: () => void;
  handleTerminalCreateFailed: (reason: string) => void;
}

function useWorkspaceTerminalTabActions({
  persistenceKey,
  openWorkspaceTabFocused,
  replaceWorkspaceTabTarget,
  labels,
  toast,
}: WorkspaceTerminalTabActionsInput): WorkspaceTerminalTabActions {
  const handleTerminalCreated = useCallback(
    ({ terminalId, destination }: { terminalId: string; destination: TerminalTabDestination }) => {
      if (!persistenceKey) {
        return;
      }
      if (destination.kind === "replace") {
        replaceWorkspaceTabTarget(persistenceKey, destination.tabId, {
          kind: "terminal",
          terminalId,
        });
        return;
      }
      openWorkspaceTabFocused(
        persistenceKey,
        { kind: "terminal", terminalId },
        paneLocalPlacement(destination.paneId),
      );
    },
    [openWorkspaceTabFocused, persistenceKey, replaceWorkspaceTabTarget],
  );
  const handleScriptTerminalSelected = useCallback(
    (terminalId: string) => {
      if (!persistenceKey) {
        return;
      }
      openWorkspaceTabFocused(
        persistenceKey,
        { kind: "terminal", terminalId },
        FOCUSED_PANE_PLACEMENT,
      );
    },
    [openWorkspaceTabFocused, persistenceKey],
  );
  const handleWorkspacePathUnavailable = useCallback(() => {
    toast.error(labels.workspacePathUnavailable);
  }, [labels.workspacePathUnavailable, toast]);
  const handleTerminalCreateQueued = useCallback(() => {
    toast.show(labels.terminalQueued);
  }, [labels.terminalQueued, toast]);
  const handleTerminalCreateFailed = useCallback(
    (reason: string) => {
      toast.error(reason);
    },
    [toast],
  );

  return {
    handleTerminalCreated,
    handleScriptTerminalSelected,
    handleWorkspacePathUnavailable,
    handleTerminalCreateQueued,
    handleTerminalCreateFailed,
  };
}

function resolveCommandCenterPanelTarget(target: WorkspacePanelTarget): WorkspaceTabTarget {
  switch (target) {
    case "changes":
      return { kind: "changes_tree" };
    case "files":
      return { kind: "files" };
    case "pull-request":
      return { kind: "pull_request" };
  }
}

function useLastMainPane(input: {
  workspaceKey: string | null;
  layout: WorkspaceLayout | null;
  explorerSidebarPaneId: string | null;
}) {
  const lastMainPaneRef = useRef<{ workspaceKey: string | null; paneId: string | null }>({
    workspaceKey: null,
    paneId: null,
  });
  if (lastMainPaneRef.current.workspaceKey !== input.workspaceKey) {
    lastMainPaneRef.current = { workspaceKey: input.workspaceKey, paneId: null };
  }
  const focusedPaneId = input.layout?.focusedPaneId ?? null;
  if (focusedPaneId && focusedPaneId !== input.explorerSidebarPaneId) {
    lastMainPaneRef.current.paneId = focusedPaneId;
  }
  return lastMainPaneRef;
}

/** The docked explorer beside the center column takes the top-right window-chrome corner. */
function DesktopCenterColumnChrome({
  explorerOpen,
  focusModeEnabled,
  children,
}: {
  explorerOpen: boolean;
  focusModeEnabled: boolean;
  children: ReactNode;
}) {
  return (
    <WindowChromeRegion corners={explorerOpen && !focusModeEnabled ? "top-left" : "both"}>
      <View style={styles.centerColumn}>{children}</View>
    </WindowChromeRegion>
  );
}

function WorkspaceScreenContent({
  serverId,
  workspaceId,
  isRouteFocused,
}: WorkspaceScreenContentProps) {
  const { t, i18n } = useTranslation();
  const hierarchyLabels = useMemo(
    () => getWorkspaceTabHierarchyLabels(i18n.language),
    [i18n.language],
  );
  const _insets = useSafeAreaInsets();
  const workspaceActionsInBar =
    resolveWorkspaceActionPlacement(useWindowLayout()) === "vertical-bar";
  const toast = useToast();
  const isMobile = useIsCompactFormFactor();
  const canRenderDesktopPaneSplits = supportsDesktopPaneSplits();
  const layoutMode = useWorkspaceLayoutStore((state) => state.layoutMode);
  const isFocusModeEnabled = usePanelStore((state) => state.desktop.focusModeEnabled);
  const desktopFocusModeEnabled = isFocusModeEnabled && !isMobile;
  const toggleFocusMode = usePanelStore((state) => state.toggleFocusMode);

  const normalizedServerId = useMemo(() => trimNonEmpty(decodeSegment(serverId)) ?? "", [serverId]);

  const normalizedWorkspaceId = useMemo(
    () => resolveWorkspaceRouteId({ routeWorkspaceId: workspaceId }) ?? "",
    [workspaceId],
  );
  const workspaceDescriptor = useWorkspace(normalizedServerId, normalizedWorkspaceId);
  useEffect(() => {
    if (!normalizedServerId || !normalizedWorkspaceId || workspaceDescriptor) return;
    void getHostRuntimeStore()
      .prepareWorkspaceRoute(normalizedServerId, normalizedWorkspaceId)
      .catch(() => undefined);
  }, [normalizedServerId, normalizedWorkspaceId, workspaceDescriptor]);
  // The focused workspace keeps its script status live even when no sidebar or viewed agent
  // timeline demands the directory. Retained, hidden workspaces release it.
  useEffect(() => {
    if (!isRouteFocused || !normalizedServerId || !normalizedWorkspaceId) return;
    return getHostRuntimeStore().acquireScriptStatusDemand(
      normalizedServerId,
      normalizedWorkspaceId,
    );
  }, [isRouteFocused, normalizedServerId, normalizedWorkspaceId]);
  const workspaceScripts = getWorkspaceScripts(workspaceDescriptor);
  const { handleRetryHost, handleManageHost, handleDismissMissingWorkspace } =
    useWorkspaceRouteActions(normalizedServerId);

  const client = useHostRuntimeClient(normalizedServerId);
  const isConnected = useHostRuntimeIsConnected(normalizedServerId);
  const supportsProvidersSnapshot = useSessionStore(
    (state) => state.sessions[normalizedServerId]?.serverInfo?.features?.providersSnapshot === true,
  );
  const workspaceDirectory = workspaceDescriptor?.workspaceDirectory || null;
  const isMissingWorkspaceDirectory = Boolean(workspaceDescriptor) && !workspaceDirectory;
  const [isImportSheetVisible, setIsImportSheetVisible] = useState(false);
  const canOpenImportSheet = [client, isConnected, workspaceDirectory].every(Boolean);
  const openImportSheet = useCallback(() => {
    setIsImportSheetVisible(true);
  }, []);
  const closeImportSheet = useCallback(() => {
    setIsImportSheetVisible(false);
  }, []);

  useEffect(() => {
    if (
      !isRouteFocused ||
      !isConnected ||
      !client ||
      !workspaceDirectory ||
      !supportsProvidersSnapshot
    ) {
      return;
    }
    prefetchProvidersSnapshot(normalizedServerId, client, { cwd: workspaceDirectory });
  }, [
    client,
    isConnected,
    isRouteFocused,
    normalizedServerId,
    supportsProvidersSnapshot,
    workspaceDirectory,
  ]);

  const persistenceKey = useMemo(
    () =>
      buildWorkspaceTabPersistenceKey({
        serverId: normalizedServerId,
        workspaceId: normalizedWorkspaceId,
      }),
    [normalizedServerId, normalizedWorkspaceId],
  );
  const openTab = useWorkspaceLayoutStore((state) => state.openTab);
  const replaceWorkspaceTabTarget = useWorkspaceLayoutStore((state) => state.replaceTab);
  const openWorkspaceTabFocused = useCallback(
    (workspaceKey: string, target: WorkspaceTabTarget, placement?: WorkspaceTabPlacement) =>
      openTab({ workspaceKey, target, intent: "reveal", placement }),
    [openTab],
  );
  const createWorkspaceTab = useCallback(
    (
      workspaceKey: string,
      target: WorkspaceTabTarget,
      placement?: WorkspaceTabPlacement,
      stateValue?: JsonValue,
    ) => openTab({ workspaceKey, target, intent: "new", placement, state: stateValue }),
    [openTab],
  );
  const revealWorkspaceChildTab = useCallback(
    (
      workspaceKey: string,
      target: WorkspaceTabTarget,
      parentTabId: string,
      placement?: WorkspaceTabPlacement,
    ) => openTab({ workspaceKey, target, intent: "reveal", parentTabId, placement }),
    [openTab],
  );
  const panelRevisions = useWorkspaceLayoutStore((state) =>
    persistenceKey ? state.panelRevisionByWorkspace[persistenceKey] : undefined,
  );
  const focusWorkspacePane = useWorkspaceLayoutStore((state) => state.focusPane);
  const hasHydratedWorkspaces = useSessionStore(
    (state) => state.sessions[normalizedServerId]?.hasHydratedWorkspaces ?? false,
  );
  const pendingOpenTarget = usePendingWorkspaceOpen({
    onOpened: revealWorkspaceTab,
    workspaceKey: persistenceKey,
    hasHydratedWorkspaces,
    workspaceExists: workspaceDescriptor !== null,
  });
  const workspaceRecovery = useWorkspaceRecovery({
    serverId: normalizedServerId,
    workspaceId: normalizedWorkspaceId,
    enabled: shouldInspectWorkspaceRecovery(
      hasHydratedWorkspaces,
      workspaceDescriptor,
      pendingOpenTarget,
    ),
  });

  const selectWorkspaceAgentVisibility = useMemo(() => {
    const select = createWorkspaceAgentVisibilitySelector({
      serverId: normalizedServerId,
      workspaceId: normalizedWorkspaceId,
    });
    let previousAgents: ReadonlyMap<string, Agent> | undefined;
    let previousVisibility: ReturnType<typeof select> | undefined;
    let previousResult: ReturnType<typeof select> | undefined;
    return (state: ReturnType<typeof useSessionStore.getState>) => {
      const visibility = select(state);
      const agents = state.sessions[normalizedServerId]?.agents;
      if (previousResult && previousVisibility === visibility && previousAgents === agents) {
        return previousResult;
      }
      const autoOpenAgentIds = [...visibility.autoOpenAgentIds].filter(
        (id) => !isSideChat(agents?.get(id)),
      );
      previousAgents = agents;
      previousVisibility = visibility;
      previousResult =
        autoOpenAgentIds.length === visibility.autoOpenAgentIds.size
          ? visibility
          : { ...visibility, autoOpenAgentIds: new Set(autoOpenAgentIds) };
      return previousResult;
    };
  }, [normalizedServerId, normalizedWorkspaceId]);
  const workspaceAgentVisibility = useStoreWithEqualityFn(
    useSessionStore,
    selectWorkspaceAgentVisibility,
    workspaceAgentVisibilityEqual,
  );

  const {
    handleTerminalCreated,
    handleScriptTerminalSelected,
    handleWorkspacePathUnavailable,
    handleTerminalCreateQueued,
    handleTerminalCreateFailed,
  } = useWorkspaceTerminalTabActions({
    persistenceKey,
    openWorkspaceTabFocused,
    replaceWorkspaceTabTarget,
    labels: {
      workspacePathUnavailable: t("workspace.header.toasts.workspacePathUnavailable"),
      terminalQueued: t("workspace.header.toasts.terminalQueued"),
    },
    toast,
  });
  const queryClient = useQueryClient();
  const {
    createMutation: createTerminalMutation,
    createTerminal,
    handleScriptTerminalStarted,
    handleViewScriptTerminal,
    invalidateTerminals,
    killMutation: killTerminalMutation,
    knownTerminalIds,
    liveTerminalIds,
    pendingCreateInput: pendingTerminalCreateInput,
    query: terminalsQuery,
    queryKey: terminalsQueryKey,
    removeTerminalFromCache,
    standaloneTerminalIds,
  } = useWorkspaceTerminals({
    client,
    isConnected,
    isRouteFocused,
    normalizedServerId,
    normalizedWorkspaceId,
    workspaceDirectory,
    workspaceScripts,
    hasHydratedWorkspaces,
    isMissingWorkspaceDirectory,
    onTerminalCreated: handleTerminalCreated,
    onScriptTerminalSelected: handleScriptTerminalSelected,
    onWorkspacePathUnavailable: handleWorkspacePathUnavailable,
    onTerminalCreateQueued: handleTerminalCreateQueued,
    onTerminalCreateFailed: handleTerminalCreateFailed,
  });
  const scriptActions = useWorkspaceScriptActions({
    client,
    serverId: normalizedServerId,
    workspaceId: normalizedWorkspaceId,
    scripts: workspaceScripts,
    onScriptTerminalStarted: handleScriptTerminalStarted,
  });
  const { archiveAgent } = useArchiveAgent();

  const { checkoutQuery, isCheckoutStatusLoading } = useWorkspaceCheckoutStatus({
    client,
    isConnected,
    isRouteFocused,
    normalizedServerId,
    normalizedWorkspaceId,
    workspaceDirectory,
  });
  const hasHydratedAgents = useSessionStore(
    (state) => state.sessions[normalizedServerId]?.hasHydratedAgents ?? false,
  );
  // An undo puts the row back before the host restores its agents. Their tabs stay until it settles.
  const isArchiveUndoRunning = useWorkspaceArchiveUndoRunning({
    serverId: normalizedServerId,
    workspaceId: normalizedWorkspaceId,
  });
  const workspaceRouteState = useResolvedWorkspaceRouteState({
    serverId: normalizedServerId,
    workspace: workspaceDescriptor,
    hasHydratedWorkspaces,
    recovery: workspaceRecovery.state,
  });
  const workspaceHeaderCheckoutState = buildWorkspaceHeaderCheckoutState({
    isCheckoutStatusLoading,
    isError: checkoutQuery.isError,
    data: checkoutQuery.data,
  });
  const {
    isWorkspaceHeaderLoading,
    workspaceHeaderTitle,
    workspaceHeaderSubtitle,
    isWorkspaceHeaderSubtitleDistinct,
    isGitCheckout,
    currentBranchName,
  } = deriveWorkspaceHeaderFields({
    workspace: workspaceDescriptor,
    checkoutState: workspaceHeaderCheckoutState,
  });
  const showMobileAgent = usePanelStore((state) => state.showMobileAgent);

  const isExplorerSidebarShowing = useIsExplorerSidebarOpen({
    isCompact: isMobile,
    workspaceKey: persistenceKey,
  });
  const hasPullRequest = useWorkspacePullRequestDiscovery({
    workspaceKey: persistenceKey,
    serverId: normalizedServerId,
    cwd: workspaceDirectory,
    workspaceActive: isRouteFocused,
    isGit: isGitCheckout,
    layoutMode,
    explorerOpen: isExplorerSidebarShowing,
  });

  useEffect(() => {
    // Back dismisses the compact overlay only. On a wide native layout the
    // explorer is a tab, `showMobileAgent` has no rendered consumer, and
    // returning true would swallow Back with nothing to show for it.
    if (!isRouteFocused || isWeb || !isMobile || !isExplorerSidebarShowing) {
      return;
    }

    const handler = BackHandler.addEventListener("hardwareBackPress", () => {
      showMobileAgent();
      return true;
    });

    return () => handler.remove();
  }, [isExplorerSidebarShowing, isMobile, isRouteFocused, showMobileAgent]);

  const workspaceLayout = useWorkspaceLayoutStore((state) =>
    persistenceKey ? (state.layoutByWorkspace[persistenceKey] ?? null) : null,
  );
  const unfocusedPaneId = useWorkspaceLayoutStore((state) =>
    persistenceKey ? state.focusRestorationByWorkspace[persistenceKey]?.restorePaneId : undefined,
  );
  const explorerSidebarPaneId = useWorkspaceLayoutStore((state) =>
    persistenceKey ? selectExplorerSidebarPaneId(state, persistenceKey) : null,
  );
  const paneFocusSuspended = useWorkspaceLayoutStore((state) =>
    persistenceKey ? selectPaneFocusSuspended(state, persistenceKey) : false,
  );
  const lastMainPaneRef = useLastMainPane({
    workspaceKey: persistenceKey,
    layout: workspaceLayout,
    explorerSidebarPaneId,
  });
  const lastMainPaneId = lastMainPaneRef.current.paneId;
  const hasHydratedWorkspaceLayoutStore = useWorkspaceLayoutStoreHydrated();
  const workspaceSetupStatus = getWorkspaceSetupStatus(workspaceDescriptor);
  const claimFailedSetupSurface = useWorkspaceSetupStore((state) => state.claimFailedSetupSurface);
  const supportsSetupObservation = useHostFeature(normalizedServerId, "workspaceSetupObservation");
  const showWorkspaceSetup = shouldShowWorkspaceSetup(
    workspaceSetupStatus,
    supportsSetupObservation,
  );
  const uiTabs = useMemo(
    () => (workspaceLayout ? collectAllTabs(workspaceLayout.root) : EMPTY_UI_TABS),
    [workspaceLayout],
  );
  const selectHierarchyTabState = useMemo(
    () =>
      createWorkspaceHierarchyTabStateSelector({
        serverId: normalizedServerId,
        workspaceId: normalizedWorkspaceId,
      }),
    [normalizedServerId, normalizedWorkspaceId],
  );
  const hierarchyTabState = useSessionStore(selectHierarchyTabState);
  const supportsHierarchyControl = useHostFeature(normalizedServerId, "agentHierarchyControl");
  const mainAgentId = hierarchyTabState.mainAgentId;
  const {
    topicWorkspace,
    isTopicWorkspace,
    onCenterColumnLayout,
    hasShellTeamWorkbench,
    isTeamDirectoryOverlay,
    isTeamDirectoryVisible,
    toggleTeamDirectory,
    hideTeamDirectory,
    showTeamDirectory,
    teamDirectoryShellValue,
    teamSummary,
  } = useWorkspaceTeamDirectoryState({
    serverId: normalizedServerId,
    workspaceId: normalizedWorkspaceId,
    client,
    isRouteFocused,
    isConnected,
    isMobile,
    mainAgentId,
    desktopFocusModeEnabled,
  });
  const supportsTopicWorkbench = useHostFeature(normalizedServerId, "topicWorkbenchV1");
  const { onUpgradeToTopic, dialog: topicUpgradeDialog } = useWorkspaceTopicUpgrade({
    client,
    isRouteFocused,
    serverId: normalizedServerId,
    workspaceId: normalizedWorkspaceId,
    cachedWorkspace: workspaceDescriptor,
    hostWorkspace: topicWorkspace,
    isConnected,
    supportsTopic: supportsTopicWorkbench,
  });
  const { preferences: codingPreferences } = useFormPreferences();
  const resolveNewAgentTabSetup = useCallback(() => {
    const state = useSessionStore.getState();
    const currentMainAgentId = selectHierarchyTabState(state).mainAgentId;
    if (!currentMainAgentId) return undefined;
    const mainAgent = state.sessions[normalizedServerId]?.agents.get(currentMainAgentId);
    if (!mainAgent) return undefined;
    return buildMainSubagentTabDraftSetup({
      mainAgent,
      mainAgentId: currentMainAgentId,
      preferredProvider: codingPreferences.provider,
    });
  }, [codingPreferences.provider, normalizedServerId, selectHierarchyTabState]);
  useOpenAgentTabLabels({
    client,
    serverId: normalizedServerId,
    workspaceId: normalizedWorkspaceId,
    tabs: uiTabs,
    enabled: hasHydratedWorkspaceLayoutStore,
  });
  useSyncWorkspaceActiveBrowser({
    workspaceLayout,
    isRouteFocused,
    workspaceId: normalizedWorkspaceId,
  });
  const openWorkspaceTabInBackground = useCallback(
    (workspaceKey: string, target: WorkspaceTabTarget, placement?: WorkspaceTabPlacement) =>
      openTab({ workspaceKey, target, intent: "background", placement }),
    [openTab],
  );
  const openInSidePane = useSettings((settings) => settings.openInSidePane);
  const pullRequestOpenLocation = useSettings((settings) => settings.pullRequestOpenLocation);
  const selectWorkspaceTabInPane = useWorkspaceLayoutStore((state) => state.selectTabInPane);
  const closeWorkspaceTab = useWorkspaceLayoutStore((state) => state.closeTab);
  const sheets = useWorkspaceLayoutStore((state) =>
    persistenceKey ? (state.sheetsByWorkspace[persistenceKey] ?? NO_SHEETS) : NO_SHEETS,
  );
  const unpinWorkspaceAgent = useWorkspaceLayoutStore((state) => state.unpinAgent);
  const hideWorkspaceAgent = useWorkspaceLayoutStore((state) => state.hideAgent);
  const setWorkspaceTabState = useWorkspaceLayoutStore((state) => state.setTabState);
  const reconcileWorkspaceTabs = useWorkspaceLayoutStore((state) => state.reconcileTabs);
  const splitWorkspacePane = useWorkspaceLayoutStore((state) => state.splitPane);
  const splitWorkspacePaneEmpty = useWorkspaceLayoutStore((state) => state.splitPaneEmpty);
  const moveWorkspaceTabToPane = useWorkspaceLayoutStore((state) => state.moveTabToPane);
  const closeWorkspacePane = useWorkspaceLayoutStore((state) => state.closePane);
  const handleToggleExplorerSidebar = useCallback(() => {
    toggleExplorerSidebar({
      isCompact: isMobile,
      workspaceKey: persistenceKey,
    });
  }, [isMobile, persistenceKey]);
  const paneFocusSuppressedRef = useRef(false);
  const resizeWorkspaceSplit = useWorkspaceLayoutStore((state) => state.resizeSplit);
  const reorderWorkspaceTabsInPane = useWorkspaceLayoutStore((state) => state.reorderTabsInPane);
  const _pinnedAgentIds = useWorkspaceLayoutStore((state) =>
    persistenceKey
      ? (state.pinnedAgentIdsByWorkspace[persistenceKey] ?? EMPTY_PINNED_AGENT_IDS)
      : EMPTY_PINNED_AGENT_IDS,
  );
  const _hiddenAgentIds = useWorkspaceLayoutStore((state) =>
    persistenceKey ? (state.hiddenAgentIdsByWorkspace[persistenceKey] ?? EMPTY_SET) : EMPTY_SET,
  );
  const pendingByDraftId = useCreateFlowStore((state) => state.pendingByDraftId);
  const { closingTabIds, closeTab } = useCloseTabs();
  const closeWorkspaceTabWithCleanup = useCallback(
    function closeWorkspaceTabWithCleanup(input: {
      tabId: string;
      target?: WorkspaceTabTarget | null;
    }) {
      const normalizedTabId = trimNonEmpty(input.tabId);
      if (!normalizedTabId || !persistenceKey || isDraftTabSubmitting(input.target)) {
        return;
      }

      if (input.target?.kind === "agent") {
        unpinWorkspaceAgent(persistenceKey, input.target.agentId);
        hideWorkspaceAgent(persistenceKey, input.target.agentId);
      }
      if (input.target?.kind === "browser") {
        const { browserId } = input.target;
        useBrowserStore.getState().removeBrowser(browserId);
        removeResidentBrowserWebview(browserId);
        void getDesktopHost()?.browser?.unregisterWorkspaceBrowser?.(browserId);
      }
      closeWorkspaceTab(persistenceKey, normalizedTabId);
    },
    [closeWorkspaceTab, hideWorkspaceAgent, persistenceKey, unpinWorkspaceAgent],
  );

  const focusedPaneTabState = useMemo(
    () =>
      deriveWorkspacePaneState({
        layout: workspaceLayout,
        tabs: uiTabs,
        paneId: workspaceLayout?.focusedPaneId ?? unfocusedPaneId,
      }),
    [uiTabs, workspaceLayout, unfocusedPaneId],
  );
  const viewedTimelineSync = useSessionStore(
    (state) => state.sessions[normalizedServerId]?.viewedTimelineSync ?? null,
  );
  const syncFocusedPaneOnly = useMemo(
    () => isMobile || isFocusModeEnabled || !supportsDesktopPaneSplits(),
    [isFocusModeEnabled, isMobile],
  );
  const visibleAgentIds = useVisibleAgentIds({
    layout: workspaceLayout,
    tabs: uiTabs,
    routeFocused: isRouteFocused,
    focusedPaneOnly: syncFocusedPaneOnly,
    explorerPaneId: explorerSidebarPaneId,
    explorerVisible: isExplorerSidebarShowing,
  });
  useEffect(() => {
    for (const agentId of visibleAgentIds) {
      void getHostRuntimeStore()
        .prepareAgentTimeline(normalizedServerId, agentId)
        .catch(() => undefined);
    }
  }, [normalizedServerId, visibleAgentIds]);
  useLayoutEffect(() => {
    if (!persistenceKey || !viewedTimelineSync) {
      return;
    }
    viewedTimelineSync.replaceVisibleAgentIds(persistenceKey, visibleAgentIds);
  }, [persistenceKey, viewedTimelineSync, visibleAgentIds]);
  useEffect(() => {
    if (!persistenceKey || !viewedTimelineSync) {
      return;
    }
    return () => viewedTimelineSync.replaceVisibleAgentIds(persistenceKey, []);
  }, [persistenceKey, viewedTimelineSync]);
  const setFocusedAgentId = useSessionStore((state) => state.setFocusedAgentId);
  const setFocusedTerminalId = useSessionStore((state) => state.setFocusedTerminalId);
  const focusedPaneAgentId = useMemo(() => {
    const target = focusedPaneTabState.activeTab?.descriptor.target;
    if (target?.kind !== "agent") {
      return null;
    }
    return target.agentId;
  }, [focusedPaneTabState.activeTab]);
  const focusedPaneTerminalId = useMemo(() => {
    const target = focusedPaneTabState.activeTab?.descriptor.target;
    if (target?.kind !== "terminal") {
      return null;
    }
    return target.terminalId;
  }, [focusedPaneTabState.activeTab]);
  const focusedProviderSubagentId = useMemo(() => {
    const target = focusedPaneTabState.activeTab?.descriptor.target;
    if (target?.kind !== "provider_subagent") {
      return null;
    }
    return target.subagentId;
  }, [focusedPaneTabState.activeTab]);

  useEffect(() => {
    if (!isRouteFocused) {
      return;
    }
    setFocusedAgentId(normalizedServerId, focusedPaneAgentId);
    setFocusedTerminalId(normalizedServerId, focusedPaneTerminalId);
  }, [
    focusedPaneAgentId,
    focusedPaneTerminalId,
    isRouteFocused,
    normalizedServerId,
    setFocusedAgentId,
    setFocusedTerminalId,
  ]);

  useEffect(() => {
    if (!isRouteFocused) {
      return;
    }
    return () => {
      setFocusedAgentId(normalizedServerId, null);
      setFocusedTerminalId(normalizedServerId, null);
    };
  }, [isRouteFocused, normalizedServerId, setFocusedAgentId, setFocusedTerminalId]);

  const openWorkspaceDraftTab = useCallback(
    function openWorkspaceDraftTab(input?: {
      ambient?: boolean;
      draftId?: string;
      focus?: boolean;
      paneId?: string | null;
      standalone?: boolean;
    }) {
      if (!persistenceKey) {
        return null;
      }

      const target = buildNewAgentTabTarget({
        draftId: trimNonEmpty(input?.draftId) ?? generateDraftId(),
        selection: input?.standalone ? { kind: "agent", relationship: "standalone" } : undefined,
        resolveSubagentSetup: resolveNewAgentTabSetup,
      });
      if (input?.ambient) {
        return openWorkspaceTabFocused(persistenceKey, target);
      }
      const placement = paneLocalPlacement(input?.paneId);
      if (input?.focus === false) {
        return openWorkspaceTabInBackground(persistenceKey, target, placement);
      }
      return openWorkspaceTabFocused(persistenceKey, target, placement);
    },
    [
      openWorkspaceTabFocused,
      openWorkspaceTabInBackground,
      persistenceKey,
      resolveNewAgentTabSetup,
    ],
  );

  useLayoutEffect(() => {
    if (!isRouteFocused) {
      return;
    }
    if (!normalizedServerId || !normalizedWorkspaceId || !persistenceKey) {
      return;
    }
    if (!hasHydratedWorkspaceLayoutStore) {
      return;
    }

    const hasActivePendingDraftCreateInWorkspace = uiTabs.some((tab) => {
      if (tab.target.kind !== "draft") {
        return false;
      }
      const pending = pendingByDraftId[tab.target.draftId];
      return pending?.serverId === normalizedServerId && pending.lifecycle === "active";
    });

    if (
      hasActivePendingDraftCreateInWorkspace &&
      mainAgentId &&
      !uiTabs.some((tab) => isWorkspaceMainTab(tab, mainAgentId))
    ) {
      // Draft reconciliation defers new agent tabs so it cannot race the draft's replacement.
      openWorkspaceTabInBackground(persistenceKey, { kind: "agent", agentId: mainAgentId });
    }

    reconcileWorkspaceTabs(
      persistenceKey,
      buildWorkspaceTabSnapshot({
        agentVisibility: workspaceAgentVisibility,
        agentsHydrated: hasHydratedAgents && !isArchiveUndoRunning,
        terminalsHydrated: terminalsQuery.isSuccess,
        knownTerminalIds,
        standaloneTerminalIds,
        hasActivePendingTerminalCreate:
          createTerminalMutation.isPending || pendingTerminalCreateInput !== null,
        hasActivePendingDraftCreate: hasActivePendingDraftCreateInWorkspace,
      }),
    );
  }, [
    hasHydratedAgents,
    isArchiveUndoRunning,
    hasHydratedWorkspaceLayoutStore,
    pendingTerminalCreateInput,
    createTerminalMutation.isPending,
    isRouteFocused,
    mainAgentId,
    normalizedServerId,
    normalizedWorkspaceId,
    openWorkspaceTabInBackground,
    pendingByDraftId,
    persistenceKey,
    reconcileWorkspaceTabs,
    knownTerminalIds,
    standaloneTerminalIds,
    terminalsQuery.isSuccess,
    uiTabs,
    workspaceAgentVisibility,
  ]);

  const activeTabId = focusedPaneTabState.activeTabId;
  const activeTab = focusedPaneTabState.activeTab;

  // Keep the stored pane order aligned with the rail, drag targets, and bulk close actions.
  useLayoutEffect(() => {
    if (!isRouteFocused || !persistenceKey || !mainAgentId) return;
    const mainTab = uiTabs.find((tab) => isWorkspaceMainTab(tab, mainAgentId));
    const layout = useWorkspaceLayoutStore.getState().layoutByWorkspace[persistenceKey];
    if (!mainTab || !layout) return;
    const pane = findPaneContainingTab(layout.root, mainTab.tabId);
    if (!pane || pane.tabIds.indexOf(mainTab.tabId) <= 0) return;
    reorderWorkspaceTabsInPane(
      persistenceKey,
      pane.id,
      pinWorkspaceMainTabIds(pane.tabIds, mainTab.tabId),
    );
  }, [isRouteFocused, mainAgentId, persistenceKey, reorderWorkspaceTabsInPane, uiTabs]);

  const tabs = useMemo<WorkspaceTabDescriptor[]>(
    () => focusedPaneTabState.tabs.map((tab) => tab.descriptor),
    [focusedPaneTabState.tabs],
  );
  const hasSetupTab = useMemo(
    () =>
      uiTabs.some(
        (tab) => tab.target.kind === "setup" && tab.target.workspaceId === normalizedWorkspaceId,
      ),
    [normalizedWorkspaceId, uiTabs],
  );
  const navigateToTabId = useCallback(
    function navigateToTabId(tabId: string) {
      if (!tabId || !persistenceKey) {
        return;
      }
      revealWorkspaceTab(persistenceKey, tabId);
    },
    [persistenceKey],
  );
  const selectTabInPane = useCallback(
    (paneId: string, tabId: string) => {
      if (persistenceKey) {
        selectWorkspaceTabInPane(persistenceKey, paneId, tabId);
      }
    },
    [persistenceKey, selectWorkspaceTabInPane],
  );
  // A "Show all" import can land in another workspace entirely; that
  // agent has no tab here, so it opens its own workspace instead.
  const navigateToImportedAgent = useNavigateToImportedAgent(normalizedServerId);
  const handleImportedAgent = useCallback(
    (agentId: string) => {
      if (!persistenceKey) {
        return;
      }
      const tabId = openWorkspaceTabFocused(
        persistenceKey,
        { kind: "agent", agentId },
        FOCUSED_PANE_PLACEMENT,
      );
      if (tabId) {
        navigateToTabId(tabId);
      }
    },
    [navigateToTabId, openWorkspaceTabFocused, persistenceKey],
  );

  useEffect(() => {
    if (!isRouteFocused) {
      return;
    }
    if (!persistenceKey) {
      return;
    }
    if (!shouldSeedWorkspaceSetupTab(workspaceSetupStatus)) {
      return;
    }

    const target = normalizeWorkspaceTabTarget({
      kind: "setup",
      workspaceId: normalizedWorkspaceId,
    });
    if (!target) {
      return;
    }
    if (
      !claimFailedSetupSurface({
        serverId: normalizedServerId,
        workspaceId: normalizedWorkspaceId,
        status: workspaceSetupStatus,
      })
    ) {
      return;
    }
    if (hasSetupTab) {
      return;
    }

    openWorkspaceTabInBackground(persistenceKey, target, {
      mode: "prefer",
      paneId: DEFAULT_PANE_ID,
    });
  }, [
    claimFailedSetupSurface,
    hasSetupTab,
    isRouteFocused,
    normalizedWorkspaceId,
    normalizedServerId,
    openWorkspaceTabInBackground,
    persistenceKey,
    workspaceSetupStatus,
  ]);

  const handleOpenFileFromChat = useCallback(
    (location: WorkspaceFileLocation, parentTabId?: string | null) => {
      const normalizedLocation = normalizeWorkspaceFileLocation(location);
      if (!normalizedLocation) {
        return;
      }
      if (!persistenceKey) {
        return;
      }
      const target = createWorkspaceFileTabTarget(normalizedLocation);
      const tabId = parentTabId
        ? revealWorkspaceChildTab(persistenceKey, target, parentTabId, FOCUSED_PANE_PLACEMENT)
        : openWorkspaceTabFocused(persistenceKey, target, FOCUSED_PANE_PLACEMENT);
      if (tabId) {
        navigateToTabId(tabId);
      }
    },
    [navigateToTabId, openWorkspaceTabFocused, revealWorkspaceChildTab, persistenceKey],
  );

  const handleOpenPreferredAssistantFile = useCallback(
    (input: { location: WorkspaceFileLocation; parentTabId?: string | null }) => {
      const location = normalizeWorkspaceFileLocation(input.location);
      if (!location) {
        return;
      }
      if (!persistenceKey) {
        return;
      }

      openPreferredWorkspaceTarget({
        workspaceKey: persistenceKey,
        target: createWorkspaceFileTabTarget(location),
        source: "chatFiles",
        preferences: openInSidePane,
        parentTabId: input.parentTabId,
      });
    },
    [openInSidePane, persistenceKey],
  );

  const handleOpenWorkspaceFileFromPane = useStableEvent(function handleOpenWorkspaceFileFromPane({
    request,
    paneId,
    parentTabId,
    focusPaneBeforeOpen,
  }: {
    request: WorkspaceFileOpenRequest;
    paneId?: string | null;
    parentTabId: string;
    focusPaneBeforeOpen?: boolean;
  }) {
    if (focusPaneBeforeOpen && paneId && persistenceKey) {
      focusWorkspacePane(persistenceKey, paneId);
    }
    if (request.disposition === "side") {
      const location = normalizeWorkspaceFileLocation(request.location);
      if (!location || !persistenceKey) return;
      openWorkspaceTargetBeside({
        workspaceKey: persistenceKey,
        target: createWorkspaceFileTabTarget(location),
        parentTabId,
      });
      return;
    }
    if (request.disposition === "preferred") {
      handleOpenPreferredAssistantFile({
        location: request.location,
        parentTabId,
      });
      return;
    }
    handleOpenFileFromChat(request.location, parentTabId);
  });

  const [hoveredCloseTabKey, setHoveredCloseTabKey] = useState<string | null>(null);
  const { handleRenameTab, renamingTab, handleRenameModalSubmit, handleRenameModalClose } =
    useWorkspaceTabRename({
      client,
      normalizedServerId,
      queryClient,
      terminalsData: terminalsQuery.data,
      terminalsQueryKey,
    });

  const allTabDescriptorsById = useMemo(() => {
    const map = new Map<string, WorkspaceTabDescriptor>();
    for (const tab of uiTabs) {
      map.set(tab.tabId, {
        key: tab.tabId,
        tabId: tab.tabId,
        kind: tab.target.kind,
        target: tab.target,
      });
    }
    return map;
  }, [uiTabs]);
  const bulkCloseConfirmationLabels = useMemo<BulkCloseConfirmationLabels>(
    () => ({
      newTab: t("workspace.tabs.actions.newTab"),
      all: ({ agents, terminals: terminalCount, tabs: tabCount }) =>
        t("workspace.tabs.confirmations.bulk.all", {
          agents,
          terminals: terminalCount,
          tabs: tabCount,
        }),
      agentsAndTerminals: ({ agents, terminals: terminalCount }) =>
        t("workspace.tabs.confirmations.bulk.agentsAndTerminals", {
          agents,
          terminals: terminalCount,
        }),
      terminalsAndTabs: ({ terminals: terminalCount, tabs: tabCount }) =>
        t("workspace.tabs.confirmations.bulk.terminalsAndTabs", {
          terminals: terminalCount,
          tabs: tabCount,
        }),
      agentsAndTabs: ({ agents, tabs: tabCount }) =>
        t("workspace.tabs.confirmations.bulk.agentsAndTabs", { agents, tabs: tabCount }),
      terminals: ({ terminals: terminalCount }) =>
        t("workspace.tabs.confirmations.bulk.terminals", { terminals: terminalCount }),
      tabs: ({ tabs: tabCount }) => t("workspace.tabs.confirmations.bulk.tabs", { tabs: tabCount }),
      agents: ({ agents }) => t("workspace.tabs.confirmations.bulk.agents", { agents }),
    }),
    [t],
  );

  const activeTabKey = useMemo(() => activeTabId ?? "", [activeTabId]);
  const handleCreateDraftTab = useCallback(
    (input?: { paneId?: string }) => {
      openWorkspaceDraftTab({ paneId: input?.paneId });
    },
    [openWorkspaceDraftTab],
  );

  const handleCreateTerminal = useStableEvent((input?: { paneId?: string }) => {
    createTerminal({
      destination: input?.paneId ? { kind: "open", paneId: input.paneId } : { kind: "open" },
    });
  });

  const handleCreateTerminalWithProfile = useCallback(
    (profile: TerminalProfile, paneId?: string) => {
      createTerminal({ profile, destination: { kind: "open", paneId } });
    },
    [createTerminal],
  );

  const handleCreateBrowserTab = useCallback(
    (input?: { paneId?: string }) => {
      if (!persistenceKey || !getIsElectron()) {
        return;
      }
      const { browserId } = createWorkspaceBrowser();
      openWorkspaceTabFocused(
        persistenceKey,
        { kind: "browser", browserId },
        paneLocalPlacement(input?.paneId),
      );
    },
    [openWorkspaceTabFocused, persistenceKey],
  );

  const handleCreateNewTab = useCallback(
    (input?: { paneId?: string }) => {
      if (!persistenceKey) {
        return;
      }
      createWorkspaceTab(persistenceKey, { kind: "new_tab" }, paneLocalPlacement(input?.paneId));
    },
    [createWorkspaceTab, persistenceKey],
  );

  const launchWorkspaceTab = useCallback(
    (selection: NewTabSelection, destination: WorkspaceTabLaunchDestination) => {
      if (!persistenceKey) {
        return;
      }
      const openTarget = (target: WorkspaceTab["target"]) => {
        if (destination.kind === "replace") {
          replaceWorkspaceTabTarget(persistenceKey, destination.tabId, target);
        } else {
          createWorkspaceTab(persistenceKey, target, paneLocalPlacement(destination.paneId));
        }
      };
      if (selection.kind === "target") {
        openTarget(selection.target);
        return;
      }
      if (selection.kind === "agent") {
        openTarget(
          buildNewAgentTabTarget({
            draftId: generateDraftId(),
            selection,
            resolveSubagentSetup: resolveNewAgentTabSetup,
          }),
        );
        return;
      }
      if (selection.kind === "terminal") {
        createTerminal({
          profile: selection.profile,
          destination,
        });
        return;
      }
      const { browserId } = createWorkspaceBrowser();
      openTarget({ kind: "browser", browserId });
    },
    [
      createTerminal,
      createWorkspaceTab,
      persistenceKey,
      replaceWorkspaceTabTarget,
      resolveNewAgentTabSetup,
    ],
  );

  const handleOpenUrlInBrowserTab = useCallback(
    (url: string) => {
      if (!persistenceKey || !getIsElectron()) {
        return;
      }
      const { browserId } = createWorkspaceBrowser({ initialUrl: url });
      openWorkspaceTabFocused(
        persistenceKey,
        { kind: "browser", browserId },
        FOCUSED_PANE_PLACEMENT,
      );
    },
    [openWorkspaceTabFocused, persistenceKey],
  );

  useDesktopBrowserNewTabRequests({
    enabled: Boolean(persistenceKey),
    workspaceLayout,
    openUrl: handleOpenUrlInBrowserTab,
  });

  const handleSelectSwitcherTab = useCallback(
    (key: string) => {
      navigateToTabId(key);
    },
    [navigateToTabId],
  );

  // The new pane opens empty and the user picks what goes in it from the launcher.
  // Seeding a draft here guessed for them, and guessed "new agent" every time.
  const handleCreateEmptySplit = useCallback(
    (input: { targetPaneId: string; position: "left" | "right" | "top" | "bottom" }) => {
      if (!persistenceKey) {
        return;
      }
      splitWorkspacePaneEmpty(persistenceKey, input);
    },
    [persistenceKey, splitWorkspacePaneEmpty],
  );

  const killTerminalAsync = killTerminalMutation.mutateAsync;

  const handleCloseTerminalTab = useCallback(
    async (input: { tabId: string; terminalId: string }) => {
      const { tabId, terminalId } = input;
      await closeTab(tabId, async () => {
        const confirmed = await confirmDialog({
          title: t("workspace.tabs.confirmations.closeTerminalTitle"),
          message: t("workspace.tabs.confirmations.closeTerminalMessage"),
          confirmLabel: t("workspace.tabs.confirmations.close"),
          cancelLabel: t("workspace.tabs.confirmations.cancel"),
          destructive: true,
        });
        if (!confirmed) {
          return;
        }

        removeTerminalFromCache(terminalId);
        setHoveredCloseTabKey((current) => (current === tabId ? null : current));
        if (persistenceKey) {
          closeWorkspaceTabWithCleanup({
            tabId,
            target: { kind: "terminal", terminalId },
          });
        }

        void killTerminalAsync(terminalId).catch(invalidateTerminals);
      });
    },
    [
      closeTab,
      closeWorkspaceTabWithCleanup,
      invalidateTerminals,
      killTerminalAsync,
      persistenceKey,
      removeTerminalFromCache,
      t,
    ],
  );

  const confirmArchiveAgentTab = useCallback(
    (session: SessionState | undefined, agentId: string) => {
      const agent = session?.agents.get(agentId);
      if (!session || !agent) return true;
      const hasMainDescendants =
        isMainControlAgent(agent) &&
        hasUnarchivedWorkspaceDescendants(session, agentId, normalizedWorkspaceId);
      if (!hasMainDescendants && agent.status !== "running") return true;
      return confirmDialog({
        title: hasMainDescendants
          ? hierarchyLabels.archiveTitle
          : t("workspace.tabs.confirmations.archiveRunningAgentTitle"),
        message: hasMainDescendants
          ? hierarchyLabels.archiveMessage
          : t("workspace.tabs.confirmations.archiveRunningAgentMessage"),
        confirmLabel: t("workspace.tabs.confirmations.archive"),
        cancelLabel: t("workspace.tabs.confirmations.cancel"),
        destructive: true,
      });
    },
    [hierarchyLabels, normalizedWorkspaceId, t],
  );

  const discardEmptySideChat = useCallback(
    async (agentId: string) => {
      const state = useSessionStore.getState();
      const session = state.sessions[normalizedServerId];
      const agent = session?.agents.get(agentId) ?? session?.agentDetails.get(agentId);
      if (!agent || !isSideChat(agent) || agent.workspaceId !== normalizedWorkspaceId) return;
      if (
        persistenceKey &&
        useWorkspaceLayoutStore
          .getState()
          .getWorkspaceTabs(persistenceKey)
          .some((tab) => tab.target.kind === "agent" && tab.target.agentId === agentId)
      )
        return;
      const sessionClient = session?.client;
      if (sessionClient) {
        await sessionClient.updateAgent(agentId, {
          labels: { [getSideChatOpenTabLabel()]: "false" },
          expectedWorkspaceId: normalizedWorkspaceId,
        });
      }
      await discardSideChatIfEmpty({
        agent,
        client: session?.client ?? null,
        supportsSideChat: selectHostFeature(state, normalizedServerId, "agentSideChat"),
      });
    },
    [normalizedServerId, normalizedWorkspaceId, persistenceKey],
  );

  const handleCloseAgentTab = useCallback(
    async (input: { tabId: string; agentId: string }) => {
      const { tabId, agentId } = input;
      await closeTab(tabId, async () => {
        if (!normalizedServerId) {
          return;
        }

        const session = useSessionStore.getState().sessions[normalizedServerId];
        const agent = session?.agents.get(agentId) ?? session?.agentDetails.get(agentId);
        // A restored tab can outlive its snapshot. Closing it cannot authorize an archive.
        const closeKind = resolveAgentTabCloseKind(agent, isTopicWorkspace);
        let shouldArchive = closeKind === "archive-on-close";
        if (shouldArchive) {
          const confirmation = confirmArchiveAgentTab(session, agentId);
          if (confirmation !== true && !(await confirmation)) {
            return;
          }
        }

        if (closeKind === "layout-only") {
          const sessionClient = useSessionStore.getState().sessions[normalizedServerId]?.client;
          if (!sessionClient) {
            toast.error(t("common.errors.daemonClientUnavailable"));
            return;
          }
          try {
            const clearResult = await clearSubagentOpenTabLabel({
              client: sessionClient,
              agentId,
              serverId: normalizedServerId,
              workspaceId: normalizedWorkspaceId,
            });
            shouldArchive = isTopicWorkspace ? false : clearResult;
          } catch (error) {
            console.error("[WorkspaceScreen] Failed to close subagent tab", { error, agentId });
            toast.error(t("workspace.tabs.toasts.failedToCloseAgent"));
            return;
          }
        }

        setHoveredCloseTabKey((current) => (current === tabId ? null : current));
        if (persistenceKey) {
          closeWorkspaceTabWithCleanup({
            tabId,
            target: { kind: "agent", agentId },
          });
        }

        if (closeKind === "side-chat") {
          try {
            await discardEmptySideChat(agentId);
          } catch (error) {
            console.warn("[WorkspaceScreen] Failed to discard empty side chat", { error, agentId });
          }
        }
        if (!shouldArchive) {
          return;
        }

        // Errors (e.g. timeout) are handled by the mutation's onSettled callback
        void archiveAgent({
          serverId: normalizedServerId,
          agentId,
          expectedWorkspaceId: normalizedWorkspaceId,
        }).catch(() => {});
      });
    },
    [
      archiveAgent,
      closeTab,
      closeWorkspaceTabWithCleanup,
      confirmArchiveAgentTab,
      discardEmptySideChat,
      isTopicWorkspace,
      normalizedServerId,
      normalizedWorkspaceId,
      persistenceKey,
      t,
      toast,
    ],
  );

  const handleMainTabAction = useCallback(
    async (tabId: string, agentId: string, action: { enabled: boolean } | { attach: true }) => {
      await closeTab(tabId, async () => {
        const session = useSessionStore.getState().sessions[normalizedServerId];
        const agent = session?.agents.get(agentId);
        if (!session?.client) {
          toast.error(t("common.errors.daemonClientUnavailable"));
          return;
        }
        if (
          session.serverInfo?.features?.agentHierarchyControl !== true ||
          !isWorkspaceRootAgent(agent, normalizedWorkspaceId) ||
          isSideChat(agent)
        ) {
          toast.error(hierarchyLabels.updateFailed);
          return;
        }
        const sessionClient = session.client;
        try {
          if ("enabled" in action) {
            await sessionClient.setAgentMainControl(agentId, action.enabled);
            return;
          }
          const currentMainId = findWorkspaceMainAgentId(session, normalizedWorkspaceId);
          if (
            !currentMainId ||
            !canAdoptTabUnderMainAgent({ session, agentId, mainAgentId: currentMainId })
          ) {
            toast.error(hierarchyLabels.attachUnavailable);
            return;
          }
          await sessionClient.setAgentParent(agentId, currentMainId);
          // The RPC succeeded even if the updated agent has not reached the session store yet.
          // Close the view directly so stale root metadata cannot route this through archive.
          closeWorkspaceTabWithCleanup({ tabId, target: { kind: "agent", agentId } });
          setHoveredCloseTabKey((current) => (current === tabId ? null : current));
          // Clear any open-tab label written if agent_update arrived just before the tab closed.
          void getOrCreateClientId()
            .then((clientId) =>
              sessionClient.updateAgent(agentId, {
                labels: { [getOpenAgentTabLabel(clientId)]: "false" },
              }),
            )
            .catch(() => {});
        } catch (error) {
          const message = hierarchyLabels.updateFailed;
          toast.error(error instanceof Error ? `${message} ${error.message}` : message);
        }
      });
    },
    [
      closeTab,
      closeWorkspaceTabWithCleanup,
      hierarchyLabels,
      normalizedServerId,
      normalizedWorkspaceId,
      t,
      toast,
    ],
  );

  const mainTabContext = useMemo<NonNullable<ContextType<typeof WorkspaceMainTabContext>>>(
    () => ({
      mainAgentId,
      actionsForTab: (tab) => {
        if (!supportsHierarchyControl || tab.target.kind !== "agent") return;
        const { agentId } = tab.target;
        if (
          !hierarchyTabState.rootAgentIds.has(agentId) ||
          isSideChat(useSessionStore.getState().sessions[normalizedServerId]?.agents.get(agentId))
        )
          return;
        return {
          isMain: agentId === mainAgentId,
          pending: closingTabIds.has(tab.tabId),
          setMain: (enabled) => {
            void handleMainTabAction(tab.tabId, agentId, { enabled });
          },
          attachToMain: hierarchyTabState.adoptableAgentIds.has(agentId)
            ? () => {
                void handleMainTabAction(tab.tabId, agentId, { attach: true });
              }
            : undefined,
        };
      },
    }),
    [
      closingTabIds,
      handleMainTabAction,
      hierarchyTabState,
      mainAgentId,
      normalizedServerId,
      supportsHierarchyControl,
    ],
  );

  const handleClosePassiveTab = useCallback(
    function handleClosePassiveTab(input: { tabId: string; target?: WorkspaceTabTarget | null }) {
      if (isDraftTabSubmitting(input.target)) return;
      setHoveredCloseTabKey((current) => (current === input.tabId ? null : current));
      if (persistenceKey) {
        closeWorkspaceTabWithCleanup({ tabId: input.tabId, target: input.target });
      }
    },
    [closeWorkspaceTabWithCleanup, persistenceKey],
  );

  const confirmDiscardModifiedTab = useCallback(
    async (tabId: string): Promise<boolean> => {
      const attributes = getPanelInstanceAttributes({
        serverId: normalizedServerId,
        workspaceId: normalizedWorkspaceId,
        tabId,
      });
      if (!attributes.modified) return true;
      const resumePendingSave = attributes.suspendPendingSave?.();
      const confirmed = await confirmDialog({
        title: t("workspace.tabs.confirmations.unsavedTitle"),
        message: t("workspace.tabs.confirmations.unsavedMessage"),
        confirmLabel: t("workspace.tabs.confirmations.closeWithoutSaving"),
        cancelLabel: t("workspace.tabs.confirmations.cancel"),
        destructive: true,
      });
      if (!confirmed) resumePendingSave?.();
      return confirmed;
    },
    [normalizedServerId, normalizedWorkspaceId, t],
  );

  const handleCloseTabById = useCallback(
    async (tabId: string) => {
      const sheet = sheets.find((entry) => entry.tab.tabId === tabId);
      if (persistenceKey && sheet) {
        if (
          !isDraftTabSubmitting(sheet.tab.target) &&
          (await confirmDiscardModifiedTab(tabId)) &&
          !isDraftTabSubmitting(sheet.tab.target)
        ) {
          closeWorkspaceTab(persistenceKey, tabId);
        }
        return;
      }
      const tab = allTabDescriptorsById.get(tabId);
      if (!tab || isDraftTabSubmitting(tab.target)) {
        return;
      }
      if (!(await confirmDiscardModifiedTab(tabId))) {
        return;
      }
      if (tab.target.kind === "terminal") {
        await handleCloseTerminalTab({ tabId, terminalId: tab.target.terminalId });
        return;
      }
      if (tab.target.kind === "agent") {
        await handleCloseAgentTab({ tabId, agentId: tab.target.agentId });
        return;
      }
      handleClosePassiveTab({ tabId, target: tab.target });
    },
    [
      allTabDescriptorsById,
      closeWorkspaceTab,
      confirmDiscardModifiedTab,
      handleCloseAgentTab,
      handleClosePassiveTab,
      handleCloseTerminalTab,
      persistenceKey,
      sheets,
    ],
  );

  const handleCopyAgentId = useCallback(
    async (agentId: string) => {
      if (!agentId) return;
      try {
        await Clipboard.setStringAsync(agentId);
        toast.copied(t("workspace.tabs.toasts.agentIdCopiedLabel"));
      } catch {
        toast.error(t("workspace.tabs.toasts.copyFailed"));
      }
    },
    [toast, t],
  );

  const handleCopyTerminalId = useCallback(
    async (terminalId: string) => {
      if (!terminalId) return;
      try {
        await Clipboard.setStringAsync(terminalId);
        toast.copied(t("workspace.tabs.toasts.terminalIdCopiedLabel"));
      } catch {
        toast.error(t("workspace.tabs.toasts.copyFailed"));
      }
    },
    [toast, t],
  );

  const handleCopyFilePath = useCallback(
    async (path: string) => {
      if (!path) return;
      try {
        await Clipboard.setStringAsync(path);
        toast.copied(t("workspace.tabs.toasts.filePathCopiedLabel"));
      } catch {
        toast.error(t("workspace.tabs.toasts.copyFailed"));
      }
    },
    [toast, t],
  );

  const handleCopyResumeCommand = useCallback(
    async (agentId: string) => {
      if (!agentId) return;
      const agent =
        useSessionStore.getState().sessions[normalizedServerId]?.agents?.get(agentId) ?? null;
      const providerSessionId =
        agent?.runtimeInfo?.sessionId ?? agent?.persistence?.sessionId ?? null;
      if (!agent || !providerSessionId) {
        toast.error(t("workspace.tabs.toasts.resumeIdUnavailable"));
        return;
      }

      const command =
        buildProviderCommand({
          provider: agent.provider,
          id: "resume",
          sessionId: providerSessionId,
        }) ?? null;
      if (!command) {
        toast.error(t("workspace.tabs.toasts.resumeCommandUnavailable"));
        return;
      }
      try {
        await Clipboard.setStringAsync(command);
        toast.copied(t("workspace.tabs.toasts.resumeCommandCopiedLabel"));
      } catch {
        toast.error(t("workspace.tabs.toasts.copyFailed"));
      }
    },
    [normalizedServerId, toast, t],
  );

  const handleReloadAgent = useCallback(
    async (agentId: string) => {
      if (!client || !isConnected) {
        toast.error(t("workspace.terminal.hostDisconnected"));
        return;
      }

      toast.show(t("workspace.tabs.toasts.reloadingAgent"), { durationMs: null });
      try {
        await client.refreshAgent(agentId);
        // Send the existing cursor so the server detects the new epoch and
        // returns reset:true. Without a cursor, the server returns reset:false
        // and the client takes the incremental path, where new-epoch rows are
        // dropped against the stale cursor.
        const sessionState = useSessionStore.getState().sessions[normalizedServerId];
        const currentCursor = sessionState?.agentTimelineCursor.get(agentId);
        await getHostRuntimeStore().fetchAgentTimeline(normalizedServerId, agentId, {
          ...planTimelineTailFetch(),
          ...(currentCursor
            ? { cursor: { epoch: currentCursor.epoch, seq: currentCursor.endSeq } }
            : {}),
        });
        toast.show(t("workspace.tabs.toasts.reloadedAgent"), { variant: "success" });
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : t("workspace.tabs.toasts.failedToReloadAgent"),
        );
      }
    },
    [client, isConnected, normalizedServerId, toast, t],
  );

  const handleCopyWorkspacePath = useCallback(async () => {
    if (!workspaceDirectory) {
      toast.error(t("workspace.header.toasts.workspacePathUnavailable"));
      return;
    }

    try {
      await Clipboard.setStringAsync(workspaceDirectory);
      toast.copied(t("workspace.header.toasts.workspacePathCopiedLabel"));
    } catch {
      toast.error(t("workspace.tabs.toasts.copyFailed"));
    }
  }, [toast, workspaceDirectory, t]);

  const handleCopyBranchName = useCallback(async () => {
    if (!currentBranchName) {
      toast.error(t("workspace.header.toasts.branchNameUnavailable"));
      return;
    }

    try {
      await Clipboard.setStringAsync(currentBranchName);
      toast.copied(t("workspace.header.toasts.branchNameCopiedLabel"));
    } catch {
      toast.error(t("workspace.tabs.toasts.copyFailed"));
    }
  }, [currentBranchName, toast, t]);

  const handleOpenSetupTab = useCallback(() => {
    if (!persistenceKey) {
      return;
    }
    const target = normalizeWorkspaceTabTarget({
      kind: "setup",
      workspaceId: normalizedWorkspaceId,
    });
    if (!target) {
      return;
    }
    openWorkspaceTabFocused(persistenceKey, target, FOCUSED_PANE_PLACEMENT);
  }, [normalizedWorkspaceId, openWorkspaceTabFocused, persistenceKey]);

  const handleBulkCloseTabs = useCallback(
    async (input: {
      tabsToClose: WorkspaceTabDescriptor[];
      title: string;
      logLabel: string;
    }): Promise<boolean> => {
      const { title, logLabel } = input;
      const tabsToClose = input.tabsToClose.filter((tab) => !isDraftTabSubmitting(tab.target));
      if (tabsToClose.length === 0) {
        return true;
      }

      const session = useSessionStore.getState().sessions[normalizedServerId];
      const groups = classifyBulkClosableTabs(tabsToClose, (agentId) => {
        const agent = session?.agents.get(agentId) ?? session?.agentDetails.get(agentId);
        if (!agent) return "layout-only";
        const policy = resolveCloseAgentTabPolicy(agent, { isTopicWorkspace }).kind;
        return policy === "archive-on-close" ? "archive" : policy;
      });
      const hasMainWithDescendants =
        session !== undefined &&
        groups.archiveAgentTabs.some(({ agentId }) => {
          const agent = session.agents.get(agentId);
          return (
            Boolean(agent && isMainControlAgent(agent)) &&
            hasUnarchivedWorkspaceDescendants(session, agentId, normalizedWorkspaceId)
          );
        });
      const modifiedCount = tabsToClose.filter(
        (tab) =>
          getPanelInstanceAttributes({
            serverId: normalizedServerId,
            workspaceId: normalizedWorkspaceId,
            tabId: tab.tabId,
          }).modified,
      ).length;
      const bulkMessage = buildBulkCloseConfirmationMessage(groups, bulkCloseConfirmationLabels);
      const confirmationParts = [bulkMessage];
      if (hasMainWithDescendants) {
        confirmationParts.push(hierarchyLabels.archiveMessage);
      }
      if (modifiedCount > 0) {
        confirmationParts.push(
          t("workspace.tabs.confirmations.bulkUnsaved", { count: modifiedCount }),
        );
      }
      const confirmed = await confirmDialog({
        title,
        message: confirmationParts.join("\n\n"),
        confirmLabel: t("workspace.tabs.confirmations.close"),
        cancelLabel: t("workspace.tabs.confirmations.cancel"),
        destructive: hasDestructiveBulkCloseTabs(groups),
      });
      if (!confirmed) {
        return false;
      }

      await closeBulkWorkspaceTabs({
        client,
        groups,
        workspaceId: normalizedWorkspaceId,
        closeTab,
        closeSideChat: discardEmptySideChat,
        closeLayoutOnlyAgent: async (agentId) => {
          const current = useSessionStore.getState().sessions[normalizedServerId];
          const agent = current?.agents.get(agentId) ?? current?.agentDetails.get(agentId);
          if (
            !agent ||
            resolveCloseAgentTabPolicy(agent, { isTopicWorkspace }).kind !== "layout-only"
          ) {
            return;
          }
          if (!client) {
            throw new Error(t("common.errors.daemonClientUnavailable"));
          }
          const shouldArchive = await clearSubagentOpenTabLabel({
            client,
            agentId,
            serverId: normalizedServerId,
            workspaceId: normalizedWorkspaceId,
          });
          if (shouldArchive && !isTopicWorkspace) {
            await archiveAgent({
              serverId: normalizedServerId,
              agentId,
              expectedWorkspaceId: normalizedWorkspaceId,
            });
          }
        },
        closeWorkspaceTabWithCleanup: (cleanupInput) => {
          if (!persistenceKey) {
            return;
          }
          closeWorkspaceTabWithCleanup(cleanupInput);
        },
        logLabel,
        warn: (message, payload) => {
          console.warn(message, payload);
        },
      });

      const closedKeys = new Set(tabsToClose.map((tab) => tab.key));
      setHoveredCloseTabKey((current) => (current && closedKeys.has(current) ? null : current));
      return true;
    },
    [
      archiveAgent,
      bulkCloseConfirmationLabels,
      discardEmptySideChat,
      client,
      closeTab,
      closeWorkspaceTabWithCleanup,
      hierarchyLabels,
      isTopicWorkspace,
      normalizedServerId,
      normalizedWorkspaceId,
      persistenceKey,
      t,
    ],
  );

  const handleCloseTabsToLeftInPane = useCallback(
    async (tabId: string, paneTabs: WorkspaceTabDescriptor[]) => {
      await handleBulkCloseTabs({
        tabsToClose: getWorkspaceBulkCloseTargets(paneTabs, tabId, "before", mainAgentId),
        title: t("workspace.tabs.confirmations.closeTabsLeftTitle"),
        logLabel: "to the left",
      });
    },
    [handleBulkCloseTabs, mainAgentId, t],
  );

  const handleCloseTabsToLeft = useCallback(
    async (tabId: string) => {
      await handleCloseTabsToLeftInPane(tabId, tabs);
    },
    [handleCloseTabsToLeftInPane, tabs],
  );

  const handleCloseTabsToRightInPane = useCallback(
    async (tabId: string, paneTabs: WorkspaceTabDescriptor[]) => {
      await handleBulkCloseTabs({
        tabsToClose: getWorkspaceBulkCloseTargets(paneTabs, tabId, "after", mainAgentId),
        title: t("workspace.tabs.confirmations.closeTabsRightTitle"),
        logLabel: "to the right",
      });
    },
    [handleBulkCloseTabs, mainAgentId, t],
  );

  const handleCloseTabsToRight = useCallback(
    async (tabId: string) => {
      await handleCloseTabsToRightInPane(tabId, tabs);
    },
    [handleCloseTabsToRightInPane, tabs],
  );

  const handleCloseOtherTabsInPane = useCallback(
    async (tabId: string, paneTabs: WorkspaceTabDescriptor[]) => {
      await handleBulkCloseTabs({
        tabsToClose: getWorkspaceBulkCloseTargets(paneTabs, tabId, "others", mainAgentId),
        title: t("workspace.tabs.confirmations.closeOtherTabsTitle"),
        logLabel: "from close other tabs",
      });
    },
    [handleBulkCloseTabs, mainAgentId, t],
  );

  const handleCloseOtherTabs = useCallback(
    async (tabId: string) => {
      await handleCloseOtherTabsInPane(tabId, tabs);
    },
    [handleCloseOtherTabsInPane, tabs],
  );

  const handleClosePane = useCallback(
    async (paneId: string) => {
      if (!persistenceKey || !workspaceLayout) {
        return;
      }
      const pane = findPaneById(workspaceLayout.root, paneId);
      // Ask before tearing anything down. The layout refuses to dismiss the final
      // visible pane, and discovering that after closing its tabs would cost the
      // user the tabs and leave the pane standing.
      if (!pane || !canDismissPaneInLayout(workspaceLayout, paneId, explorerSidebarPaneId)) {
        return;
      }
      const tabsToClose = pane.tabIds.flatMap((tabId) => {
        const tab = allTabDescriptorsById.get(tabId);
        return tab ? [tab] : [];
      });
      if (tabsToClose.some((tab) => isDraftTabSubmitting(tab.target))) {
        return;
      }
      const closed = await handleBulkCloseTabs({
        tabsToClose,
        title: t("workspace.tabs.confirmations.closePaneTitle"),
        logLabel: "from pane close",
      });
      if (!closed) {
        return;
      }
      const layoutStore = useWorkspaceLayoutStore.getState();
      const latestLayout = layoutStore.layoutByWorkspace[persistenceKey];
      const latestPane = latestLayout && findPaneById(latestLayout.root, paneId);
      if (
        latestPane &&
        layoutStore
          .getWorkspaceTabs(persistenceKey)
          .some((tab) => latestPane.tabIds.includes(tab.tabId) && isDraftTabSubmitting(tab.target))
      ) {
        return;
      }
      closeWorkspacePane(persistenceKey, paneId);
    },
    [
      allTabDescriptorsById,
      closeWorkspacePane,
      handleBulkCloseTabs,
      persistenceKey,
      t,
      workspaceLayout,
      explorerSidebarPaneId,
    ],
  );

  const handleWorkspacePanelOpenAction = useCallback(
    (action: KeyboardActionDefinition): boolean => {
      if (action.id !== "workspace.tab.open") return false;
      if (!persistenceKey) return true;

      const target = resolveCommandCenterPanelTarget(action.target);
      if (action.placement === "supporting") {
        if (action.target === "files" || action.target === "changes") {
          openExplorerSidebarView({
            isCompact: isMobile,
            workspaceKey: persistenceKey,
            view: action.target === "files" ? "files" : "changes",
          });
          return true;
        }
        if (action.target === "pull-request") {
          openWorkspacePullRequest({
            isCompact: isMobile,
            workspaceKey: persistenceKey,
            destination: pullRequestOpenLocation,
          });
          return true;
        }
        openWorkspaceTabFocused(persistenceKey, target, FOCUSED_PANE_PLACEMENT);
        return true;
      }
      if (action.placement === "side-pane") {
        openWorkspaceTargetBeside({
          workspaceKey: persistenceKey,
          target,
        });
        return true;
      }
      const focusedPaneId = focusedPaneTabState.pane?.id;
      openWorkspaceTabFocused(
        persistenceKey,
        target,
        focusedPaneId ? { mode: "pane", paneId: focusedPaneId } : undefined,
      );
      return true;
    },
    [
      focusedPaneTabState.pane?.id,
      isMobile,
      openWorkspaceTabFocused,
      persistenceKey,
      pullRequestOpenLocation,
    ],
  );

  const handleWorkspaceCurrentTabMetadataAction = useCallback(
    (action: KeyboardActionDefinition): boolean => {
      const descriptor = activeTab?.descriptor;
      switch (action.id) {
        case "workspace.tab.rename-current":
          if (descriptor) handleRenameTab(descriptor);
          return true;
        case "workspace.tab.reload-current":
          if (descriptor?.target.kind === "agent")
            void handleReloadAgent(descriptor.target.agentId);
          return true;
        case "workspace.tab.copy-resume-command":
          if (descriptor?.target.kind === "agent") {
            void handleCopyResumeCommand(descriptor.target.agentId);
          }
          return true;
        case "workspace.tab.copy-id":
          if (descriptor?.target.kind === "agent")
            void handleCopyAgentId(descriptor.target.agentId);
          if (descriptor?.target.kind === "terminal") {
            void handleCopyTerminalId(descriptor.target.terminalId);
          }
          return true;
        case "workspace.tab.copy-file-path":
          if (descriptor?.target.kind === "file") void handleCopyFilePath(descriptor.target.path);
          return true;
        default:
          return false;
      }
    },
    [
      activeTab,
      handleCopyAgentId,
      handleCopyFilePath,
      handleCopyResumeCommand,
      handleCopyTerminalId,
      handleReloadAgent,
      handleRenameTab,
    ],
  );

  const handleWorkspaceCurrentTabCloseAction = useCallback(
    (action: KeyboardActionDefinition): boolean => {
      if (!activeTabId) return true;
      if (action.id === "workspace.tab.close-left") {
        void handleCloseTabsToLeft(activeTabId);
        return true;
      }
      if (action.id === "workspace.tab.close-right") {
        void handleCloseTabsToRight(activeTabId);
        return true;
      }
      if (action.id === "workspace.tab.close-others") {
        void handleCloseOtherTabs(activeTabId);
        return true;
      }
      return false;
    },
    [activeTabId, handleCloseOtherTabs, handleCloseTabsToLeft, handleCloseTabsToRight],
  );

  const handleWorkspaceTabAction = useCallback(
    (action: KeyboardActionDefinition): boolean => {
      switch (action.id) {
        case "workspace.agent.new":
          handleCreateDraftTab();
          return true;
        case "workspace.terminal.new":
          handleCreateTerminal();
          return true;
        case "workspace.browser.new":
          handleCreateBrowserTab();
          return true;
        case "workspace.tab.menu.open":
          handleCreateNewTab({ paneId: focusedPaneTabState.pane?.id });
          return true;
        case "workspace.tab.close-current":
          if (activeTabId) {
            void handleCloseTabById(activeTabId);
          }
          return true;
        case "workspace.tab.navigate-index": {
          const next = tabs[action.index - 1] ?? null;
          if (next?.tabId) {
            navigateToTabId(next.tabId);
          }
          return true;
        }
        case "workspace.tab.navigate-relative": {
          if (tabs.length > 0) {
            const currentIndex = tabs.findIndex((tab) => tab.tabId === activeTabId);
            const fromIndex = currentIndex >= 0 ? currentIndex : 0;
            const nextIndex = (fromIndex + action.delta + tabs.length) % tabs.length;
            const next = tabs[nextIndex] ?? null;
            if (next?.tabId) {
              navigateToTabId(next.tabId);
            }
          }
          return true;
        }
        default:
          return false;
      }
    },
    [
      activeTabId,
      handleCloseTabById,
      handleCreateDraftTab,
      handleCreateBrowserTab,
      handleCreateNewTab,
      handleCreateTerminal,
      focusedPaneTabState.pane?.id,
      navigateToTabId,
      tabs,
    ],
  );

  const handleWorkspaceDirectTargetAction = useCallback(
    (action: KeyboardActionDefinition): boolean => {
      const paneId = focusedPaneTabState.pane?.id;
      switch (action.id) {
        case "workspace.tab.target.agent":
          handleCreateDraftTab({ paneId });
          return true;
        case "workspace.tab.target.browser":
          handleCreateBrowserTab({ paneId });
          return true;
        case "workspace.tab.target.changes":
          if (persistenceKey && isGitCheckout) {
            openExplorerSidebarView({
              isCompact: isMobile,
              workspaceKey: persistenceKey,
              view: "changes",
            });
          }
          return true;
        case "workspace.tab.target.files":
          if (persistenceKey) {
            openExplorerSidebarView({
              isCompact: isMobile,
              workspaceKey: persistenceKey,
              view: "files",
            });
          }
          return true;
        default:
          return false;
      }
    },
    [
      focusedPaneTabState.pane?.id,
      handleCreateBrowserTab,
      handleCreateDraftTab,
      isGitCheckout,
      isMobile,
      persistenceKey,
    ],
  );

  const handleWorkspaceSidebarAction = useCallback(
    (action: KeyboardActionDefinition): boolean => {
      if (action.id === "sidebar.toggle.right") {
        handleToggleExplorerSidebar();
        return true;
      }
      if (action.id !== "sidebar.toggle.both") {
        return false;
      }
      // This screen owns the layout key and the checkout, so it is the only
      // place that can read "is the explorer open" correctly.
      const panel = usePanelStore.getState();
      toggleDesktopSidebarsWithCheckoutIntent({
        isAgentListOpen: selectIsAgentListOpen(panel, { isCompact: isMobile }),
        isExplorerOpen: isExplorerSidebarOpen({
          isCompact: isMobile,
          workspaceKey: persistenceKey,
        }),
        openAgentList: () => panel.openAgentListForLayout({ isCompact: isMobile }),
        closeAgentList: () => panel.closeAgentListForLayout({ isCompact: isMobile }),
        toggleExplorer: handleToggleExplorerSidebar,
      });
      return true;
    },
    [handleToggleExplorerSidebar, isMobile, persistenceKey],
  );

  const handleWorkspacePaneAction = useCallback(
    (action: KeyboardActionDefinition): boolean => {
      if (action.id === "workspace.focus.toggle") {
        toggleFocusMode();
        return true;
      }

      if (!persistenceKey || !workspaceLayout) {
        return true;
      }

      const focusedPane = focusedPaneTabState.pane;
      if (!focusedPane) {
        return true;
      }

      if (action.id === "workspace.pane.split.right") {
        handleCreateEmptySplit({
          targetPaneId: focusedPane.id,
          position: "right",
        });
        return true;
      }

      if (action.id === "workspace.pane.split.down") {
        handleCreateEmptySplit({
          targetPaneId: focusedPane.id,
          position: "bottom",
        });
        return true;
      }

      if (action.id.startsWith("workspace.pane.focus.")) {
        const direction = parsePaneDirection(action.id);
        if (direction) {
          const adjacentPaneId = findAdjacentPane(workspaceLayout.root, focusedPane.id, direction);
          if (adjacentPaneId) {
            focusWorkspacePane(persistenceKey, adjacentPaneId);
          }
        }
        return true;
      }

      if (action.id.startsWith("workspace.pane.move-tab.")) {
        const direction = parsePaneDirection(action.id);
        if (direction) {
          const activePaneTabId = focusedPaneTabState.activeTabId;
          const adjacentPaneId = findAdjacentPane(workspaceLayout.root, focusedPane.id, direction);
          if (activePaneTabId && adjacentPaneId) {
            paneFocusSuppressedRef.current = true;
            moveWorkspaceTabToPane(persistenceKey, activePaneTabId, adjacentPaneId);
            requestAnimationFrame(() => {
              paneFocusSuppressedRef.current = false;
            });
          }
        }
        return true;
      }

      if (action.id === "workspace.pane.close") {
        void handleClosePane(focusedPane.id);
        return true;
      }

      return false;
    },
    [
      focusWorkspacePane,
      handleClosePane,
      handleCreateEmptySplit,
      moveWorkspaceTabToPane,
      persistenceKey,
      focusedPaneTabState.activeTabId,
      focusedPaneTabState.pane,
      toggleFocusMode,
      workspaceLayout,
    ],
  );

  // Shared by every handler below: these actions only exist on a focused workspace route.
  const workspaceActionsEnabled = Boolean(
    isRouteFocused && normalizedServerId && normalizedWorkspaceId,
  );

  useKeyboardActionHandler({
    handlerId: buildWorkspaceKeyboardHandlerId({
      name: "workspace-tab-actions",
      serverId: normalizedServerId,
      workspaceId: normalizedWorkspaceId,
    }),
    actions: [
      "workspace.agent.new",
      "workspace.tab.close-current",
      "workspace.tab.navigate-index",
      "workspace.tab.navigate-relative",
      "workspace.terminal.new",
      "workspace.browser.new",
      "workspace.tab.menu.open",
    ] as const,
    enabled: workspaceActionsEnabled,
    priority: 100,
    isActive: () => true,
    handle: handleWorkspaceTabAction,
  });

  useKeyboardActionHandler({
    handlerId: buildWorkspaceKeyboardHandlerId({
      name: "workspace-direct-target-actions",
      serverId: normalizedServerId,
      workspaceId: normalizedWorkspaceId,
    }),
    actions: [
      "workspace.tab.target.agent",
      "workspace.tab.target.browser",
      "workspace.tab.target.changes",
      "workspace.tab.target.files",
    ] as const,
    enabled: workspaceActionsEnabled,
    priority: 100,
    isActive: () => true,
    handle: handleWorkspaceDirectTargetAction,
  });

  useKeyboardActionHandler({
    handlerId: buildWorkspaceKeyboardHandlerId({
      name: "workspace-panel-open-actions",
      serverId: normalizedServerId,
      workspaceId: normalizedWorkspaceId,
    }),
    actions: ["workspace.tab.open"] as const,
    enabled: workspaceActionsEnabled,
    priority: 100,
    isActive: () => true,
    handle: handleWorkspacePanelOpenAction,
  });

  useKeyboardActionHandler({
    handlerId: buildWorkspaceKeyboardHandlerId({
      name: "workspace-current-tab-metadata-actions",
      serverId: normalizedServerId,
      workspaceId: normalizedWorkspaceId,
    }),
    actions: [
      "workspace.tab.rename-current",
      "workspace.tab.reload-current",
      "workspace.tab.copy-resume-command",
      "workspace.tab.copy-id",
      "workspace.tab.copy-file-path",
    ] as const,
    enabled: workspaceActionsEnabled,
    priority: 100,
    isActive: () => true,
    handle: handleWorkspaceCurrentTabMetadataAction,
  });

  useKeyboardActionHandler({
    handlerId: buildWorkspaceKeyboardHandlerId({
      name: "workspace-current-tab-close-actions",
      serverId: normalizedServerId,
      workspaceId: normalizedWorkspaceId,
    }),
    actions: [
      "workspace.tab.close-left",
      "workspace.tab.close-right",
      "workspace.tab.close-others",
    ] as const,
    enabled: workspaceActionsEnabled,
    priority: 100,
    isActive: () => true,
    handle: handleWorkspaceCurrentTabCloseAction,
  });

  useKeyboardActionHandler({
    handlerId: buildWorkspaceKeyboardHandlerId({
      name: "workspace-pane-actions",
      serverId: normalizedServerId,
      workspaceId: normalizedWorkspaceId,
    }),
    actions: [
      "workspace.pane.split.right",
      "workspace.pane.split.down",
      "workspace.pane.focus.left",
      "workspace.pane.focus.right",
      "workspace.pane.focus.up",
      "workspace.pane.focus.down",
      "workspace.pane.move-tab.left",
      "workspace.pane.move-tab.right",
      "workspace.pane.move-tab.up",
      "workspace.pane.move-tab.down",
      "workspace.pane.close",
      "workspace.focus.toggle",
    ] as const,
    enabled: workspaceActionsEnabled,
    priority: 100,
    isActive: () => true,
    handle: handleWorkspacePaneAction,
  });

  useKeyboardActionHandler({
    handlerId: buildWorkspaceKeyboardHandlerId({
      name: "workspace-sidebar-actions",
      serverId: normalizedServerId,
      workspaceId: normalizedWorkspaceId,
    }),
    actions: ["sidebar.toggle.right", "sidebar.toggle.both"] as const,
    enabled: workspaceActionsEnabled,
    priority: 100,
    isActive: () => true,
    handle: handleWorkspaceSidebarAction,
  });

  // Gated on the same predicate as the header menu item, so the command center never lists a
  // Show setup entry the menu would hide.
  // Gated by isActive so the handler is only dispatched when the workspace has visible setup;
  // the command center contribution is separately gated by canShowSetup in workspace-registration.
  useKeyboardActionHandler({
    handlerId: `workspace-setup-show:${normalizedServerId}:${normalizedWorkspaceId}`,
    actions: ["workspace.setup.show"] as const,
    enabled: workspaceActionsEnabled,
    priority: 100,
    isActive: () => showWorkspaceSetup,
    handle: () => {
      handleOpenSetupTab();
      return true;
    },
  });

  const activeTabDescriptor = useMemo(() => activeTab?.descriptor ?? null, [activeTab]);
  const activeFileFields = getWorkspaceFileLocationFields(activeTabDescriptor);
  const activeFilePath = activeFileFields.path;
  const activeFileLineStart = activeFileFields.lineStart;
  const activeFileLineEnd = activeFileFields.lineEnd;
  const activeFileLocation = useMemo<WorkspaceFileLocation | null>(
    () =>
      buildWorkspaceFileLocation({
        path: activeFilePath,
        lineStart: activeFileLineStart,
        lineEnd: activeFileLineEnd,
      }),
    [activeFileLineEnd, activeFileLineStart, activeFilePath],
  );
  const shouldRenderDesktopPaneFallback = useMemo(
    () => !isMobile && !canRenderDesktopPaneSplits,
    [isMobile, canRenderDesktopPaneSplits],
  );
  useEffect(() => {
    if (!isRouteFocused || isNative || typeof document === "undefined" || activeTabDescriptor) {
      return;
    }
    document.title = "Workspace";
  }, [activeTabDescriptor, isRouteFocused]);
  const buildPaneContentModel = useCallback(
    (input: {
      tab: WorkspaceTabDescriptor;
      paneId?: string | null;
      focusPaneBeforeOpen?: boolean;
      host?: PaneHost;
      /** Overrides the guarded tab close, for a host that closes the tab its own way. */
      onCloseCurrentTab?: () => void;
    }) =>
      buildWorkspacePaneContentModel({
        tab: input.tab,
        normalizedServerId,
        normalizedWorkspaceId,
        host:
          input.host ??
          (input.paneId !== null && input.paneId === explorerSidebarPaneId ? "explorer" : "main"),
        panelRevision: panelRevisions?.[input.tab.tabId] ?? 0,
        onOpenTab: (target) => {
          if (!persistenceKey) {
            return;
          }
          const tabId = revealWorkspaceChildTab(
            persistenceKey,
            target,
            input.tab.tabId,
            paneLocalPlacement(input.focusPaneBeforeOpen ? input.paneId : null),
          );
          if (tabId) {
            navigateToTabId(tabId);
          }
        },
        onOpenPreferredTarget: (target, source) => {
          if (!persistenceKey) return;
          openPreferredWorkspacePreview({
            workspaceKey: persistenceKey,
            serverId: normalizedServerId,
            workspaceId: normalizedWorkspaceId,
            explorerSidebarPaneId,
            lastMainPaneId,
            target,
            source,
            preferences: openInSidePane,
          });
        },
        onOpenTargetToSide:
          canRenderDesktopPaneSplits &&
          input.paneId !== null &&
          input.paneId === explorerSidebarPaneId
            ? (target) => {
                if (!persistenceKey) return;
                openWorkspaceTargetBeside({
                  workspaceKey: persistenceKey,
                  target,
                  parentTabId: input.tab.tabId,
                });
              }
            : undefined,
        onCloseCurrentTab:
          input.onCloseCurrentTab ??
          (() => {
            void handleCloseTabById(input.tab.tabId);
          }),
        onRetargetCurrentTab: (target) => {
          if (!persistenceKey) {
            return;
          }
          const replaced = replaceWorkspaceTabTarget(persistenceKey, input.tab.tabId, target);
          if (replaced === null && target.kind === "agent") {
            revealCreatedDraftAgentTab({
              workspaceKey: persistenceKey,
              target,
              preferences: openInSidePane,
            });
          }
        },
        onSetCurrentTabState: (state) => {
          if (persistenceKey) {
            setWorkspaceTabState(persistenceKey, input.tab.tabId, state);
          }
        },
        onOpenWorkspaceFile: (request: WorkspaceFileOpenRequest) => {
          handleOpenWorkspaceFileFromPane({
            request,
            paneId: input.paneId,
            parentTabId: input.tab.tabId,
            focusPaneBeforeOpen: input.focusPaneBeforeOpen,
          });
        },
        onOpenImportSheet: openImportSheet,
      }),
    [
      handleCloseTabById,
      panelRevisions,
      handleOpenWorkspaceFileFromPane,
      navigateToTabId,
      normalizedServerId,
      normalizedWorkspaceId,
      canRenderDesktopPaneSplits,
      openImportSheet,
      openInSidePane,
      revealWorkspaceChildTab,
      persistenceKey,
      replaceWorkspaceTabTarget,
      setWorkspaceTabState,
      explorerSidebarPaneId,
      lastMainPaneId,
    ],
  );
  const focusedPaneId = useMemo(
    () => focusedPaneTabState.pane?.id ?? null,
    [focusedPaneTabState.pane],
  );
  const focusedPaneTabIds = useMemo(() => tabs.map((tab) => tab.tabId), [tabs]);
  const modifiedFocusedPaneTabIds = useModifiedPanelTabIds({
    serverId: normalizedServerId,
    workspaceId: normalizedWorkspaceId,
    tabIds: focusedPaneTabIds,
  });
  const focusedPaneTabDescriptorMap = useStableTabDescriptorMap(tabs);
  const { mountedTabIds: mountedFocusedPaneTabIdsSet } = useMountedTabSet({
    activeTabId,
    allTabIds: focusedPaneTabIds,
    retainedTabIds: modifiedFocusedPaneTabIds,
    cap: 3,
  });
  const mountedFocusedPaneTabIds = useMemo(
    () => focusedPaneTabIds.filter((tabId) => mountedFocusedPaneTabIdsSet.has(tabId)),
    [focusedPaneTabIds, mountedFocusedPaneTabIdsSet],
  );
  const buildMobilePaneContentModel = useCallback(
    function buildMobilePaneContentModel(input: {
      paneId: string | null;
      tab: WorkspaceTabDescriptor;
    }) {
      return buildPaneContentModel({
        tab: input.tab,
        paneId: input.paneId,
        focusPaneBeforeOpen: false,
      });
    },
    [buildPaneContentModel],
  );
  const buildSheetPaneContentModel = useCallback(
    function buildSheetPaneContentModel(tab: WorkspaceTabDescriptor, closeCurrentTab: () => void) {
      return buildPaneContentModel({
        tab,
        paneId: null,
        focusPaneBeforeOpen: false,
        host: "sheet",
        onCloseCurrentTab: closeCurrentTab,
      });
    },
    [buildPaneContentModel],
  );
  const sheetPaneHost = useMemo<SheetPaneHost | null>(
    () =>
      persistenceKey
        ? {
            workspaceKey: persistenceKey,
            serverId: normalizedServerId,
            workspaceId: normalizedWorkspaceId,
            isWorkspaceFocused: isRouteFocused,
            buildContent: buildSheetPaneContentModel,
          }
        : null,
    [
      buildSheetPaneContentModel,
      isRouteFocused,
      normalizedServerId,
      normalizedWorkspaceId,
      persistenceKey,
    ],
  );
  const handleFocusPane = useStableEvent(function handleFocusPane(paneId: string) {
    if (!persistenceKey || paneFocusSuppressedRef.current) {
      return;
    }
    focusWorkspacePane(persistenceKey, paneId);
  });
  const openTopicQuestion = useStableEvent((draftId: string) => {
    if (
      !isTopicFirstQuestionDraft(draftId, normalizedServerId, normalizedWorkspaceId) ||
      !selectHostFeature(useSessionStore.getState(), normalizedServerId, "topicWorkbenchV1")
    ) {
      return;
    }
    openWorkspaceDraftTab({
      draftId,
      paneId: lastMainPaneId ?? DEFAULT_PANE_ID,
      standalone: true,
    });
  });
  const askFirstTopicQuestion = useStableEvent(async () => {
    try {
      openTopicQuestion(
        await resolveTopicFirstQuestionDraftId(normalizedServerId, normalizedWorkspaceId),
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  });
  const {
    content: topicEmptyContent,
    placeholderTabId: topicPlaceholderTabId,
    withoutTab: topicWithoutTab,
  } = useUnboundTopicContent({
    topicWorkspace,
    canOpenDraft: Boolean(persistenceKey),
    hasHydratedLayout: hasHydratedWorkspaceLayoutStore,
    hasHydratedAgents,
    mainAgentId,
    descriptor: workspaceDescriptor,
    layout: workspaceLayout,
    explorerPaneId: explorerSidebarPaneId,
    tabs: uiTabs,
    onAsk: askFirstTopicQuestion,
  });
  const [gitGraphIntentStore] = useState(createGitGraphNavigationIntentStore);
  useEffect(() => {
    if (persistenceKey === null) {
      gitGraphIntentStore.clear();
      return;
    }
    return () => {
      gitGraphIntentStore.clear();
    };
  }, [gitGraphIntentStore, persistenceKey]);
  const {
    handleOpenGitGraph,
    handleFocusAttentionAgent,
    handleOpenDirectoryAgent,
    handleOpenDirectoryAgentBeside,
    handleOpenProviderSubrun,
  } = useWorkspaceTeamDirectoryActions({
    serverId: normalizedServerId,
    workspaceId: normalizedWorkspaceId,
    persistenceKey,
    lastMainPaneId,
    isTeamDirectoryOverlay,
    hideTeamDirectory,
    showTeamDirectory,
    openInSidePane,
    gitGraphIntentStore,
    openWorkspaceTabFocused,
  });
  const content = renderWorkspaceContent({
    topicEmptyContent,
    topicPlaceholderTabId,
    isMissingWorkspaceDirectory,
    activeTabDescriptor,
    hasHydratedAgents,
    hasLoadedTerminals: terminalsQuery.isSuccess,
    mountedFocusedPaneTabIds,
    focusedPaneTabDescriptorMap,
    isRouteFocused,
    focusedPaneId,
    paneFocusSuspended,
    onFocusPane: handleFocusPane,
    buildMobilePaneContentModel,
  });

  const buildDesktopPaneContentModel = useCallback(
    function buildDesktopPaneContentModel(input: { paneId: string; tab: WorkspaceTabDescriptor }) {
      const model = buildPaneContentModel({
        tab: input.tab,
        paneId: input.paneId,
        focusPaneBeforeOpen: true,
      });
      return input.tab.tabId === topicPlaceholderTabId
        ? { ...model, Component: TopicEmptyTabContent }
        : model;
    },
    [buildPaneContentModel, topicPlaceholderTabId],
  );

  const desktopTabRowItems = useMemo<WorkspaceDesktopTabRowItem[]>(
    () =>
      tabs.map((tab) => ({
        tab,
        isActive: tab.tabId === activeTabDescriptor?.tabId,
        isCloseHovered: hoveredCloseTabKey === tab.key,
        isClosingTab: closingTabIds.has(tab.tabId),
      })),
    [activeTabDescriptor?.tabId, closingTabIds, hoveredCloseTabKey, tabs],
  );

  const handleSplitPane = useCallback(
    function handleSplitPane(input: {
      tabId: string;
      targetPaneId: string;
      position: "left" | "right" | "top" | "bottom";
    }) {
      if (!persistenceKey) {
        return;
      }
      splitWorkspacePane(persistenceKey, input);
    },
    [persistenceKey, splitWorkspacePane],
  );

  const handleMoveTabToPane = useCallback(
    function handleMoveTabToPane(tabId: string, toPaneId: string) {
      if (!persistenceKey) {
        return;
      }
      moveWorkspaceTabToPane(persistenceKey, tabId, toPaneId);
    },
    [moveWorkspaceTabToPane, persistenceKey],
  );

  const handleResizePaneSplit = useCallback(
    function handleResizePaneSplit(groupId: string, sizes: number[]) {
      if (!persistenceKey) {
        return;
      }
      resizeWorkspaceSplit(persistenceKey, groupId, sizes);
    },
    [persistenceKey, resizeWorkspaceSplit],
  );

  const handleReorderTabsInPane = useCallback(
    function handleReorderTabsInPane(paneId: string, tabIds: string[]) {
      if (!persistenceKey) {
        return;
      }
      const mainTab = mainAgentId
        ? uiTabs.find((tab) => isWorkspaceMainTab(tab, mainAgentId))
        : null;
      reorderWorkspaceTabsInPane(
        persistenceKey,
        paneId,
        pinWorkspaceMainTabIds(tabIds, mainTab?.tabId),
      );
    },
    [mainAgentId, persistenceKey, reorderWorkspaceTabsInPane, uiTabs],
  );

  const handleReorderTabsInFocusedPane = useCallback(
    (nextTabs: WorkspaceTabDescriptor[]) => {
      if (!focusedPaneId) {
        return;
      }
      handleReorderTabsInPane(
        focusedPaneId,
        nextTabs.map((tab) => tab.tabId),
      );
    },
    [focusedPaneId, handleReorderTabsInPane],
  );

  const containerStyle = [styles.container, styles.containerWorkspaceBackground];

  const workspaceScreenGate = renderWorkspaceRouteGate({
    state: workspaceRouteState,
    actions: {
      onRetryHost: handleRetryHost,
      onManageHost: handleManageHost,
      onDismissMissingWorkspace: handleDismissMissingWorkspace,
      onRecoverWorkspace: workspaceRecovery.restore,
      onRetryRecoveryInspection: workspaceRecovery.retryInspection,
    },
  });
  const gatedWorkspaceScreen = renderWorkspaceScreenGateShell({
    gate: workspaceScreenGate,
    workspaceKey: persistenceKey,
  });

  const explorerControls = useWorkspaceExplorerControls({
    hasWorkspace: !!workspaceDirectory,
    compact: isMobile,
    focusMode: desktopFocusModeEnabled,
    expanded: isExplorerSidebarShowing,
    onToggle: handleToggleExplorerSidebar,
  });
  const headerRight = useMemo(
    () => (
      <View style={styles.headerRight}>
        <PluginHeaderButtons serverId={normalizedServerId} workspaceId={normalizedWorkspaceId} />
        {workspaceDescriptor && workspaceDescriptor.scripts.length > 0 ? (
          <WorkspaceScriptsButton
            actions={scriptActions}
            scripts={workspaceDescriptor.scripts}
            liveTerminalIds={liveTerminalIds}
            onViewTerminal={handleViewScriptTerminal}
            onOpenUrlInBrowserTab={handleOpenUrlInBrowserTab}
            hideLabels
          />
        ) : null}
        {workspaceDirectory ? (
          <WorkspaceOpenInEditorButton
            serverId={normalizedServerId}
            cwd={workspaceDirectory}
            projectId={workspaceDescriptor?.projectId ?? null}
            activeFile={activeFileLocation}
            hideLabels
          />
        ) : null}
        {workspaceDirectory ? (
          <>
            <WorkspaceActions serverId={normalizedServerId} cwd={workspaceDirectory} />
            {workspaceActionsInBar ? null : explorerControls.headerAction}
          </>
        ) : null}
      </View>
    ),
    [
      workspaceDescriptor,
      normalizedServerId,
      normalizedWorkspaceId,
      workspaceDirectory,
      activeFileLocation,
      liveTerminalIds,
      scriptActions,
      handleViewScriptTerminal,
      handleOpenUrlInBrowserTab,
      explorerControls.headerAction,
      workspaceActionsInBar,
    ],
  );

  const showScreenHeader = useMemo(
    () => shouldShowWorkspaceScreenHeader({ isFocusModeEnabled, isMobile }),
    [isFocusModeEnabled, isMobile],
  );
  const createTerminalDisabled = useMemo(
    () => createTerminalMutation.isPending || pendingTerminalCreateInput !== null,
    [createTerminalMutation.isPending, pendingTerminalCreateInput],
  );
  const showCreateBrowserTab = getIsElectron();
  const newTabLauncher = useMemo<NewTabLauncher>(
    () => ({
      hasMainAgent: Boolean(mainAgentId),
      showChanges: isGitCheckout,
      showPullRequest: hasPullRequest,
      showBrowser: showCreateBrowserTab,
      terminalDisabled: createTerminalDisabled,
      launch: launchWorkspaceTab,
    }),
    [
      createTerminalDisabled,
      hasPullRequest,
      isGitCheckout,
      launchWorkspaceTab,
      mainAgentId,
      showCreateBrowserTab,
    ],
  );
  const focusedPaneIdOrUndefined = useMemo(() => focusedPaneId ?? undefined, [focusedPaneId]);
  const workspaceFloatingPanelPortalHostName = useMemo(
    () =>
      `${WORKSPACE_FLOATING_PANEL_PORTAL_HOST_PREFIX}:${normalizedServerId}:${normalizedWorkspaceId}`,
    [normalizedServerId, normalizedWorkspaceId],
  );
  const renderWorkspaceScreenHeader = useCallback(
    () =>
      showScreenHeader ? (
        <>
          <ScreenHeader
            left={
              <>
                <SidebarMenuToggle />
                <WorkspaceHeaderTitleBar
                  isLoading={isWorkspaceHeaderLoading}
                  title={workspaceHeaderTitle}
                  subtitle={workspaceHeaderSubtitle}
                  isSubtitleDistinct={isWorkspaceHeaderSubtitleDistinct}
                  currentBranchName={currentBranchName}
                  normalizedServerId={normalizedServerId}
                  showWorkspaceSetup={showWorkspaceSetup}
                  importAgentDisabled={!canOpenImportSheet}
                  copyPathDisabled={!workspaceDirectory}
                  onOpenImportSheet={openImportSheet}
                  onCopyWorkspacePath={handleCopyWorkspacePath}
                  onCopyBranchName={handleCopyBranchName}
                  onOpenSetupTab={handleOpenSetupTab}
                  onUpgradeToTopic={onUpgradeToTopic}
                />
              </>
            }
            right={headerRight}
          />
          <WorkspaceTopicHeaderSlot
            enabled={hasShellTeamWorkbench}
            serverId={normalizedServerId}
            workspaceId={normalizedWorkspaceId}
            client={client}
            isConnected={isConnected}
            isRouteFocused={isRouteFocused}
            topicWorkspace={topicWorkspace}
            workspaceDirectory={workspaceDirectory}
            isGitCheckout={isGitCheckout}
            currentBranchName={currentBranchName}
            setupStatus={workspaceSetupStatus}
            showWorkspaceSetup={showWorkspaceSetup}
            isCheckoutStatusLoading={isCheckoutStatusLoading}
            teamSummary={teamSummary}
            isDirectoryVisible={isTeamDirectoryVisible}
            onToggleDirectory={toggleTeamDirectory}
            onOpenGitGraph={handleOpenGitGraph}
            onOpenSetupTab={handleOpenSetupTab}
            onFocusAttentionAgent={handleFocusAttentionAgent}
          />
        </>
      ) : null,
    [
      canOpenImportSheet,
      client,
      currentBranchName,
      handleCopyBranchName,
      handleCopyWorkspacePath,
      handleFocusAttentionAgent,
      handleOpenGitGraph,
      handleOpenSetupTab,
      hasShellTeamWorkbench,
      headerRight,
      isCheckoutStatusLoading,
      isConnected,
      isGitCheckout,
      isRouteFocused,
      isTeamDirectoryVisible,
      isWorkspaceHeaderLoading,
      isWorkspaceHeaderSubtitleDistinct,
      normalizedServerId,
      normalizedWorkspaceId,
      onUpgradeToTopic,
      openImportSheet,
      showScreenHeader,
      showWorkspaceSetup,
      teamSummary,
      toggleTeamDirectory,
      topicWorkspace,
      workspaceDirectory,
      workspaceHeaderSubtitle,
      workspaceHeaderTitle,
      workspaceSetupStatus,
    ],
  );
  const compactHeaderScripts = useMemo(
    () => ({
      actions: scriptActions,
      scripts: workspaceScripts,
      liveTerminalIds,
      onViewTerminal: handleViewScriptTerminal,
      onOpenUrlInBrowserTab: handleOpenUrlInBrowserTab,
    }),
    [
      workspaceScripts,
      liveTerminalIds,
      scriptActions,
      handleViewScriptTerminal,
      handleOpenUrlInBrowserTab,
    ],
  );
  const renderWorkspaceTabSwitcher = useCallback(
    ({
      tabs: headerTabs,
      activeTabKey: headerActiveTabKey,
      actions,
    }: WorkspaceCompactHeaderTabs) => {
      return (
        <MobileWorkspaceTabSwitcher
          paneId={actions.pane?.id}
          tabs={headerTabs}
          activeTabKey={headerActiveTabKey}
          normalizedServerId={normalizedServerId}
          normalizedWorkspaceId={normalizedWorkspaceId}
          onSelectSwitcherTab={handleSelectSwitcherTab}
          createTerminalDisabled={createTerminalDisabled}
          onCreateDraftTab={handleCreateDraftTab}
          onCreateTerminal={handleCreateTerminal}
          onCopyResumeCommand={handleCopyResumeCommand}
          onCopyAgentId={handleCopyAgentId}
          onCopyTerminalId={handleCopyTerminalId}
          onCopyFilePath={handleCopyFilePath}
          onReloadAgent={handleReloadAgent}
          onRenameTab={handleRenameTab}
          onCloseTab={handleCloseTabById}
          onCloseTabsAbove={actions.closeAbove}
          onCloseTabsBelow={actions.closeBelow}
          onCloseOtherTabs={actions.closeOthers}
        />
      );
    },
    [
      normalizedServerId,
      normalizedWorkspaceId,
      handleSelectSwitcherTab,
      createTerminalDisabled,
      handleCreateDraftTab,
      handleCreateTerminal,
      handleCopyResumeCommand,
      handleCopyAgentId,
      handleCopyTerminalId,
      handleCopyFilePath,
      handleReloadAgent,
      handleRenameTab,
      handleCloseTabById,
    ],
  );
  const compactTeamDirectory = useMemo(() => {
    if (!isTopicWorkspace && !mainAgentId) return undefined;
    return (close: () => void) => (
      <CompactWorkspaceTeamDirectory
        close={close}
        serverId={normalizedServerId}
        workspaceId={normalizedWorkspaceId}
        mainAgentId={mainAgentId}
        isTopicWorkspace={isTopicWorkspace}
        focusedAgentId={focusedPaneAgentId}
        focusedProviderSubagentId={focusedProviderSubagentId}
        onOpenAgent={handleOpenDirectoryAgent}
        onOpenAgentBeside={handleOpenDirectoryAgentBeside}
        onOpenProviderSubrun={handleOpenProviderSubrun}
        onAskFirstQuestion={isTopicWorkspace ? askFirstTopicQuestion : undefined}
      />
    );
  }, [
    askFirstTopicQuestion,
    focusedPaneAgentId,
    focusedProviderSubagentId,
    handleOpenDirectoryAgent,
    handleOpenDirectoryAgentBeside,
    handleOpenProviderSubrun,
    isTopicWorkspace,
    mainAgentId,
    normalizedServerId,
    normalizedWorkspaceId,
  ]);
  const compactConflictAction = useMemo(
    () => (
      <CompactWorkspaceRebaseConflictAction
        serverId={normalizedServerId}
        client={client}
        isConnected={isConnected}
        isRouteFocused={isRouteFocused}
        workspaceDirectory={workspaceDirectory}
        onOpenGitGraph={handleOpenGitGraph}
      />
    ),
    [
      client,
      handleOpenGitGraph,
      isConnected,
      isRouteFocused,
      normalizedServerId,
      workspaceDirectory,
    ],
  );
  // Without a pane's tabs (above a split) the header carries workspace controls only: split panes
  // keep their tab rails.
  const renderCompactWorkspaceHeader = useCallback(
    (paneTabs: WorkspaceCompactHeaderTabs | null, actionsOnly = false) => {
      const tabSwitcher = paneTabs ? renderWorkspaceTabSwitcher(paneTabs) : null;
      return (
        <CompactWorkspaceHeader
          headerVariant={actionsOnly ? "full" : "compact"}
          isRouteFocused={isRouteFocused}
          isCompact={isMobile}
          tabSwitcher={tabSwitcher}
          inDesktopTitlebar={explorerControls.inDesktopTitlebar}
          explorerAction={explorerControls.compactAction}
          isLoading={isWorkspaceHeaderLoading}
          title={workspaceHeaderTitle}
          subtitle={workspaceHeaderSubtitle}
          isSubtitleDistinct={isWorkspaceHeaderSubtitleDistinct}
          serverId={normalizedServerId}
          compactTeamDirectory={compactTeamDirectory}
          compactConflictAction={compactConflictAction}
        >
          <WorkspaceHeaderMenuMobile
            pane={paneTabs?.actions.pane}
            onExitFocusMode={isFocusModeEnabled ? toggleFocusMode : undefined}
            normalizedServerId={normalizedServerId}
            normalizedWorkspaceId={normalizedWorkspaceId}
            scripts={compactHeaderScripts}
            currentBranchName={currentBranchName}
            showWorkspaceSetup={showWorkspaceSetup}
            showCreateBrowserTab={showCreateBrowserTab}
            createTerminalDisabled={createTerminalDisabled}
            importAgentDisabled={!canOpenImportSheet}
            copyPathDisabled={!workspaceDirectory}
            onCreateTerminalWithProfile={handleCreateTerminalWithProfile}
            onCreateBrowser={handleCreateBrowserTab}
            onOpenImportSheet={openImportSheet}
            onCopyWorkspacePath={handleCopyWorkspacePath}
            onCopyBranchName={handleCopyBranchName}
            onOpenSetupTab={handleOpenSetupTab}
            onUpgradeToTopic={onUpgradeToTopic}
          />
        </CompactWorkspaceHeader>
      );
    },
    [
      renderWorkspaceTabSwitcher,
      explorerControls.inDesktopTitlebar,
      explorerControls.compactAction,
      isFocusModeEnabled,
      toggleFocusMode,
      canOpenImportSheet,
      compactHeaderScripts,
      compactTeamDirectory,
      compactConflictAction,
      createTerminalDisabled,
      currentBranchName,
      handleCopyBranchName,
      handleCopyWorkspacePath,
      handleCreateBrowserTab,
      handleCreateTerminalWithProfile,
      handleOpenSetupTab,
      isMobile,
      isRouteFocused,
      isWorkspaceHeaderLoading,
      isWorkspaceHeaderSubtitleDistinct,
      normalizedServerId,
      normalizedWorkspaceId,
      onUpgradeToTopic,
      openImportSheet,
      showCreateBrowserTab,
      showWorkspaceSetup,
      workspaceDirectory,
      workspaceHeaderSubtitle,
      workspaceHeaderTitle,
    ],
  );
  const workspaceCompactHeaderTabs = {
    tabs,
    activeTabKey,
    actions: {
      closeAbove: handleCloseTabsToLeft,
      closeBelow: handleCloseTabsToRight,
      closeOthers: handleCloseOtherTabs,
    },
  };
  const compactWorkspaceHeader = renderCompactWorkspaceHeader(workspaceCompactHeaderTabs);
  // SplitContainer reserves the corner around its own compact headers; this is the column's.
  const centerColumnCompactHeader = useMemo(
    () => <WindowChromeSafeArea placement="inline">{compactWorkspaceHeader}</WindowChromeSafeArea>,
    [compactWorkspaceHeader],
  );
  const fullWorkspaceActions = renderCompactWorkspaceHeader(workspaceCompactHeaderTabs, true);
  const desktopSplitContent = useMemo(() => {
    if (!canRenderDesktopPaneSplits || !workspaceLayout || !persistenceKey || topicWithoutTab) {
      return null;
    }
    return (
      <SplitContainer
        layout={workspaceLayout}
        renderMainHeader={renderWorkspaceScreenHeader}
        renderCompactHeader={renderCompactWorkspaceHeader}
        focusModeEnabled={desktopFocusModeEnabled}
        onExitFocusMode={toggleFocusMode}
        workspaceKey={persistenceKey}
        normalizedServerId={normalizedServerId}
        normalizedWorkspaceId={normalizedWorkspaceId}
        isWorkspaceFocused={isRouteFocused}
        uiTabs={uiTabs}
        hoveredCloseTabKey={hoveredCloseTabKey}
        setHoveredCloseTabKey={setHoveredCloseTabKey}
        closingTabIds={closingTabIds}
        onNavigateTab={navigateToTabId}
        onCloseTab={handleCloseTabById}
        onCopyResumeCommand={handleCopyResumeCommand}
        onCopyAgentId={handleCopyAgentId}
        onCopyTerminalId={handleCopyTerminalId}
        onCopyFilePath={handleCopyFilePath}
        onReloadAgent={handleReloadAgent}
        onRenameTab={handleRenameTab}
        onCloseTabsToLeft={handleCloseTabsToLeftInPane}
        onCloseTabsToRight={handleCloseTabsToRightInPane}
        onCloseOtherTabs={handleCloseOtherTabsInPane}
        onCreateNewTab={handleCreateNewTab}
        buildPaneContentModel={buildDesktopPaneContentModel}
        onFocusPane={handleFocusPane}
        onSplitPane={handleSplitPane}
        onSplitPaneEmpty={handleCreateEmptySplit}
        onMoveTabToPane={handleMoveTabToPane}
        onSelectTabInPane={selectTabInPane}
        onResizeSplit={handleResizePaneSplit}
        onReorderTabsInPane={handleReorderTabsInPane}
      />
    );
  }, [
    topicWithoutTab,
    canRenderDesktopPaneSplits,
    workspaceLayout,
    renderWorkspaceScreenHeader,
    renderCompactWorkspaceHeader,
    persistenceKey,
    desktopFocusModeEnabled,
    toggleFocusMode,
    normalizedServerId,
    normalizedWorkspaceId,
    isRouteFocused,
    uiTabs,
    hoveredCloseTabKey,
    closingTabIds,
    navigateToTabId,
    handleCloseTabById,
    handleCopyResumeCommand,
    handleCopyAgentId,
    handleCopyTerminalId,
    handleCopyFilePath,
    handleReloadAgent,
    handleRenameTab,
    handleCloseTabsToLeftInPane,
    handleCloseTabsToRightInPane,
    handleCloseOtherTabsInPane,
    handleCreateNewTab,
    buildDesktopPaneContentModel,
    handleFocusPane,
    handleSplitPane,
    handleCreateEmptySplit,
    handleMoveTabToPane,
    selectTabInPane,
    handleResizePaneSplit,
    handleReorderTabsInPane,
  ]);
  const desktopContent = desktopSplitContent ?? content;
  const rendersDesktopSplitContent = !isMobile && desktopSplitContent !== null;

  const workspacePanelTabIds = useMemo(
    () => [...uiTabs.map((tab) => tab.tabId), ...sheets.map((sheet) => sheet.tab.tabId)],
    [uiTabs, sheets],
  );
  const workspacePanelKey = `${normalizedServerId}:${normalizedWorkspaceId}`;
  const createFallbackTab = useCallback(
    () => handleCreateNewTab({ paneId: focusedPaneIdOrUndefined }),
    [handleCreateNewTab, focusedPaneIdOrUndefined],
  );
  const ownsFallbackKeyboardShortcuts = useMemo(
    () => shouldRenderDesktopPaneFallback && isRouteFocused,
    [shouldRenderDesktopPaneFallback, isRouteFocused],
  );
  useWorkspaceNewTabKeyboardAction({
    handlerName: "workspace-chrome-new-tab",
    ownsKeyboardShortcuts: ownsFallbackKeyboardShortcuts,
    normalizedServerId,
    normalizedWorkspaceId,
    paneId: focusedPaneIdOrUndefined,
    createNewTab: createFallbackTab,
  });
  const compactHeaderLayout = resolveCompactHeaderLayout({
    header: compactWorkspaceHeader,
    activeTab: activeTabDescriptor,
    composerFullscreen: useComposerTabFullscreen(workspacePanelKey, activeTabId),
  });
  const canResumeTopicQuestion = [
    supportsTopicWorkbench,
    isRouteFocused,
    hasHydratedWorkspaceLayoutStore,
    persistenceKey,
    workspaceDirectory,
  ].every(Boolean);
  const topicQuestionResume = (
    <TopicQuestionResume
      key={persistenceKey}
      enabled={canResumeTopicQuestion}
      serverId={normalizedServerId}
      workspaceId={normalizedWorkspaceId}
      openTargets={[...uiTabs.map((tab) => tab.target), ...sheets.map((sheet) => sheet.tab.target)]}
      onOpen={openTopicQuestion}
    />
  );

  // Compact sheets escape to the app overlay host, above both sidebars.
  const workspaceCenterColumn = isMobile ? (
    <View style={styles.centerColumn}>
      <FloatingHeaderLayout
        header={
          <>
            {compactHeaderLayout.header}
            {topicQuestionResume}
          </>
        }
        floating={compactHeaderLayout.floating}
      >
        {(topOverlayInset) => (
          <StreamTopOverlayProvider value={topOverlayInset}>
            <View style={styles.content}>{content}</View>
          </StreamTopOverlayProvider>
        )}
      </FloatingHeaderLayout>
      <SheetTabs onCloseTab={handleCloseTabById} />
    </View>
  ) : (
    <DesktopCenterColumnChrome
      explorerOpen={isExplorerSidebarShowing}
      focusModeEnabled={desktopFocusModeEnabled}
    >
      {rendersDesktopSplitContent ? null : (
        <AdaptiveWorkspaceChrome compactHeader={centerColumnCompactHeader}>
          {fullWorkspaceActions}
          {renderWorkspaceScreenHeader()}

          {shouldRenderDesktopPaneFallback ? (
            <NewTabLauncherProvider value={newTabLauncher}>
              <WorkspaceDesktopTabsRow
                paneId={focusedPaneIdOrUndefined}
                ownsKeyboardShortcuts={false}
                isFocused={isRouteFocused}
                tabs={desktopTabRowItems}
                normalizedServerId={normalizedServerId}
                normalizedWorkspaceId={normalizedWorkspaceId}
                setHoveredCloseTabKey={setHoveredCloseTabKey}
                onNavigateTab={navigateToTabId}
                onCloseTab={handleCloseTabById}
                onCopyResumeCommand={handleCopyResumeCommand}
                onCopyAgentId={handleCopyAgentId}
                onCopyTerminalId={handleCopyTerminalId}
                onCopyFilePath={handleCopyFilePath}
                onReloadAgent={handleReloadAgent}
                onRenameTab={handleRenameTab}
                onCloseTabsToLeft={handleCloseTabsToLeft}
                onCloseTabsToRight={handleCloseTabsToRight}
                onCloseOtherTabs={handleCloseOtherTabs}
                onCreateNewTab={handleCreateNewTab}
                onReorderTabs={handleReorderTabsInFocusedPane}
                focusModeEnabled={desktopFocusModeEnabled}
                onExitFocusMode={toggleFocusMode}
              />
            </NewTabLauncherProvider>
          ) : null}
        </AdaptiveWorkspaceChrome>
      )}
      <View style={styles.centerContent} onLayout={onCenterColumnLayout}>
        {topicQuestionResume}
        <WorkspaceDesktopBody
          isTeamDirectoryVisible={isTeamDirectoryVisible}
          isTeamDirectoryOverlay={isTeamDirectoryOverlay}
          hideLabel={t("topicWorkbench.directory.hide")}
          serverId={normalizedServerId}
          workspaceId={normalizedWorkspaceId}
          mainAgentId={mainAgentId}
          isTopicWorkspace={isTopicWorkspace}
          focusedAgentId={focusedPaneAgentId}
          focusedProviderSubagentId={focusedProviderSubagentId}
          onHideDirectory={hideTeamDirectory}
          onOpenAgent={handleOpenDirectoryAgent}
          onOpenAgentBeside={handleOpenDirectoryAgentBeside}
          onOpenProviderSubrun={handleOpenProviderSubrun}
          onAskFirstQuestion={askFirstTopicQuestion}
          topicEmptyContent={topicEmptyContent}
          desktopContent={desktopContent}
        />
      </View>
    </DesktopCenterColumnChrome>
  );

  const sharedExplorer = useMemo(() => {
    if (!workspaceLayout || !explorerSidebarPaneId || !persistenceKey) return null;
    const explorerPane = findPaneById(workspaceLayout.root, explorerSidebarPaneId);
    if (!explorerPane) return null;
    const dock = (
      <ExplorerSidebarDock
        pane={explorerPane}
        uiTabs={uiTabs}
        normalizedServerId={normalizedServerId}
        normalizedWorkspaceId={normalizedWorkspaceId}
        isWorkspaceFocused={isRouteFocused}
        paneFocusSuspended={paneFocusSuspended}
        closingTabIds={closingTabIds}
        hoveredCloseTabKey={hoveredCloseTabKey}
        setHoveredCloseTabKey={setHoveredCloseTabKey}
        onSelectTab={selectTabInPane}
        onCloseTab={handleCloseTabById}
        onCreateNewTab={handleCreateNewTab}
        onCopyResumeCommand={handleCopyResumeCommand}
        onCopyAgentId={handleCopyAgentId}
        onCopyTerminalId={handleCopyTerminalId}
        onCopyFilePath={handleCopyFilePath}
        onReloadAgent={handleReloadAgent}
        onRenameTab={handleRenameTab}
        onCloseTabsToLeft={handleCloseTabsToLeftInPane}
        onCloseTabsToRight={handleCloseTabsToRightInPane}
        onCloseOtherTabs={handleCloseOtherTabsInPane}
        onExitFocusMode={toggleFocusMode}
        onReorderTabsInPane={handleReorderTabsInPane}
        buildPaneContentModel={buildDesktopPaneContentModel}
        headerAction={explorerControls.dockAction}
      />
    );
    return (
      <ExplorerFrame
        presentation={isMobile ? "overlay" : "dock"}
        isWorkspaceActive={isRouteFocused}
        persistenceKey={persistenceKey}
        isOpen={isExplorerSidebarShowing && !desktopFocusModeEnabled}
      >
        {dock}
      </ExplorerFrame>
    );
  }, [
    workspaceLayout,
    explorerSidebarPaneId,
    persistenceKey,
    isMobile,
    uiTabs,
    normalizedServerId,
    normalizedWorkspaceId,
    isRouteFocused,
    paneFocusSuspended,
    isExplorerSidebarShowing,
    closingTabIds,
    hoveredCloseTabKey,
    selectTabInPane,
    handleCloseTabById,
    handleCreateNewTab,
    handleCopyResumeCommand,
    handleCopyAgentId,
    handleCopyTerminalId,
    handleCopyFilePath,
    handleReloadAgent,
    handleRenameTab,
    handleCloseTabsToLeftInPane,
    handleCloseTabsToRightInPane,
    handleCloseOtherTabsInPane,
    toggleFocusMode,
    handleReorderTabsInPane,
    buildDesktopPaneContentModel,
    explorerControls.dockAction,
    desktopFocusModeEnabled,
  ]);

  const { revealDirectory } = useFileExplorerActions({
    serverId: normalizedServerId,
    workspaceId: normalizedWorkspaceId,
    workspaceRoot: workspaceDirectory,
  });
  const openMarkdownFile = useStableEvent((location: WorkspaceFileLocation) => {
    handleOpenPreferredAssistantFile({ location, parentTabId: activeTabId });
  });
  const openMarkdownDirectory = useStableEvent((directoryPath: string) => {
    void revealDirectory(directoryPath);
    openExplorerSidebarView({
      isCompact: isMobile,
      workspaceKey: persistenceKey,
      view: "files",
    });
  });
  const openMarkdownOutsideDirectory = useOpenOutsideWorkspaceFolder(normalizedServerId);
  const markdownPathOpener = useMemo(
    () =>
      createInlinePathOpener({
        workspaceRoot: workspaceDirectory ?? "",
        client,
        openFile: openMarkdownFile,
        openDirectory: openMarkdownDirectory,
        openOutsideDirectory: openMarkdownOutsideDirectory,
      }),
    [
      workspaceDirectory,
      client,
      openMarkdownFile,
      openMarkdownDirectory,
      openMarkdownOutsideDirectory,
    ],
  );
  useEffect(() => {
    if (!isRouteFocused) markdownPathOpener.cancel();
    return () => markdownPathOpener.cancel();
  }, [markdownPathOpener, isRouteFocused, activeTabId]);
  const openMarkdownPath = useStableEvent(
    (target: InlinePathTarget, disposition: OpenFileDisposition) => {
      if (isRouteFocused) void markdownPathOpener.open(target, disposition);
    },
  );

  const renderedWorkspaceScreen = (
    <RenderProfile id="WorkspaceScreenContent">
      <View style={containerStyle}>
        <WorkspaceDocumentTitleEffectSlot
          tab={activeTabDescriptor}
          serverId={normalizedServerId}
          workspaceId={normalizedWorkspaceId}
          isRouteFocused={isRouteFocused}
        />
        <WorkspacePanelSurface
          launcher={newTabLauncher}
          workspaceKey={workspacePanelKey}
          tabIds={workspacePanelTabIds}
        >
          <FloatingPanelPortalHostNameProvider hostName={workspaceFloatingPanelPortalHostName}>
            <WorkspaceTabDragScope
              layout={workspaceLayout}
              explorerSidebarPaneId={explorerSidebarPaneId}
              allowCrossPane={layoutMode === "split-panes"}
              normalizedServerId={normalizedServerId}
              normalizedWorkspaceId={normalizedWorkspaceId}
              uiTabs={uiTabs}
              onMoveTabToPane={handleMoveTabToPane}
              onReorderTabsInPane={handleReorderTabsInPane}
              onSplitPane={handleSplitPane}
            >
              {explorerControls.titlebarAction}
              {workspaceCenterColumn}
              {sharedExplorer}
            </WorkspaceTabDragScope>
          </FloatingPanelPortalHostNameProvider>
          <FloatingPanelPortalHost name={workspaceFloatingPanelPortalHostName} />
        </WorkspacePanelSurface>
        <ImportSessionSheet
          visible={isRouteFocused && isImportSheetVisible}
          client={client}
          serverId={normalizedServerId}
          cwd={workspaceDirectory}
          workspaceId={normalizedWorkspaceId}
          onClose={closeImportSheet}
          onImportedAgent={handleImportedAgent}
          onImported={navigateToImportedAgent}
        />
        <WorkspaceTabRenameModal
          renamingTab={isRouteFocused ? renamingTab : null}
          onSubmit={handleRenameModalSubmit}
          onClose={handleRenameModalClose}
        />
      </View>
    </RenderProfile>
  );

  return (
    <>
      {gatedWorkspaceScreen ?? (
        <WorkspaceShellProviders
          persistenceKey={persistenceKey}
          sheetPaneHost={sheetPaneHost}
          mainTabContext={mainTabContext}
          teamDirectoryShellValue={teamDirectoryShellValue}
          gitGraphIntentStore={gitGraphIntentStore}
          workspaceDescriptor={workspaceDescriptor}
          client={client}
          serverId={normalizedServerId}
          workspaceDirectory={workspaceDirectory}
          openMarkdownPath={openMarkdownPath}
          toast={toast}
        >
          {renderedWorkspaceScreen}
        </WorkspaceShellProviders>
      )}
      {topicUpgradeDialog}
    </>
  );
}

/** File links and forge references for every Markdown surface in the workspace. */
function WorkspaceMarkdownLinks({
  workspace,
  children,
  ...fileLinks
}: AssistantFileLinkResolverProviderProps & { workspace: WorkspaceDescriptor | null | undefined }) {
  return (
    <AssistantFileLinkResolverProvider {...fileLinks}>
      <ForgeShorthandProvider
        forge={workspace?.forge}
        remoteUrl={workspace?.gitRuntime?.remoteUrl}
        forgeWeb={workspace?.forgeWeb}
      >
        {children}
      </ForgeShorthandProvider>
    </AssistantFileLinkResolverProvider>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  containerWorkspaceBackground: {
    backgroundColor: theme.colors.surfaceWorkspace,
  },
  threePaneRow: {
    // Keep the Explorer overlay below the workspace sheet host on web as well as native.
    zIndex: 0,
    flex: 1,
    minHeight: 0,
    flexDirection: "row",
    alignItems: "stretch",
  },
  centerColumn: {
    flex: 1,
    minHeight: 0,
  },
  headerTitleContainer: {
    flex: 1,
    flexShrink: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: {
      xs: theme.spacing[1],
      md: theme.spacing[2],
    },
    overflow: "hidden",
  },
  headerTitleTextGroup: {
    minWidth: 0,
    overflow: "hidden",
    flexShrink: 1,
    flexGrow: {
      xs: 1,
      md: 0,
    },
    flexDirection: {
      xs: "column",
      md: "row",
    },
    alignItems: {
      xs: "stretch",
      md: "center",
    },
    justifyContent: "flex-start",
    gap: {
      xs: 0,
      md: theme.spacing[2],
    },
  },
  headerTitleSkeleton: {
    width: 220,
    maxWidth: "100%",
    height: 22,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface3,
    opacity: 0.25,
  },
  headerRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: {
      xs: theme.spacing[1],
      md: theme.spacing[2],
    },
  },
  compactHeaderMenuCluster: {
    flexDirection: "row",
    alignItems: "center",
    gap: {
      xs: 0,
      md: theme.spacing[2],
    },
  },
  newTabActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  newTabActionButton: {
    width: 30,
    height: 30,
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    alignItems: "center",
    justifyContent: "center",
  },
  newTabActionButtonHovered: {
    backgroundColor: theme.colors.surface2,
  },
  newTabTooltipText: {
    fontSize: theme.fontSize.base,
    color: theme.colors.popoverForeground,
  },
  newTabTooltipRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  newTabTooltipShortcut: {},
  headerMenuProfileIconWrapper: {
    width: 16,
    height: 16,
  },
  tabsContainer: {
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
    flexDirection: "row",
    alignItems: "center",
  },
  tabsScroll: {
    flex: 1,
    minWidth: 0,
  },
  tabsContent: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
  },
  tabsActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingRight: theme.spacing[2],
    paddingVertical: theme.spacing[1],
  },
  centerContent: {
    flex: 1,
    minHeight: 0,
  },
  workspaceBodyRow: {
    flex: 1,
    flexDirection: "row",
    minWidth: 0,
    minHeight: 0,
    position: "relative",
  },
  teamDirectoryOverlayBackdrop: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 3,
  },
  workspaceMainArea: {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    backgroundColor: theme.colors.surface0,
    position: "relative",
  },
  tab: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    maxWidth: 260,
  },
  tabHandle: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    flex: 1,
    minWidth: 0,
  },
  tabIcon: {
    flexShrink: 0,
  },
  tabActive: {
    backgroundColor: theme.colors.surface2,
  },
  tabHovered: {
    backgroundColor: theme.colors.surface2,
  },
  tabLabel: {
    flexShrink: 1,
    minWidth: 0,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
  },
  tabLabelWithCloseButton: {
    paddingRight: 0,
  },
  tabLabelActive: {
    color: theme.colors.foreground,
  },
  tabCloseButton: {
    width: 18,
    height: 18,
    marginLeft: 0,
    borderRadius: theme.borderRadius.sm,
    alignItems: "center",
    justifyContent: "center",
  },
  tabCloseButtonShown: {
    opacity: 1,
  },
  tabCloseButtonHidden: {
    opacity: 0,
  },
  tabCloseButtonActive: {
    backgroundColor: theme.colors.surface3,
  },
  content: {
    flex: 1,
    minHeight: 0,
    backgroundColor: theme.colors.surface0,
    position: "relative",
  },
  mobileMountedTabSlot: {
    ...StyleSheet.absoluteFill,
  },
  contentPlaceholder: {
    flex: 1,
    minHeight: 0,
    backgroundColor: theme.colors.surface0,
  },
  emptyState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[6],
  },
  emptyStateText: {
    color: theme.colors.foregroundMuted,
    textAlign: "center",
  },
}));
