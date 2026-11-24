import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { WorkspaceDurableItem } from "@getpaseo/protocol/messages";
import { describe, expect, it, vi } from "vitest";
import { AbortController as BasicAbortController } from "abort-controller";
import {
  applyDurableItemRevision,
  getDurableItemDecisionBlock,
  listDurableItems,
  selectPendingDurableItems,
  submitDurableItemDecision,
} from "./model";

const pending = {
  workspaceId: "workspace",
  requestId: "request",
  sourceAgentId: "agent",
  sourceTurnId: "turn",
  title: "Accept trace",
  kind: "acceptance",
  evidence: [{ type: "file", path: "startup-trace.md", fingerprint: "hash" }],
  createdAt: "2026-01-01T00:00:00Z",
  revision: 0,
  status: "pending",
} satisfies WorkspaceDurableItem;
const decided = {
  ...pending,
  status: "decided",
  revision: 1,
  decision: "request_changes",
  decidedAt: "2026-01-02T00:00:00Z",
} satisfies WorkspaceDurableItem;

function page(items: WorkspaceDurableItem[], nextCursor: string | null = null) {
  return { requestId: "call", items, nextCursor, error: null };
}

describe("durable item inbox", () => {
  it("stops requesting pages after a basic native-style signal is cancelled", async () => {
    const controller = new BasicAbortController();
    const { signal } = controller;
    expect("throwIfAborted" in signal).toBe(false);
    const list = vi.fn<DaemonClient["listWorkspaceDurableItems"]>(async () => {
      controller.abort();
      return page([pending], "next");
    });
    await expect(
      listDurableItems({ listWorkspaceDurableItems: list }, { pendingOnly: true }, signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(list).toHaveBeenCalledTimes(1);
    await expect(
      listDurableItems({ listWorkspaceDurableItems: list }, { pendingOnly: true }, signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("follows host pages, counts one revision per workspace, and keeps separate host identities", async () => {
    const otherWorkspace = { ...pending, workspaceId: "parked" };
    const list = vi
      .fn<DaemonClient["listWorkspaceDurableItems"]>()
      .mockResolvedValueOnce(page([pending], "page-2"))
      .mockResolvedValueOnce(page([pending, otherWorkspace]));
    const result = await listDurableItems(
      { listWorkspaceDurableItems: list },
      { pendingOnly: true },
      new AbortController().signal,
    );

    expect(list.mock.calls).toEqual([
      [{ statusFilter: "pending", limit: 100, cursor: undefined }],
      [{ statusFilter: "pending", limit: 100, cursor: "page-2" }],
    ]);
    expect(
      selectPendingDurableItems([
        { serverId: "host-a", items: result },
        { serverId: "host-b", items: [pending] },
      ]),
    ).toEqual([
      { serverId: "host-a", item: pending },
      { serverId: "host-a", item: otherWorkspace },
      { serverId: "host-b", item: pending },
    ]);
  });

  it("keeps the winning terminal revision when listing the selected workspace", async () => {
    const list = vi
      .fn<DaemonClient["listWorkspaceDurableItems"]>()
      .mockResolvedValueOnce(page([decided], "next"))
      .mockResolvedValueOnce(page([pending, { ...pending, workspaceId: "other" }]));
    const result = await listDurableItems(
      { listWorkspaceDurableItems: list },
      { workspaceId: pending.workspaceId },
      new AbortController().signal,
    );
    expect(list.mock.calls).toEqual([
      [{ workspaceId: pending.workspaceId, limit: 100, cursor: undefined }],
      [{ workspaceId: pending.workspaceId, limit: 100, cursor: "next" }],
    ]);
    expect(result).toEqual([decided]);
    expect(applyDurableItemRevision(result, pending, false)).toEqual([decided]);
    expect(applyDurableItemRevision([pending], decided, true)).toEqual([]);
  });

  it("fails an incomplete scan instead of reporting a partial count as complete", async () => {
    const list = vi
      .fn<DaemonClient["listWorkspaceDurableItems"]>()
      .mockResolvedValue(page([pending], "loop"));
    await expect(
      listDurableItems(
        { listWorkspaceDurableItems: list },
        { pendingOnly: true },
        new AbortController().signal,
      ),
    ).rejects.toThrow("Repeated durable item cursor");
    expect(list).toHaveBeenCalledTimes(2);
  });
});

describe("durable item decisions", () => {
  it("submits the revision displayed to the user and keeps the other device's decision", async () => {
    const decide = vi.fn<DaemonClient["decideWorkspaceDurableItem"]>().mockResolvedValue({
      requestId: "rpc",
      workspaceId: pending.workspaceId,
      durableItemRequestId: pending.requestId,
      item: decided,
      error: "This item changed",
    });
    await expect(
      submitDurableItemDecision({ decideWorkspaceDurableItem: decide }, pending, "approve"),
    ).resolves.toEqual({ outcome: "conflict", item: decided });
    expect(decide).toHaveBeenCalledWith({
      workspaceId: pending.workspaceId,
      durableItemRequestId: pending.requestId,
      expectedRevision: 0,
      decision: "approve",
    });
  });

  it("keeps non-approval actions available when an acceptance has missing or stale evidence", () => {
    const input = { item: pending, online: true, confirmed: true, decision: "approve" } as const;
    expect(getDurableItemDecisionBlock({ ...input, online: false })).toBe("offline");
    expect(getDurableItemDecisionBlock({ ...input, item: { ...pending, evidence: [] } })).toBe(
      "evidenceMissing",
    );
    expect(getDurableItemDecisionBlock({ ...input, staleEvidenceRevision: 0 })).toBe(
      "evidenceStale",
    );
    expect(
      getDurableItemDecisionBlock({
        ...input,
        staleEvidenceRevision: 0,
        decision: "request_changes",
      }),
    ).toBeUndefined();
    expect(
      getDurableItemDecisionBlock({
        ...input,
        item: { ...pending, kind: "authorization", evidence: [] },
      }),
    ).toBeUndefined();
  });
});
