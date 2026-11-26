import { createContext, useContext, useMemo, type ReactNode } from "react";

import { useTranslation } from "react-i18next";
import { useStableEvent } from "@/hooks/use-stable-event";
import {
  useIsWorkspaceSheetPageOnTop,
  useWorkspaceSheetPages,
} from "@/screens/workspace/sheet-pane/stack-context";

export interface TeamDirectoryShellContextValue {
  /** True when WorkspaceScreen mounts the unified Zone 3 team directory at the shell level. */
  isOwnedByWorkspaceShell: boolean;
  /** True when the shell-level team directory is currently visible on screen. */
  isDirectoryVisible: boolean;
  /** Toggle visibility of the shell-level team directory. */
  toggleDirectory: () => void;
  /** Open the workspace team directory (desktop dock/overlay or compact sheet) if hidden. */
  openDirectory?: () => void;
}

const DEFAULT_VALUE: TeamDirectoryShellContextValue = {
  isOwnedByWorkspaceShell: false,
  isDirectoryVisible: false,
  toggleDirectory: () => {},
};

const TeamDirectoryShellContext = createContext<TeamDirectoryShellContextValue>(DEFAULT_VALUE);

export function TeamDirectoryShellProvider({
  value,
  children,
}: {
  value: TeamDirectoryShellContextValue;
  children: ReactNode;
}) {
  return (
    <TeamDirectoryShellContext.Provider value={value}>
      {children}
    </TeamDirectoryShellContext.Provider>
  );
}

export function useTeamDirectoryShell(): TeamDirectoryShellContextValue {
  return useContext(TeamDirectoryShellContext);
}

const TEAM_DIRECTORY_PAGE = "team";

/** Give the leading button and workspace menu the same compact sheet action. */
export function TeamDirectorySheetProvider({
  renderDirectory,
  children,
}: {
  renderDirectory: (close: () => void) => ReactNode;
  children: ReactNode;
}) {
  const baseValue = useTeamDirectoryShell();
  const { t } = useTranslation();
  const stack = useWorkspaceSheetPages();
  const visible = useIsWorkspaceSheetPageOnTop(TEAM_DIRECTORY_PAGE);
  const title = t("topicWorkbench.directory.title");
  const render = useStableEvent(renderDirectory);
  const openDirectory = useStableEvent(() => {
    stack?.push({ key: TEAM_DIRECTORY_PAGE, title, render });
  });
  const toggleDirectory = useStableEvent(() => {
    const top = stack?.getSnapshot().at(-1);
    if (top?.kind === "page" && top.page.key === TEAM_DIRECTORY_PAGE) {
      stack?.closeTopPage(top);
    } else {
      openDirectory();
    }
  });
  const value = useMemo(
    () =>
      stack
        ? { ...baseValue, isDirectoryVisible: visible, openDirectory, toggleDirectory }
        : baseValue,
    [baseValue, openDirectory, stack, toggleDirectory, visible],
  );
  return <TeamDirectoryShellProvider value={value}>{children}</TeamDirectoryShellProvider>;
}
