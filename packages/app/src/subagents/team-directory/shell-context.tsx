import { createContext, useContext, type ReactNode } from "react";

export interface TeamDirectoryShellContextValue {
  /** True when WorkspaceScreen mounts the unified Zone 3 team directory at the shell level. */
  isOwnedByWorkspaceShell: boolean;
  /** True when the shell-level team directory is currently visible on screen. */
  isDirectoryVisible: boolean;
  /** Toggle visibility of the shell-level team directory. */
  toggleDirectory: () => void;
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
