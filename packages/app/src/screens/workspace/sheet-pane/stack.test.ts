import { expect, it, vi } from "vitest";
import type { SheetTab } from "@/stores/workspace-layout-store";
import { createWorkspaceSheetStack } from "./stack";

function tab(id: string): SheetTab {
  return {
    tab: { tabId: id, target: { kind: "agent", agentId: id }, createdAt: 0 },
    policy: { openAsTab: true },
    parentTabId: null,
  };
}

it("keeps tab and page identities through mixed pushes and back presses", () => {
  const stack = createWorkspaceSheetStack();
  const teamClose = vi.fn();
  const conflictClose = vi.fn();
  const evidence = tab("evidence");
  stack.push({ key: "team", title: "Team", render: () => null, onClose: teamClose });
  const team = stack.getSnapshot()[0]!;
  stack.syncTabs([evidence]);
  const evidenceEntry = stack.getSnapshot()[1]!;
  stack.push({ key: "conflict", title: "Conflict", render: () => null, onClose: conflictClose });
  stack.syncTabs([evidence]);

  expect(stack.getSnapshot().map(({ key }) => key)).toEqual([
    "page:team",
    "tab:evidence",
    "page:conflict",
  ]);
  stack.closeTopPage(team);
  expect(teamClose).not.toHaveBeenCalled();
  stack.closeTopPage(stack.getSnapshot().at(-1)!);

  expect(conflictClose).toHaveBeenCalledOnce();
  expect(stack.getSnapshot()[1]).toBe(evidenceEntry);
  stack.syncTabs([]);
  expect(stack.getSnapshot()[0]).toBe(team);
  stack.closeTopPage(team);

  expect(teamClose).toHaveBeenCalledOnce();
  expect(stack.getSnapshot()).toHaveLength(0);
});

it("keeps a closed declarative page closed when its source publishes a late update", () => {
  const stack = createWorkspaceSheetStack();
  const page = { key: "detail", title: "Commit", render: () => null };
  stack.push(page);
  stack.closeTopPage(stack.getSnapshot()[0]!);
  stack.update({ ...page, title: "Late result" });
  expect(stack.getSnapshot()).toHaveLength(0);
});

it("leaves a busy page on top until it can be closed", () => {
  const stack = createWorkspaceSheetStack();
  let busy = true;
  const onClose = vi.fn();
  stack.push({
    key: "conflict",
    title: "Conflict",
    render: () => null,
    canClose: () => !busy,
    onClose,
  });
  const page = stack.getSnapshot()[0]!;
  stack.closeTopPage(page);
  expect(stack.getSnapshot()[0]).toBe(page);
  expect(onClose).not.toHaveBeenCalled();
  busy = false;
  stack.closeTopPage(page);
  expect(onClose).toHaveBeenCalledOnce();
  expect(stack.getSnapshot()).toHaveLength(0);
});
