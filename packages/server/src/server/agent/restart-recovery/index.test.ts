import { expect, test } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readdir, symlink, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { AgentStorage, parseStoredAgentRecord } from "../agent-storage.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import { readPersistedConfig } from "../../persisted-config.js";
import { createRestartRecovery } from "./index.js";

test("recovery saves intent before normalization, clears before dispatch, and resumes each agent independently", async () => {
  const root = await mkdtemp(join(tmpdir(), "restart-recovery-"));
  try {
    const storage = new AgentStorage(root, createTestLogger());
    for (const [id, lastStatus] of [
      ["broken", "running"],
      ["stuck", "running"],
      ["working", "running"],
      ["idle", "idle"],
      ["initializing", "initializing"],
    ] as const) {
      await storage.upsert(
        parseStoredAgentRecord({
          id,
          lastStatus,
          provider: "codex",
          cwd: root,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
      );
    }
    const dispatched: string[] = [];
    const recovery = createRestartRecovery({
      storage,
      settings: () => ({ enabled: true, prompt: "Continue verbatim.\n" }),
      eligible: async () => true,
      dispatch: async (id, prompt) => {
        expect((await storage.get(id))?.resumeOnStartup).toBe(false);
        if (id === "broken") throw new Error("unavailable");
        if (id === "stuck") return new Promise(() => {});
        dispatched.push(id + prompt);
      },
      report: () => {},
    });
    await recovery.prepareStartup();
    expect((await storage.get("working"))?.resumeOnStartup).toBe(true);
    expect((await storage.get("working"))?.lastStatus).toBe("closed");
    recovery.resumePending();
    const running = new AbortController().signal;
    await recovery.waitForResume("broken", running);
    await recovery.waitForResume("working", running);
    await recovery.waitForResume("idle", running);
    expect(dispatched).toEqual(["workingContinue verbatim.\n"]);
    const stopped = new AbortController();
    stopped.abort();
    await expect(recovery.waitForResume("stuck", stopped.signal)).rejects.toBeDefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("opt-out consumes pending recovery and excludes archived, private, owned and archived-workspace agents", async () => {
  const root = await mkdtemp(join(tmpdir(), "restart-recovery-"));
  try {
    const storage = new AgentStorage(root, createTestLogger());
    for (const extra of [
      { id: "running" },
      { id: "archived", archivedAt: "today" },
      { id: "private", internal: true },
      { id: "owned", owner: { kind: "daemon", daemonId: "hub", executionId: "run" } },
      { id: "workspace", workspaceId: "archived" },
    ]) {
      await storage.upsert(
        parseStoredAgentRecord({
          lastStatus: "running",
          provider: "codex",
          cwd: root,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          ...extra,
        }),
      );
    }
    let enabled = true;
    const dispatched: string[] = [];
    const recovery = createRestartRecovery({
      storage,
      settings: () => ({ enabled, prompt: "Resume working." }),
      eligible: async (record) => record.workspaceId !== "archived",
      dispatch: async (id) => {
        dispatched.push(id);
      },
      report: () => {},
    });
    await recovery.captureRunningAgents();
    expect((await storage.get("running"))?.resumeOnStartup).toBe(true);
    enabled = false;
    await recovery.prepareStartup();
    enabled = true;
    recovery.resumePending();
    expect(dispatched).toEqual([]);
    expect((await storage.listAll()).every((record) => !record.resumeOnStartup)).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("forced capture resumes eligible running agents on only the next startup with recovery disabled", async () => {
  const root = await mkdtemp(join(tmpdir(), "restart-recovery-once-"));
  try {
    const agentsPath = join(root, "agents");
    const oneShotMarkerPath = join(root, "paseo-home", "restart-recovery-once.json");
    const dispatched: { id: string; prompt: string }[] = [];
    const start = (failCapture = false) => {
      const storage = new AgentStorage(agentsPath, createTestLogger());
      const recovery = createRestartRecovery({
        storage,
        oneShotMarkerPath,
        settings: () => ({ enabled: false, prompt: "Continue once.\n" }),
        eligible: async (record) => {
          if (failCapture) throw new Error("Failed to check eligibility");
          return record.id !== "ineligible";
        },
        dispatch: async (id, prompt) => {
          expect((await storage.get(id))?.resumeOnStartup).toBe(false);
          dispatched.push({ id, prompt });
        },
        report: () => {},
      });
      return { storage, recovery };
    };
    const shutdown = start();
    for (const [id, lastStatus] of [
      ["working", "running"],
      ["ineligible", "running"],
      ["idle", "idle"],
    ] as const) {
      await shutdown.storage.upsert(
        parseStoredAgentRecord({
          id,
          lastStatus,
          resumeOnStartup: false,
          provider: "codex",
          cwd: root,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
      );
    }
    await expect(start(true).recovery.captureRunningAgents({ force: true })).rejects.toThrow(
      "Failed to check eligibility",
    );
    await expect(readFile(oneShotMarkerPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await shutdown.recovery.captureRunningAgents({ force: true });
    await expect(readFile(oneShotMarkerPath, "utf8")).resolves.toBe(JSON.stringify({ version: 1 }));
    const interruptedStartup = start();
    expect((await interruptedStartup.storage.get("working"))?.resumeOnStartup).toBe(true);
    expect((await shutdown.storage.get("ineligible"))?.resumeOnStartup).toBe(false);
    expect((await shutdown.storage.get("idle"))?.resumeOnStartup).toBe(false);

    const signal = new AbortController().signal;
    await interruptedStartup.recovery.prepareStartup();
    await expect(readFile(oneShotMarkerPath, "utf8")).resolves.toBe(JSON.stringify({ version: 1 }));
    const first = start();
    await first.recovery.prepareStartup();
    first.recovery.resumePending();
    await expect(readFile(oneShotMarkerPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await first.recovery.waitForResume("working", signal);
    expect(dispatched).toEqual([{ id: "working", prompt: "Continue once.\n" }]);
    expect((await first.storage.get("working"))?.resumeOnStartup).toBe(false);

    const second = start();
    await second.recovery.prepareStartup();
    second.recovery.resumePending();
    await second.recovery.waitForResume("working", signal);
    expect(dispatched).toEqual([{ id: "working", prompt: "Continue once.\n" }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("disabled recovery clears a persisted resume flag when the one-shot marker is absent", async () => {
  const root = await mkdtemp(join(tmpdir(), "restart-recovery-no-marker-"));
  try {
    const agentsPath = join(root, "agents");
    const storage = new AgentStorage(agentsPath, createTestLogger());
    await storage.upsert(
      parseStoredAgentRecord({
        id: "pending",
        lastStatus: "closed",
        resumeOnStartup: true,
        provider: "codex",
        cwd: root,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );
    const startupStorage = new AgentStorage(agentsPath, createTestLogger());
    const dispatched: string[] = [];
    const recovery = createRestartRecovery({
      storage: startupStorage,
      oneShotMarkerPath: join(root, "restart-recovery-once.json"),
      settings: () => ({ enabled: false, prompt: "Continue." }),
      eligible: async () => true,
      dispatch: async (id) => {
        dispatched.push(id);
      },
      report: () => {},
    });
    await recovery.prepareStartup();
    recovery.resumePending();
    await recovery.waitForResume("pending", new AbortController().signal);
    expect(dispatched).toEqual([]);
    expect((await startupStorage.get("pending"))?.resumeOnStartup).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const bashAvailable =
  process.platform !== "win32" &&
  spawnSync("bash", ["-c", "true"], { stdio: "ignore" }).status === 0;
for (const seeder of ["setup", "shell", "setup-bom"] as const) {
  test.skipIf(seeder === "shell" && !bashAvailable)(
    `${seeder} seed never dispatches copied running or pending agents and excludes automation`,
    async () => {
      const root = await mkdtemp(join(tmpdir(), "inert-seed-"));
      try {
        const source = join(root, "source");
        const targetRoot = join(root, "target");
        const target = join(targetRoot, ".dev/paseo-home");
        const storage = new AgentStorage(join(root, "source-records"), createTestLogger());
        for (const [id, lastStatus, resumeOnStartup] of [
          ["live", "running", false],
          ["crashed", "running", true],
          ["stopped", "closed", true],
        ] as const) {
          await storage.upsert(
            parseStoredAgentRecord({
              id,
              lastStatus,
              resumeOnStartup,
              provider: "codex",
              cwd: root,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            }),
          );
        }
        await storage.flush();
        await mkdir(source, { recursive: true });
        await writeFile(join(source, "restart-recovery-once.json"), JSON.stringify({ version: 1 }));
        await symlink(
          join(root, "source-records"),
          join(source, "agents"),
          process.platform === "win32" ? "junction" : "dir",
        );
        await mkdir(join(source, "schedules"), { recursive: true });
        await writeFile(join(source, "schedules", "schedule.json"), '{"kind":"scheduled"}');
        await writeFile(join(source, "schedules", "heartbeat.json"), '{"kind":"heartbeat"}');
        await writeFile(
          join(source, "config.json"),
          (seeder === "setup-bom" ? "\uFEFF" : "") +
            JSON.stringify({
              version: 1,
              agents: { resumeOnStartup: true, resumePrompt: "Continue" },
            }),
        );
        const repo = fileURLToPath(new URL("../../../../../../", import.meta.url));
        const env = {
          ...process.env,
          PASEO_SOURCE_CHECKOUT_PATH: join(root, "checkout"),
          PASEO_WORKTREE_PATH: targetRoot,
          PASEO_DEV_SEED_HOME: source,
          PASEO_HOME: target,
        };
        if (seeder !== "shell")
          execFileSync(process.execPath, [join(repo, "scripts/seed-worktree-dev-state.mjs")], {
            env,
          });
        else {
          const linkedRepo = join(root, "linked-checkout");
          await symlink(repo, linkedRepo, "dir");
          execFileSync("bash", [join(linkedRepo, "scripts/dev-home.sh")], { env });
        }
        expect((await readdir(target)).sort()).toEqual(["agents", "config.json"]);
        const config = readPersistedConfig(target);
        const copied = new AgentStorage(join(target, "agents"), createTestLogger());
        const dispatched: string[] = [];
        const recovery = createRestartRecovery({
          storage: copied,
          oneShotMarkerPath: join(target, "restart-recovery-once.json"),
          settings: () => ({
            enabled: config.agents?.resumeOnStartup === true,
            prompt: "Continue",
          }),
          eligible: async () => true,
          dispatch: async (id) => {
            dispatched.push(id);
          },
          report: () => {},
        });
        await recovery.prepareStartup();
        recovery.resumePending();
        for (const record of await copied.listAll())
          await recovery.waitForResume(record.id, new AbortController().signal);
        expect(dispatched).toEqual([]);
        expect((await copied.listAll()).map((r) => [r.lastStatus, r.resumeOnStartup])).toEqual([
          ["closed", false],
          ["closed", false],
          ["closed", false],
        ]);
        expect(readPersistedConfig(source).agents?.resumeOnStartup).toBe(true);
        const unchangedSource = new AgentStorage(join(root, "source-records"), createTestLogger());
        expect((await unchangedSource.get("live"))?.lastStatus).toBe("running");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
}

test("seeding skips an existing home without reading invalid source config", async () => {
  const root = await mkdtemp(join(tmpdir(), "seed-skip-"));
  try {
    const source = join(root, "source");
    const targetRoot = join(root, "target");
    const target = join(targetRoot, ".dev/paseo-home");
    await mkdir(source, { recursive: true });
    await mkdir(target, { recursive: true });
    await writeFile(join(source, "config.json"), "invalid JSON");
    await writeFile(join(target, "keep.json"), "{}");
    const repo = fileURLToPath(new URL("../../../../../../", import.meta.url));
    execFileSync(process.execPath, [join(repo, "scripts/seed-worktree-dev-state.mjs")], {
      env: {
        ...process.env,
        PASEO_SOURCE_CHECKOUT_PATH: join(root, "checkout"),
        PASEO_WORKTREE_PATH: targetRoot,
        PASEO_DEV_SEED_HOME: source,
        PASEO_DEV_RESET_HOME: "0",
      },
    });
    expect(await readdir(target)).toEqual(["keep.json"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
