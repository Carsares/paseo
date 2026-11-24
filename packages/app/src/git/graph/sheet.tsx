import { useCallback } from "react";
import {
  AdaptiveModalSheet,
  type AdaptiveModalSheetProps,
} from "@/components/adaptive-modal-sheet";
import type { ContextBridge } from "@/components/ui/isolated-bottom-sheet-modal";
import { PaneProvider, usePaneContext } from "@/panels/pane-context";
import { useSheetPaneBridge } from "@/screens/workspace/sheet-pane/host";

export function GraphSheet(props: AdaptiveModalSheetProps) {
  const pane = usePaneContext();
  const bridgeWorkspace = useSheetPaneBridge();
  const bridge = useCallback<ContextBridge>(
    (children) => bridgeWorkspace(<PaneProvider value={pane}>{children}</PaneProvider>),
    [bridgeWorkspace, pane],
  );
  return <AdaptiveModalSheet {...props} contextBridge={bridge} />;
}
