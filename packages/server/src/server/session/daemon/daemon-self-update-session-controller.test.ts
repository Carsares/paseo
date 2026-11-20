import { SessionDelivery } from "../owned-subscriptions/index.js";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import {
  DaemonSelfUpdateInProgressError,
  DaemonSelfUpdater,
  type DaemonSelfUpdateInput,
} from "./daemon-self-updater.js";
import {
  DaemonSelfUpdateSessionController,
  type DaemonSelfUpdateSessionControllerOptions,
} from "./daemon-self-update-session-controller.js";

type TestUpdater = Pick<DaemonSelfUpdater, "update">;
type RestartIntent = Parameters<DaemonSelfUpdateSessionControllerOptions["emitLifecycleIntent"]>[0];

interface ControllerHarness {
  controller: DaemonSelfUpdateSessionController;
  emitted: SessionOutboundMessage[];
  restartIntents: RestartIntent[];
}

function createController(input: {
  updater: TestUpdater;
  prepareLifecycleIntent?: DaemonSelfUpdateSessionControllerOptions["prepareLifecycleIntent"];
  daemonVersion?: string | null;
  desktopManaged?: boolean;
}): ControllerHarness {
  const emitted: SessionOutboundMessage[] = [];
  const restartIntents: RestartIntent[] = [];
  const controller = new DaemonSelfUpdateSessionController({
    clientId: "client-1",
    daemonVersion: input.daemonVersion ?? "0.1.15",
    desktopManaged: input.desktopManaged,
    emit: (msg) => {
      emitted.push(msg);
    },
    prepareLifecycleIntent: input.prepareLifecycleIntent ?? (async () => {}),
    emitLifecycleIntent: (intent) => {
      restartIntents.push(intent);
    },
    sessionLogger: createTestLogger(),
    updater: input.updater,
  });

  return { controller, emitted, restartIntents };
}

const updateRequest: SessionInboundMessage = {
  type: "daemon.update.request",
  requestId: "update-1",
};

describe("DaemonSelfUpdateSessionController", () => {
  test("returns undefined synchronously for messages owned by another subsystem", () => {
    const updater: TestUpdater = {
      async update() {
        throw new Error("update should not run");
      },
    };
    const { controller, emitted, restartIntents } = createController({ updater });
    const message: SessionInboundMessage = {
      type: "daemon.get_status.request",
      requestId: "status-1",
    };

    const result = controller.dispatch(message);

    expect(result).toBeUndefined();
    expect(emitted).toEqual([]);
    expect(restartIntents).toEqual([]);
  });

  test("emits progress, response, and restart lifecycle intent after a successful update", async () => {
    let updateInput: DaemonSelfUpdateInput | null = null;
    const updater: TestUpdater = {
      async update(input) {
        updateInput = input;
        input.onProgress("starting");
        input.onProgress("installing");
        return { success: true, error: null, newVersion: "0.1.96", agentResumeSupported: true };
      },
    };
    const { controller, emitted, restartIntents } = createController({ updater });

    await controller.dispatch(updateRequest);

    expect(updateInput?.daemonVersion).toBe("0.1.15");
    expect(updateInput?.desktopManaged).toBe(false);
    expect(emitted).toEqual([
      {
        type: "daemon.update.progress",
        payload: {
          requestId: "update-1",
          phase: "starting",
        },
      },
      {
        type: "daemon.update.progress",
        payload: {
          requestId: "update-1",
          phase: "installing",
        },
      },
      {
        type: "daemon.update.response",
        payload: {
          requestId: "update-1",
          success: true,
          error: null,
          previousVersion: "0.1.15",
          newVersion: "0.1.96",
          agentResume: "requested",
        },
      },
    ]);
    expect(restartIntents).toEqual([
      {
        type: "restart",
        clientId: "client-1",
        requestId: "update-1",
        reason: "daemon_update",
        keepTerminals: true,
        resumeAgents: true,
      },
    ]);
  });

  test("emits a failed response without restart lifecycle intent", async () => {
    let updateInput: DaemonSelfUpdateInput | null = null;
    const updater: TestUpdater = {
      async update(input) {
        updateInput = input;
        return { success: false, error: "not an npm global install", newVersion: null };
      },
    };
    const { controller, emitted, restartIntents } = createController({
      updater,
      desktopManaged: true,
    });

    await controller.dispatch(updateRequest);

    expect(updateInput?.desktopManaged).toBe(true);
    expect(emitted).toEqual([
      {
        type: "daemon.update.response",
        payload: {
          requestId: "update-1",
          success: false,
          error: "not an npm global install",
          previousVersion: "0.1.15",
          newVersion: null,
        },
      },
    ]);
    expect(restartIntents).toEqual([]);
  });

  test("restarts without requesting agent resume when the installed target has no attestation", async () => {
    const prepareLifecycleIntent = vi.fn(async () => {});
    const { controller, emitted, restartIntents } = createController({
      prepareLifecycleIntent,
      updater: {
        async update() {
          return { success: true, error: null, newVersion: "0.1.96" };
        },
      },
    });

    await controller.dispatch(updateRequest);

    expect(emitted).toMatchObject([
      { type: "daemon.update.response", payload: { success: true, agentResume: "unverified" } },
    ]);
    expect(restartIntents).toHaveLength(1);
    expect(restartIntents[0]).not.toHaveProperty("resumeAgents");
    expect(prepareLifecycleIntent).toHaveBeenCalledExactlyOnceWith(restartIntents[0]);
  });

  test("waits for recovery and retries a verified install from a new connection", async ({
    onTestFinished,
  }) => {
    const root = await mkdtemp(path.join(tmpdir(), "paseo-update-retry-"));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    const packagePath = path.join(root, "node_modules", "@getpaseo", "cli");
    const serverRoot = path.join(packagePath, "node_modules", "@getpaseo", "server");
    const launcher = path.join(packagePath, "dist", "commands", "daemon", "local-daemon.js");
    const worker = "dist/server/server/daemon-worker.js";
    await mkdir(path.dirname(launcher), { recursive: true });
    await mkdir(path.dirname(path.join(serverRoot, worker)), { recursive: true });
    await writeFile(launcher, "");
    await writeFile(path.join(serverRoot, worker), "");

    let version = "0.1.15";
    let isLinked = false;
    const installLatest = vi.fn(async () => {
      version = "0.1.96";
      await writeFile(
        path.join(serverRoot, "package.json"),
        JSON.stringify({
          name: "@getpaseo/server",
          version,
          main: worker,
          paseoAgentResumeOnRestart: true,
        }),
      );
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const updater = new DaemonSelfUpdater({
      npm: {
        inspect: async () => ({ version, packagePath, globalRootPath: root, isLinked }),
        installLatest,
      },
      installOrigin: { resolveCurrentServerPackageRoot: () => serverRoot },
    });
    const preparation = Promise.withResolvers<void>();
    const started = Promise.withResolvers<RestartIntent>();
    const { controller, emitted, restartIntents } = createController({
      updater,
      prepareLifecycleIntent(intent) {
        started.resolve(intent);
        return preparation.promise;
      },
    });

    const update = controller.dispatch(updateRequest);
    await expect(started.promise).resolves.toMatchObject({ resumeAgents: true });
    const responses = () => emitted.filter((message) => message.type === "daemon.update.response");
    expect(responses()).toEqual([]);
    preparation.reject(new Error("Recovery data could not be saved"));
    await update;

    expect(restartIntents).toEqual([]);
    expect(responses()).toMatchObject([
      {
        type: "daemon.update.response",
        payload: {
          success: false,
          newVersion: "0.1.96",
          error: "Installed daemon 0.1.96 but could not restart: Recovery data could not be saved",
        },
      },
    ]);

    const retry = createController({ updater });
    await retry.controller.dispatch({ ...updateRequest, requestId: "update-2" });
    expect(retry.emitted.at(-1)).toMatchObject({
      type: "daemon.update.response",
      payload: {
        requestId: "update-2",
        success: true,
        newVersion: version,
        agentResume: "requested",
      },
    });
    expect(retry.restartIntents).toMatchObject([{ requestId: "update-2", resumeAgents: true }]);

    const workerPath = path.join(serverRoot, worker);
    await rename(workerPath, `${workerPath}.previous`);
    await writeFile(workerPath, "");
    const replacedRetry = createController({ updater });
    await replacedRetry.controller.dispatch(updateRequest);
    expect(replacedRetry.emitted.at(-1)).toMatchObject({
      type: "daemon.update.response",
      payload: {
        success: false,
        error: expect.stringContaining("global npm has 0.1.96, daemon is 0.1.15"),
      },
    });
    expect(replacedRetry.restartIntents).toEqual([]);

    isLinked = true;
    const linkedRetry = createController({ updater });
    await linkedRetry.controller.dispatch(updateRequest);
    expect(linkedRetry.emitted.at(-1)).toMatchObject({
      type: "daemon.update.response",
      payload: { success: false, error: expect.stringContaining("is linked") },
    });
    expect(linkedRetry.restartIntents).toEqual([]);
    expect(installLatest).toHaveBeenCalledOnce();
  });

  test("maps concurrent updates to rpc_error", async () => {
    const updater: TestUpdater = {
      async update() {
        throw new DaemonSelfUpdateInProgressError();
      },
    };
    const { controller, emitted, restartIntents } = createController({ updater });

    await controller.dispatch(updateRequest);

    expect(emitted).toEqual([
      {
        type: "rpc_error",
        payload: {
          requestId: "update-1",
          requestType: "daemon.update.request",
          error: "An update is already in progress",
          code: "already_updating",
        },
      },
    ]);
    expect(restartIntents).toEqual([]);
  });
});

test("self-update progress is request-owned through the final delivery boundary", async () => {
  const source = {},
    sibling = {};
  const frames: SessionOutboundMessage[] = [];
  const delivery = new SessionDelivery((socket, message) => {
    expect(socket).toBe(source);
    expect(delivery.permits(source, message)).toBe(true);
    expect(delivery.permits(sibling, message)).toBe(false);
    frames.push(message);
  });
  delivery.attach(source, true);
  delivery.attach(sibling, true);
  let lateProgress: (() => void) | undefined;
  const controller = new DaemonSelfUpdateSessionController({
    clientId: "safe-update",
    daemonVersion: "0.8.0",
    sessionLogger: createTestLogger(),
    emit: (message) => {
      delivery.reply(message);
    },
    prepareLifecycleIntent: async () => {},
    emitLifecycleIntent: () => {
      throw new Error("No restart is allowed in this test");
    },
    updater: {
      async update(input) {
        input.onProgress("starting");
        await Promise.resolve();
        input.onProgress("installing");
        lateProgress = () => input.onProgress("starting");
        return { success: false, error: "Safe injected update stopped", newVersion: null };
      },
    },
  });
  await delivery.request(source, updateRequest, async () => {
    await controller.dispatch(updateRequest);
  });
  expect(frames.map((message) => message.type)).toEqual([
    "daemon.update.progress",
    "daemon.update.progress",
    "daemon.update.response",
  ]);
  lateProgress?.();
  expect(frames).toHaveLength(3);
});
