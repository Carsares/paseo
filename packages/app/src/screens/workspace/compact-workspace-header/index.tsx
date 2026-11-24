import { Fragment, useMemo, type ReactNode } from "react";
import { Text } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
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
    explorer: explorerAction,
  };
  const actions = (
    <>
      {isCompact && stack && compactTeamDirectory ? (
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
      ) : null}
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
          subtitle={projectRow}
          loading={isLoading}
          actions={actionsInBar ? undefined : actions}
        />
      ) : null}
      <WorkspaceWindowActions isRouteFocused={isRouteFocused} isCompact={isCompact}>
        {actions}
      </WorkspaceWindowActions>
    </IconButtonChromeProvider>
  );
}

// Panel changes only affect the portaled controls. Keep their subscription below the
// workspace and header so opening a sidebar does not render the chat or rebuild its actions.
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
