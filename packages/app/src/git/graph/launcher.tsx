import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { GitFork } from "lucide-react-native";
import { useStableEvent } from "@/hooks/use-stable-event";
import { Button } from "@/components/ui/button";
import { newTabPanelRegistration } from "@/panels/new-tab-panel";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { usePaneContext } from "@/panels/pane-context";
import { styles } from "./ui";

const NewTabPanel = newTabPanelRegistration.component;

function NewTabWithGitGraph() {
  const { t } = useTranslation();
  const { host, serverId, workspaceId, retargetCurrentTab } = usePaneContext();
  const openGraph = useStableEvent(() => {
    const key = buildWorkspaceTabPersistenceKey({ serverId, workspaceId });
    if (!key) return;
    const layout = useWorkspaceLayoutStore.getState();
    const existing = layout.getWorkspaceTabs(key).find((tab) => tab.target.kind === "git_graph");
    if (existing) layout.focusTab(key, existing.tabId);
    else retargetCurrentTab({ kind: "git_graph" });
  });
  if (host !== "main") return <NewTabPanel />;
  return (
    <View style={styles.fill}>
      <NewTabPanel />
      <View style={[styles.stack, styles.rowBorder]}>
        <Button
          leftIcon={GitFork}
          variant="ghost"
          testID="workspace-new-tab-git-graph"
          onPress={openGraph}
        >
          {t("gitWorkbench.graphTitle")}
        </Button>
      </View>
    </View>
  );
}

export const newTabWithGitGraphRegistration = {
  ...newTabPanelRegistration,
  component: NewTabWithGitGraph,
};
