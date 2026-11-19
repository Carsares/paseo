import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createStopCommandRunner, type StopCommandDeps } from "./stop.js";

// A connection that advertises capabilities and records the shutdown options it receives.
function createFakeDaemon(
  features: { terminalsSurviveRestart?: boolean; resumeAgentsOnStop?: boolean } = {},
) {
  const shutdownRequests: Array<{ keepTerminals?: boolean; resumeAgents?: boolean }> = [];
  const connectToDaemon = vi.fn<StopCommandDeps["connectToDaemon"]>(async () => ({
    getLastServerInfoMessage: () => ({
      status: "server_info",
      serverId: "fake-daemon",
      version: "0.11.0",
      features,
    }),
    shutdownServer: async (options) => {
      shutdownRequests.push({
        keepTerminals: options?.keepTerminals,
        ...(options?.resumeAgents === true ? { resumeAgents: true } : {}),
      });
      return { status: "shutdown_requested", clientId: "fake-client", requestId: "fake-request" };
    },
    close: async () => undefined,
  }));
  return { deps: { connectToDaemon }, shutdownRequests };
}

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function stop(options: Record<string, unknown>, deps: StopCommandDeps) {
  return createStopCommandRunner(deps)(options as never, new Command("stop"));
}

// A home whose lock names a live stand-in supervisor, so the local stop path runs for real.
function homeWithRunningSupervisor(): { home: string; supervisor: ChildProcess } {
  const home = mkdtempSync(path.join(tmpdir(), "paseo-stop-keep-"));
  const supervisor = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e9)"], {
    stdio: "ignore",
  });
  writeFileSync(
    path.join(home, "paseo.pid"),
    JSON.stringify({
      pid: supervisor.pid,
      startedAt: new Date().toISOString(),
      hostname: hostname(),
      uid: process.getuid?.() ?? 0,
      listen: "127.0.0.1:1",
    }),
  );
  cleanups.push(() => {
    supervisor.kill("SIGKILL");
    rmSync(home, { recursive: true, force: true });
  });
  return { home, supervisor };
}

describe("daemon stop --keep-terminals", () => {
  test("refuses an endpoint daemon that does not advertise terminalsSurviveRestart", async () => {
    const daemon = createFakeDaemon();
    await expect(
      stop(
        { daemonTarget: { kind: "endpoint", host: "127.0.0.1:7777" }, keepTerminals: true },
        daemon.deps,
      ),
    ).rejects.toMatchObject({ code: "TERMINALS_KEEP_UNSUPPORTED" });
    expect(daemon.shutdownRequests).toEqual([]);
  });

  test.skipIf(process.platform === "win32")(
    "refuses a local daemon without the capability and never signals its supervisor",
    async () => {
      const daemon = createFakeDaemon();
      const { home, supervisor } = homeWithRunningSupervisor();
      await expect(
        stop({ daemonTarget: { kind: "instance", home }, keepTerminals: true }, daemon.deps),
      ).rejects.toMatchObject({ code: "TERMINALS_KEEP_UNSUPPORTED" });
      expect(daemon.shutdownRequests).toEqual([]);
      expect(supervisor.exitCode).toBeNull();
      expect(supervisor.signalCode).toBeNull();
    },
  );

  test("asks a capable daemon to keep its terminals", async () => {
    const daemon = createFakeDaemon({ terminalsSurviveRestart: true });
    await stop(
      { daemonTarget: { kind: "endpoint", host: "127.0.0.1:7777" }, keepTerminals: true },
      daemon.deps,
    );
    expect(daemon.shutdownRequests).toEqual([{ keepTerminals: true }]);
  });

  test("rejects --force with --keep-terminals before contacting the daemon", async () => {
    const daemon = createFakeDaemon({ terminalsSurviveRestart: true });
    const { home } = homeWithRunningSupervisor();
    await expect(
      stop(
        { daemonTarget: { kind: "instance", home }, keepTerminals: true, force: true },
        daemon.deps,
      ),
    ).rejects.toMatchObject({ code: "INVALID_OPTIONS" });
    expect(daemon.shutdownRequests).toEqual([]);
  });
});

describe("daemon stop --resume-agents", () => {
  test("refuses an endpoint daemon that does not advertise resumeAgentsOnStop", async () => {
    const daemon = createFakeDaemon();
    await expect(
      stop(
        { daemonTarget: { kind: "endpoint", host: "127.0.0.1:7777" }, resumeAgents: true },
        daemon.deps,
      ),
    ).rejects.toMatchObject({ code: "AGENT_RESUME_ON_STOP_UNSUPPORTED" });
    expect(daemon.shutdownRequests).toEqual([]);
  });

  test.skipIf(process.platform === "win32")(
    "refuses a local daemon without the capability and never signals its supervisor",
    async () => {
      const daemon = createFakeDaemon();
      const { home, supervisor } = homeWithRunningSupervisor();
      const kill = vi.spyOn(process, "kill");
      cleanups.push(() => kill.mockRestore());
      await expect(
        stop({ daemonTarget: { kind: "instance", home }, resumeAgents: true }, daemon.deps),
      ).rejects.toMatchObject({ code: "AGENT_RESUME_ON_STOP_UNSUPPORTED" });
      expect(daemon.shutdownRequests).toEqual([]);
      expect(
        kill.mock.calls.filter(([pid, signal]) => pid === supervisor.pid && signal !== 0),
      ).toEqual([]);
    },
  );

  test.each([false, true])("requests agent resume with keepTerminals=%s", async (keepTerminals) => {
    const daemon = createFakeDaemon({
      resumeAgentsOnStop: true,
      terminalsSurviveRestart: keepTerminals,
    });
    await stop(
      {
        daemonTarget: { kind: "endpoint", host: "127.0.0.1:7777" },
        resumeAgents: true,
        keepTerminals,
      },
      daemon.deps,
    );
    expect(daemon.shutdownRequests).toEqual([{ resumeAgents: true, keepTerminals }]);
  });

  test("rejects --force with --resume-agents before contacting the daemon", async () => {
    const daemon = createFakeDaemon({ resumeAgentsOnStop: true });
    const { home } = homeWithRunningSupervisor();
    await expect(
      stop(
        { daemonTarget: { kind: "instance", home }, resumeAgents: true, force: true },
        daemon.deps,
      ),
    ).rejects.toMatchObject({
      code: "INVALID_OPTIONS",
      message: "--force kills agents; it cannot be combined with --resume-agents.",
    });
    expect(daemon.deps.connectToDaemon).not.toHaveBeenCalled();
  });
});
