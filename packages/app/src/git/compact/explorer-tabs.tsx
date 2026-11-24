import { useTranslation } from "react-i18next";
import { useCallback } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { TOUCH_TARGET } from "@/components/ui/control-geometry";

export type CompactGitExplorerView = "changes" | "history" | "stash";
const VIEWS = ["changes", "history", "stash"] as const;
const SELECTED = { selected: true };
const UNSELECTED = { selected: false };

export function CompactGitExplorerTabs({
  value,
  onChange,
  historyEnabled = true,
  disabled = false,
}: {
  value: CompactGitExplorerView | null;
  onChange: (view: CompactGitExplorerView) => void;
  historyEnabled?: boolean;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const labels = {
    changes: t("gitWorkbench.compact.changes"),
    history: t("gitWorkbench.compact.history"),
    stash: t("gitWorkbench.stashTab"),
  };
  return (
    <View style={styles.tabs} testID="compact-git-explorer-tabs">
      {VIEWS.map((view) => (
        <ExplorerTab
          key={view}
          view={view}
          label={labels[view]}
          selected={value === view}
          disabled={disabled || (view === "history" && !historyEnabled)}
          onChange={onChange}
        />
      ))}
    </View>
  );
}

function ExplorerTab({
  view,
  label,
  selected,
  disabled,
  onChange,
}: {
  view: CompactGitExplorerView;
  label: string;
  selected: boolean;
  disabled: boolean;
  onChange: (view: CompactGitExplorerView) => void;
}) {
  const select = useCallback(() => onChange(view), [onChange, view]);
  return (
    <Button
      variant={selected ? "secondary" : "ghost"}
      accessibilityState={selected ? SELECTED : UNSELECTED}
      aria-selected={selected}
      style={styles.tab}
      disabled={disabled}
      onPress={select}
      testID={`compact-git-${view}`}
    >
      {label}
    </Button>
  );
}

const styles = StyleSheet.create((theme) => ({
  tabs: { flexDirection: "row", gap: theme.spacing[1] },
  tab: { flex: 1, minHeight: TOUCH_TARGET },
}));
