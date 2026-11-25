import { type ReactNode, useCallback } from "react";
import { Folder, Import, Plus } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { PressHighlight } from "@/components/ui/press-highlight";
import { useSidebarViewStore } from "@/stores/sidebar-view-store";

function SidebarEmptyStateCard({
  testID,
  title,
  description,
  children,
}: {
  testID: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <View style={styles.card} testID={testID}>
      <View style={styles.copy}>
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.description}>{description}</Text>
      </View>
      <View style={styles.actions}>{children}</View>
    </View>
  );
}

/**
 * The two things the sidebar's workspace list says when it has no rows.
 *
 * Both are bodies, not screens: a list mode renders one where its groups would go, inside its own
 * scroll and below the section header it already owns. The header carries the display menu's
 * trigger, and an empty state that replaces the list rather than its body takes the header with
 * it — which is how filtering the last row away used to close the menu you were filtering from.
 */
export function SidebarFilterEmptyState() {
  const { t } = useTranslation();
  const clearLabelFilter = useSidebarViewStore((state) => state.clearLabelFilter);
  const clearProjectFilters = useSidebarViewStore((state) => state.clearProjectFilters);
  // Clears every filter that can empty the list, not just the one that did. The card names no
  // filter, so a Clear that undid only one of two active filters would leave it on screen looking
  // like it had failed.
  const clearFilters = useCallback(() => {
    clearLabelFilter();
    clearProjectFilters();
  }, [clearLabelFilter, clearProjectFilters]);

  return (
    <SidebarEmptyStateCard
      testID="sidebar-filter-empty-state"
      title={t("sidebar.filterEmpty.title")}
      description={t("sidebar.filterEmpty.description")}
    >
      <Button
        variant="secondary"
        size="sm"
        style={styles.action}
        textStyle={styles.actionText}
        onPress={clearFilters}
      >
        {t("sidebar.filterEmpty.clear")}
      </Button>
    </SidebarEmptyStateCard>
  );
}

export function SidebarProjectEmptyState({
  onAddProject,
  onImportSession,
}: {
  onAddProject?: () => void;
  onImportSession?: () => void;
}) {
  const { t } = useTranslation();

  return (
    <SidebarEmptyStateCard
      testID="sidebar-project-empty-state"
      title={t("sidebar.project.empty.title")}
      description={t("sidebar.project.empty.description")}
    >
      <Button
        variant="secondary"
        size="sm"
        leftIcon={Plus}
        style={styles.action}
        textStyle={styles.actionText}
        onPress={onAddProject}
      >
        {t("sidebar.actions.addProject")}
      </Button>
      <Button
        variant="outline"
        size="sm"
        leftIcon={Import}
        style={styles.action}
        textStyle={styles.actionText}
        onPress={onImportSession}
      >
        {t("importSession.title")}
      </Button>
    </SidebarEmptyStateCard>
  );
}

export function SidebarTopicEmptyState({
  hiddenWorkspaceCount,
  onCreateTopic,
}: {
  hiddenWorkspaceCount: number;
  onCreateTopic?: () => void;
}) {
  const { t } = useTranslation();
  const setGroupMode = useSidebarViewStore((state) => state.setGroupMode);
  const handleShowAllWorkspaces = useCallback(() => {
    setGroupMode("project");
  }, [setGroupMode]);

  return (
    <SidebarEmptyStateCard
      testID="sidebar-topic-empty-state"
      title={t("topicWorkbench.sidebar.emptyTitle")}
      description={t("topicWorkbench.sidebar.emptyDescription")}
    >
      {onCreateTopic ? (
        <Button
          variant="secondary"
          size="sm"
          leftIcon={Plus}
          style={styles.action}
          textStyle={styles.actionText}
          onPress={onCreateTopic}
          testID="sidebar-topic-empty-create"
        >
          {t("topicWorkbench.sidebar.newTopic")}
        </Button>
      ) : null}
      {hiddenWorkspaceCount > 0 ? (
        <Button
          variant="outline"
          size="sm"
          leftIcon={Folder}
          style={styles.action}
          textStyle={styles.actionText}
          onPress={handleShowAllWorkspaces}
          testID="sidebar-topic-empty-show-all"
        >
          {t("topicWorkbench.sidebar.viewAllWorkspaces", { count: hiddenWorkspaceCount })}
        </Button>
      ) : null}
    </SidebarEmptyStateCard>
  );
}

export function SidebarHiddenWorkspacesFooter({
  hiddenWorkspaceCount,
  activeWorkspaceHidden,
}: {
  hiddenWorkspaceCount: number;
  activeWorkspaceHidden: boolean;
}) {
  const { t } = useTranslation();
  const setGroupMode = useSidebarViewStore((state) => state.setGroupMode);
  const handleSwitchToProject = useCallback(() => {
    setGroupMode("project");
  }, [setGroupMode]);

  if (hiddenWorkspaceCount <= 0 && !activeWorkspaceHidden) return null;
  const label = activeWorkspaceHidden
    ? t("topicWorkbench.sidebar.activeNonTopicHint")
    : t("topicWorkbench.sidebar.hiddenWorkspacesHint", { count: hiddenWorkspaceCount });

  return (
    <PressHighlight
      accessibilityRole="button"
      onPress={handleSwitchToProject}
      style={styles.hiddenFooterButton}
      highlightStyle={styles.hiddenFooterPressed}
      testID="sidebar-topic-hidden-workspaces-footer"
    >
      <Text style={styles.hiddenFooterText} numberOfLines={1}>
        {label}
      </Text>
    </PressHighlight>
  );
}

const styles = StyleSheet.create((theme) => ({
  card: {
    marginTop: theme.spacing[3],
    padding: theme.spacing[4],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
  },
  copy: {
    gap: theme.spacing[1],
  },
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
    marginTop: theme.spacing[4],
  },
  action: {
    maxWidth: "100%",
  },
  actionText: {
    flexShrink: 1,
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
  },
  description: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  hiddenFooterButton: {
    marginTop: theme.spacing[2],
    paddingVertical: theme.spacing[1.5],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
  },
  hiddenFooterPressed: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  hiddenFooterText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
