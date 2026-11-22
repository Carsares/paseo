import { expect, test, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readdir, symlink, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { AgentStorage, parseStoredAgentRecord } from "../agent-storage.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import { readPersistedConfig } from "../../persisted-config.js";
import { createRestartRecovery } from "./index.js";
import { createLifecyclePreparation } from "./lifecycle-preparation.js";

test("recovery preserves intent until dispatch settles and resumes each agent independently", async () => {
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
    const stuckDispatchStarted = Promise.withResolvers<void>();
    const releaseStuckDispatch = Promise.withResolvers<void>();
    const recovery = createRestartRecovery({
      storage,
      settings: () => ({ enabled: true, prompt: "Continue verbatim.\n" }),
      eligible: async () => true,
      dispatch: async (id, prompt) => {
        expect((await storage.get(id))?.resumeOnStartup).toBe(true);
        if (id === "broken") throw new Error("unavailable");
        if (id === "stuck") {
          stuckDispatchStarted.resolve();
          await releaseStuckDispatch.promise;
        }
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
    expect((await storage.get("working"))?.resumeOnStartup).toBe(false);
    expect((await storage.get("broken"))?.resumeOnStartup).toBe(true);
    const stopped = new AbortController();
    stopped.abort();
    await expect(recovery.waitForResume("stuck", stopped.signal)).rejects.toBeDefined();

    const pauseDelivery = vi.fn(() => undefined);
    const lifecycle = createLifecyclePreparation({
      assertStartupRecoverySettled: recovery.assertStartupRecoverySettled,
      pauseDelivery,
      pauseRunAdmission: () => () => {},
      waitForAdmittedRunsToStart: async () => {},
      capture: (force) => recovery.captureRunningAgents({ force }),
    });
    await stuckDispatchStarted.promise;
    expect((await storage.get("stuck"))?.resumeOnStartup).toBe(true);
    await expect(lifecycle.prepare(true)).rejects.toThrow("startup recovery is still in progress");
    expect(pauseDelivery).not.toHaveBeenCalled();
    releaseStuckDispatch.resolve();
    await recovery.waitForResume("stuck", running);
    await expect(lifecycle.prepare(true)).resolves.toBeUndefined();
    expect(pauseDelivery).toHaveBeenCalledTimes(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an ordinary stop leaves time for cleanup when the two admission waits overlap its deadline", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const releaseDelivery = vi.fn();
  const releaseRuns = vi.fn();
  const capture = vi.fn(async () => {});
  const report = vi.fn();
  const lifecycle = createLifecyclePreparation({
    pauseDelivery: () => ({
      drained: new Promise<void>((resolve) => setTimeout(resolve, 4_000)),
      release: releaseDelivery,
    }),
    pauseRunAdmission: () => releaseRuns,
    waitForAdmittedRunsToStart: () => new Promise<void>(() => {}),
    capture,
    report,
  });
  try {
    const stopped = lifecycle.beforeStop(false);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(capture).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(stopped).resolves.toEqual({ deliveryDrained: true });
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("settle agent run admissions") }),
    );
    expect(capture).toHaveBeenCalledExactlyOnceWith(false);
    expect(releaseDelivery).not.toHaveBeenCalled();
    expect(releaseRuns).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
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
          expect((await storage.get(id))?.resumeOnStartup).toBe(true);
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
    await expect(readFile(oneShotMarkerPath, "utf8")).resolves.toBe(
      JSON.stringify({ version: 2, agentIds: ["working"] }),
    );
    const interruptedStartup = start();
    expect((await interruptedStartup.storage.get("working"))?.resumeOnStartup).toBe(true);
    expect((await shutdown.storage.get("ineligible"))?.resumeOnStartup).toBe(false);
    expect((await shutdown.storage.get("idle"))?.resumeOnStartup).toBe(false);

    const signal = new AbortController().signal;
    await interruptedStartup.recovery.prepareStartup();
    await expect(readFile(oneShotMarkerPath, "utf8")).resolves.toBe(
      JSON.stringify({ version: 2, agentIds: ["working"] }),
    );
    const first = start();
    await first.recovery.prepareStartup();
    first.recovery.resumePending();
    await first.recovery.waitForResume("working", signal);
    await expect(readFile(oneShotMarkerPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
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

test.each([false, true])(
  "a second startup retains unfinished recovery (graceful stop: %s)",
  async (gracefulStop) => {
    const root = await mkdtemp(join(tmpdir(), "restart-recovery-interrupted-"));
    const releaseDispatch = Promise.withResolvers<void>();
    const interruptedLoad = Promise.withResolvers<void>();
    const queuedLoad = Promise.withResolvers<void>();
    const unfinished = ["interrupted", "queued"];
    const signal = new AbortController().signal;
    const start = (dispatch: (id: string) => Promise<void>) => {
      const storage = new AgentStorage(join(root, "agents"), createTestLogger());
      const recovery = createRestartRecovery({
        storage,
        oneShotMarkerPath: join(root, "restart-recovery-once.json"),
        settings: () => ({ enabled: false, prompt: "Continue." }),
        eligible: async ({ id }) => id !== "ineligible",
        dispatch,
        report: () => {},
      });
      return { storage, recovery };
    };
    const markerPath = join(root, "restart-recovery-once.json");
    const first = start(async (id) => {
      if (id === "interrupted") {
        const record = await first.storage.get(id);
        expect(record?.resumeOnStartup).toBe(true);
        // Session registration can persist an idle snapshot before sending the prompt.
        await first.storage.upsert({ ...record!, lastStatus: "idle", resumeOnStartup: false });
        interruptedLoad.resolve();
      } else if (id === "queued") {
        queuedLoad.resolve();
      }
      if (unfinished.includes(id)) {
        await releaseDispatch.promise;
        throw new Error("Interrupted");
      }
    });
    const waitForUnfinished = (recovery: ReturnType<typeof createRestartRecovery>) =>
      Promise.all(unfinished.map((id) => recovery.waitForResume(id, signal)));
    try {
      for (const id of ["finished", "also-finished", ...unfinished, "ineligible"]) {
        await first.storage.upsert(
          parseStoredAgentRecord({
            id,
            lastStatus: "closed",
            resumeOnStartup: true,
            provider: "codex",
            cwd: root,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }),
        );
      }
      await writeFile(markerPath, JSON.stringify({ version: 1 }));
      await first.recovery.prepareStartup();
      first.recovery.resumePending();
      await Promise.all([interruptedLoad.promise, queuedLoad.promise]);
      await first.recovery.waitForResume("finished", signal);
      await first.recovery.waitForResume("also-finished", signal);
      const marker = JSON.parse(await readFile(markerPath, "utf8"));
      expect(marker.version).toBe(2);
      expect(marker.agentIds.sort()).toEqual(unfinished);
      expect((await first.storage.get("interrupted"))?.resumeOnStartup).toBe(false);
      if (gracefulStop) {
        releaseDispatch.resolve();
        await waitForUnfinished(first.recovery);
        await first.recovery.captureRunningAgents({ force: true });
      }
      const dispatchAfterRestart = vi.fn(async (_id: string, _prompt: string) => {});
      const second = start(dispatchAfterRestart);
      await second.recovery.prepareStartup();
      second.recovery.resumePending();
      await waitForUnfinished(second.recovery);
      expect(dispatchAfterRestart.mock.calls.sort()).toEqual(
        unfinished.map((id) => [id, "Continue."]),
      );
      await expect(readFile(markerPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      releaseDispatch.resolve();
      await waitForUnfinished(first.recovery);
      await rm(root, { recursive: true, force: true });
    }
  },
);

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

test.each([true, false])(
  "retains failed automatic startup intent despite an error snapshot, without overriding opt-out (enabled: %s)",
  async (enabled) => {
    const root = await mkdtemp(join(tmpdir(), "restart-recovery-automatic-"));
    const automaticMarkerPath = join(root, "restart-recovery-pending.json");
    const initialStorage = new AgentStorage(root, createTestLogger());
    const startEntered = Promise.withResolvers<void>();
    const startOutcome = Promise.withResolvers<void>();
    const dispatch = vi.fn(async () => {
      // Provider load and failure can both reset the record's resume flag.
      const record = (await initialStorage.get("working"))!;
      await initialStorage.upsert({ ...record, resumeOnStartup: false, lastStatus: "error" });
      startEntered.resolve();
      await startOutcome.promise;
    });
    const retry = vi.fn(async () => {});
    const create = (storage: AgentStorage, recover: boolean, send: () => Promise<void>) =>
      createRestartRecovery({
        storage,
        automaticMarkerPath,
        settings: () => ({ enabled: recover, prompt: "Continue." }),
        eligible: async () => true,
        dispatch: send,
        report: () => {},
      });
    const initial = create(initialStorage, true, dispatch);
    const signal = new AbortController().signal;
    try {
      const timestamp = new Date().toISOString();
      await initialStorage.upsert(
        parseStoredAgentRecord({
          id: "working",
          provider: "codex",
          cwd: root,
          createdAt: timestamp,
          updatedAt: timestamp,
          lastStatus: "running",
        }),
      );
      await initial.prepareStartup();
      initial.resumePending();
      initial.resumePending();
      await startEntered.promise;
      expect(JSON.parse(await readFile(automaticMarkerPath, "utf8"))).toEqual({
        version: 2,
        agentIds: ["working"],
      });
      startOutcome.reject(new Error("Provider rejected start"));
      await initial.waitForResume("working", signal);
      expect(dispatch).toHaveBeenCalledOnce();

      const next = create(new AgentStorage(root, createTestLogger()), enabled, retry);
      await next.prepareStartup();
      next.resumePending();
      await next.waitForResume("working", signal);
      expect(retry).toHaveBeenCalledTimes(enabled ? 1 : 0);
      await expect(readFile(automaticMarkerPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      startOutcome.resolve();
      await initial.waitForResume("working", signal);
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("a manually accepted run consumes only its pending automatic recovery intent", async () => {
  const root = await mkdtemp(join(tmpdir(), "restart-recovery-manual-accept-"));
  try {
    const markerPath = join(root, "restart-recovery-pending.json");
    const storage = new AgentStorage(join(root, "agents"), createTestLogger());
    const timestamp = new Date().toISOString();
    await storage.upsert(
      parseStoredAgentRecord({
        id: "manual",
        provider: "codex",
        cwd: root,
        createdAt: timestamp,
        updatedAt: timestamp,
        lastStatus: "closed",
        resumeOnStartup: true,
      }),
    );
    await writeFile(markerPath, JSON.stringify({ version: 2, agentIds: ["manual"] }));
    const dispatch = vi.fn(async () => {});
    const recovery = createRestartRecovery({
      storage,
      automaticMarkerPath: markerPath,
      settings: () => ({ enabled: true, prompt: "Continue." }),
      eligible: async () => true,
      dispatch,
      report: () => {},
    });

    await recovery.prepareStartup();
    await recovery.consumeAutomaticRecovery("manual");
    recovery.resumePending();
    await recovery.waitForResume("manual", new AbortController().signal);

    expect(dispatch).not.toHaveBeenCalled();
    await expect(readFile(markerPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect((await storage.get("manual"))?.resumeOnStartup).toBe(false);

    // A later interruption creates fresh recovery work for the same agent.
    const record = (await storage.get("manual"))!;
    await storage.upsert({ ...record, lastStatus: "running" });
    await recovery.captureRunningAgents();
    const nextStartup = createRestartRecovery({
      storage,
      automaticMarkerPath: markerPath,
      settings: () => ({ enabled: true, prompt: "Continue." }),
      eligible: async () => true,
      dispatch,
      report: () => {},
    });
    await nextStartup.prepareStartup();
    nextStartup.resumePending();
    await nextStartup.waitForResume("manual", new AbortController().signal);
    expect(dispatch).toHaveBeenCalledExactlyOnceWith("manual", "Continue.", expect.any(Function));
    await expect(readFile(markerPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("does not dispatch a completed one-shot recovery again if clearing its agent flag fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "restart-recovery-flag-write-"));
  try {
    const markerPath = join(root, "restart-recovery-once.json");
    const storage = new AgentStorage(join(root, "agents"), createTestLogger());
    const dispatch = vi.fn(async () => {});
    const report = vi.fn();
    const start = (agentStorage: AgentStorage) =>
      createRestartRecovery({
        storage: agentStorage,
        oneShotMarkerPath: markerPath,
        settings: () => ({ enabled: false, prompt: "Continue." }),
        eligible: async () => true,
        dispatch,
        report,
      });
    await storage.upsert(
      parseStoredAgentRecord({
        id: "working",
        lastStatus: "closed",
        resumeOnStartup: true,
        provider: "codex",
        cwd: root,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );
    await writeFile(markerPath, JSON.stringify({ version: 2, agentIds: ["working"] }));
    const first = start(storage);
    await first.prepareStartup();
    const writeError = new Error("Agent record write failed");
    vi.spyOn(storage, "clearAgentRecovery").mockRejectedValueOnce(writeError);
    first.resumePending();
    const signal = new AbortController().signal;
    await first.waitForResume("working", signal);
    expect(report).toHaveBeenCalledExactlyOnceWith("working", writeError);
    await expect(readFile(markerPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    const second = start(new AgentStorage(join(root, "agents"), createTestLogger()));
    await second.prepareStartup();
    second.resumePending();
    await second.waitForResume("working", signal);
    expect(dispatch).toHaveBeenCalledExactlyOnceWith("working", "Continue.");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("capture fails without writing a one-shot marker when an agent record cannot be persisted", async () => {
  const root = await mkdtemp(join(tmpdir(), "restart-recovery-write-failure-"));
  try {
    const storage = new AgentStorage(join(root, "agents"), createTestLogger());
    await storage.upsert(
      parseStoredAgentRecord({
        id: "working",
        lastStatus: "running",
        provider: "codex",
        cwd: root,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );
    const markerPath = join(root, "restart-recovery-once.json");
    const recovery = createRestartRecovery({
      storage,
      oneShotMarkerPath: markerPath,
      settings: () => ({ enabled: false, prompt: "Continue." }),
      eligible: async () => true,
      dispatch: async () => {},
      report: () => {},
    });
    vi.spyOn(storage, "setRunningAgentRecovery").mockRejectedValueOnce(new Error("disk full"));

    await expect(recovery.captureRunningAgents({ force: true })).rejects.toThrow("disk full");
    await expect(readFile(markerPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("capture does not overwrite a turn that completed while eligibility was checked", async () => {
  const root = await mkdtemp(join(tmpdir(), "restart-recovery-completed-"));
  try {
    const storage = new AgentStorage(join(root, "agents"), createTestLogger());
    const record = parseStoredAgentRecord({
      id: "completed",
      lastStatus: "running",
      provider: "codex",
      cwd: root,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await storage.upsert(record);
    const markerPath = join(root, "restart-recovery-once.json");
    const recovery = createRestartRecovery({
      storage,
      oneShotMarkerPath: markerPath,
      settings: () => ({ enabled: false, prompt: "Continue." }),
      eligible: async () => {
        await storage.upsert({ ...record, lastStatus: "idle", title: "Latest title" });
        return true;
      },
      dispatch: async () => {},
      report: () => {},
    });
    await recovery.captureRunningAgents({ force: true });
    await expect(storage.get(record.id)).resolves.toMatchObject({
      lastStatus: "idle",
      title: "Latest title",
    });
    await expect(readFile(markerPath, "utf8")).resolves.toBe(
      JSON.stringify({ version: 2, agentIds: [] }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a still running agent without a durable running record prevents a preservation receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "restart-recovery-missing-snapshot-"));
  try {
    const storage = new AgentStorage(join(root, "agents"), createTestLogger());
    const markerPath = join(root, "restart-recovery-once.json");
    const recovery = createRestartRecovery({
      storage,
      oneShotMarkerPath: markerPath,
      settings: () => ({ enabled: false, prompt: "Continue." }),
      eligible: async () => true,
      dispatch: async () => {},
      report: () => {},
    });
    const listRunningAgents = () => [{ id: "live" }];
    await expect(recovery.captureRunningAgents({ force: true, listRunningAgents })).rejects.toThrow(
      "Could not persist running agent live for recovery",
    );
    await expect(readFile(markerPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(recovery.captureRunningAgents({ listRunningAgents })).resolves.toBeUndefined();
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
