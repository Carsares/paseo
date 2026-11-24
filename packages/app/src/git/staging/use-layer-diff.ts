import { useEffect, useMemo, useState } from "react";
import type { DiffCompare, DiffState } from "@getpaseo/client";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import type { StagingLayer } from "./model";

export function stagedDiffCompare(cwd: string, headSha: string | null): DiffCompare {
  const base =
    headSha === null ? { kind: "empty" as const } : { kind: "rev" as const, rev: headSha };
  return { cwd, base, head: { kind: "index" } };
}

export function useStagingLayerDiff(
  serverId: string,
  repoRoot: string,
  headSha: string | null,
  layer: StagingLayer,
  active: boolean,
) {
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  const compare = useMemo<DiffCompare>(() => {
    if (layer === "unstaged") {
      return { cwd: repoRoot, base: { kind: "index" }, head: { kind: "worktree" } };
    }
    return stagedDiffCompare(repoRoot, headSha);
  }, [headSha, layer, repoRoot]);
  const [frame, setFrame] = useState<{
    compare: typeof compare;
    client: typeof client;
    diff?: DiffState;
    error?: string;
  } | null>(null);
  useEffect(() => {
    if (!client || !active || !connected) return;
    let current = true;
    const subscription = client.observeDiff(compare);
    const unsubscribe = subscription.subscribe({
      snapshot: (diff) => {
        if (current) setFrame({ compare, client, diff });
      },
      update: () => {},
      error: (error) => {
        if (current) setFrame({ compare, client, error: String(error) });
      },
    });
    return () => {
      current = false;
      unsubscribe();
      void subscription.release().catch(console.error);
    };
  }, [active, client, compare, connected]);

  const available = active && connected && frame?.compare === compare && frame.client === client;
  const current = available ? frame : undefined;
  const diff = current?.diff;
  return { diff, error: diff?.phase === "error" ? diff.error.message : current?.error };
}
