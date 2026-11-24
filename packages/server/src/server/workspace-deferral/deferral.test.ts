import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, onTestFinished, test } from "vitest";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { MessageReceipts } from "../message-receipts/index.js";
import {
  FileBackedWorkspaceRegistry,
  createPersistedWorkspaceRecord,
} from "../workspace-registry.js";
import { WorkspaceDeferral } from "./deferral.js";

test("workspace deferral keeps workspace identity, survives restart, and clears on archive", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-deferral-test-"));
  onTestFinished(() => rm(home, { recursive: true, force: true }));
  const logger = createTestLogger();
  const file = join(home, "workspaces.json");
  const receiptsPath = join(home, "receipts");
  let now = Date.parse("2026-11-24T12:00:00.000Z");
  const until = new Date(now + 60_000).toISOString();
  const workspace = new FileBackedWorkspaceRegistry(file, logger);
  const service = new WorkspaceDeferral(
    workspace,
    logger,
    () => now,
    new MessageReceipts(receiptsPath),
  );
  await service.start();
  onTestFinished(() => service.stop());
  for (const [workspaceId, background] of [
    ["left", false],
    ["right", false],
    ["background", true],
  ] as const) {
    await workspace.upsert(
      createPersistedWorkspaceRecord({
        workspaceId,
        projectId: "project",
        cwd: home,
        kind: "directory",
        displayName: workspaceId,
        createdAt: new Date(now).toISOString(),
        updatedAt: new Date(now).toISOString(),
        background,
      }),
    );
  }

  await expect(service.set({ workspaceId: "background", action: "park" })).rejects.toThrow(
    "unavailable",
  );
  await expect(
    service.set({
      workspaceId: "left",
      action: "snooze",
      snoozedUntil: new Date(now).toISOString(),
    }),
  ).rejects.toThrow("future");
  await expect(
    service.set({ workspaceId: "left", action: "park", snoozedUntil: until }),
  ).rejects.toThrow("time");

  await service.set({ workspaceId: "left", action: "park" });
  await service.set({ workspaceId: "right", action: "snooze", snoozedUntil: until });
  const firstReportAt = new Date(now + 1).toISOString();
  await service.wakeForBlockedReport("left", "confirmed-first-child-report", firstReportAt);
  expect((await workspace.get("left"))?.parkedAt).toBeUndefined();
  expect((await workspace.get("right"))?.snoozedUntil).toBe(until);
  await service.set({ workspaceId: "left", action: "park" });
  service.stop();

  const reopened = new FileBackedWorkspaceRegistry(file, logger);
  const restarted = new WorkspaceDeferral(
    reopened,
    logger,
    () => now,
    new MessageReceipts(receiptsPath),
  );
  onTestFinished(() => restarted.stop());
  now += 60_001;
  await restarted.start();
  expect((await reopened.get("right"))?.snoozedUntil).toBeUndefined();
  expect((await reopened.get("left"))?.parkedAt).toBeTruthy();

  await restarted.wakeForBlockedReport("left", "confirmed-first-child-report", firstReportAt);
  expect((await reopened.get("left"))?.parkedAt).toBeTruthy();
  await restarted.wakeForBlockedReport(
    "left",
    "confirmed-second-child-report",
    new Date(now).toISOString(),
  );
  expect((await reopened.get("left"))?.parkedAt).toBeUndefined();

  await restarted.set({ workspaceId: "left", action: "park" });
  await reopened.archive("left", new Date(now).toISOString(), {
    autoArchivedChangeRequestUrl: "https://git.example/1",
  });
  expect(await reopened.get("left")).toMatchObject({ archivedAt: new Date(now).toISOString() });
  expect((await reopened.get("left"))?.parkedAt).toBeUndefined();
  expect((await reopened.get("left"))?.snoozedUntil).toBeUndefined();
});

test("a blocked report first observed after a later deferral cannot restore it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-late-blocked-report-"));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const logger = createTestLogger();
  const now = Date.parse("2026-11-24T12:00:00.000Z");
  const workspaceId = "parent-workspace";
  const registry = new FileBackedWorkspaceRegistry(join(directory, "workspaces.json"), logger);
  const service = new WorkspaceDeferral(
    registry,
    logger,
    () => now,
    new MessageReceipts(join(directory, "receipts")),
  );
  await registry.upsert(
    createPersistedWorkspaceRecord({
      workspaceId,
      projectId: "project",
      cwd: directory,
      kind: "directory",
      displayName: workspaceId,
      createdAt: new Date(now - 60_000).toISOString(),
      updatedAt: new Date(now - 60_000).toISOString(),
    }),
  );
  const parked = await service.set({ workspaceId, action: "park" });
  await service.wakeForBlockedReport(
    workspaceId,
    "old-but-first-delivery",
    new Date(now - 1000).toISOString(),
  );
  expect((await registry.get(workspaceId))?.deferralRevision).toBe(parked.deferralRevision);
  expect((await registry.get(workspaceId))?.parkedAt).toBe(parked.parkedAt);
  await service.wakeForBlockedReport(workspaceId, "new-block", new Date(now + 1000).toISOString());
  expect((await registry.get(workspaceId))?.parkedAt).toBeUndefined();
});
