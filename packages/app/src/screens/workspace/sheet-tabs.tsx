import { useIsFocused } from "expo-router/react-navigation";
import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { Keyboard, StyleSheet } from "react-native";
import {
  FULL_SHEET_SNAP_POINTS,
  SheetBackground,
  SheetHandle,
} from "@/components/adaptive-modal-sheet";
import { RetainedPanel, useRetainedPanelActive } from "@/components/retained-panel";
import {
  IsolatedBottomSheetModal,
  type IsolatedBottomSheetModalRef,
  systemBackPress,
} from "@/components/ui/isolated-bottom-sheet-modal";
import { SheetVisibleFrame } from "@/components/ui/isolated-bottom-sheet-modal/visible-frame";
import { useStableEvent } from "@/hooks/use-stable-event";
import { isNative } from "@/constants/platform";
import {
  SheetPane,
  useSheetPaneBridge,
  useSheetPaneHost,
  useWorkspaceSheetPages,
} from "@/screens/workspace/sheet-pane";
import { WorkspacePagePane } from "@/screens/workspace/sheet-pane/page";
import { useRegisterActiveWorkspaceSheet } from "@/screens/workspace/sheet-pane/active-workspace";
import type {
  WorkspaceSheetEntry,
  WorkspaceSheetStack,
} from "@/screens/workspace/sheet-pane/stack";

export interface SheetTabsProps {
  /** The workspace's ordinary tab close, including its unsaved-changes guard. */
  onCloseTab: (tabId: string) => Promise<void>;
}

/** The single modal hosts ordinary sheet tabs and workspace pages in opening order. */
export function SheetTabs(props: SheetTabsProps) {
  const stack = useWorkspaceSheetPages();
  return stack ? <WorkspaceSheetTabs {...props} stack={stack} /> : null;
}

function WorkspaceSheetTabs({
  onCloseTab,
  stack,
}: SheetTabsProps & { stack: WorkspaceSheetStack }) {
  const { workspaceKey, isWorkspaceFocused } = useSheetPaneHost();
  const isScreenFocused = useIsFocused();
  const active = useRetainedPanelActive();
  const ownsSheet = active && isScreenFocused && isWorkspaceFocused;
  useRegisterActiveWorkspaceSheet(stack, ownsSheet);
  const entries = useSyncExternalStore(stack.subscribe, stack.getSnapshot, stack.getSnapshot);
  const top = entries.at(-1);
  return top ? (
    <SheetTabModal
      key={workspaceKey}
      stack={stack}
      entries={entries}
      ownsSheet={ownsSheet}
      onCloseTab={onCloseTab}
    />
  ) : null;
}

function SheetTabModal({
  entries,
  stack,
  ownsSheet,
  onCloseTab,
}: SheetTabsProps & {
  stack: WorkspaceSheetStack;
  entries: readonly WorkspaceSheetEntry[];
  ownsSheet: boolean;
}) {
  const sheetRef = useRef<IsolatedBottomSheetModalRef>(null);
  const alive = useRef(false);
  const closing = useRef(false);
  const contextBridge = useSheetPaneBridge();

  const closeTop = useStableEvent(async (slidDown = false) => {
    if (closing.current || !alive.current || !ownsSheet) return;
    const top = stack.getSnapshot().at(-1);
    if (!top) return;
    closing.current = true;
    try {
      if (top.kind === "page") stack.closeTopPage(top);
      else await onCloseTab(top.sheet.tab.tabId);
    } finally {
      closing.current = false;
      if (slidDown && alive.current && stack.getSnapshot().length > 0) {
        sheetRef.current?.snapToIndex(0);
      }
    }
  });
  const back = useStableEvent(() => void closeTop());
  const handleChange = useStableEvent((index: number) => {
    if (index === -1) void closeTop(true);
  });

  useLayoutEffect(() => {
    alive.current = true;
    sheetRef.current?.present();
    return () => {
      alive.current = false;
    };
  }, []);

  const topKey = entries.at(-1)?.key;
  useEffect(() => {
    if (isNative && ownsSheet && topKey) Keyboard.dismiss();
  }, [ownsSheet, topKey]);

  useEffect(() => {
    if (!ownsSheet) return;
    return systemBackPress.subscribe(() => {
      back();
      return true;
    });
  }, [back, ownsSheet]);

  return (
    <IsolatedBottomSheetModal
      ref={sheetRef}
      contextBridge={contextBridge}
      snapPoints={FULL_SHEET_SNAP_POINTS}
      enableDynamicSizing={false}
      enablePanDownToClose={entries.length === 1}
      enableContentPanningGesture={false}
      enableDismissOnClose={false}
      backgroundComponent={SheetBackground}
      handleComponent={SheetHandle}
      backdropOpacity={ownsSheet ? 0.45 : undefined}
      containerStyle={ownsSheet ? undefined : styles.inactiveContainer}
      onChange={handleChange}
      accessible={false}
    >
      <SheetVisibleFrame>
        {entries.map((entry, index) => {
          const top = index === entries.length - 1;
          const onBack = index > 0 ? back : undefined;
          return (
            <RetainedPanel
              key={entry.kind === "tab" ? `${entry.key}:${entry.sheet.tab.target.kind}` : entry.key}
              active={top && ownsSheet}
            >
              {entry.kind === "tab" ? (
                <SheetPane
                  sheet={entry.sheet}
                  onClose={back}
                  onBack={onBack}
                  isTop={top && ownsSheet}
                />
              ) : (
                <WorkspacePagePane page={entry.page} onClose={back} onBack={onBack} />
              )}
            </RetainedPanel>
          );
        })}
      </SheetVisibleFrame>
    </IsolatedBottomSheetModal>
  );
}

const styles = StyleSheet.create({
  inactiveContainer: { display: "none" },
});
