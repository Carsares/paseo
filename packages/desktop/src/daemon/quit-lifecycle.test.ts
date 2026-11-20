import { describe, expect, it, vi } from "vitest";

import { DEFAULT_DESKTOP_SETTINGS } from "../settings/desktop-settings";
import {
  createQuitLifecycle,
  registerExternalQuitSignals,
  shouldStopDesktopManagedDaemonOnQuit,
  stopDesktopManagedDaemonOnQuitIfNeeded,
} from "./quit-lifecycle";

const SETTINGS_STOP_ON_QUIT = DEFAULT_DESKTOP_SETTINGS;
const SETTINGS_KEEP_RUNNING = {
  ...DEFAULT_DESKTOP_SETTINGS,
  daemon: {
    ...DEFAULT_DESKTOP_SETTINGS.daemon,
    keepRunningAfterQuit: true,
  },
};

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function waitForQuitLifecycle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("quit-lifecycle", () => {
  it("turns external termination signals into one Electron quit", () => {
    const listeners = new Map<NodeJS.Signals, () => void>();
    const quits: string[] = [];

    registerExternalQuitSignals({
      signals: {
        on: (signal, listener) => {
          listeners.set(signal, listener);
        },
      },
      quit: () => quits.push("quit"),
    });

    expect(Array.from(listeners.keys())).toEqual(["SIGHUP", "SIGINT", "SIGTERM"]);
    listeners.get("SIGTERM")?.();
    listeners.get("SIGHUP")?.();
    expect(quits).toEqual(["quit"]);
  });

  it("stops by default and only keeps running when keepRunningAfterQuit is enabled", () => {
    expect(shouldStopDesktopManagedDaemonOnQuit(SETTINGS_STOP_ON_QUIT)).toBe(true);
    expect(shouldStopDesktopManagedDaemonOnQuit(SETTINGS_KEEP_RUNNING)).toBe(false);
  });

  it("short-circuits without inspecting the daemon when keep-running is on", async () => {
    const events: string[] = [];

    const stopped = await stopDesktopManagedDaemonOnQuitIfNeeded({
      settingsStore: { get: async () => SETTINGS_KEEP_RUNNING },
      isDesktopManagedDaemonRunning: () => {
        events.push("inspect");
        return true;
      },
      stopDaemon: async () => {
        events.push("stop");
      },
      showShutdownFeedback: () => {
        events.push("feedback");
      },
    });

    expect(stopped).toBe(false);
    expect(events).toEqual([]);
  });

  it("does not stop a manually started daemon on quit", async () => {
    const events: string[] = [];

    const stopped = await stopDesktopManagedDaemonOnQuitIfNeeded({
      settingsStore: { get: async () => SETTINGS_STOP_ON_QUIT },
      isDesktopManagedDaemonRunning: () => false,
      stopDaemon: async () => {
        events.push("stop");
      },
      showShutdownFeedback: () => {
        events.push("feedback");
      },
    });

    expect(stopped).toBe(false);
    expect(events).toEqual([]);
  });

  it("shows feedback then stops a desktop-managed daemon", async () => {
    const events: string[] = [];

    const stopped = await stopDesktopManagedDaemonOnQuitIfNeeded({
      settingsStore: { get: async () => SETTINGS_STOP_ON_QUIT },
      isDesktopManagedDaemonRunning: () => true,
      stopDaemon: async (reason) => {
        events.push(`stop:${reason}`);
      },
      showShutdownFeedback: () => {
        events.push("feedback");
      },
    });

    expect(stopped).toBe(true);
    expect(events).toEqual(["feedback", "stop:quit"]);
  });

  it("treats a downloaded update as an ordinary quit when official updates are disabled", async () => {
    const events: string[] = [];
    const stopped = await stopDesktopManagedDaemonOnQuitIfNeeded({
      settingsStore: { get: async () => SETTINGS_STOP_ON_QUIT },
      isDesktopManagedDaemonRunning: () => true,
      stopDaemon: async (reason) => {
        events.push(`stop:${reason}`);
      },
      showShutdownFeedback: () => events.push("feedback"),
    });

    expect(stopped).toBe(true);
    expect(events).toEqual(["feedback", "stop:quit"]);
  });

  it("keeps the app and its connections open when preserving work fails", async () => {
    const events: string[] = [];
    const error = new Error("Cannot save agents for restart");
    const beforeQuit = { preventDefault: () => events.push("prevent-default") };
    const quitLifecycle = createQuitLifecycle({
      app: {
        quit: () => quitLifecycle.handleBeforeQuit(beforeQuit),
        exit: (code) => events.push(`exit:${code}`),
      },
      closeTransportSessions: () => events.push("close-transports"),
      stopDesktopManagedDaemonIfNeeded: async (options) => {
        events.push(`preserve:${options?.preserveWork}`);
        if (options?.preserveWork) throw error;
        return true;
      },
      installAppUpdateOnQuit: async () => {
        events.push("revalidate-update");
        return false;
      },
      createUpdateDeadlineSignal: () => new AbortController().signal,
      onStopError: (reported) => {
        expect(reported).toBe(error);
        events.push("stop-error");
      },
      onPreserveWorkStopFailed: (reported) => {
        expect(reported).toBe(error);
        events.push("alert");
      },
      onUpdateError: () => {},
    });

    quitLifecycle.requestPreserveWorkQuit();
    quitLifecycle.handleBeforeQuit(beforeQuit);
    await waitForQuitLifecycle();
    expect(events).toEqual([
      "prevent-default",
      "preserve:true",
      "prevent-default",
      "stop-error",
      "alert",
    ]);

    events.length = 0;
    quitLifecycle.handleBeforeQuit(beforeQuit);
    await waitForQuitLifecycle();
    expect(events).toEqual([
      "close-transports",
      "prevent-default",
      "revalidate-update",
      "preserve:undefined",
      "exit:0",
    ]);
  });

  it("honors a preserve-work quit for a daemon from a previous launch even with keep-running enabled", async () => {
    const events: string[] = [];
    const stopGate = deferred<void>();
    const quitLifecycle = createQuitLifecycle({
      app: {
        quit: () => {
          events.push("quit");
          quitLifecycle.handleBeforeQuit({ preventDefault: () => events.push("prevent-default") });
        },
        exit: (code) => events.push(`exit:${code}`),
      },
      closeTransportSessions: () => {},
      stopDesktopManagedDaemonIfNeeded: (options) =>
        stopDesktopManagedDaemonOnQuitIfNeeded({
          settingsStore: { get: async () => SETTINGS_KEEP_RUNNING },
          isDesktopManagedDaemonRunning: () => false,
          isDesktopManagedDaemonPresent: () => true,
          preserveWork: options?.preserveWork,
          stopDaemon: async (reason) => {
            events.push(`stop:${reason}`);
            await stopGate.promise;
          },
          showShutdownFeedback: () => events.push("feedback"),
        }),
      installAppUpdateOnQuit: async () => false,
      createUpdateDeadlineSignal: () => new AbortController().signal,
      onStopError: () => events.push("stop-error"),
      onUpdateError: () => events.push("update-error"),
    });

    quitLifecycle.requestPreserveWorkQuit();
    // Repeated invocations while quitting is already in progress must be idempotent no-ops.
    quitLifecycle.requestPreserveWorkQuit();
    stopGate.resolve();
    await waitForQuitLifecycle();

    expect(events).toEqual([
      "quit",
      "prevent-default",
      "feedback",
      "stop:quit_preserve_work",
      "exit:0",
    ]);
  });

  it("ignores preserve-work quit requests when an update quit is already in progress", () => {
    const events: string[] = [];
    const quitLifecycle = createQuitLifecycle({
      app: {
        quit: () => events.push("quit"),
        exit: (code) => events.push(`exit:${code}`),
      },
      closeTransportSessions: () => {},
      stopDesktopManagedDaemonIfNeeded: async () => false,
      installAppUpdateOnQuit: async () => false,
      createUpdateDeadlineSignal: () => new AbortController().signal,
      onStopError: () => {},
      onUpdateError: () => {},
    });

    quitLifecycle.handleBeforeQuitForUpdate();
    quitLifecycle.requestPreserveWorkQuit();

    expect(events).toEqual([]);
  });

  it("chooses the same update for shutdown and installation before stopping the daemon", async () => {
    const validated = deferred<{ version: string }>();
    const stopped = deferred<boolean>();
    const events: string[] = [];
    const deadline = new AbortController();
    const lifecycle = createQuitLifecycle({
      app: { exit: (code) => events.push(`exit:${code}`) },
      closeTransportSessions: () => {},
      stopDesktopManagedDaemonIfNeeded: async () => false,
      prepareDaemonForAppUpdate: async (target) => {
        events.push(`stop:${target.version}`);
        await stopped.promise;
      },
      installAppUpdateOnQuit: async (_signal, beforeQuit) => {
        const target = await validated.promise;
        if ((await beforeQuit(target)) === false) return false;
        events.push(`install:${target.version}`);
        return true;
      },
      createUpdateDeadlineSignal: () => deadline.signal,
      onStopError: () => events.push("stop-error"),
      onUpdateError: () => events.push("update-error"),
    });

    lifecycle.handleBeforeQuit({ preventDefault: () => {} });
    expect(events).toEqual([]);
    validated.resolve({ version: "1.2.5" });
    await waitForQuitLifecycle();
    expect(events).toEqual(["stop:1.2.5"]);

    stopped.resolve(true);
    lifecycle.handleBeforeQuitForUpdate();
    await waitForQuitLifecycle();
    expect(events).toEqual(["stop:1.2.5", "install:1.2.5"]);
  });

  it("lets the updater own process exit when a validated update is installing", async () => {
    const exits: number[] = [];
    const quitLifecycle = createQuitLifecycle({
      app: { exit: (code) => exits.push(code) },
      closeTransportSessions: () => {},
      stopDesktopManagedDaemonIfNeeded: async () => false,
      installAppUpdateOnQuit: async (_signal, beforeQuit) => {
        await beforeQuit({ version: "1.2.4" });
        return true;
      },
      createUpdateDeadlineSignal: () => new AbortController().signal,
      onStopError: () => {},
      onUpdateError: () => {},
    });

    quitLifecycle.handleBeforeQuit({ preventDefault: () => {} });
    await waitForQuitLifecycle();
    quitLifecycle.handleBeforeQuitForUpdate();
    await waitForQuitLifecycle();

    expect(exits).toEqual([]);
  });

  it("prevents repeated user quits while the selected installer is still pending", async () => {
    const exits: number[] = [];
    let preventedQuitCount = 0;
    const installation = deferred<boolean>();
    const quitLifecycle = createQuitLifecycle({
      app: { exit: (code) => exits.push(code) },
      closeTransportSessions: () => {},
      stopDesktopManagedDaemonIfNeeded: async () => false,
      installAppUpdateOnQuit: async (_signal, beforeQuit) => {
        await beforeQuit({ version: "1.2.4" });
        return installation.promise;
      },
      createUpdateDeadlineSignal: () => new AbortController().signal,
      onStopError: () => {},
      onUpdateError: () => {},
    });

    quitLifecycle.handleBeforeQuit({ preventDefault: () => preventedQuitCount++ });
    await waitForQuitLifecycle();
    quitLifecycle.handleBeforeQuit({ preventDefault: () => preventedQuitCount++ });
    await waitForQuitLifecycle();
    expect(preventedQuitCount).toBe(2);

    quitLifecycle.handleBeforeQuitForUpdate();
    quitLifecycle.handleBeforeQuit({ preventDefault: () => preventedQuitCount++ });
    installation.resolve(true);
    await waitForQuitLifecycle();

    expect(preventedQuitCount).toBe(2);
    expect(exits).toEqual([]);
  });

  it("quits normally if confirmation expires and cannot stop for a late approval", async () => {
    const deadline = new AbortController();
    const confirmation = deferred<boolean>();
    const events: string[] = [];
    const quitLifecycle = createQuitLifecycle({
      app: { exit: (code) => events.push(`exit:${code}`) },
      closeTransportSessions: () => {},
      prepareDaemonForAppUpdate: async () => {
        events.push("update-stop");
      },
      stopDesktopManagedDaemonIfNeeded: async () => {
        events.push("ordinary-stop");
        return true;
      },
      confirmAppUpdate: () => {
        events.push("confirm");
        return confirmation.promise;
      },
      installAppUpdateOnQuit: async (_signal, beforeQuit) => {
        if ((await beforeQuit({ version: "1.2.4" })) === false) return false;
        events.push("install");
        return true;
      },
      createUpdateDeadlineSignal: () => deadline.signal,
      onStopError: () => {},
      onUpdateError: () => {},
    });

    quitLifecycle.handleBeforeQuit({ preventDefault: () => {} });
    await waitForQuitLifecycle();
    expect(events).toEqual(["confirm"]);
    deadline.abort();
    await waitForQuitLifecycle();
    expect(events).toEqual(["confirm", "ordinary-stop", "exit:0"]);

    confirmation.resolve(true);
    await waitForQuitLifecycle();
    expect(events).toEqual(["confirm", "ordinary-stop", "exit:0"]);
  });

  it("does not intercept a quit started by a manual update", () => {
    const events: string[] = [];
    const quitLifecycle = createQuitLifecycle({
      app: { exit: (code) => events.push(`exit:${code}`) },
      closeTransportSessions: () => events.push("close-transports"),
      isManualUpdateHandoffInProgress: () => true,
      stopDesktopManagedDaemonIfNeeded: async () => {
        events.push("stop-daemon");
        return false;
      },
      installAppUpdateOnQuit: async () => {
        events.push("revalidate-update");
        return false;
      },
      createUpdateDeadlineSignal: () => new AbortController().signal,
      onStopError: () => events.push("stop-error"),
      onUpdateError: () => events.push("update-error"),
    });

    quitLifecycle.handleBeforeQuit({
      preventDefault: () => events.push("prevent-default"),
    });
    expect(events).toEqual(["prevent-default"]);

    quitLifecycle.handleBeforeQuitForUpdate();
    quitLifecycle.handleBeforeQuit({
      preventDefault: () => events.push("prevent-default"),
    });

    expect(events).toEqual(["prevent-default", "close-transports"]);
  });

  it("blocks a late updater quit without treating the next user quit as an update", async () => {
    const exit = vi.fn();
    const preventDefault = vi.fn();
    const lifecycle = createQuitLifecycle({
      app: { exit },
      closeTransportSessions: () => {},
      stopDesktopManagedDaemonIfNeeded: async () => false,
      installAppUpdateOnQuit: async () => false,
      createUpdateDeadlineSignal: () => new AbortController().signal,
      onStopError: vi.fn(),
      onUpdateError: vi.fn(),
    });

    lifecycle.handleBeforeQuitForUpdate(false);
    lifecycle.handleBeforeQuit({ preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(lifecycle.isQuitting()).toBe(false);
    await waitForQuitLifecycle();
    lifecycle.handleBeforeQuit({ preventDefault });
    await waitForQuitLifecycle();
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it("exits when update revalidation reaches its deadline", async () => {
    const deadline = new AbortController();
    const updateDecision = deferred<boolean>();
    const exits: number[] = [];
    const quitLifecycle = createQuitLifecycle({
      app: { exit: (code) => exits.push(code) },
      closeTransportSessions: () => {},
      stopDesktopManagedDaemonIfNeeded: async () => false,
      installAppUpdateOnQuit: () => updateDecision.promise,
      createUpdateDeadlineSignal: () => deadline.signal,
      onStopError: () => {},
      onUpdateError: () => {},
    });

    quitLifecycle.handleBeforeQuit({ preventDefault: () => {} });
    await waitForQuitLifecycle();
    deadline.abort();
    await waitForQuitLifecycle();

    expect(exits).toEqual([0]);

    updateDecision.resolve(true);
    await waitForQuitLifecycle();
    expect(exits).toEqual([0]);
  });
});
