import { Fragment, useMemo, type ReactNode } from "react";
import { Text } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Users } from "lucide-react-native";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { HeaderToggleButton } from "@/components/headers/header-toggle-button";
import { useStableEvent } from "@/hooks/use-stable-event";
import { useWorkspaceSheetPages } from "@/screens/workspace/sheet-pane";
import { usePanelStore } from "@/stores/panel-store";
import { CompactHeader } from "@/components/headers/compact-header";
import { WorkspaceHeaderProjectRow } from "@/screens/workspace/workspace-header-project-row";
import {
  useWindowLayout,
  resolveWorkspaceActionPlacement,
  resolveWorkspaceBarActions,
  WindowLayoutActions,
} from "@/window-layout";
import { IconButtonChromeProvider } from "@/components/ui/icon-button-chrome";

export { MobileWorkspaceTabSwitcher } from "./tab-switcher";

interface CompactWorkspaceHeaderProps {
  serverId: string;
  isLoading: boolean;
  title: string;
  subtitle: string;
  isSubtitleDistinct: boolean;
  explorerAction: ReactNode;
  tabSwitcher: ReactNode;
  inDesktopTitlebar: boolean;
  /** Workspace overflow menu. */
  children: ReactNode;
  headerVariant: "compact" | "full";
  isRouteFocused: boolean;
  isCompact: boolean;
  compactTeamDirectory?: (close: () => void) => ReactNode;
  compactConflictAction?: ReactNode;
  topicHeader?: boolean;
  titleContent?: ReactNode;
  modeControl?: ReactNode;
  desktopTeamAction?: ReactNode;
}

/** The compact header with the workspace's project row and controls. */
export function CompactWorkspaceHeader({
  isLoading,
  title,
  subtitle,
  isSubtitleDistinct,
  explorerAction,
  children,
  tabSwitcher,
  inDesktopTitlebar,
  serverId,
  headerVariant,
  isRouteFocused,
  isCompact,
  compactTeamDirectory,
  compactConflictAction,
  topicHeader,
  titleContent,
  modeControl,
  desktopTeamAction,
}: CompactWorkspaceHeaderProps) {
  const { t } = useTranslation();
  const stack = useWorkspaceSheetPages();
  const teamTitle = t("topicWorkbench.directory.title");
  const renderTeam = useStableEvent((close: () => void) => compactTeamDirectory?.(close));
  const openTeam = useStableEvent(() => {
    if (!compactTeamDirectory) return;
    stack?.push({ key: "team", title: teamTitle, render: renderTeam });
  });
  const actionsInBar = resolveWorkspaceActionPlacement(useWindowLayout()) === "vertical-bar";
  const projectRow = useMemo(
    () => (
      <WorkspaceHeaderProjectRow
        subtitle={subtitle}
        isSubtitleDistinct={isSubtitleDistinct}
        serverId={serverId}
      />
    ),
    [subtitle, isSubtitleDistinct, serverId],
  );
  const symbols = {
    "tab-count": tabSwitcher,
    overflow: children,
    explorer: topicHeader && actionsInBar ? null : explorerAction,
  };
  let teamAction = desktopTeamAction;
  if (isCompact && stack && compactTeamDirectory) {
    teamAction = topicHeader ? (
      <ToolbarButton compact label={teamTitle} onPress={openTeam} testID="workspace-header-team">
        <ThemedUsers size={16} />
      </ToolbarButton>
    ) : (
      <HeaderToggleButton
        accessibilityRole="button"
        accessibilityLabel={teamTitle}
        onPress={openTeam}
        testID="workspace-header-team"
        tooltipLabel={t("topicWorkbench.directory.show")}
        tooltipKeys={NO_SHORTCUTS}
        tooltipSide="bottom"
        style={styles.teamButton}
      >
        <Text style={styles.teamLabel} numberOfLines={1}>
          {teamTitle}
        </Text>
      </HeaderToggleButton>
    );
  }
  const actions = (
    <>
      {teamAction}
      {modeControl}
      {isCompact ? compactConflictAction : null}
      {resolveWorkspaceBarActions(headerVariant).map((symbol) => (
        <Fragment key={symbol}>{symbols[symbol]}</Fragment>
      ))}
    </>
  );

  return (
    <IconButtonChromeProvider value="header-island">
      {headerVariant === "compact" ? (
        <CompactHeader
          navigation="menu"
          inDesktopTitlebar={inDesktopTitlebar}
          title={title}
          titleTestID="workspace-header-title"
          testID={topicHeader ? "workspace-topic-header" : undefined}
          titleContent={titleContent}
          subtitle={projectRow}
          loading={isLoading}
          actions={actionsInBar && !topicHeader ? undefined : actions}
        />
      ) : null}
      {topicHeader ? null : (
        <WorkspaceWindowActions isRouteFocused={isRouteFocused} isCompact={isCompact}>
          {actions}
        </WorkspaceWindowActions>
      )}
    </IconButtonChromeProvider>
  );
}

// Panel changes only affect the portaled controls. Keep their subscription below the
// workspace and header so opening a sidebar does not render the chat or rebuild its actions.
export function TopicWorkspaceExplorerActions({
  topicHeader,
  isRouteFocused,
  isCompact,
  explorerAction,
}: {
  topicHeader: boolean;
  isRouteFocused: boolean;
  isCompact: boolean;
  explorerAction: ReactNode;
}) {
  if (!topicHeader || !explorerAction) return null;
  return (
    <WorkspaceWindowActions isRouteFocused={isRouteFocused} isCompact={isCompact}>
      {explorerAction}
    </WorkspaceWindowActions>
  );
}

function WorkspaceWindowActions({
  isRouteFocused,
  isCompact,
  children,
}: {
  isRouteFocused: boolean;
  isCompact: boolean;
  children: ReactNode;
}) {
  const active = usePanelStore(
    (state) => isRouteFocused && (!isCompact || state.mobilePanel.target === "agent"),
  );
  return <WindowLayoutActions active={active}>{children}</WindowLayoutActions>;
}

const NO_SHORTCUTS: [] = [];

const styles = StyleSheet.create((theme) => ({
  teamButton: { width: "auto", minWidth: 44, paddingHorizontal: theme.spacing[2] },
  teamLabel: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
}));

const ThemedUsers = withUnistyles(Users, (theme) => ({ color: theme.colors.foregroundMuted }));
