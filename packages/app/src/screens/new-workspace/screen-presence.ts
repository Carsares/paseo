import { usePathname } from "expo-router";
import { useNavigation } from "expo-router/react-navigation";
import { useCallback, useEffect, useRef } from "react";

const NEW_WORKSPACE_PATHNAME = "/new";

export interface NewWorkspaceScreenPresence {
  isMounted: boolean;
  isFocused: boolean;
  pathname: string;
}

/**
 * Workspace creation blocks on a slow daemon RPC, so by the time it resolves the user may have
 * moved on. Popping unmounts the old screen, and pushing another /new leaves it mounted with
 * the same pathname. Only the focused route instance may navigate on receipt.
 */
export function isNewWorkspaceScreenActive(input: NewWorkspaceScreenPresence): boolean {
  return input.isMounted && input.isFocused && input.pathname === NEW_WORKSPACE_PATHNAME;
}

export function useNewWorkspaceScreenPresence(): () => boolean {
  const pathname = usePathname();
  const navigation = useNavigation();
  const pathnameRef = useRef(pathname);
  pathnameRef.current = pathname;
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  return useCallback(
    () =>
      isNewWorkspaceScreenActive({
        isMounted: isMountedRef.current,
        isFocused: navigation.isFocused(),
        pathname: pathnameRef.current,
      }),
    [navigation],
  );
}
