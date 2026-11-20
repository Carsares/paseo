import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";
import type { DaemonLifecycleIntent } from "./bootstrap.js";

const mocks = vi.hoisted(() => ({
  createDaemon:
    vi.fn<
      (config: { onLifecycleIntent: (intent: DaemonLifecycleIntent) => void }) => Promise<unknown>
    >(),
  getHome: vi.fn<() => string>(),
}));

vi.mock("./bootstrap.js", () => ({
  createPaseoDaemon: mocks.createDaemon,
  formatListenTarget: () => "test-listener",
}));
vi.mock("./network/index.js", () => ({ initializeEnvironmentProxy: () => [] }));
vi.mock("./config.js", () => ({ loadConfig: () => ({ configReload: {} }) }));
vi.mock("./paseo-home.js", () => ({ resolvePaseoHome: mocks.getHome }));
vi.mock("./logger.js", () => ({ createRootLogger: () => ({ info() {}, warn() {}, error() {} }) }));
vi.mock("./process-diagnostics.js", () => ({ getProcessDiagnostics: () => ({}) }));

test.each([
  { type: "restart", keep: true, reply: {}, failure: null, exitCode: 0 },
  { type: "restart", keep: false, reply: {}, failure: "save", exitCode: 1 },
  { type: "restart", keep: false, reply: {}, failure: "terminals", exitCode: 0 },
  {
    type: "restart",
    keep: false,
    reply: { resumeAgents: true },
    failure: "terminals",
    exitCode: 0,
  },
  {
    type: "restart",
    keep: false,
    reply: { resumeAgents: false },
    failure: "terminals",
    exitCode: 1,
  },
  { type: "shutdown", keep: false, reply: {}, failure: "terminals", exitCode: 1 },
] as const)(
  "$type with keepTerminals=$keep, supervisor flags $reply and failure $failure exits $exitCode",
  async ({ type, keep, reply, failure, exitCode }) => {
    const home = await mkdtemp(path.join(tmpdir(), "paseo-daemon-worker-"));
    const title = process.title;
    const ready = Promise.withResolvers<void>();
    const exited = Promise.withResolvers<number>();
    const stop = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const ipc: { receiveMessage?: (message: unknown) => void } = {};
    mocks.getHome.mockReturnValue(home);
    mocks.createDaemon.mockResolvedValue({
      start: async () => {},
      stop,
      getListenTarget: () => "test-listener",
      getServerId: () => "test-server",
    });
    const send = vi.fn((message: { type: string }) => {
      if (message.type === "paseo:ready") ready.resolve();
      return true;
    });
    const originalSend = Object.getOwnPropertyDescriptor(process, "send");
    Object.defineProperty(process, "send", { configurable: true, value: send });
    const on = vi.spyOn(process, "on").mockImplementation((event, listener) => {
      if (event === "message") ipc.receiveMessage = listener;
      return process;
    });
    const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
      exited.resolve(Number(code));
      return undefined as never;
    });
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });

    try {
      vi.resetModules();
      const { SavedRecoveryTerminalCleanupError } = await import("./daemon-shutdown-outcome.js");
      if (failure === "terminals") {
        stop.mockRejectedValue(new SavedRecoveryTerminalCleanupError(new Error("Reaper failed")));
      } else if (failure === "save") {
        stop.mockRejectedValue(new Error("Failed to save agent recovery"));
      }
      await import("./daemon-worker.js");
      await ready.promise;
      const config = mocks.createDaemon.mock.lastCall?.[0];
      if (!config || !ipc.receiveMessage)
        throw new Error("Worker did not register lifecycle handlers");
      const { onLifecycleIntent } = config;
      onLifecycleIntent({
        type,
        clientId: "test-client",
        requestId: "restart-request",
        reason: "test_restart",
        keepTerminals: keep,
        resumeAgents: true,
      });
      expect(send).toHaveBeenLastCalledWith({
        type: `paseo:${type}`,
        reason: "test_restart",
        keepTerminals: keep,
        resumeAgents: true,
      });
      ipc.receiveMessage({ type: "paseo:graceful-shutdown", ...reply });
      expect(stop).toHaveBeenCalledExactlyOnceWith({ keepTerminals: keep, resumeAgents: true });
      await expect(exited.promise).resolves.toBe(exitCode);
    } finally {
      vi.useRealTimers();
      exit.mockRestore();
      on.mockRestore();
      if (originalSend) Object.defineProperty(process, "send", originalSend);
      else Reflect.deleteProperty(process, "send");
      process.title = title;
      await rm(home, { recursive: true, force: true });
    }
  },
);
