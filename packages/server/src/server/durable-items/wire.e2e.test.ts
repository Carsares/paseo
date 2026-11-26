import { execFileSync, fork } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { expect, test } from "vitest";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestAgentClient } from "../test-utils/fake-agent-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { FileBackedWorkspaceRegistry } from "../workspace-registry.js";
import { openDurableItemStore } from "./requests.js";

const workbenchFeatures = [
  "topicWorkbenchV1",
  "checkoutGitStagingV1",
  "checkoutGitGraphV1",
  "checkoutGitRebaseV1",
  "checkoutGitMultiRepoV1",
  "checkoutGitP2V1",
] as const;
const requestHumanDecision = "request_human_decision";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
  });
}

async function connectMcp(port: number, agentId: string, token: string) {
  const client = new Client({ name: "durable-item-test", version: "1" });
  const url = new URL(`http://127.0.0.1:${port}/mcp/agents`);
  url.searchParams.set("callerAgentId", agentId);
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  try {
    await client.connect(transport);
    return client;
  } catch (error) {
    await client.close();
    throw error;
  }
}

async function withCompatWorker(
  paseoHome: string,
  compat: boolean,
  run: (client: DaemonClient) => Promise<void>,
) {
  const worker = fork(fileURLToPath(new URL("../daemon-worker.ts", import.meta.url)), [], {
    execArgv: ["--conditions=source", "--import", "tsx"],
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: {
      PATH: process.env.PATH,
      PASEO_HOME: paseoHome,
      PASEO_LISTEN: "127.0.0.1:0",
      PASEO_RELAY_ENABLED: "0",
      PASEO_WEB_UI_ENABLED: "0",
      ...(compat && { PASEO_WORKBENCH_COMPAT: "1" }),
    },
  });
  let output = "";
  worker.stdout?.on("data", (data) => (output += String(data)));
  worker.stderr?.on("data", (data) => (output += String(data)));
  const deadline = AbortSignal.timeout(15_000);
  try {
    const ready = new Promise<string>((resolve) => {
      worker.on("message", (message) => {
        if (
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          message.type === "paseo:ready" &&
          "listen" in message &&
          typeof message.listen === "string"
        ) {
          resolve(message.listen);
        }
      });
    });
    const listen = await Promise.race([
      ready,
      once(worker, "exit", { signal: deadline }).then(([code]) => {
        throw new Error(`Daemon worker exited ${code} before becoming ready: ${output}`);
      }),
    ]);
    expect(listen).toMatch(/^127\.0\.0\.1:[1-9][0-9]*$/);
    const client = new DaemonClient({ url: `ws://${listen}/ws` });
    try {
      await client.connect();
      await run(client);
    } finally {
      await client.close();
    }
  } finally {
    if (worker.exitCode === null && worker.signalCode === null) {
      const exited = once(worker, "exit");
      worker.kill("SIGTERM");
      const forceExit = setTimeout(() => worker.kill("SIGKILL"), 6000);
      try {
        expect(await exited).toEqual([0, null]);
      } finally {
        clearTimeout(forceExit);
      }
    }
  }
}

test("an active topic Main Control requests acceptance over MCP and a worker in compatibility mode can decide it", async () => {
  const root = await mkdtemp(join(tmpdir(), "paseo-durable-agent-wire-"));
  const cwd = join(root, "project");
  const originalTrace = "Trace submitted for acceptance";
  const stagedTrace = "Staged trace revision";
  const trace = originalTrace + "\n";
  const input = {
    kind: "acceptance",
    title: "Accept the trace",
    evidence: [
      { type: "file", path: "trace.txt" },
      { type: "git", path: "trace.txt", repoRoot: "." },
    ],
  };
  const turnStarted = Promise.withResolvers<void>();
  const finishTurn = Promise.withResolvers<void>();
  try {
    await mkdir(cwd);
    const repoRoot = await realpath(cwd);
    const tracePath = join(cwd, "trace.txt");
    git(cwd, "init", "--initial-branch=main");
    await writeFile(tracePath, trace);
    git(cwd, "add", "--", "trace.txt");
    git(
      cwd,
      "-c",
      "user.name=Paseo Test",
      "-c",
      "user.email=paseo-test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "Record original trace",
    );
    const headSha = git(cwd, "rev-parse", "HEAD").trim();
    await writeFile(tracePath, stagedTrace + "\n");
    git(cwd, "add", "--", "trace.txt");
    // The working copy cancels the staged edit when compared directly with HEAD.
    await writeFile(tracePath, trace);
    expect(git(cwd, "diff", "HEAD", "--", "trace.txt")).toBe("");
    await writeFile(join(root, "outside.txt"), "Outside the workspace");
    const persisted = await (async () => {
      const host = await createTestPaseoDaemon({
        paseoHomeRoot: root,
        staticDir: cwd,
        cleanup: false,
        mcpEnabled: true,
        agentClients: {
          codex: createTestAgentClient("codex", {
            onStartTurn: () => turnStarted.resolve(),
            beforeTurnComplete: () => finishTurn.promise,
          }),
        },
      });
      const ws = new DaemonClient({ url: `ws://127.0.0.1:${host.port}/ws` });
      const mcpClients: Client[] = [];
      try {
        await ws.connect();
        const { workspace, mainAgent, error } = await ws.createWorkspace({
          source: { kind: "directory", path: cwd },
          title: "Review trace",
          topic: { hideFromModel: true },
          mainAgent: { config: { provider: "codex", cwd } },
        });
        expect(error).toBeNull();
        if (!workspace || !mainAgent) throw new Error("Expected a topic with a Main Control agent");
        const workspaceId = workspace.id;
        expect(workspace.topic?.mainAgentId).toBe(mainAgent.id);
        const manager = host.daemon.agentManager;
        const scopedToken = manager.getMcpAuthToken(mainAgent.id);
        const commonToken = manager.getMcpAuthToken();
        if (!scopedToken || !commonToken) throw new Error("Expected Agent MCP credentials");
        const scoped = await connectMcp(host.port, mainAgent.id, scopedToken);
        mcpClients.push(scoped);
        const unverified = await connectMcp(host.port, mainAgent.id, commonToken);
        mcpClients.push(unverified);
        const toolNames = async (client: Client) =>
          (await client.listTools()).tools.map(({ name }) => name);
        const call = (client: Client, args: Record<string, unknown>) =>
          client.callTool({ name: requestHumanDecision, arguments: args });
        expect(await toolNames(unverified)).not.toContain(requestHumanDecision);
        expect(await call(scoped, input)).toMatchObject({ isError: true });

        await ws.sendMessage(mainAgent.id, "Review the trace.");
        await turnStarted.promise;
        const mainTools = await toolNames(scoped);
        expect(mainTools).toContain(requestHumanDecision);
        expect(mainTools).not.toContain("send_terminal_keys");
        expect(mainTools).not.toContain("archive_workspace");
        const live = manager.getAgent(mainAgent.id);
        const sourceTurnId = live?.activeForegroundTurnId ?? live?.activeTurnId;
        expect(sourceTurnId).toEqual(expect.any(String));
        await expect(call(unverified, input)).rejects.toThrow(
          "Tool request_human_decision not found",
        );
        for (const forged of [
          { ...input, workspaceId, sourceAgentId: mainAgent.id, sourceTurnId },
          { ...input, evidence: [{ ...input.evidence[0], fingerprint: "forged" }] },
          { ...input, evidence: [] },
          { ...input, evidence: [{ type: "file", path: "../outside.txt" }] },
        ]) {
          expect(await call(scoped, forged)).toMatchObject({ isError: true });
        }
        const itemFile = join(host.paseoHome, "durable-items", "items.json");
        await expect(readFile(itemFile)).rejects.toMatchObject({ code: "ENOENT" });
        expect(await ws.listWorkspaceDurableItems({ workspaceId })).toMatchObject({
          error: null,
          items: [],
        });

        const created = await call(scoped, input);
        expect(created.isError).not.toBe(true);
        const { items, error: listError } = await ws.listWorkspaceDurableItems({ workspaceId });
        expect(listError).toBeNull();
        expect(items).toHaveLength(1);
        const pending = items[0]!;
        expect(created.structuredContent).toEqual({ item: pending });
        expect(pending).toMatchObject({
          status: "pending",
          revision: 0,
          sourceAgentId: mainAgent.id,
          sourceTurnId,
          workspaceId,
          kind: input.kind,
          title: input.title,
          evidence: [
            {
              type: "file",
              path: "trace.txt",
              fingerprint: createHash("sha256").update(trace).digest("hex"),
            },
            {
              type: "git",
              path: "trace.txt",
              repoRoot,
              headSha,
              blobOrIndexFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
            },
          ],
        });
        expect(JSON.parse(await readFile(itemFile, "utf8"))).toMatchObject({
          serverId: host.daemon.getServerId(),
          items: [{ item: pending }],
        });
        const decision = await call(scoped, {
          kind: "decision",
          title: "Choose the trace format",
          evidence: [],
        });
        expect(decision.isError).not.toBe(true);
        const decisionId = (await ws.listWorkspaceDurableItems({ workspaceId })).items.find(
          (item) => item.kind === "decision",
        )?.requestId;
        if (!decisionId) throw new Error("The Agent decision request was not stored");
        expect(
          await ws.decideWorkspaceDurableItem({
            workspaceId,
            durableItemRequestId: decisionId,
            decision: "approve",
            expectedRevision: 0,
          }),
        ).toMatchObject({ error: null, item: { status: "decided", revision: 1, evidence: [] } });
        finishTurn.resolve();
        await ws.waitForFinish(mainAgent.id, 5000);
        return { paseoHome: host.paseoHome, workspaceId, requestId: pending.requestId, pending };
      } finally {
        finishTurn.resolve();
        await Promise.allSettled([ws.close(), ...mcpClients.map((client) => client.close())]);
        await host.close();
      }
    })();
    const { paseoHome, workspaceId, requestId, pending } = persisted;

    await withCompatWorker(paseoHome, false, async (ws) => {
      const features = ws.getLastServerInfoMessage()?.features;
      for (const name of workbenchFeatures) expect(features?.[name]).toBe(true);
      expect(features?.workspaceDurableItemsV1).toBe(true);
      expect(
        await ws.listWorkspaceDurableItems({ workspaceId, statusFilter: "pending" }),
      ).toMatchObject({
        error: null,
        items: [pending],
      });
    });
    await withCompatWorker(paseoHome, true, async (ws) => {
      const features = ws.getLastServerInfoMessage()?.features;
      expect(features).toBeDefined();
      for (const name of workbenchFeatures) expect(features).not.toHaveProperty(name);
      expect(features?.workspaceDurableItemsV1).toBe(true);
      expect(features?.diffSubscription).toBe(true);
      await expect(ws.checkoutGitWorkingTreeGet({ cwd })).rejects.toThrow("Update the host");
      const staged = await ws.readDiff({
        cwd,
        base: { kind: "rev", rev: "HEAD" },
        head: { kind: "index" },
      });
      const unstaged = await ws.readDiff({
        cwd,
        base: { kind: "index" },
        head: { kind: "worktree" },
      });
      for (const [diff, before, after] of [
        [staged, originalTrace, stagedTrace],
        [unstaged, stagedTrace, originalTrace],
      ] as const) {
        expect(diff).toMatchObject({
          phase: "ready",
          files: [
            {
              path: "trace.txt",
              hunks: [
                {
                  lines: expect.arrayContaining([
                    expect.objectContaining({ type: "remove", content: before }),
                    expect.objectContaining({ type: "add", content: after }),
                  ]),
                },
              ],
            },
          ],
        });
      }
      expect(
        await ws.listWorkspaceDurableItems({ workspaceId, statusFilter: "pending" }),
      ).toMatchObject({
        error: null,
        items: [pending],
      });
      const result = await ws.decideWorkspaceDurableItem({
        workspaceId,
        durableItemRequestId: requestId,
        decision: "approve",
        expectedRevision: pending.revision,
      });
      expect(result).toMatchObject({
        error: null,
        item: { ...pending, status: "decided", revision: 1, decision: "approve" },
      });
      expect(await ws.listWorkspaceDurableItems({ workspaceId })).toMatchObject({
        error: null,
        items: expect.arrayContaining([result.item]),
      });
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("disabling topic workbench hides the request tool from verified Main Control", async () => {
  const host = await createTestPaseoDaemon({
    mcpEnabled: true,
    serverFeatureOverrides: { topicWorkbenchV1: false },
  });
  const ws = new DaemonClient({ url: `ws://127.0.0.1:${host.port}/ws` });
  let scoped: Client | undefined;
  try {
    await ws.connect();
    expect(ws.getLastServerInfoMessage()?.features?.workspaceDurableItemsV1).toBe(true);
    const { id: agentId } = await ws.createAgent({ cwd: host.staticDir, provider: "codex" });
    const manager = host.daemon.agentManager;
    await manager.setAgentMainControl(agentId, true);
    const token = manager.getMcpAuthToken(agentId);
    if (!token) throw new Error("Expected scoped Agent MCP credentials");
    scoped = await connectMcp(host.port, agentId, token);
    const names = (await scoped.listTools()).tools.map(({ name }) => name);
    expect(names).toContain("get_agent_status");
    expect(names).not.toContain(requestHumanDecision);
  } finally {
    await Promise.allSettled([ws.close(), scoped?.close()]);
    await host.close();
  }
});

test("two connected clients can decide a persisted item once without restoring its workspace", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "paseo-durable-wire-"));
  try {
    const daemon = await createTestPaseoDaemon({ mcpEnabled: false });
    try {
      const url = `ws://127.0.0.1:${daemon.port}/ws`;
      const first = new DaemonClient({ url });
      const second = new DaemonClient({ url });
      try {
        await Promise.all([first.connect(), second.connect()]);
        expect(first.getLastServerInfoMessage()?.features?.workspaceDurableItemsV1).toBe(true);
        const { workspace, mainAgent, error } = await first.createWorkspace({
          source: { kind: "directory", path: cwd },
          title: "Review the trace",
          topic: { hideFromModel: true },
          mainAgent: { config: { provider: "codex", cwd } },
        });
        expect(error).toBeNull();
        if (!workspace || !mainAgent) throw new Error("Expected a topic with a silent main agent");

        const workspaceId = workspace.id;
        const serverId = daemon.daemon.getServerId();
        const openRegistry = () =>
          new FileBackedWorkspaceRegistry(
            join(daemon.paseoHome, "projects", "workspaces.json"),
            createTestLogger(),
          );
        const registry = openRegistry();
        const store = openDurableItemStore({
          paseoHome: daemon.paseoHome,
          serverId,
          workspaceRegistry: registry,
          agentStorage: daemon.daemon.agentStorage,
        });
        const tracePath = join(cwd, "trace.txt");
        await writeFile(tracePath, "Original trace\n");
        await store.create({
          serverId,
          workspaceId,
          requestId: "accept-trace",
          sourceAgentId: mainAgent.id,
          sourceTurnId: "trace-turn",
          kind: "acceptance",
          title: "Accept trace",
          evidence: [{ type: "file", path: "trace.txt" }],
        });
        await first.setWorkspaceDeferral({ workspaceId, action: "park" });

        const list = await second.listWorkspaceDurableItems({
          workspaceId,
          statusFilter: "pending",
        });
        expect(list).toMatchObject({
          error: null,
          items: [{ requestId: "accept-trace", status: "pending", revision: 0 }],
          nextCursor: null,
        });

        const input = { workspaceId, durableItemRequestId: "accept-trace", expectedRevision: 0 };
        await writeFile(tracePath, "Replaced trace\n");
        const stale = await first.decideWorkspaceDurableItem({ ...input, decision: "approve" });
        expect(stale.errorCode).toBe("DURABLE_ITEM_STALE_EVIDENCE");
        await writeFile(tracePath, "Original trace\n");

        const outcomes = await Promise.all([
          first.decideWorkspaceDurableItem({ ...input, decision: "approve" }),
          second.decideWorkspaceDurableItem({ ...input, decision: "request_changes" }),
        ]);
        const successes = outcomes.filter(({ error: responseError }) => responseError === null);
        expect(successes).toHaveLength(1);
        expect(successes[0]?.item).toMatchObject({ status: "decided", revision: 1 });
        expect(await first.listWorkspaceDurableItems({ workspaceId })).toMatchObject({
          error: null,
          items: [successes[0]?.item],
        });
        expect((await openRegistry().get(workspaceId))?.parkedAt).toEqual(expect.any(String));
        expect((await daemon.daemon.agentStorage.get(mainAgent.id))?.lastStatus).toBe("closed");
      } finally {
        await Promise.allSettled([first.close(), second.close()]);
      }
    } finally {
      await daemon.close();
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}, 30_000);
