// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { CheckoutGitRepo } from "@getpaseo/protocol/messages";
import { expect, it, vi } from "vitest";
import { useRebaseSurfaces } from "./use-rebase-surfaces";
import { refreshVisibleConflict } from "./use-working-tree";

const repo: CheckoutGitRepo = {
  repoRoot: "/workspace/repo",
  repoId: "repo",
  displayName: "repo",
  currentBranch: "topic",
  headSha: "a".repeat(40),
  operationState: "idle",
};

it("keeps the new same-repo sheet when an earlier operation responds after hide and reopen", () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const mount = document.createElement("div");
  const root = createRoot(mount);
  const refresh = vi.fn();
  let actions: ReturnType<typeof useRebaseSurfaces>;
  function Harness({ active }: { active: boolean }) {
    actions = useRebaseSurfaces(active, repo, refresh);
    return null;
  }
  try {
    act(() => root.render(<Harness active />));
    act(() => actions.openSurface(repo, "conflicts"));
    const old = actions!.surface!;
    act(() => root.render(<Harness active={false} />));
    act(() => actions.reportSurfaceResult(old, true, false));
    expect(refresh).not.toHaveBeenCalled();
    act(() => root.render(<Harness active />));
    expect(refresh).toHaveBeenCalledTimes(1);
    act(() => actions.openSurface(repo, "plan"));
    const reopened = actions!.surface;

    act(() => actions.reportSurfaceResult(old, false, false));
    act(() => actions.closeSurface(old));
    expect(actions!.surface).toBe(reopened);
    expect(refresh).toHaveBeenCalledTimes(1);

    act(() => actions.closeSurface(reopened!));
    expect(actions!.surface).toBeNull();
    expect(refresh).toHaveBeenCalledTimes(2);
    act(() => actions.reportSurfaceResult(old, false, false));
    expect(refresh).toHaveBeenCalledTimes(3);
    act(() => actions.reportHiddenConflictChange());
    expect(refresh).toHaveBeenCalledTimes(4);
  } finally {
    act(() => root.unmount());
  }
});

it("skips conflict reads after hiding, including when a tree read is already in flight", async () => {
  const tree = Promise.withResolvers<void>();
  const readTree = vi.fn(() => tree.promise);
  const readConflict = vi.fn().mockResolvedValue(undefined);
  const active = { current: false };
  await refreshVisibleConflict(active, readTree, readConflict);
  expect(readTree).not.toHaveBeenCalled();

  active.current = true;
  const refreshing = refreshVisibleConflict(active, readTree, readConflict);
  expect(readTree).toHaveBeenCalledOnce();
  active.current = false;
  tree.resolve();
  await refreshing;
  expect(readConflict).not.toHaveBeenCalled();
});
