import { SessionDelivery } from "../owned-subscriptions/index.js";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, onTestFinished, test, vi } from "vitest";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import { createLifecyclePreparation } from "../../agent/restart-recovery/lifecycle-preparation.js";
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
import { DefaultNpmGlobalPaseoCli } from "./npm-global-cli.js";

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

async function createNpmUpdateFixture(
  declaration: { paseoAgentResumeOnRestart?: boolean },
  options: { failFirstInstall?: boolean } = {},
) {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-update-retry-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const packagePath = path.join(root, "node_modules", "@getpaseo", "cli");
  const serverRoot = path.join(packagePath, "node_modules", "@getpaseo", "server");
  const launcher = path.join(packagePath, "dist", "commands", "daemon", "local-daemon.js");
  const worker = "dist/server/server/daemon-worker.js";
  const workerPath = path.join(serverRoot, worker);
  await mkdir(path.dirname(launcher), { recursive: true });
  await mkdir(path.dirname(workerPath), { recursive: true });
  await writeFile(launcher, "");

  let version = "0.1.15";
  async function writeDistribution(nextVersion: string) {
    await writeFile(workerPath, `// daemon worker ${nextVersion}\n`);
    await writeFile(
      path.join(serverRoot, "package.json"),
      JSON.stringify({
        name: "@getpaseo/server",
        version: nextVersion,
        main: worker,
        ...declaration,
      }),
    );
    version = nextVersion;
  }
  await writeDistribution(version);

  const installLatest = vi.fn(async () => {
    await writeDistribution("0.1.96");
    return { exitCode: 0, stdout: "", stderr: "" };
  });
  if (options.failFirstInstall) {
    installLatest.mockResolvedValueOnce({
      exitCode: 1,
      stdout: "",
      stderr: "Registry unavailable",
    });
  }
  const npm = new DefaultNpmGlobalPaseoCli(async (command, args) => {
    expect(command).toBe("npm");
    if (args[0] === "install") {
      return installLatest();
    }
    expect(args.slice(0, 3)).toEqual(["-g", "ls", "@getpaseo/cli"]);
    return {
      exitCode: 0,
      stderr: "",
      stdout: JSON.stringify({
        path: root,
        dependencies: { "@getpaseo/cli": { version, path: packagePath } },
      }),
    };
  });
  const updater = new DaemonSelfUpdater({
    npm,
    installOrigin: { resolveCurrentServerPackageRoot: () => serverRoot },
  });
  return { installLatest, packagePath, updater, workerPath };
}

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

  test.each([
    {
      target: "with agent resume support",
      declaration: { paseoAgentResumeOnRestart: true },
      preparationError: "Recovery data could not be saved",
      resumeIntent: { resumeAgents: true },
      agentResume: "requested",
      competingPreparation: false,
    },
    {
      target: "without an agent resume declaration",
      declaration: {},
      preparationError: "A daemon lifecycle request is already in progress",
      resumeIntent: {},
      agentResume: "unverified",
      competingPreparation: true,
    },
  ])("retries the installed target $target after preparation fails", async (scenario) => {
    const { declaration, preparationError, resumeIntent, agentResume, competingPreparation } =
      scenario;
    const { installLatest, packagePath, updater, workerPath } =
      await createNpmUpdateFixture(declaration);
    const preparation = Promise.withResolvers<void>();
    const captureStarted = Promise.withResolvers<void>();
    const capture = vi.fn(async (_force: boolean) => {});
    capture.mockImplementationOnce(() => {
      captureStarted.resolve();
      return preparation.promise;
    });
    const lifecycle = createLifecyclePreparation({
      pauseDelivery: () => undefined,
      pauseRunAdmission: () => () => {},
      waitForAdmittedRunsToStart: async () => {},
      capture,
    });
    const previousPreparation = competingPreparation ? lifecycle.prepare(true) : undefined;
    if (previousPreparation) await captureStarted.promise;

    const allowPreparation = Promise.withResolvers<void>();
    const started = Promise.withResolvers<RestartIntent>();
    const { controller, emitted, restartIntents } = createController({
      updater,
      async prepareLifecycleIntent(intent) {
        started.resolve(intent);
        await allowPreparation.promise;
        await lifecycle.prepare(intent.resumeAgents === true);
      },
    });

    const update = controller.dispatch(updateRequest);
    await expect(started.promise).resolves.toEqual({
      type: "restart",
      clientId: "client-1",
      requestId: "update-1",
      reason: "daemon_update",
      keepTerminals: true,
      ...resumeIntent,
    });
    const responses = () => emitted.filter((message) => message.type === "daemon.update.response");
    expect(responses()).toEqual([]);
    allowPreparation.resolve();
    if (previousPreparation) {
      await update;
      const failed = expect(previousPreparation).rejects.toThrow(
        "Recovery data could not be saved",
      );
      preparation.reject(new Error("Recovery data could not be saved"));
      await failed;
    } else {
      await captureStarted.promise;
      expect(responses()).toEqual([]);
      preparation.reject(new Error(preparationError));
    }
    await update;

    expect(restartIntents).toEqual([]);
    await expect(readFile(workerPath, "utf8")).resolves.toBe("// daemon worker 0.1.96\n");
    expect(installLatest).toHaveBeenCalledOnce();
    expect(responses()).toEqual([
      {
        type: "daemon.update.response",
        payload: {
          requestId: "update-1",
          success: false,
          previousVersion: "0.1.15",
          newVersion: "0.1.96",
          error: `Installed daemon 0.1.96 but could not restart: ${preparationError}`,
        },
      },
    ]);

    const prepareRetry = vi.fn((intent: RestartIntent) =>
      lifecycle.prepare(intent.resumeAgents === true),
    );
    const retry = createController({ updater, prepareLifecycleIntent: prepareRetry });
    await retry.controller.dispatch({ ...updateRequest, requestId: "update-2" });
    expect(retry.emitted.at(-1)).toEqual({
      type: "daemon.update.response",
      payload: {
        requestId: "update-2",
        success: true,
        error: null,
        previousVersion: "0.1.15",
        newVersion: "0.1.96",
        agentResume,
      },
    });
    expect(retry.restartIntents).toEqual([
      {
        type: "restart",
        clientId: "client-1",
        requestId: "update-2",
        reason: "daemon_update",
        keepTerminals: true,
        ...resumeIntent,
      },
    ]);
    expect(prepareRetry).toHaveBeenCalledExactlyOnceWith(retry.restartIntents[0]);
    expect(capture.mock.calls).toEqual([[true], [agentResume === "requested"]]);

    await rename(workerPath, `${workerPath}.previous`);
    await writeFile(workerPath, "// replacement daemon worker 0.1.96\n");
    await expect(readFile(workerPath, "utf8")).resolves.toBe(
      "// replacement daemon worker 0.1.96\n",
    );
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

    await rename(packagePath, `${packagePath}.previous`);
    await symlink(`${packagePath}.previous`, packagePath, "junction");
    const linkedRetry = createController({ updater });
    await linkedRetry.controller.dispatch(updateRequest);
    expect(linkedRetry.emitted.at(-1)).toMatchObject({
      type: "daemon.update.response",
      payload: { success: false, error: expect.stringContaining("is linked") },
    });
    expect(linkedRetry.restartIntents).toEqual([]);
    expect(installLatest).toHaveBeenCalledOnce();
  });

  test("installs again after npm fails before preparing a restart", async () => {
    const { installLatest, updater, workerPath } = await createNpmUpdateFixture(
      {},
      { failFirstInstall: true },
    );
    const prepareLifecycleIntent = vi.fn(async () => {});
    const { controller, emitted, restartIntents } = createController({
      updater,
      prepareLifecycleIntent,
    });

    await controller.dispatch(updateRequest);

    expect(emitted.at(-1)).toEqual({
      type: "daemon.update.response",
      payload: {
        requestId: "update-1",
        success: false,
        error: "Registry unavailable",
        previousVersion: "0.1.15",
        newVersion: null,
      },
    });
    await expect(readFile(workerPath, "utf8")).resolves.toBe("// daemon worker 0.1.15\n");
    expect(installLatest).toHaveBeenCalledOnce();
    expect(prepareLifecycleIntent).not.toHaveBeenCalled();
    expect(restartIntents).toEqual([]);

    const retry = createController({ updater, prepareLifecycleIntent });
    await retry.controller.dispatch({ ...updateRequest, requestId: "update-2" });

    await expect(readFile(workerPath, "utf8")).resolves.toBe("// daemon worker 0.1.96\n");
    expect(installLatest).toHaveBeenCalledTimes(2);
    expect(retry.emitted.at(-1)).toEqual({
      type: "daemon.update.response",
      payload: {
        requestId: "update-2",
        success: true,
        error: null,
        previousVersion: "0.1.15",
        newVersion: "0.1.96",
        agentResume: "unverified",
      },
    });
    expect(retry.restartIntents).toHaveLength(1);
    expect(retry.restartIntents[0]).not.toHaveProperty("resumeAgents");
    expect(prepareLifecycleIntent).toHaveBeenCalledExactlyOnceWith(retry.restartIntents[0]);
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
