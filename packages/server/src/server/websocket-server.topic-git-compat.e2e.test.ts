import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isMainControlAgentLabels } from "@getpaseo/protocol/agent-labels";
import { expect, test } from "vitest";
import { createTestLogger } from "../test-utils/test-logger.js";
import type { PaseoDaemon } from "./bootstrap.js";
import { openDurableItemStore } from "./durable-items/requests.js";
import { generateLocalPairingOffer } from "./pairing-offer.js";
import { DaemonClient } from "./test-utils/daemon-client.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "./test-utils/paseo-daemon.js";
import type { ServerFeatureOverrides } from "./websocket-server.js";
import { FileBackedWorkspaceRegistry } from "./workspace-registry.js";

const workbenchOff = {
  topicWorkbenchV1: false,
  checkoutGitStagingV1: false,
  checkoutGitGraphV1: false,
  checkoutGitRebaseV1: false,
  checkoutGitMultiRepoV1: false,
  checkoutGitP2V1: false,
} satisfies ServerFeatureOverrides;
const workbenchFeatures = Object.keys(workbenchOff) as (keyof typeof workbenchOff)[];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
  }).trim();
}

async function pairingIdentity(paseoHome: string): Promise<string> {
  const offer = await generateLocalPairingOffer({
    paseoHome,
    relayEnabled: true,
    includeQr: false,
  });
  if (!offer.url) throw new Error("Pairing identity was not available");
  return offer.url;
}

function durableItems(paseoHome: string, daemon: PaseoDaemon) {
  const workspaceRegistry = new FileBackedWorkspaceRegistry(
    join(paseoHome, "projects", "workspaces.json"),
    createTestLogger(),
  );
  return openDurableItemStore({
    paseoHome,
    serverId: daemon.getServerId(),
    workspaceRegistry,
    agentStorage: daemon.agentStorage,
  });
}

async function sessionHistory(client: DaemonClient, agentId: string) {
  const timeline = await client.fetchAgentTimeline(agentId, { direction: "tail" });
  expect(timeline.error).toBeNull();
  return timeline.entries
    .flatMap(({ item }) => (item.type === "assistant_message" ? [item.text] : []))
    .join("");
}

test("upgrades a legacy worktree in place and preserves data while the topic and Git workbenches are hidden", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "paseo-topic-git-compat-")));
  const repo = join(root, "project");
  const staticDir = join(root, "static");
  const phases = async <T>(
    options: Pick<
      NonNullable<Parameters<typeof createTestPaseoDaemon>[0]>,
      | "daemonVersion"
      | "serverFeatureOverrides"
      | "daemonStatusRpcCapability"
      | "relayConfigCapability"
    >,
    run: (host: TestPaseoDaemon, current: DaemonClient, legacy: DaemonClient) => Promise<T>,
  ): Promise<T> => {
    const host = await createTestPaseoDaemon({
      ...options,
      paseoHomeRoot: root,
      staticDir,
      mcpEnabled: false,
      cleanup: false,
      logger: createTestLogger(),
    });
    try {
      const url = `ws://127.0.0.1:${host.port}/ws`;
      const current = new DaemonClient({ url, appVersion: "0.18.0", clientType: "browser" });
      // Only legacy directory, history, Git and close requests are sent from this client.
      const legacy = new DaemonClient({ url, appVersion: "0.17.0", clientType: "browser" });
      try {
        await Promise.all([current.connect(), legacy.connect()]);
        return await run(host, current, legacy);
      } finally {
        await Promise.allSettled([current.close(), legacy.close()]);
      }
    } finally {
      await host.close();
    }
  };

  try {
    await Promise.all([mkdir(repo), mkdir(staticDir)]);
    git(repo, "init", "--initial-branch=main", "--quiet");
    git(repo, "config", "user.name", "Paseo Test");
    git(repo, "config", "user.email", "paseo-test@example.invalid");
    await writeFile(join(repo, "trace.txt"), "Initial trace\n");
    git(repo, "add", "trace.txt");
    git(repo, "commit", "-m", "Add startup trace");
    const originalHead = git(repo, "rev-parse", "HEAD");

    const original = await phases(
      {
        daemonVersion: "0.17.0",
        serverFeatureOverrides: workbenchOff,
        daemonStatusRpcCapability: false,
        relayConfigCapability: false,
      },
      async ({ daemon, paseoHome }, current, legacy) => {
        const features = current.getLastServerInfoMessage()?.features;
        expect(features).toBeDefined();
        for (const feature of workbenchFeatures) {
          expect(features).not.toHaveProperty(feature);
        }
        expect(features).not.toHaveProperty("daemonStatusRpc");
        expect(features).not.toHaveProperty("relayConfig");
        const { workspace, error } = await legacy.createWorkspace({
          source: { kind: "worktree", cwd: repo, action: "branch-off", branchName: "review/trace" },
        });
        expect(error).toBeNull();
        if (!workspace?.workspaceDirectory) throw new Error("Worktree was not created");
        const { id: workspaceId, workspaceDirectory: cwd } = workspace;
        async function rootAgent(title: string) {
          const agent = await legacy.createAgent({ workspaceId, cwd, provider: "codex", title });
          await legacy.sendMessage(agent.id, `Respond with exactly: ${title}`);
          await expect.poll(() => sessionHistory(current, agent.id)).toContain(title);
          return agent;
        }
        const first = await rootAgent("Inspect earlier traces");
        const selected = await rootAgent("Review startup trace");
        expect(await current.findWorkspace(workspaceId)).toMatchObject({
          id: workspaceId,
          workspaceDirectory: cwd,
          workspaceKind: "worktree",
        });
        expect(await sessionHistory(current, selected.id)).toContain("Review startup trace");
        await expect(
          current.updateWorkspaceTopic({ workspaceId, upgradeToTopic: true }),
        ).rejects.toThrow("Update the host");
        expect((await legacy.findWorkspace(workspaceId))?.topic).toBeUndefined();
        return {
          workspaceId,
          cwd,
          firstId: first.id,
          selectedId: selected.id,
          hostId: daemon.getServerId(),
          offer: await pairingIdentity(paseoHome),
        };
      },
    );
    const { workspaceId, cwd, firstId, selectedId, hostId, offer } = original;
    const target = { cwd, targetRepoRoot: cwd };

    const upgraded = await phases(
      { daemonVersion: "0.18.0" },
      async ({ daemon, paseoHome }, current, legacy) => {
        const features = current.getLastServerInfoMessage()?.features;
        for (const feature of workbenchFeatures) expect(features?.[feature]).toBe(true);
        expect(features?.daemonStatusRpc).toBe(true);
        expect(features?.relayConfig).toBe(true);
        expect(current.getLastServerInfoMessage()?.permissions).toContain("workspace.manage");
        expect(
          await current.updateWorkspaceTopic({ workspaceId, upgradeToTopic: true }),
        ).toMatchObject({
          workspaceId,
          topic: null,
          error: expect.stringContaining("Select a Main Control agent"),
        });
        const stillLegacy = await current.findWorkspace(workspaceId);
        expect(stillLegacy).toMatchObject({ id: workspaceId, workspaceDirectory: cwd });
        expect(stillLegacy?.topic).toBeUndefined();
        for (const agentId of [firstId, selectedId]) {
          const result = await current.fetchAgent(agentId);
          expect(result?.agent.workspaceId).toBe(workspaceId);
          expect(isMainControlAgentLabels(result?.agent.labels)).toBe(false);
        }
        const updated = await current.updateWorkspaceTopic({
          workspaceId,
          upgradeToTopic: true,
          mainAgentId: selectedId,
          summary: "Check the startup trace",
        });
        expect(updated).toMatchObject({
          error: null,
          workspaceId,
          topic: { mainAgentId: selectedId },
        });
        expect(await current.findWorkspace(workspaceId)).toMatchObject({
          id: workspaceId,
          workspaceDirectory: cwd,
          workspaceKind: "worktree",
          topic: updated.topic,
        });
        expect(await legacy.findWorkspace(workspaceId)).toMatchObject({
          id: workspaceId,
          workspaceDirectory: cwd,
          workspaceKind: "worktree",
        });
        for (const [agentId, isMain] of [
          [firstId, false],
          [selectedId, true],
        ] as const) {
          const result = await current.fetchAgent(agentId);
          expect(result?.agent.workspaceId).toBe(workspaceId);
          expect(isMainControlAgentLabels(result?.agent.labels)).toBe(isMain);
        }
        expect(await sessionHistory(legacy, firstId)).toContain("Inspect earlier traces");
        expect(await sessionHistory(legacy, selectedId)).toContain("Review startup trace");
        expect(git(cwd, "rev-parse", "HEAD")).toBe(originalHead);
        expect(await current.checkoutGitBlameGet({ ...target, path: "trace.txt" })).toMatchObject({
          error: null,
          lines: [{ lineNumber: 1, sha: originalHead }],
        });
        await writeFile(join(cwd, "trace.txt"), "Discarded trace draft\n");
        const discarded = await current.checkoutGitDiscardApply({
          ...target,
          scope: "paths",
          paths: ["trace.txt"],
          expectedHeadSha: originalHead,
        });
        expect(discarded).toMatchObject({ success: true, error: null });
        if (!discarded.backupRef)
          throw new Error("Discarding the draft did not create a backup ref");
        const backupSha = git(cwd, "rev-parse", "--verify", discarded.backupRef);
        expect(git(cwd, "show", `${discarded.backupRef}:trace.txt`)).toBe("Discarded trace draft");
        const pendingItem = await durableItems(paseoHome, daemon).create({
          serverId: hostId,
          workspaceId,
          requestId: "accept-startup-trace",
          sourceAgentId: selectedId,
          sourceTurnId: "startup-trace",
          kind: "acceptance",
          title: "Accept the startup trace",
          evidence: [{ type: "file", path: "trace.txt" }],
        });
        expect(pendingItem.status).toBe("pending");
        const pending = await current.listWorkspaceDurableItems({
          workspaceId,
          statusFilter: "pending",
        });
        expect(pending.error).toBeNull();
        expect(pending.items).toEqual([pendingItem]);
        return { backupRef: discarded.backupRef, backupSha, topic: updated.topic, pendingItem };
      },
    );

    const decidedItem = await phases(
      { daemonVersion: "0.18.0", serverFeatureOverrides: workbenchOff },
      async ({ paseoHome }, current, legacy) => {
        const info = current.getLastServerInfoMessage();
        expect(info?.serverId).toBe(hostId);
        for (const feature of workbenchFeatures) expect(info?.features).not.toHaveProperty(feature);
        expect(info?.features?.workspaceDurableItemsV1).toBe(true);
        expect(await pairingIdentity(paseoHome)).toBe(offer);
        expect(await legacy.findWorkspace(workspaceId)).toMatchObject({
          id: workspaceId,
          workspaceDirectory: cwd,
          topic: upgraded.topic,
        });
        const close = await legacy.closeItems({ agentIds: [selectedId] });
        expect(close.agents).toEqual([]);
        expect((await current.fetchAgent(selectedId))?.agent.archivedAt ?? null).toBeNull();
        expect(await sessionHistory(legacy, selectedId)).toContain("Review startup trace");
        await expect(
          current.updateWorkspaceTopic({ workspaceId, summary: "Must stay unchanged" }),
        ).rejects.toThrow("Update the host");
        await expect(current.checkoutGitWorkingTreeGet(target)).rejects.toThrow("Update the host");
        await expect(current.checkoutGitBlameGet({ ...target, path: "trace.txt" })).rejects.toThrow(
          "Update the host",
        );
        expect((await legacy.stashList(cwd)).error).toBeNull();
        expect(git(cwd, "rev-parse", "--verify", upgraded.backupRef)).toBe(upgraded.backupSha);
        expect(git(cwd, "show", `${upgraded.backupRef}:trace.txt`)).toBe("Discarded trace draft");
        expect(await readFile(join(cwd, "trace.txt"), "utf8")).toBe("Initial trace\n");
        const pending = await current.listWorkspaceDurableItems({
          workspaceId,
          statusFilter: "pending",
        });
        expect(pending.error).toBeNull();
        expect(pending.items).toEqual([upgraded.pendingItem]);
        const decision = await current.decideWorkspaceDurableItem({
          workspaceId,
          durableItemRequestId: upgraded.pendingItem.requestId,
          expectedRevision: upgraded.pendingItem.revision,
          decision: "approve",
        });
        expect(decision).toMatchObject({
          error: null,
          item: {
            ...upgraded.pendingItem,
            status: "decided",
            revision: upgraded.pendingItem.revision + 1,
            decision: "approve",
          },
        });
        return decision.item;
      },
    );

    await phases({ daemonVersion: "0.18.0" }, async ({ paseoHome }, current) => {
      const features = current.getLastServerInfoMessage()?.features;
      for (const feature of workbenchFeatures) expect(features?.[feature]).toBe(true);
      expect(await pairingIdentity(paseoHome)).toBe(offer);
      expect((await current.findWorkspace(workspaceId))?.topic).toEqual(upgraded.topic);
      expect(await sessionHistory(current, firstId)).toContain("Inspect earlier traces");
      const listed = await current.listWorkspaceDurableItems({ workspaceId });
      expect(listed.error).toBeNull();
      expect(listed.items).toEqual([decidedItem]);
      expect(await current.checkoutGitBlameGet({ ...target, path: "trace.txt" })).toMatchObject({
        error: null,
        lines: [{ lineNumber: 1, sha: originalHead }],
      });
      expect(git(cwd, "rev-parse", "--verify", upgraded.backupRef)).toBe(upgraded.backupSha);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 40_000);
