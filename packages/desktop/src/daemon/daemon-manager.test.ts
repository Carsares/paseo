import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_DESKTOP_SETTINGS } from "../settings/desktop-settings";
import { ExternalCliCommandError } from "./cli/external";
import {
  createDaemonCommandHandlers,
  isDesktopManagedDaemonPresentSync,
  isDesktopManagedDaemonRunningSync,
  keepsTerminalsOnStop,
  resumesAgentsOnStop,
  stopCapturedDaemon,
  stopDesktopDaemon,
  type DesktopDaemonStopReason,
} from "./daemon-manager";

const mocks = vi.hoisted(() => ({
  paseoHome: "",
  settings: {
    releaseChannel: "stable",
    daemon: {
      manageBuiltInDaemon: true,
      keepRunningAfterQuit: true,
    },
  },
  runExternalCliJsonCommand: vi.fn(),
  runExternalCliTextCommand: vi.fn(),
  createNodeEntrypointInvocation: vi.fn(() => ({
    command: "node",
    args: [],
    env: {},
  })),
  spawnProcess: vi.fn(),
  startDaemonInstance: vi.fn(),
  stopDaemonInstance: vi.fn(),
  logInfo: vi.fn(),
  logError: vi.fn(),
  appLogPath: "",
  getElectronLogFile: vi.fn(),
}));

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn(() => mocks.paseoHome),
    getVersion: vi.fn(() => "1.2.3"),
    isPackaged: true,
  },
  ipcMain: { handle: vi.fn() },
  powerMonitor: { getSystemIdleTime: vi.fn(() => 0) },
}));

vi.mock("electron-log/main", () => ({
  default: {
    info: mocks.logInfo,
    error: mocks.logError,
    transports: {
      file: {
        getFile: mocks.getElectronLogFile,
      },
    },
  },
}));

vi.mock("@getpaseo/server/daemon-control", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolvePaseoHome: () => mocks.paseoHome,
  spawnProcess: mocks.spawnProcess,
  startDaemonInstance: mocks.startDaemonInstance,
  stopDaemonInstance: mocks.stopDaemonInstance,
}));

vi.mock("../settings/desktop-settings-electron.js", () => ({
  getDesktopSettingsStore: () => ({
    get: async () => mocks.settings,
    patch: vi.fn(),
    migrateLegacyRendererSettings: vi.fn(),
  }),
}));

vi.mock("./runtime-paths.js", () => ({
  createNodeEntrypointInvocation: mocks.createNodeEntrypointInvocation,
  resolveDaemonRunnerEntrypoint: vi.fn(() => ({
    entryPath: path.join(mocks.paseoHome, "daemon.js"),
    execArgv: [],
  })),
}));

vi.mock("./cli/external.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runExternalCliJsonCommand: mocks.runExternalCliJsonCommand,
  runExternalCliTextCommand: mocks.runExternalCliTextCommand,
}));

describe("daemon-manager commands", () => {
  let fixtureRoot: string;

  beforeEach(() => {
    fixtureRoot = mkdtempSync(path.join(tmpdir(), "paseo daemon manager "));
    mocks.paseoHome = path.join(fixtureRoot, "home");
    mocks.appLogPath = path.join(fixtureRoot, "main.log");
    mocks.settings = DEFAULT_DESKTOP_SETTINGS;
    mocks.runExternalCliJsonCommand.mockReset();
    mocks.runExternalCliTextCommand.mockReset();
    mocks.createNodeEntrypointInvocation.mockReset();
    mocks.createNodeEntrypointInvocation.mockReturnValue({ command: "node", args: [], env: {} });
    mocks.spawnProcess.mockReset();
    mocks.startDaemonInstance.mockReset();
    mocks.stopDaemonInstance.mockReset();
    mocks.logInfo.mockReset();
    mocks.logError.mockReset();
    mocks.getElectronLogFile.mockReset();
    mocks.getElectronLogFile.mockReturnValue({ path: mocks.appLogPath });
  });

  afterEach(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it("returns the Electron main-process log tail from electron-log", () => {
    writeFileSync(
      mocks.appLogPath,
      Array.from({ length: 105 }, (_value, index) => `main log line ${index + 1}`).join("\n"),
    );
    const handlers = createDaemonCommandHandlers();

    expect(handlers.desktop_app_logs()).toEqual({
      logPath: mocks.appLogPath,
      contents: Array.from({ length: 100 }, (_value, index) => `main log line ${index + 6}`).join(
        "\n",
      ),
    });
  });

  it("exposes updater diagnostics through the desktop command boundary", () => {
    const diagnostics = createDaemonCommandHandlers().desktop_update_diagnostics();

    expect(diagnostics).toMatchObject({
      platform: process.platform,
      currentVersion: "1.2.3",
    });
  });

  it("reports a stopped daemon without launching the CLI when no local daemon runs", async () => {
    mkdirSync(mocks.paseoHome);
    writeFileSync(path.join(mocks.paseoHome, "server-id"), "srv_existing\n");
    mocks.runExternalCliJsonCommand.mockResolvedValue({
      home: mocks.paseoHome,
      pid: null,
      startedAt: null,
      listen: null,
      hostname: null,
      localDaemon: "stopped",
      desktopManaged: false,
      connectedDaemon: "not_probed",
    });

    const status = await createDaemonCommandHandlers().desktop_daemon_status();

    expect(status).toMatchObject({ serverId: "", status: "stopped", pid: null });
    expect(mocks.runExternalCliJsonCommand).not.toHaveBeenCalled();
  });

  it("recognizes a desktop-managed daemon left running by a previous desktop launch", () => {
    expect(isDesktopManagedDaemonPresentSync()).toBe(false);

    mkdirSync(mocks.paseoHome);
    const lockPath = path.join(mocks.paseoHome, "paseo.pid");
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, desktopManaged: true }));
    expect(isDesktopManagedDaemonRunningSync()).toBe(false);
    expect(isDesktopManagedDaemonPresentSync()).toBe(true);

    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, desktopManaged: false }));
    expect(isDesktopManagedDaemonPresentSync()).toBe(false);

    writeFileSync(lockPath, "garbage");
    expect(isDesktopManagedDaemonPresentSync()).toBe(false);
  });

  it("reports an errored daemon when the local daemon state cannot be read", async () => {
    mkdirSync(mocks.paseoHome);
    writeFileSync(path.join(mocks.paseoHome, "paseo.pid"), "garbage");

    const status = await createDaemonCommandHandlers().desktop_daemon_status();

    expect(status).toMatchObject({ serverId: "", status: "errored", pid: null });
    expect(status.error).toBeTruthy();
  });

  it("returns a local credential only for its live managed daemon listen", async () => {
    mkdirSync(mocks.paseoHome);
    const token = "a".repeat(43);
    writeFileSync(path.join(mocks.paseoHome, "local-credential"), `${token}\n`, { mode: 0o600 });
    const lock = {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      hostname: hostname(),
      uid: process.getuid?.() ?? 0,
      listen: "127.0.0.1:6799",
      desktopManaged: true,
    };
    const lockPath = path.join(mocks.paseoHome, "paseo.pid");
    writeFileSync(lockPath, JSON.stringify(lock));
    const handler = createDaemonCommandHandlers().desktop_local_credential;
    expect(await handler({ listen: "localhost:6799" })).toBe(token);
    expect(await handler({ listen: "remote:6799" })).toBeNull();
    writeFileSync(lockPath, JSON.stringify({ ...lock, desktopManaged: false }));
    expect(await handler({ listen: "localhost:6799" })).toBeNull();
  });

  it("stops a desktop-managed daemon from a previous launch only for resume-agents reasons and never stops a manual CLI daemon", async () => {
    mkdirSync(mocks.paseoHome);
    const lock = {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      hostname: hostname(),
      uid: process.getuid?.() ?? 0,
      listen: "127.0.0.1:6799",
      desktopManaged: true,
    };
    const lockPath = path.join(mocks.paseoHome, "paseo.pid");
    writeFileSync(lockPath, JSON.stringify(lock));
    mocks.runExternalCliJsonCommand.mockResolvedValue({
      localDaemon: "running",
      pid: lock.pid,
      startedAt: lock.startedAt,
      listen: lock.listen,
      desktopManaged: true,
    });
    mocks.stopDaemonInstance.mockResolvedValue({
      action: "stopped",
      pid: lock.pid,
      forced: false,
      usedLifecycleRpc: true,
    });

    for (const reason of ["quit", "settings", "host_remove", "manual_ipc"] as const) {
      await stopDesktopDaemon(reason);
    }
    expect(mocks.stopDaemonInstance).not.toHaveBeenCalled();

    for (const reason of ["quit_preserve_work", "app_update", "version_mismatch"] as const) {
      await stopDesktopDaemon(reason);
    }
    expect(mocks.stopDaemonInstance).toHaveBeenCalledTimes(3);

    mocks.stopDaemonInstance.mockClear();
    writeFileSync(lockPath, JSON.stringify({ ...lock, desktopManaged: false }));
    for (const reason of [
      "quit",
      "quit_preserve_work",
      "app_update",
      "version_mismatch",
    ] as const) {
      await stopDesktopDaemon(reason);
    }
    expect(mocks.stopDaemonInstance).not.toHaveBeenCalled();
  });

  it("restarts a version-mismatched daemon from a previous desktop launch on start, but leaves a manual CLI daemon untouched", async () => {
    mkdirSync(mocks.paseoHome);
    const lock = {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      hostname: hostname(),
      uid: process.getuid?.() ?? 0,
      listen: "127.0.0.1:6799",
      desktopManaged: false,
    };
    const lockPath = path.join(mocks.paseoHome, "paseo.pid");
    writeFileSync(lockPath, JSON.stringify(lock));
    mocks.runExternalCliJsonCommand.mockResolvedValue({
      localDaemon: "running",
      pid: lock.pid,
      startedAt: lock.startedAt,
      listen: lock.listen,
      daemonVersion: "0.15.0",
      desktopManaged: false,
    });

    const handlers = createDaemonCommandHandlers();
    await handlers.start_desktop_daemon();
    expect(mocks.stopDaemonInstance).not.toHaveBeenCalled();
    expect(mocks.startDaemonInstance).not.toHaveBeenCalled();

    writeFileSync(lockPath, JSON.stringify({ ...lock, desktopManaged: true }));
    mocks.runExternalCliJsonCommand.mockResolvedValue({
      localDaemon: "running",
      pid: lock.pid,
      startedAt: lock.startedAt,
      listen: lock.listen,
      daemonVersion: "0.15.0",
      desktopManaged: true,
    });
    mocks.stopDaemonInstance.mockResolvedValue({
      action: "stopped",
      pid: lock.pid,
      forced: false,
      usedLifecycleRpc: true,
    });
    mocks.startDaemonInstance.mockResolvedValue({ instance: lock });

    await handlers.start_desktop_daemon();
    expect(mocks.stopDaemonInstance).toHaveBeenCalledExactlyOnceWith(
      mocks.paseoHome,
      expect.objectContaining({
        keepTerminals: process.platform !== "win32",
        resumeAgents: true,
      }),
    );
    expect(mocks.startDaemonInstance).toHaveBeenCalledOnce();
  });
});

describe("desktop stops and terminals", () => {
  const reasons: DesktopDaemonStopReason[] = [
    "manual_ipc",
    "settings",
    "host_remove",
    "quit",
    "quit_preserve_work",
    "app_update",
    "version_mismatch",
    "restart",
  ];

  it("keeps terminals only for an app update or version-mismatch restart, never on Windows", () => {
    for (const platform of ["darwin", "linux"] as const) {
      expect(reasons.filter((reason) => keepsTerminalsOnStop(reason, platform))).toEqual([
        "app_update",
        "version_mismatch",
      ]);
    }
    expect(reasons.filter((reason) => keepsTerminalsOnStop(reason, "win32"))).toEqual([]);
  });

  it("resumes agents only after a preserve-work quit, app update, or version-mismatch restart", () => {
    expect(reasons.filter(resumesAgentsOnStop)).toEqual([
      "quit_preserve_work",
      "app_update",
      "version_mismatch",
    ]);
  });

  function stopHarness(runCliJson: (args: string[]) => Promise<unknown>) {
    const stops: Array<{ keepTerminals?: boolean; resumeAgents?: boolean }> = [];
    const logged: string[] = [];
    const instance = {
      pid: 4242,
      startedAt: "2026-10-21T00:00:00.000Z",
      hostname: "host",
      uid: 501,
      listen: "127.0.0.1:6799",
    };
    const stopInstance: NonNullable<
      Parameters<typeof stopCapturedDaemon>[0]["stopInstance"]
    > = async (_home, { requestShutdown, ...options } = {}) => {
      stops.push({
        keepTerminals: options.keepTerminals,
        ...("resumeAgents" in options ? { resumeAgents: options.resumeAgents } : {}),
      });
      await requestShutdown?.(instance);
      return { action: "stopped", pid: instance.pid, forced: false, usedLifecycleRpc: true };
    };
    return {
      stops,
      logged,
      input: {
        home: "/tmp/paseo-home",
        instance,
        stopInstance,
        runCliJson,
        log: (message: string) => logged.push(message),
      } as Omit<Parameters<typeof stopCapturedDaemon>[0], "reason" | "keepTerminals">,
    };
  }

  it("asks the daemon to keep its terminals and resume agents on an app update", async () => {
    const runCliJson = vi.fn().mockResolvedValue({ action: "shutdown_requested" });
    const harness = stopHarness(runCliJson);

    await stopCapturedDaemon({
      ...harness.input,
      reason: "app_update",
      keepTerminals: true,
      resumeAgents: true,
    });

    expect(harness.stops).toEqual([{ keepTerminals: true, resumeAgents: true }]);
    expect(runCliJson).toHaveBeenCalledExactlyOnceWith([
      "daemon",
      "stop",
      "--host",
      "127.0.0.1:6799",
      "--keep-terminals",
      "--resume-agents",
      "--json",
    ]);
  });

  it("asks the daemon to resume agents and close its terminals on a preserve-work quit", async () => {
    const runCliJson = vi.fn().mockResolvedValue({ action: "shutdown_requested" });
    const harness = stopHarness(runCliJson);

    await stopCapturedDaemon({
      ...harness.input,
      reason: "quit_preserve_work",
      keepTerminals: false,
      resumeAgents: true,
    });

    expect(harness.stops).toEqual([{ keepTerminals: false, resumeAgents: true }]);
    expect(runCliJson).toHaveBeenCalledExactlyOnceWith([
      "daemon",
      "stop",
      "--host",
      "127.0.0.1:6799",
      "--resume-agents",
      "--json",
    ]);
  });

  it("rejects a preserve-work quit without retrying when the daemon cannot resume agents", async () => {
    const error = new ExternalCliCommandError("refused", {
      code: "AGENT_RESUME_ON_STOP_UNSUPPORTED",
    });
    const runCliJson = vi.fn().mockRejectedValue(error);
    const harness = stopHarness(runCliJson);

    await expect(
      stopCapturedDaemon({
        ...harness.input,
        reason: "quit_preserve_work",
        keepTerminals: false,
        resumeAgents: true,
      }),
    ).rejects.toBe(error);
    expect(harness.stops).toEqual([{ keepTerminals: false, resumeAgents: true }]);
  });

  it.each(["app_update", "version_mismatch"] as const)(
    "keeps terminals on %s when the daemon cannot resume agents",
    async (reason) => {
      const runCliJson = vi
        .fn()
        .mockRejectedValueOnce(
          new ExternalCliCommandError("refused", {
            code: "AGENT_RESUME_ON_STOP_UNSUPPORTED",
            version: "0.16.0",
          }),
        )
        .mockResolvedValueOnce({ action: "shutdown_requested" });
      const harness = stopHarness(runCliJson);

      await stopCapturedDaemon({
        ...harness.input,
        reason,
        keepTerminals: true,
        resumeAgents: true,
      });

      expect(harness.stops).toEqual([
        { keepTerminals: true, resumeAgents: true },
        { keepTerminals: true },
      ]);
      expect(runCliJson).toHaveBeenCalledTimes(2);
      expect(runCliJson).toHaveBeenLastCalledWith([
        "daemon",
        "stop",
        "--host",
        "127.0.0.1:6799",
        "--keep-terminals",
        "--json",
      ]);
      expect(harness.logged).toEqual([
        "daemon v0.16.0 cannot resume agents on stop; stopping without agent resume",
      ]);
    },
  );

  it("drops unsupported terminal preservation before retrying agent resume", async () => {
    const runCliJson = vi
      .fn()
      .mockRejectedValueOnce(
        new ExternalCliCommandError("refused", { code: "TERMINALS_KEEP_UNSUPPORTED" }),
      )
      .mockRejectedValueOnce(
        new ExternalCliCommandError("refused", { code: "AGENT_RESUME_ON_STOP_UNSUPPORTED" }),
      )
      .mockResolvedValueOnce({ action: "shutdown_requested" });
    const harness = stopHarness(runCliJson);

    await stopCapturedDaemon({
      ...harness.input,
      reason: "app_update",
      keepTerminals: true,
      resumeAgents: true,
    });

    expect(harness.stops).toEqual([
      { keepTerminals: true, resumeAgents: true },
      { keepTerminals: false, resumeAgents: true },
      { keepTerminals: false },
    ]);
    expect(runCliJson).toHaveBeenNthCalledWith(2, [
      "daemon",
      "stop",
      "--host",
      "127.0.0.1:6799",
      "--resume-agents",
      "--json",
    ]);
    expect(runCliJson).toHaveBeenLastCalledWith([
      "daemon",
      "stop",
      "--host",
      "127.0.0.1:6799",
      "--json",
    ]);
  });

  it("stops a daemon without the capability with its terminals closed, and says so", async () => {
    const calls: string[][] = [];
    const harness = stopHarness(async (args) => {
      calls.push(args);
      if (args.includes("--keep-terminals")) {
        throw new ExternalCliCommandError("refused", {
          code: "TERMINALS_KEEP_UNSUPPORTED",
          version: "0.11.0",
        });
      }
      return { action: "shutdown_requested" };
    });

    await stopCapturedDaemon({ ...harness.input, reason: "app_update", keepTerminals: true });

    expect(harness.stops).toEqual([{ keepTerminals: true }, { keepTerminals: false }]);
    expect(calls[1]).toEqual(["daemon", "stop", "--host", "127.0.0.1:6799", "--json"]);
    expect(harness.logged).toContain(
      "daemon v0.11.0 cannot keep terminals; stopping it and closing them",
    );
  });

  it("does not retry a keep stop that failed for another reason", async () => {
    const harness = stopHarness(async () => {
      throw new ExternalCliCommandError("unreachable", { code: "DAEMON_UNREACHABLE" });
    });

    await expect(
      stopCapturedDaemon({ ...harness.input, reason: "app_update", keepTerminals: true }),
    ).rejects.toThrow("unreachable");
    expect(harness.stops).toEqual([{ keepTerminals: true }]);
  });
});
