import { useCallback, useMemo } from "react";
import {
  AdaptiveModalSheet,
  type AdaptiveModalSheetProps,
} from "@/components/adaptive-modal-sheet";
import type { ContextBridge } from "@/components/ui/isolated-bottom-sheet-modal";
import { PaneProvider, usePaneContext } from "@/panels/pane-context";
import {
  useSheetPaneBridge,
  useWorkspaceSheetPages,
  WorkspaceSheetSurface,
} from "@/screens/workspace/sheet-pane";
import { useIsCompactFormFactor } from "@/constants/layout";

type GraphSheetProps = AdaptiveModalSheetProps & {
  workspacePageKey?: string;
  canClose?: () => boolean;
};

export function GraphSheet({ workspacePageKey, canClose, ...props }: GraphSheetProps) {
  const pane = usePaneContext();
  const compact = useIsCompactFormFactor();
  const stack = useWorkspaceSheetPages();
  const bridgeWorkspace = useSheetPaneBridge();
  const bridgePane = useCallback<ContextBridge>(
    (children) => <PaneProvider value={pane}>{children}</PaneProvider>,
    [pane],
  );
  const bridge = useCallback<ContextBridge>(
    (children) => bridgeWorkspace(bridgePane(children)),
    [bridgeWorkspace, bridgePane],
  );
  const { children, footer, header, onClose, scrollable, testID } = props;
  const page = useMemo(
    () =>
      workspacePageKey && header
        ? {
            key: workspacePageKey,
            title: header.title,
            header,
            render: () => children,
            bridge: bridgePane,
            onClose,
            canClose,
            scrollable,
            footer,
            testID,
          }
        : null,
    [workspacePageKey, header, children, bridgePane, onClose, canClose, scrollable, footer, testID],
  );
  if (compact && stack && page) return props.visible ? <WorkspaceSheetSurface page={page} /> : null;
  return <AdaptiveModalSheet {...props} contextBridge={bridge} />;
}
