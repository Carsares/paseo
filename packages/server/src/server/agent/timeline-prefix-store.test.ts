import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentStorage } from "./agent-storage.js";
import type { AgentTimelineRow } from "./agent-timeline-store-types.js";
import { sliceTimelineRowsAtBoundary, TimelinePrefixStore } from "./timeline-prefix-store.js";

const timestamp = new Date(0).toISOString();
const rows: AgentTimelineRow[] = [
  { seq: 1, timestamp, item: { type: "user_message", text: "First", clientMessageId: "u1" } },
  { seq: 2, timestamp, item: { type: "assistant_message", text: "Reply", messageId: "a1" } },
  { seq: 3, timestamp, item: { type: "compaction", status: "loading", trigger: "auto" } },
  { seq: 4, timestamp, item: { type: "compaction", status: "completed", trigger: "auto" } },
];

test("atomically replaces a sidecar and removes it with the agent record", async () => {
  const dir = await mkdtemp(join(tmpdir(), "paseo-prefix-"));
  try {
    const storage = new AgentStorage(dir, createTestLogger());
    await storage.timelinePrefixes.save("agent", { version: 1, rows, pendingContextHandoff: {} });
    await storage.timelinePrefixes.save("agent", {
      version: 1,
      rows,
      pendingContextHandoff: { olderSummary: "prior context" },
    });
    const restarted = new AgentStorage(dir, createTestLogger());
    expect(await restarted.timelinePrefixes.load("agent")).toEqual({
      version: 1,
      rows: [rows[0], rows[1], rows[3]],
      pendingContextHandoff: { olderSummary: "prior context" },
    });
    expect(await readdir(dir)).toEqual(["agent.timeline-prefix.json"]);
    expect(await restarted.listAll()).toEqual([]);
    await restarted.remove("agent");
    expect(await new TimelinePrefixStore(dir).load("agent")).toBeNull();
    expect(await readdir(dir)).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("slices inclusively by message ID or a cursor from the current epoch", () => {
  expect(sliceTimelineRowsAtBoundary(rows, { boundaryMessageId: "u1" })).toEqual(rows.slice(0, 1));
  expect(sliceTimelineRowsAtBoundary(rows, { boundaryMessageId: "a1" })).toEqual(rows.slice(0, 2));
  expect(
    sliceTimelineRowsAtBoundary(rows, {
      timelineEpoch: "current",
      boundaryCursor: { epoch: "current", seq: 2 },
    }),
  ).toEqual(rows.slice(0, 2));
  expect(() => sliceTimelineRowsAtBoundary(rows, { boundaryMessageId: "missing" })).toThrow(
    "Selected message",
  );
  expect(() =>
    sliceTimelineRowsAtBoundary(rows, {
      timelineEpoch: "current",
      boundaryCursor: { epoch: "stale", seq: 2 },
    }),
  ).toThrow("Selected timeline position");
});

test("an interrupted switch exposes only the prefix selected by the durable record", async () => {
  const dir = await mkdtemp(join(tmpdir(), "paseo-prefix-switch-"));
  const logger = createTestLogger();
  try {
    const storage = new AgentStorage(dir, logger);
    const record = {
      id: "agent",
      provider: "codex",
      cwd: dir,
      createdAt: timestamp,
      updatedAt: timestamp,
      lastStatus: "idle" as const,
      labels: {},
      metadata: {},
    };
    await storage.upsert(record);
    const previous = { version: 1 as const, rows: rows.slice(0, 1) };
    const next = { version: 1 as const, rows: rows.slice(0, 2) };
    await storage.timelinePrefixes.stageSwitch(record.id, "switch-1", previous, next);
    expect(await new AgentStorage(dir, logger).timelinePrefixes.load(record.id)).toEqual(previous);
    await storage.upsert({ ...record, provider: "claude", timelinePrefixSwitchId: "switch-1" });
    expect(await new AgentStorage(dir, logger).timelinePrefixes.load(record.id)).toEqual(next);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
