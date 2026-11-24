import { useCallback, useMemo } from "react";
import { ScrollView, View, StyleSheet } from "react-native";
import {
  SheetBottomInset,
  SheetDragArea,
  SheetFooter,
  SheetHeaderView,
} from "@/components/adaptive-modal-sheet";
import { useMenuContext, type MenuFillPageDefinition } from "@/components/ui/menu";
import { usePaneContext } from "@/panels/pane-context";
import type { SheetTab } from "@/stores/workspace-layout-store";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";
import { useSheetPaneBridge } from "./host";
import { SheetPane } from "./sheet-pane";
import type { WorkspaceSheetPage } from "./stack";

/**
 * Shows sheet tabs as pages of a menu opened from a pane, so a row's sheet replaces the list it
 * was chosen from instead of stacking a second sheet over it. Back returns to the list; Close
 * closes the menu, which uncovers the pane the menu was opened from.
 */
export function useSheetPanePage(): (sheet: SheetTab) => MenuFillPageDefinition {
  const bridge = useSheetPaneBridge();
  const { target: opener } = usePaneContext();
  return useCallback(
    (sheet) => ({
      id: sheet.tab.tabId,
      fill: true,
      content: bridge(
        // Keyed like the detached container, so the panel's descriptor hook stays fixed per page.
        <MenuSheetPane
          key={`${sheet.tab.tabId}:${sheet.tab.target.kind}`}
          sheet={sheet}
          opener={opener}
        />,
      ),
    }),
    [bridge, opener],
  );
}

function MenuSheetPane({ sheet, opener }: { sheet: SheetTab; opener: WorkspaceTabTarget }) {
  const { setOpen, goBack } = useMenuContext("MenuSheetPane");
  const close = useCallback(() => setOpen(false), [setOpen]);
  return <SheetPane sheet={sheet} onClose={close} onBack={goBack} opener={opener} isTop />;
}

export function WorkspacePagePane({
  page,
  onClose,
  onBack,
}: {
  page: WorkspaceSheetPage;
  onClose: () => void;
  onBack?: () => void;
}) {
  const body = page.render(onClose);
  const header = useMemo(
    () => ({
      ...page.header,
      title: page.title,
      back: onBack ? { onPress: onBack } : undefined,
    }),
    [onBack, page.header, page.title],
  );
  const content = (
    <View style={styles.page}>
      <SheetDragArea>
        <SheetHeaderView header={header} onClose={onClose} testID={page.testID} />
      </SheetDragArea>
      <SheetBottomInset style={styles.page} role="dialog" aria-label={page.title}>
        {page.scrollable ? (
          <ScrollView style={styles.page} keyboardShouldPersistTaps="handled">
            {body}
          </ScrollView>
        ) : (
          <View style={styles.page}>{body}</View>
        )}
        {page.footer ? <SheetFooter>{page.footer}</SheetFooter> : null}
      </SheetBottomInset>
    </View>
  );
  return page.bridge ? page.bridge(content) : content;
}

const styles = StyleSheet.create({
  page: { flex: 1, minHeight: 0 },
});
