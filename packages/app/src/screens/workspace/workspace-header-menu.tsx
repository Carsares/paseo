import { useTeamDirectoryShell } from "@/subagents/team-directory";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import type { TopicHeaderMenuStatus } from "./topic-header";
import type { WorkspaceCompactHeaderActions } from "./adaptive-workspace-chrome";
import React, {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ContextType,
  type ReactNode,
} from "react";
import { Text, View } from "react-native";
import { useRouter, type Href } from "expo-router";
import { useTranslation } from "react-i18next";
import {
  Archive,
  ArrowUp,
  Copy,
  Ellipsis,
  Globe,
  Import as ImportIcon,
  Settings,
} from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { TerminalProfile } from "@getpaseo/protocol/messages";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  type MenuPageDefinition,
} from "@/components/ui/dropdown-menu";
import { isSubPageOpen, useMenuContext, useMenuDepth, useMenuSurface } from "@/components/ui/menu";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { useFilePanelOpenWithMenu } from "@/file-panels";
import {
  getFallbackTabOptionLabel,
  useMobileWorkspaceTabMenu,
  useWorkspaceTabFallbackLabels,
  type MobileWorkspaceTabMenuActions,
} from "./compact-workspace-header/tab-switcher";
import {
  WorkspaceTabIcon,
  WorkspaceTabPresentationResolver,
  type WorkspaceTabPresentation,
} from "./workspace-tab-presentation";
import { isWorkspaceMainTab, WorkspaceMainTabContext } from "./workspace-tab-menu";
import { MobileTabMenuEntries } from "./workspace-tab-trailing-accessory";
import type { WorkspaceTabDescriptor } from "./workspace-tabs-types";
import {
  extraMutedIconColorMapping,
  iconButtonChromeGlyphSize,
  iconButtonChromeStyle,
  useIconButtonChromeStyle,
} from "@/components/ui/icon-button-chrome";
import { TerminalProfileIcon } from "@/components/terminal-profile-icon";
import { useActiveWorkspaceArchive } from "@/hooks/use-active-workspace-archive";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import {
  getTerminalProfileIcon,
  resolveTerminalProfiles,
} from "@getpaseo/protocol/terminal-profiles";
import { buildSettingsHostSectionRoute } from "@/utils/host-routes";
import type { Theme } from "@/styles/theme";
import {
  useWorkspaceScriptsMenuPages,
  type UseWorkspaceScriptsMenuPagesInput,
} from "@/screens/workspace/scripts";
import { usePluginWorkspaceMenu } from "@/plugins";

const ThemedEllipsis = withUnistyles(Ellipsis);
const ThemedArchive = withUnistyles(Archive);
const ThemedCopy = withUnistyles(Copy);
const ThemedGlobe = withUnistyles(Globe);
const ThemedImport = withUnistyles(ImportIcon);
const ThemedSettings = withUnistyles(Settings);
const ThemedArrowUp = withUnistyles(ArrowUp);

const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

const MENU_NEW_BROWSER_ICON = <ThemedGlobe size={16} uniProps={mutedColorMapping} />;
const MENU_IMPORT_ICON = <ThemedImport size={16} uniProps={mutedColorMapping} />;
const MENU_COPY_ICON = <ThemedCopy size={16} uniProps={mutedColorMapping} />;
const MENU_ARCHIVE_ICON = <ThemedArchive size={16} uniProps={mutedColorMapping} />;
const MENU_SETTINGS_ICON = <ThemedSettings size={16} uniProps={mutedColorMapping} />;
const MENU_UPGRADE_ICON = <ThemedArrowUp size={16} uniProps={mutedColorMapping} />;
function WorkspaceHeaderMenuTriggerIcon() {
  return (
    <ThemedEllipsis
      size={iconButtonChromeGlyphSize("large")}
      uniProps={extraMutedIconColorMapping}
    />
  );
}

/** The ⋯ with a dot on it, for when something inside the menu needs looking at. */
function WorkspaceHeaderMenuAttentionTriggerIcon() {
  return (
    <View>
      <WorkspaceHeaderMenuTriggerIcon />
      <View style={styles.attentionDot} testID="workspace-header-menu-attention" />
    </View>
  );
}

/**
 * The compact header buttons draw at 32pt, under the 44pt touch minimum, and sit flush against
 * each other — so the slop can only grow vertically. Widening it would put two buttons' slop over
 * the same pixels, which is a worse miss than a small target.
 */
const COMPACT_HEADER_BUTTON_HIT_SLOP = { top: 8, bottom: 8 } as const;

/**
 * Actions that belong to the workspace itself rather than to a tab. Both header menus render them,
 * from the same callbacks, so the two surfaces can't drift.
 */
export interface WorkspaceHeaderWorkspaceActions {
  topicStatus?: TopicHeaderMenuStatus;
  onCreateTab?: (paneId?: string) => void;
  currentBranchName: string | null;
  showWorkspaceSetup: boolean;
  importAgentDisabled: boolean;
  copyPathDisabled: boolean;
  onOpenImportSheet: () => void;
  onCopyWorkspacePath: () => void;
  onCopyBranchName: () => void;
  onOpenSetupTab: () => void;
  onUpgradeToTopic?: () => void;
}

function WorkspaceHeaderWorkspaceActionItems({
  currentBranchName,
  showWorkspaceSetup,
  importAgentDisabled,
  copyPathDisabled,
  onOpenImportSheet,
  onCopyWorkspacePath,
  onCopyBranchName,
  onOpenSetupTab,
  onUpgradeToTopic,
}: WorkspaceHeaderWorkspaceActions) {
  const { t } = useTranslation();
  return (
    <>
      <DropdownMenuItem
        testID="workspace-header-copy-path"
        leading={MENU_COPY_ICON}
        disabled={copyPathDisabled}
        onSelect={onCopyWorkspacePath}
      >
        {t("workspace.header.actions.copyPath")}
      </DropdownMenuItem>
      {currentBranchName ? (
        <DropdownMenuItem
          testID="workspace-header-copy-branch-name"
          leading={MENU_COPY_ICON}
          onSelect={onCopyBranchName}
        >
          {t("workspace.header.actions.copyBranchName")}
        </DropdownMenuItem>
      ) : null}
      <DropdownMenuItem
        testID="workspace-header-import-agent"
        leading={MENU_IMPORT_ICON}
        disabled={importAgentDisabled}
        onSelect={onOpenImportSheet}
      >
        {t("workspace.header.actions.importSession")}
      </DropdownMenuItem>
      {onUpgradeToTopic ? (
        <DropdownMenuItem
          testID="workspace-header-upgrade-to-topic"
          leading={MENU_UPGRADE_ICON}
          onSelect={onUpgradeToTopic}
        >
          {t("topicWorkbench.upgrade.title")}
        </DropdownMenuItem>
      ) : null}
      {showWorkspaceSetup ? (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            testID="workspace-header-show-setup"
            leading={MENU_SETTINGS_ICON}
            onSelect={onOpenSetupTab}
          >
            {t("workspace.header.actions.showSetup")}
          </DropdownMenuItem>
        </>
      ) : null}
    </>
  );
}

function useWorkspaceDirection(direction: string | null | undefined) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const title = t("topicWorkbench.header.directionTitle");
  const header = useMemo(() => ({ title }), [title]);
  const show = useCallback(() => setOpen(true), []);
  const close = useCallback(() => setOpen(false), []);
  return {
    item: direction ? (
      <DropdownMenuItem onSelect={show} testID="workspace-header-direction">
        {t("topicWorkbench.header.showDirection")}
      </DropdownMenuItem>
    ) : null,
    dialog:
      direction && open ? (
        <AdaptiveModalSheet
          visible
          onClose={close}
          header={header}
          testID="workspace-direction-dialog"
        >
          <Text selectable style={styles.directionText}>
            {direction}
          </Text>
        </AdaptiveModalSheet>
      ) : null,
  };
}

function WorkspaceTopicStatusItems({
  status,
  directionItem,
  onOpenSetup,
  onShowDirectory,
}: {
  status: TopicHeaderMenuStatus;
  directionItem: ReactNode;
  onOpenSetup?: () => void;
  onShowDirectory?: () => void;
}) {
  const { t } = useTranslation();
  const openPending = useCallback(() => {
    if (status.onOpenPending()) onShowDirectory?.();
  }, [onShowDirectory, status]);
  return (
    <>
      {directionItem}
      {status.hideFromModel ? (
        <DropdownMenuLabel>{t("topicWorkbench.header.hiddenFromModel")}</DropdownMenuLabel>
      ) : null}
      {status.onOpenGit ? (
        <DropdownMenuItem onSelect={status.onOpenGit}>{status.gitLabel}</DropdownMenuItem>
      ) : null}
      {!status.onOpenGit && status.gitLabel ? (
        <DropdownMenuLabel>{status.gitLabel}</DropdownMenuLabel>
      ) : null}
      {onOpenSetup ? (
        <DropdownMenuItem testID="workspace-header-show-setup" onSelect={onOpenSetup}>
          {t("workspace.header.actions.showSetup")} · {status.envLabel}
        </DropdownMenuItem>
      ) : (
        <DropdownMenuLabel>{status.envLabel}</DropdownMenuLabel>
      )}
      <DropdownMenuLabel>{status.teamLabel}</DropdownMenuLabel>
      <DropdownMenuItem onSelect={openPending}>{status.pendingLabel}</DropdownMenuItem>
      <DropdownMenuSeparator />
    </>
  );
}

function WorkspacePaneActionItems({
  pane,
  onCreateTab,
}: {
  pane?: WorkspaceCompactHeaderActions["pane"];
  onCreateTab?: (paneId?: string) => void;
}) {
  const { t } = useTranslation();
  const createTab = useCallback(() => onCreateTab?.(pane?.id), [onCreateTab, pane?.id]);
  return (
    <>
      {onCreateTab ? (
        <DropdownMenuItem testID="workspace-header-new-tab" onSelect={createTab}>
          {t("workspace.tabs.actions.newTab")}
        </DropdownMenuItem>
      ) : null}
      {pane?.splitRight ? (
        <DropdownMenuItem onSelect={pane.splitRight}>
          {t("workspace.tabs.actions.splitRight")}
        </DropdownMenuItem>
      ) : null}
      {pane?.splitDown ? (
        <DropdownMenuItem onSelect={pane.splitDown}>
          {t("workspace.tabs.actions.splitDown")}
        </DropdownMenuItem>
      ) : null}
      {pane?.toggleMaximized ? (
        <DropdownMenuItem onSelect={pane.toggleMaximized}>
          {t(
            pane.maximized
              ? "workspace.tabs.actions.restorePane"
              : "workspace.tabs.actions.maximizePane",
          )}
        </DropdownMenuItem>
      ) : null}
    </>
  );
}

function workspaceHeaderMenuButtonStyle({
  hovered,
  pressed,
  open,
}: {
  hovered: boolean;
  pressed: boolean;
  open: boolean;
}) {
  return iconButtonChromeStyle({ size: "large", state: { hovered, pressed, open } });
}

/**
 * When the directory replaces the tab strip, this menu also carries the pane's launcher and split actions.
 */
export function WorkspaceHeaderMenuDesktop({
  pane,
  topicStatus,
  onCreateTab,
  ...props
}: WorkspaceHeaderWorkspaceActions & { pane?: WorkspaceCompactHeaderActions["pane"] }) {
  const { t } = useTranslation();
  const { item, dialog } = useWorkspaceDirection(topicStatus?.direction);
  const { openDirectory } = useTeamDirectoryShell();
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          testID="workspace-header-menu-trigger"
          style={workspaceHeaderMenuButtonStyle}
          accessibilityRole="button"
          accessibilityLabel={t("workspace.header.actions.workspaceActions")}
        >
          {topicStatus?.needsAttention ? (
            <WorkspaceHeaderMenuAttentionTriggerIcon />
          ) : (
            <WorkspaceHeaderMenuTriggerIcon />
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align={topicStatus ? "end" : "start"}
          width={220}
          testID="workspace-header-menu"
        >
          {topicStatus ? (
            <WorkspaceTopicStatusItems
              status={topicStatus}
              directionItem={item}
              onShowDirectory={openDirectory}
              onOpenSetup={props.showWorkspaceSetup ? props.onOpenSetupTab : undefined}
            />
          ) : null}
          <WorkspacePaneActionItems pane={pane} onCreateTab={onCreateTab} />
          <WorkspaceHeaderWorkspaceActionItems
            {...props}
            showWorkspaceSetup={!topicStatus && props.showWorkspaceSetup}
          />
        </DropdownMenuContent>
      </DropdownMenu>
      {dialog}
    </>
  );
}

interface HeaderMenuProfileItemProps {
  profile: TerminalProfile;
  disabled: boolean;
  onCreateTerminalWithProfile: (profile: TerminalProfile) => void;
}

function HeaderMenuProfileItem({
  profile,
  disabled,
  onCreateTerminalWithProfile,
}: HeaderMenuProfileItemProps) {
  const handleSelect = useCallback(() => {
    onCreateTerminalWithProfile(profile);
  }, [onCreateTerminalWithProfile, profile]);

  const leading = useMemo(
    () => (
      <View style={styles.headerMenuProfileIconWrapper}>
        <TerminalProfileIcon iconKey={getTerminalProfileIcon(profile)} size={16} />
      </View>
    ),
    [profile],
  );

  return (
    <DropdownMenuItem leading={leading} disabled={disabled} onSelect={handleSelect}>
      {profile.name}
    </DropdownMenuItem>
  );
}

const WORKSPACE_TABS_PAGE_ID = "workspace-tabs";

function workspaceTabActionsPageId(tabId: string): string {
  return `${WORKSPACE_TABS_PAGE_ID}/${tabId}`;
}

function workspaceTabOpenWithPageId(tabId: string): string {
  return `${WORKSPACE_TABS_PAGE_ID}/${tabId}/open-with`;
}

export interface WorkspaceHeaderTabMenuActions extends Omit<
  MobileWorkspaceTabMenuActions,
  "onCloseTabsAbove" | "onCloseTabsBelow" | "onCloseOtherTabs"
> {
  onCloseTabsAbove: (tabId: string, tabs: WorkspaceTabDescriptor[]) => Promise<void> | void;
  onCloseTabsBelow: (tabId: string, tabs: WorkspaceTabDescriptor[]) => Promise<void> | void;
  onCloseOtherTabs: (tabId: string, tabs: WorkspaceTabDescriptor[]) => Promise<void> | void;
}

export interface WorkspaceHeaderMenuMobileProps extends WorkspaceHeaderWorkspaceActions {
  pane?: WorkspaceCompactHeaderActions["pane"];
  tabs?: WorkspaceTabDescriptor[];
  activeTabKey?: string;
  onSelectTab?: (key: string) => void;
  tabMenuActions?: WorkspaceHeaderTabMenuActions;
  onExitFocusMode?: () => void;
  normalizedServerId: string;
  normalizedWorkspaceId: string;
  scripts: UseWorkspaceScriptsMenuPagesInput;
  showCreateBrowserTab: boolean;
  createTerminalDisabled: boolean;
  onCreateTerminalWithProfile: (profile: TerminalProfile, paneId?: string) => void;
  onCreateBrowser: (input?: { paneId?: string }) => void;
}

function WorkspaceHeaderTabActionsTrigger({
  tabId,
  label,
  pageId,
  onOpenTabActions,
}: {
  tabId: string;
  label: string;
  pageId: string;
  onOpenTabActions?: (tabId: string, label: string) => void;
}) {
  const { t } = useTranslation();
  const menu = useMenuContext("WorkspaceHeaderTabActionsTrigger");
  const depth = useMenuDepth();
  const { registerSubAnchor } = useMenuSurface("WorkspaceHeaderTabActionsTrigger");
  const anchorRef = useRef<View>(null);

  useEffect(() => {
    registerSubAnchor(pageId, anchorRef);
  }, [pageId, registerSubAnchor]);

  const isOpen = isSubPageOpen(menu.path, { id: pageId, depth });
  const handlePress = useCallback(() => {
    onOpenTabActions?.(tabId, label);
    menu.openSub({ id: pageId, depth });
  }, [depth, label, menu, onOpenTabActions, pageId, tabId]);

  return (
    <View ref={anchorRef} collapsable={false}>
      <ToolbarButton
        testID={`workspace-header-tab-actions-${tabId}`}
        label={t("workspace.tabs.menu.openFor", { label })}
        selected={isOpen}
        onPress={handlePress}
      >
        <ThemedEllipsis size={14} uniProps={mutedColorMapping} />
      </ToolbarButton>
    </View>
  );
}

function WorkspaceHeaderTabMenuOption({
  tab,
  presentation,
  selected,
  actionsPageId,
  onSelectTab,
  onOpenTabActions,
}: {
  tab: WorkspaceTabDescriptor;
  presentation: WorkspaceTabPresentation;
  selected: boolean;
  actionsPageId?: string;
  onSelectTab: WorkspaceHeaderMenuMobileProps["onSelectTab"];
  onOpenTabActions?: (tabId: string, label: string) => void;
}) {
  const select = useCallback(() => onSelectTab?.(tab.key), [onSelectTab, tab.key]);
  const icon = useMemo(
    () => <WorkspaceTabIcon presentation={presentation} backdrop="surface0" />,
    [presentation],
  );
  return (
    <View style={styles.tabOptionRow}>
      <View style={styles.tabOptionMain}>
        <DropdownMenuItem
          testID={`workspace-header-tab-${tab.tabId}`}
          leading={icon}
          selected={selected}
          onSelect={select}
        >
          {presentation.label}
        </DropdownMenuItem>
      </View>
      {actionsPageId ? (
        <WorkspaceHeaderTabActionsTrigger
          tabId={tab.tabId}
          label={presentation.label}
          pageId={actionsPageId}
          onOpenTabActions={onOpenTabActions}
        />
      ) : null}
    </View>
  );
}

function WorkspaceHeaderTabActionsPage({
  tab,
  tabIndex,
  tabCount,
  mainTabIndex,
  mainTabContext,
  openWithPageId,
  normalizedServerId,
  normalizedWorkspaceId,
  actions,
}: {
  tab: WorkspaceTabDescriptor;
  tabIndex: number;
  tabCount: number;
  mainTabIndex: number;
  mainTabContext: ContextType<typeof WorkspaceMainTabContext>;
  openWithPageId?: string;
  normalizedServerId: string;
  normalizedWorkspaceId: string;
  actions: MobileWorkspaceTabMenuActions;
}) {
  const { menuEntries, openWith } = useMobileWorkspaceTabMenu({
    tab,
    tabIndex,
    tabCount,
    mainTabIndex,
    mainTabContext,
    openWithPageId,
    normalizedServerId,
    normalizedWorkspaceId,
    ...actions,
  });
  return <MobileTabMenuEntries menuEntries={menuEntries} openWith={openWith} />;
}

function WorkspaceHeaderTabOpenWithPage({
  serverId,
  workspaceId,
  tabId,
  pageId,
}: {
  serverId: string;
  workspaceId: string;
  tabId: string;
  pageId: string;
}) {
  const openWith = useFilePanelOpenWithMenu(
    { serverId, workspaceId, tabId },
    `workspace-tab-menu-${tabId}`,
    pageId,
  );
  return openWith.pages[0]?.content ?? null;
}

/**
 * Compact layouts have no tab strip. Topic workspaces put the remaining tabs in a page of this
 * menu. Other workspaces keep their tab switcher and its launch actions.
 *
 * The header has no room for a scripts button either, so scripts are a page of this menu, and the
 * ⋯ carries a dot while a running service is unhealthy. Plugin header buttons are rows here for the
 * same reason.
 */
export function WorkspaceHeaderMenuMobile({
  normalizedServerId,
  normalizedWorkspaceId,
  scripts,
  showCreateBrowserTab,
  createTerminalDisabled,
  onCreateTerminalWithProfile,
  onCreateBrowser,
  pane,
  tabs,
  activeTabKey,
  onSelectTab,
  tabMenuActions,
  onExitFocusMode,
  topicStatus,
  onCreateTab,
  ...workspaceActions
}: WorkspaceHeaderMenuMobileProps) {
  const paneId = pane?.id;
  const handleCreateBrowser = useCallback(
    () => onCreateBrowser({ paneId }),
    [onCreateBrowser, paneId],
  );
  const handleCreateTerminalWithProfile = useCallback(
    (profile: TerminalProfile) => onCreateTerminalWithProfile(profile, paneId),
    [onCreateTerminalWithProfile, paneId],
  );
  const { t } = useTranslation();
  const router = useRouter();
  const triggerStyle = useIconButtonChromeStyle({ size: "large" });
  const { config } = useDaemonConfig(normalizedServerId);
  const profiles = useMemo(
    () => resolveTerminalProfiles(config?.terminalProfiles),
    [config?.terminalProfiles],
  );

  const handleEditProfiles = useCallback(() => {
    router.push(buildSettingsHostSectionRoute(normalizedServerId, "terminals") as Href);
  }, [normalizedServerId, router]);
  const { canArchive, archive } = useActiveWorkspaceArchive();
  const handleArchiveWorkspace = useCallback(() => {
    archive();
  }, [archive]);
  const scriptsMenu = useWorkspaceScriptsMenuPages(scripts);
  const pluginMenu = usePluginWorkspaceMenu(normalizedServerId, normalizedWorkspaceId);
  const mainTab = useContext(WorkspaceMainTabContext);
  const mainTabIndex = useMemo(
    () => tabs?.findIndex((tab) => isWorkspaceMainTab(tab, mainTab?.mainAgentId)) ?? -1,
    [mainTab?.mainAgentId, tabs],
  );
  const tabFallbackLabels = useWorkspaceTabFallbackLabels();
  const [activeTabActionsTitle, setActiveTabActionsTitle] = useState<{
    tabId: string;
    label: string;
  } | null>(null);
  const handleOpenTabActions = useCallback((tabId: string, label: string) => {
    setActiveTabActionsTitle({ tabId, label });
  }, []);
  const tabsTitle = t("workspace.tabs.switcher.title");
  const openWithTitle = t("panels.file.filePanels.openWith");
  const scopedTabMenuActions = useMemo<MobileWorkspaceTabMenuActions | undefined>(
    () =>
      tabMenuActions && tabs?.length
        ? {
            ...tabMenuActions,
            onCloseTabsAbove: (tabId) => tabMenuActions.onCloseTabsAbove(tabId, tabs),
            onCloseTabsBelow: (tabId) => tabMenuActions.onCloseTabsBelow(tabId, tabs),
            onCloseOtherTabs: (tabId) => tabMenuActions.onCloseOtherTabs(tabId, tabs),
          }
        : undefined,
    [tabMenuActions, tabs],
  );
  const pages = useMemo(() => {
    const menuPages: MenuPageDefinition[] = [...scriptsMenu.pages, ...pluginMenu.pages];
    if (tabs?.length) {
      menuPages.push({
        id: WORKSPACE_TABS_PAGE_ID,
        title: tabsTitle,
        content: tabs.map((tab) => (
          <WorkspaceTabPresentationResolver
            key={tab.key}
            tab={tab}
            serverId={normalizedServerId}
            workspaceId={normalizedWorkspaceId}
          >
            {(presentation) => (
              <WorkspaceHeaderTabMenuOption
                tab={tab}
                presentation={presentation}
                selected={tab.key === activeTabKey}
                actionsPageId={
                  scopedTabMenuActions ? workspaceTabActionsPageId(tab.tabId) : undefined
                }
                onSelectTab={onSelectTab}
                onOpenTabActions={handleOpenTabActions}
              />
            )}
          </WorkspaceTabPresentationResolver>
        )),
      });
      if (scopedTabMenuActions) {
        tabs.forEach((tab, tabIndex) => {
          const openWithPageId =
            tab.target.kind === "file" ? workspaceTabOpenWithPageId(tab.tabId) : undefined;
          menuPages.push({
            id: workspaceTabActionsPageId(tab.tabId),
            title:
              activeTabActionsTitle?.tabId === tab.tabId
                ? activeTabActionsTitle.label
                : getFallbackTabOptionLabel(tab, tabFallbackLabels),
            content: (
              <WorkspaceHeaderTabActionsPage
                tab={tab}
                tabIndex={tabIndex}
                tabCount={tabs.length}
                mainTabIndex={mainTabIndex}
                mainTabContext={mainTab}
                openWithPageId={openWithPageId}
                normalizedServerId={normalizedServerId}
                normalizedWorkspaceId={normalizedWorkspaceId}
                actions={scopedTabMenuActions}
              />
            ),
          });
          if (openWithPageId) {
            menuPages.push({
              id: openWithPageId,
              title: openWithTitle,
              content: (
                <WorkspaceHeaderTabOpenWithPage
                  serverId={normalizedServerId}
                  workspaceId={normalizedWorkspaceId}
                  tabId={tab.tabId}
                  pageId={openWithPageId}
                />
              ),
            });
          }
        });
      }
    }
    return menuPages;
  }, [
    activeTabActionsTitle,
    activeTabKey,
    handleOpenTabActions,
    mainTab,
    mainTabIndex,
    normalizedServerId,
    normalizedWorkspaceId,
    onSelectTab,
    openWithTitle,
    pluginMenu.pages,
    scopedTabMenuActions,
    scriptsMenu.pages,
    tabFallbackLabels,
    tabs,
    tabsTitle,
  ]);

  const { item, dialog } = useWorkspaceDirection(topicStatus?.direction);
  const { openDirectory } = useTeamDirectoryShell();
  return (
    <>
      <DropdownMenu compactMode="sheet">
        <DropdownMenuTrigger
          testID="workspace-header-menu-trigger"
          style={triggerStyle}
          hitSlop={COMPACT_HEADER_BUTTON_HIT_SLOP}
          accessibilityRole="button"
          accessibilityLabel={
            scriptsMenu.needsAttention
              ? t("workspace.header.actions.workspaceActionsUnhealthy")
              : t("workspace.header.actions.workspaceActions")
          }
        >
          {scriptsMenu.needsAttention || topicStatus?.needsAttention ? (
            <WorkspaceHeaderMenuAttentionTriggerIcon />
          ) : (
            <WorkspaceHeaderMenuTriggerIcon />
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          width={220}
          testID="workspace-header-menu"
          pages={pages}
          sheetTitle={t("workspace.header.actions.workspaceActions")}
        >
          {onExitFocusMode ? (
            <DropdownMenuItem onSelect={onExitFocusMode}>
              {t("workspace.tabs.actions.exitFocusMode")}
            </DropdownMenuItem>
          ) : null}
          {topicStatus ? (
            <WorkspaceTopicStatusItems
              status={topicStatus}
              directionItem={item}
              onShowDirectory={openDirectory}
              onOpenSetup={
                workspaceActions.showWorkspaceSetup ? workspaceActions.onOpenSetupTab : undefined
              }
            />
          ) : null}
          <WorkspacePaneActionItems pane={pane} onCreateTab={onCreateTab} />
          {tabs?.length ? (
            <DropdownMenuSubTrigger id={WORKSPACE_TABS_PAGE_ID} testID="workspace-header-tabs">
              {tabsTitle}
            </DropdownMenuSubTrigger>
          ) : null}
          {scriptsMenu.trigger}
          {pluginMenu.rows}
          {pluginMenu.rows.length > 0 ? <DropdownMenuSeparator /> : null}
          {showCreateBrowserTab ? (
            <DropdownMenuItem
              testID="workspace-header-new-browser"
              leading={MENU_NEW_BROWSER_ICON}
              onSelect={handleCreateBrowser}
            >
              {t("workspace.header.actions.newBrowser")}
            </DropdownMenuItem>
          ) : null}
          <WorkspaceHeaderWorkspaceActionItems
            {...workspaceActions}
            showWorkspaceSetup={!topicStatus && workspaceActions.showWorkspaceSetup}
          />
          <DropdownMenuSeparator />
          <DropdownMenuItem
            testID="workspace-header-archive-workspace"
            leading={MENU_ARCHIVE_ICON}
            disabled={!canArchive}
            onSelect={handleArchiveWorkspace}
          >
            {t("sidebar.workspace.actions.archiveWorkspace")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>{t("workspace.tabs.actions.terminalProfilesMenu")}</DropdownMenuLabel>
          {profiles.map((profile) => (
            <HeaderMenuProfileItem
              key={profile.id}
              profile={profile}
              disabled={createTerminalDisabled}
              onCreateTerminalWithProfile={handleCreateTerminalWithProfile}
            />
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            testID="workspace-header-edit-terminal-profiles"
            onSelect={handleEditProfiles}
          >
            {t("workspace.tabs.actions.editTerminalProfiles")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {dialog}
    </>
  );
}

const ATTENTION_DOT_SIZE = 6;

const styles = StyleSheet.create((theme) => ({
  directionText: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  headerMenuProfileIconWrapper: {
    width: 16,
    height: 16,
  },
  tabOptionRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingRight: theme.spacing[1],
  },
  tabOptionMain: {
    flex: 1,
    minWidth: 0,
  },
  // Same red as the Scripts row's unhealthy ▶, so the dot and the row it leads to agree.
  attentionDot: {
    position: "absolute",
    top: -1,
    right: -2,
    width: ATTENTION_DOT_SIZE,
    height: ATTENTION_DOT_SIZE,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.palette.red[500],
  },
}));
