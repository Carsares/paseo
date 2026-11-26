import { Fragment, useMemo, type ReactNode } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { TopicStreamModeControl } from "@/agent-stream/topic-card/topic-stream-mode-control";
import { useContainerWidthBelow } from "@/hooks/use-container-width";
import { useTeamDirectoryShell } from "@/subagents/team-directory/shell-context";
import { TopicDirectoryToggle } from "../topic-header";
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
  compactConflictAction?: ReactNode;
  topicHeader?: boolean;
  showDirectoryToggle?: boolean;
  titleContent?: ReactNode;
  modeTarget?: WorkspaceModeTarget;
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
  compactConflictAction,
  topicHeader,
  showDirectoryToggle = true,
  titleContent,
  modeTarget,
}: CompactWorkspaceHeaderProps) {
  const { openDirectory } = useTeamDirectoryShell();
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
  const topicTitle = useMemo(() => {
    if (!topicHeader && !(showDirectoryToggle && openDirectory)) return titleContent;
    return (
      <WorkspaceTopicHeaderLeading
        compact={isCompact}
        modeTarget={modeTarget}
        showDirectoryToggle={showDirectoryToggle}
      >
        {titleContent ?? (
          <>
            {isLoading ? (
              <View style={styles.skeleton} />
            ) : (
              <Text
                style={styles.title}
                numberOfLines={1}
                ellipsizeMode="tail"
                testID="workspace-header-title"
              >
                {title}
              </Text>
            )}
            {isLoading ? null : projectRow}
          </>
        )}
      </WorkspaceTopicHeaderLeading>
    );
  }, [
    isCompact,
    isLoading,
    modeTarget,
    openDirectory,
    projectRow,
    showDirectoryToggle,
    title,
    titleContent,
    topicHeader,
  ]);
  const actions = (
    <>
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
          titleContent={topicTitle}
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

interface WorkspaceModeTarget {
  serverId: string;
  workspaceId: string;
  agentId: string;
}

export function WorkspaceTopicHeaderLeading({
  compact = false,
  modeTarget,
  showDirectoryToggle = true,
  children,
}: {
  compact?: boolean;
  modeTarget?: WorkspaceModeTarget;
  showDirectoryToggle?: boolean;
  children: ReactNode;
}) {
  // Measure the space left after navigation, directory and trailing actions. This
  // leaves room for a short title beside both translated mode labels.
  const { isBelow: iconOnly, onLayout } = useContainerWidthBelow(288);
  return (
    <View style={styles.leading}>
      {showDirectoryToggle ? <TopicDirectoryToggle compact={compact} /> : null}
      <View style={styles.heading} onLayout={onLayout}>
        <View style={styles.titleSlot}>{children}</View>
        {modeTarget ? (
          <View style={styles.mode}>
            <TopicStreamModeControl
              serverId={modeTarget.serverId}
              agentId={modeTarget.agentId}
              compact={compact}
              iconOnly={iconOnly}
            />
          </View>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  leading: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  heading: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  titleSlot: {
    flex: 1,
    minWidth: 0,
    justifyContent: "center",
    overflow: "hidden",
  },
  mode: { flexShrink: 0 },
  title: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  skeleton: {
    width: 140,
    maxWidth: "100%",
    height: 22,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface3,
    opacity: 0.25,
  },
}));
