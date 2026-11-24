import { useLayoutEffect, useRef, useState } from "react";
import type { CheckoutGitRepo } from "@getpaseo/protocol/messages";
import { useStableEvent } from "@/hooks/use-stable-event";
import { useLiveEnabled } from "./use-live-enabled";

export interface RebaseSurfaceState {
  id: number;
  kind: "plan" | "conflicts";
  repo: CheckoutGitRepo;
}

export function useRebaseSurfaces(
  active: boolean,
  repo: CheckoutGitRepo | null,
  refresh: () => void,
) {
  const nextId = useRef(0);
  const [surface, setSurface] = useState<RebaseSurfaceState | null>(null);
  const dirty = useRef(false);
  const live = useLiveEnabled(active);
  const visible = active && surface?.repo.repoRoot === repo?.repoRoot ? surface : null;
  const refreshWhenIdle = useStableEvent(() => {
    if (live.current && !visible) {
      dirty.current = false;
      refresh();
    } else {
      dirty.current = true;
    }
  });
  useLayoutEffect(() => {
    if (!visible) setSurface(null);
    if (active && dirty.current && !visible) {
      dirty.current = false;
      refresh();
    }
  }, [active, visible, refresh]);
  const openSurface = useStableEvent(
    (target: CheckoutGitRepo, kind: RebaseSurfaceState["kind"]) => {
      if (!live.current) return;
      if (dirty.current) {
        dirty.current = false;
        refresh();
      }
      const id = ++nextId.current;
      setSurface({ id, kind, repo: target });
    },
  );
  const closeSurface = useStableEvent((source: RebaseSurfaceState) => {
    if (visible?.id !== source.id) return;
    setSurface(null);
    if (source.kind === "conflicts") dirty.current = true;
  });
  const reportSurfaceResult = useStableEvent(
    (source: RebaseSurfaceState, paused: boolean, plan: boolean) => {
      if (!live.current || visible?.id !== source.id) {
        refreshWhenIdle();
        return;
      }
      if (!paused) {
        dirty.current = true;
        setSurface(null);
      } else if (plan) {
        const id = ++nextId.current;
        setSurface({ ...source, id, kind: "conflicts" });
        refresh();
      }
    },
  );
  return {
    surface: visible,
    openSurface,
    closeSurface,
    reportSurfaceResult,
    reportHiddenConflictChange: refreshWhenIdle,
  };
}
