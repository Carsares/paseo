import { createIdleRuntimeCleanup } from "../idle-runtime-cleanup/index.js";
import { HostObservationError } from "../host-operations/index.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { DaemonClient, WaitForFinishResult } from "@getpaseo/client/internal/daemon-client";
import {
  createAgentMessageDelivery,
  parseAgentMessages,
  type AgentMessageDelivery,
  type AgentPromptSource,
} from "../agent-messages/index.js";
import { buildStoredAgentPayload } from "../agent-projections.js";
import { registerParentFinishSubscription } from "../create-agent/create.js";
import { MessageReceipts } from "../../message-receipts/index.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import { decodeParentReportIdentity } from "./report-identity.js";
import { formatFinishNotificationBody } from "./internal/notification.js";
import {
  createFinishSubscriptions,
  createJsonFinishSubscriptionStore,
  type FinishObservation,
  type FinishSubscriptions,
} from "./index.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
class Observation implements FinishObservation {
  waits: Array<{ signal: AbortSignal; result: ReturnType<typeof deferred<WaitForFinishResult>> }> =
    [];
  permission = deferred<void>();
  opening: Promise<void> = Promise.resolve();
  openedSignals: AbortSignal[] = [];
  closed = vi.fn(async () => {});
  async open(_record: unknown, signal: AbortSignal) {
    this.openedSignals.push(signal);
    await this.opening;
    return { next: () => this.wait(signal), close: this.closed };
  }
  async wait(signal: AbortSignal) {
    signal.throwIfAborted();
    const result = deferred<WaitForFinishResult>();
    signal.addEventListener("abort", () => result.reject(new Error("Stopped")), { once: true });
    this.waits.push({ signal, result });
    return result.promise;
  }
  afterPermission() {
    return this.permission.promise;
  }
}
class Delivery implements AgentMessageDelivery {
  prompts: string[] = [];
  sources: AgentPromptSource[] = [];
  acknowledgments: Array<ReturnType<typeof deferred<"steered">>> = [];
  enqueue(message: Parameters<AgentMessageDelivery["enqueue"]>[0]) {
    this.prompts.push(String(message.prompt));
    this.sources.push(message.source);
    const acknowledgment = deferred<"steered">();
    this.acknowledgments.push(acknowledgment);
    return {
      status: "queued" as const,
      messageId: "notification",
      dispatched: acknowledgment.promise,
    };
  }
  async close() {}
  async waitForDispatch() {}
  withdrawPending() {
    return 0;
  }
}
const homes: string[] = [];
const services: FinishSubscriptions[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});
async function scenario(directory?: string, removalFailures = 0, retryDelayMs = 1) {
  const home = directory ?? (await mkdtemp(join(tmpdir(), "finish-recovery-")));
  if (!directory) homes.push(home);
  const durableStore = createJsonFinishSubscriptionStore(home);
  const store = {
    ...durableStore,
    async remove(id: string) {
      if (removalFailures > 0) {
        removalFailures--;
        throw new Error("Subscription removal unavailable");
      }
      await durableStore.remove(id);
    },
  };
  const observation = new Observation();
  const delivery = new Delivery();
  let active = true;
  const service = createFinishSubscriptions({
    store,
    messages: () => delivery,
    open: observation.open.bind(observation),
    callerIsActive: async () => active,
    serverId: "origin",
    logger: createTestLogger(),
    retryDelayMs,
  });
  services.push(service);
  await service.start();
  return {
    home,
    store,
    observation,
    delivery,
    service,
    archive: () => {
      active = false;
    },
  };
}
const intent = { callerAgentId: "parent", childAgentId: "child" };
function outcome(
  status: "idle" | "running" | "closed" | "error" = "closed",
  title: string | null = "Child task",
): WaitForFinishResult {
  return {
    status: status === "error" ? "error" : "idle",
    final: buildStoredAgentPayload(
      {
        id: "child",
        provider: "codex",
        cwd: "/tmp",
        title,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        labels: { "paseo.parent-agent-id": "parent" },
        lastStatus: status,
      },
      ["codex"],
      (_provider, own) => own ?? {},
    ),
    lastMessage: "Partial work saved",
    error: null,
  };
}
async function until(check: () => boolean) {
  await expect.poll(check).toBe(true);
}

test("a durable explicit report keeps the active approval and suppresses only its turn's automatic finish", async () => {
  const home = await mkdtemp(join(tmpdir(), "finish-suppression-"));
  homes.push(home);
  const store = createJsonFinishSubscriptionStore(home);
  const persisted = createJsonFinishSubscriptionStore(home, "reports.json");
  const reports = vi.fn(async () => {});
  const observation = new Observation();
  const delivery = new Delivery();
  const service = createFinishSubscriptions({
    store,
    followups: {
      watches: createJsonFinishSubscriptionStore(home, "watches.json"),
      reports: persisted,
      dispatch: reports,
    },
    open: observation.open.bind(observation),
    messages: () => delivery,
    callerIsActive: async () => true,
    serverId: "origin",
    logger: createTestLogger(),
    retryDelayMs: 1,
  });
  services.push(service);
  await service.start();
  const automatic = { ...intent, requireParentOwnership: true, automaticParent: true };
  await service.register(automatic);
  await until(() => observation.waits.length === 1);
  const permission = outcome("running");
  permission.status = "permission";
  permission.final!.pendingPermissions = [
    { id: "approval", provider: "codex", name: "Write", kind: "tool", input: {} },
  ];
  observation.waits[0]!.result.resolve(permission);
  await until(() => delivery.prompts.length === 1);
  expect(delivery.prompts[0]).toContain("approval");
  const reportId = await service.queueParentReport(intent, {
    title: "Child",
    summary: "Waiting for approval",
    status: "blocked",
    turnId: "first",
  });
  await expect.poll(() => reports.mock.calls.length).toBe(1);
  expect(await store.list()).toHaveLength(1);
  delivery.acknowledgments[0]!.resolve("steered");
  await until(() => observation.waits.length === 2);
  observation.waits[1]!.result.resolve({
    ...outcome("idle"),
    turnId: "first",
  } as WaitForFinishResult);
  await expect.poll(() => store.list()).toEqual([]);
  expect(delivery.prompts).toHaveLength(1);
  await expect.poll(() => persisted.list()).toEqual([]);
  expect(reportId).toBeTruthy();
  await service.register(automatic);
  await until(() => observation.waits.length === 3);
  observation.waits[2]!.result.resolve({
    ...outcome("idle"),
    turnId: "second",
  } as WaitForFinishResult);
  await until(() => delivery.prompts.length === 2);
  expect(delivery.prompts[1]).toContain("finished");
  delivery.acknowledgments[1]!.resolve("steered");
  await expect.poll(() => store.list()).toEqual([]);
});

test.each(["restart", "reporting migration"] as const)(
  "multiple held finishes from the same child survive registration until %s",
  async (action) => {
    const home = await mkdtemp(join(tmpdir(), "finish-inbox-recovery-"));
    homes.push(home);
    async function open() {
      const observation = new Observation();
      const store = createJsonFinishSubscriptionStore(home);
      const dispatched: string[] = [];
      const delivery = createAgentMessageDelivery({
        shouldHoldInbox: () => true,
        classifyInbox: async () => "ordinary",
        dispatch: async (batch) => {
          dispatched.push(String(batch.prompt));
          return "turn_started";
        },
        onError: () => {},
      });
      const service = createFinishSubscriptions({
        store,
        followups: {
          watches: createJsonFinishSubscriptionStore(home, "watches.json"),
          reports: createJsonFinishSubscriptionStore(home, "reports.json"),
          async dispatch(record, report) {
            await delivery.enqueue({
              recipientId: record.callerAgentId,
              messageId: report.id,
              source: {
                kind: "agent-notification",
                agentId: record.childAgentId,
                event: "finished",
              },
              prompt: report.prompt,
              subagentInbox: "ordinary",
            }).dispatched;
          },
        },
        open: observation.open.bind(observation),
        messages: () => delivery,
        callerIsActive: async () => true,
        serverId: "origin",
        logger: createTestLogger(),
        retryDelayMs: 1,
      });
      services.push(service);
      await service.start();
      return { observation, store, dispatched, delivery, service };
    }
    const first = await open();
    const automatic = { ...intent, requireParentOwnership: true, automaticParent: true };
    await first.service.register(automatic);
    await until(() => first.observation.waits.length === 1);
    first.observation.waits[0]!.result.resolve({
      ...outcome("idle"),
      turnId: "first",
      lastMessage: "First turn result",
    });
    await expect.poll(() => first.delivery.getInbox?.("parent")?.count).toBe(1);
    await first.service.register(automatic);
    await until(() => first.observation.waits.length === 2);
    first.observation.waits[1]!.result.resolve({
      ...outcome("idle"),
      turnId: "second",
      lastMessage: "Second turn result",
    });
    await expect.poll(() => first.delivery.getInbox?.("parent")?.count).toBe(2);
    const captured = async () => (await first.store.list()).map((record) => record.reportTurnId);
    expect(await captured()).toEqual(["first", "second"]);
    if (action === "reporting migration") {
      await first.service.cancelAutomaticParent(intent.childAgentId, intent.callerAgentId);
      expect(first.delivery.getInbox?.("parent")).toBeUndefined();
      expect(await captured()).toEqual([]);
      await first.delivery.close();
      expect(first.dispatched).toEqual([]);
      return;
    }
    await first.service.close();
    await first.delivery.close();
    const recovered = await open();
    await expect.poll(() => recovered.delivery.getInbox?.("parent")?.count).toBe(2);
    expect(recovered.observation.waits).toEqual([]);
    recovered.delivery.flushInbox?.("parent");
    await recovered.delivery.close();
    await expect.poll(() => recovered.store.list()).toEqual([]);
    expect(recovered.dispatched).toHaveLength(1);
    const reports = parseAgentMessages(recovered.dispatched[0]!)?.map(({ text }) => text);
    expect(reports).toEqual([
      expect.stringContaining("First turn result"),
      expect.stringContaining("Second turn result"),
    ]);
  },
);

test("restores a remote parent subscription and delivers to the owning host", async () => {
  const first = await scenario();
  await first.service.register({
    ...intent,
    callerServerId: "parent-host",
    requireParentOwnership: true,
  });
  await first.service.close();

  const store = createJsonFinishSubscriptionStore(first.home);
  const observation = new Observation();
  const callerIsActive = vi.fn(async () => false);
  const confirmed = Promise.withResolvers<{ deliveryStatus?: "queued" }>();
  const sendMessage = vi
    .fn<() => Promise<{ deliveryStatus?: "queued" }>>()
    .mockResolvedValueOnce({ deliveryStatus: "queued" })
    .mockRejectedValueOnce(new Error("Provider preparation failed"))
    .mockImplementation(() => confirmed.promise);
  const fetchAgent = vi.fn(async () => ({ agent: { archivedAt: null } }));
  const use = vi.fn((_serverId: string, action: (client: DaemonClient) => Promise<unknown>) =>
    action({
      sendMessage,
      fetchAgent,
      getLastServerInfoMessage: () => ({
        features: { agentMessageDispatchConfirmation: true },
      }),
    } as unknown as DaemonClient),
  );
  const restarted = createFinishSubscriptions({
    store,
    serverId: "origin",
    logger: createTestLogger(),
    callerIsActive,
    messages: () => first.delivery,
    hosts: () => ({
      directory: async () => {
        throw new Error("Unexpected host listing");
      },
      use: use as import("../host-operations/index.js").ToolHosts["use"],
    }),
    open: observation.open.bind(observation),
    retryDelayMs: 1,
  });
  services.push(restarted);
  await restarted.start();
  await until(() => observation.waits.length === 1);
  const finished = outcome("idle");
  finished.final!.labels!["paseo.parent-server-id"] = "parent-host";
  observation.waits[0]!.result.resolve(finished);
  await expect.poll(() => sendMessage.mock.calls.length).toBe(3);
  expect(await store.list()).toHaveLength(1);
  expect(sendMessage.mock.calls[1]).toEqual(sendMessage.mock.calls[0]);
  expect(sendMessage.mock.calls[2]).toEqual(sendMessage.mock.calls[0]);
  confirmed.resolve({});
  await expect.poll(async () => await store.list()).toEqual([]);
  expect(use).toHaveBeenCalledWith("parent-host", expect.any(Function), expect.any(AbortSignal));
  expect(sendMessage).toHaveBeenNthCalledWith(
    1,
    "parent",
    expect.stringContaining("Partial work saved"),
    {
      messageId: expect.any(String),
      sourceAgentId: "child",
      sourceAgentServerId: "origin",
      activeTurnBehavior: "queue",
      waitForDispatch: true,
    },
  );
  expect(callerIsActive).not.toHaveBeenCalled();
  expect(first.delivery.prompts).toEqual([]);
});

test("stops retrying when the parent host cannot confirm message dispatch", async () => {
  const home = await mkdtemp(join(tmpdir(), "finish-capability-"));
  homes.push(home);
  const store = createJsonFinishSubscriptionStore(home);
  const observation = new Observation();
  const sendMessage = vi.fn<() => Promise<{ deliveryStatus?: "queued" }>>().mockRejectedValue(
    Object.assign(new Error("Update the Paseo host to confirm agent message dispatch."), {
      code: "AGENT_MESSAGE_DISPATCH_CONFIRMATION_UNSUPPORTED",
    }),
  );
  const logger = createTestLogger();
  const warn = vi.spyOn(logger, "warn");
  const service = createFinishSubscriptions({
    store,
    serverId: "origin",
    logger,
    callerIsActive: async () => true,
    messages: () => new Delivery(),
    open: observation.open.bind(observation),
    retryDelayMs: 1,
    hosts: () => ({
      directory: async () => {
        throw new Error("Unexpected host listing");
      },
      use: async (_serverId, action) =>
        action({
          fetchAgent: async () => ({ agent: { archivedAt: null } }),
          getLastServerInfoMessage: () => ({
            features: { agentMessageDispatchConfirmation: false },
          }),
          sendMessage,
        } as unknown as DaemonClient),
    }),
  });
  services.push(service);
  await service.start();
  await service.register({ ...intent, callerServerId: "parent-host" });
  await until(() => observation.waits.length === 1);
  const finished = outcome("idle");
  finished.final!.labels!["paseo.parent-server-id"] = "parent-host";
  observation.waits[0]!.result.resolve(finished);
  await expect.poll(() => observation.closed.mock.calls.length).toBe(1);
  expect(sendMessage).toHaveBeenCalledTimes(1);
  expect(warn).toHaveBeenCalledWith(
    expect.objectContaining({ callerServerId: "parent-host" }),
    expect.stringContaining("Update the parent host"),
  );
  expect(await store.list()).toHaveLength(1);
});

test("retains intent until parent dispatch acknowledgment, then restart sends nothing", async () => {
  const first = await scenario();
  await first.service.register(intent);
  await until(() => first.observation.waits.length === 1);
  first.observation.waits[0]!.result.resolve(outcome());
  await until(() => first.delivery.prompts.length === 1);
  expect(first.delivery.prompts[0]).toContain("was closed");
  expect(first.delivery.prompts[0]).toContain("Partial work saved");
  expect(first.delivery.sources[0]).toMatchObject({ title: "Child task" });
  expect(await first.store.list()).toHaveLength(1);
  first.delivery.acknowledgments[0]!.resolve("steered");
  await expect.poll(async () => (await first.store.list()).length).toBe(0);
  await first.service.close();
  const restarted = await scenario(first.home);
  expect(restarted.observation.waits).toHaveLength(0);
});

test.each(["child", " CHILD ", "ABCDEF12-3456-7890-ABCD-EF1234567890", "   "])(
  "omits invalid title %j from notification metadata and body",
  async (title) => {
    const state = await scenario();
    await state.service.register(intent);
    await until(() => state.observation.waits.length === 1);
    state.observation.waits[0]!.result.resolve(outcome("idle", title));
    await until(() => state.delivery.prompts.length === 1);
    expect(state.delivery.sources[0]).not.toHaveProperty("title");
    expect(state.delivery.prompts[0]).toContain("Agent child finished.");
    expect(state.delivery.prompts[0]).not.toContain("(child)");
  },
);

test.each([
  ["finished", "Agent child (A renamed task) finished."],
  ["host unreachable", "Status of child agent child (A renamed task) is unknown."],
] as const)(
  "keeps the %s status line on one line when the title contains whitespace",
  (reason, expected) => {
    const body = formatFinishNotificationBody({
      childAgentId: "child",
      serverId: "remote",
      title: "  A\n  renamed\t task  ",
      reason,
      lastAssistantMessage: null,
    });
    expect(body.split("\n")).toContain(expected);
  },
);

test.each(["finished", "permission-required"] as const)(
  "a one-way human prompt retains a %s report before the first poll",
  async (firstEvent) => {
    const home = await mkdtemp(join(tmpdir(), "finish-followup-"));
    homes.push(home);
    const store = createJsonFinishSubscriptionStore(home);
    const watches = createJsonFinishSubscriptionStore(home, "watches.json");
    const reports = createJsonFinishSubscriptionStore(home, "reports.json");
    const observation = new Observation();
    const reverseAttempt = deferred<void>();
    const service = createFinishSubscriptions({
      store,
      followups: { watches, reports, dispatch: async () => {} },
      callerIsActive: async () => true,
      messages: () => new Delivery(),
      serverId: "origin",
      logger: createTestLogger(),
      open: observation.open.bind(observation),
      retryDelayMs: 1,
      hosts: () => ({
        directory: async () => {
          throw new Error("Unexpected host listing");
        },
        use: async () => {
          reverseAttempt.resolve();
          throw new HostObservationError("removed");
        },
      }),
    });
    services.push(service);
    await service.start();

    const pair = { ...intent, callerServerId: "parent-host" };
    const address = { ...pair, sourceId: "parent-source" };
    const finished = outcome("idle");
    finished.final!.labels!["paseo.parent-server-id"] = pair.callerServerId;
    const registration = await registerParentFinishSubscription({
      agentId: pair.childAgentId,
      serverId: "origin",
      agentManager: { getAgent: () => null, convergeLegacyParentReporting: async () => null },
      agentStorage: {
        get: async (id) => ({
          id,
          provider: "codex",
          cwd: "/tmp",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          labels: finished.final!.labels!,
        }),
      },
      finishSubscriptions: service,
    });
    registration!.accept();
    await until(() => observation.waits.length === 1);
    const first = firstEvent === "finished" ? finished : structuredClone(finished);
    if (firstEvent === "permission-required") {
      first.status = "permission";
      first.final!.pendingPermissions = [{ id: "approval", kind: "tool", name: "Edit", input: {} }];
    }
    observation.waits[0]!.result.resolve(first);
    await reverseAttempt.promise;
    expect(await watches.list()).toEqual([]);
    expect(await reports.list()).toHaveLength(1);

    const result = await service.pullReports(address, [], true, "active");
    expect(result).toMatchObject({
      ownsBinding: true,
      reports: [{ event: firstEvent }],
    });
    if (firstEvent === "permission-required") {
      expect(result.reports[0]!.prompt).toContain('"requestId": "approval"');
      await until(() => observation.waits.length === 2);
      observation.waits[1]!.result.resolve(finished);
      await expect.poll(async () => (await reports.list()).length).toBe(2);
      const followup = await service.pullReports(address, [result.reports[0]!.id], true, "active");
      expect(followup.reports).toMatchObject([
        { event: "finished", prompt: expect.stringContaining("Partial work saved") },
      ]);
    } else {
      expect(result.reports[0]!.prompt).toContain("Partial work saved");
    }
    await expect.poll(() => store.list()).toEqual([]);
    const retired = await service.pullReports(address, [], true, "unrelated");
    expect(retired).toEqual({ ownsBinding: false, reports: [] });
    expect(await watches.list()).toEqual([]);
    expect(await reports.list()).toEqual([]);
  },
);

test("unknown delivery outcomes are retained while later reports on subsequent pages are acknowledged", async () => {
  const home = await mkdtemp(join(tmpdir(), "finish-unknown-"));
  homes.push(home);
  const pair = { ...intent, callerServerId: "parent-host" };
  const address = { ...pair, sourceId: "parent-source" };
  const childReports = createJsonFinishSubscriptionStore(home, "child-reports.json");
  const child = createFinishSubscriptions({
    store: createJsonFinishSubscriptionStore(home, "child-intents.json"),
    followups: {
      watches: createJsonFinishSubscriptionStore(home, "child-watches.json"),
      reports: childReports,
      dispatch: async () => {},
    },
    callerIsActive: async () => true,
    messages: () => new Delivery(),
    serverId: "child-host",
    logger: createTestLogger(),
    open: async () => {
      throw new Error("Unexpected observation");
    },
  });
  services.push(child);
  const unknownIds = Array.from({ length: 8 }, (_, index) => `unknown-${index}`);
  const receipts = new MessageReceipts(join(home, "receipts"));
  const providerAccepted: string[] = [];
  const send = (id: string, loseAcknowledgment = false) =>
    receipts.send({
      agentId: pair.callerAgentId,
      messageId: id,
      request: { prompt: id },
      async send(beforeDispatch) {
        await beforeDispatch();
        providerAccepted.push(id);
        if (loseAcknowledgment) throw new Error("Lost provider acknowledgment");
      },
    });
  for (const id of unknownIds) {
    await expect(send(id, true)).rejects.toThrow("Lost provider acknowledgment");
  }
  await send("already-pushed");
  for (const id of [...unknownIds, "delivered", "already-pushed"]) {
    await childReports.put({
      ...pair,
      id,
      report: { id, prompt: id, title: "Child", event: "finished" },
    });
  }
  const client = {
    pullAgentFinishReports: async (
      _childId: string,
      _parentId: string,
      acknowledged: string[],
      observe: boolean,
    ) => {
      const { ownsBinding, reports } = await child.pullReports(
        address,
        acknowledged,
        observe,
        "active",
      );
      return { ownsChild: ownsBinding, reports, error: null };
    },
  } as DaemonClient;
  const parent = createFinishSubscriptions({
    store: createJsonFinishSubscriptionStore(home, "parent-intents.json"),
    followups: {
      watches: createJsonFinishSubscriptionStore(home, "parent-watches.json"),
      reports: createJsonFinishSubscriptionStore(home, "parent-reports.json"),
      async dispatch(_record, report) {
        await send(report.id);
      },
    },
    hosts: () => ({
      directory: async () => ({
        self: { serverId: "parent-host", label: "Parent" },
        hosts: [
          {
            registrationId: "child-registration",
            serverId: "child-host",
            label: "Child",
            source: { id: "owner", key: "child" },
            metadata: {},
            enabled: true,
            status: "online",
            targetDescription: "Child",
            lastOnlineAt: null,
            nextRetryAt: null,
            error: null,
          },
        ],
      }),
      use: async (_id, action) => action(client),
    }),
    callerIsActive: async () => true,
    messages: () => new Delivery(),
    logger: createTestLogger(),
    serverId: "parent-host",
    retryDelayMs: 1,
    open: async () => {
      throw new Error("Unexpected observation");
    },
  });
  services.unshift(parent);
  await parent.start();
  await parent.trackRemoteChild({ ...intent, serverId: "child-host" });
  await expect
    .poll(async () => (await childReports.list()).map(({ id }) => id))
    .toEqual(unknownIds);
  expect(providerAccepted).toEqual([...unknownIds, "already-pushed", "delivered"]);
});

test("restart coalesces predecessor and queued candidate into one settled notification", async () => {
  const first = await scenario();
  await first.service.register(intent);
  await first.service.register(intent, true);
  expect(await first.store.list()).toHaveLength(2);
  await first.service.close();
  const restarted = await scenario(first.home);
  await until(() => restarted.observation.waits.length === 1);
  restarted.observation.waits[0]!.result.resolve(outcome());
  await until(() => restarted.delivery.prompts.length === 1);
  restarted.delivery.acknowledgments[0]!.resolve("steered");
  await expect.poll(async () => (await restarted.store.list()).length).toBe(0);
  expect(restarted.delivery.prompts).toHaveLength(1);
});

test("rejected queued follow-up preserves the predecessor and its buffered finish", async () => {
  const state = await scenario();
  await state.service.register(intent);
  await until(() => state.observation.waits.length === 1);
  const pending = await state.service.register(intent, true);
  state.observation.waits[0]!.result.resolve(outcome("idle"));
  await Promise.resolve();
  expect(state.delivery.prompts).toHaveLength(0);
  await pending.reject();
  await until(() => state.delivery.prompts.length === 1);
  expect(await state.store.list()).toHaveLength(1);
});

test("accepted replacement ignores old idle and stale acknowledgment cannot delete new intent", async () => {
  const state = await scenario();
  await state.service.register(intent);
  await until(() => state.observation.waits.length === 1);
  state.observation.waits[0]!.result.resolve(outcome("idle"));
  await until(() => state.delivery.prompts.length === 1);
  const next = await state.service.register(intent, true);
  next.accept();
  await until(() => state.observation.waits.length === 2);
  state.delivery.acknowledgments[0]!.resolve("steered");
  await expect.poll(async () => (await state.store.list()).length).toBe(1);
  state.observation.waits[1]!.result.resolve(outcome("idle"));
  await until(() => state.delivery.prompts.length === 2);
});

test("a rejected candidate releases the preceding observer even if its cleanup write fails", async () => {
  const state = await scenario(undefined, 1);
  await state.service.register(intent);
  await until(() => state.observation.waits.length === 1);
  const candidate = await state.service.register(intent, true);
  state.observation.waits[0]!.result.resolve(outcome());
  await expect(candidate.reject()).rejects.toThrow("Subscription removal unavailable");
  await until(() => state.delivery.prompts.length === 1);
});

test("shutdown before dispatch acknowledgment leaves intent for recovery", async () => {
  const state = await scenario();
  await state.service.register(intent);
  await until(() => state.observation.waits.length === 1);
  state.observation.waits[0]!.result.resolve(outcome());
  await until(() => state.delivery.prompts.length === 1);
  await state.service.close();
  state.delivery.acknowledgments[0]!.resolve("steered");
  const restarted = await scenario(state.home);
  await until(() => restarted.observation.waits.length === 1);
  restarted.observation.waits[0]!.result.resolve(outcome());
  await until(() => restarted.delivery.prompts.length === 1);
});

test("remote recovery before three failed observations still reports child completion", async () => {
  const first = await scenario();
  await first.service.register({ ...intent, serverId: "remote" });
  await first.service.close();
  const state = await scenario(first.home);
  await until(() => state.observation.waits.length === 1);
  state.observation.waits[0]!.result.reject(new HostObservationError("unreachable"));
  await until(() => state.observation.waits.length === 2);
  expect(await state.store.list()).toHaveLength(1);
  expect(state.delivery.prompts).toHaveLength(0);
  state.observation.waits[1]!.result.resolve(outcome("idle"));
  await until(() => state.delivery.prompts.length === 1);
  expect(state.delivery.prompts[0]).toContain("Server: remote");
});

test("archived parent suppresses delivery and removes obsolete intent", async () => {
  const state = await scenario();
  await state.service.register(intent);
  await until(() => state.observation.waits.length === 1);
  state.archive();
  state.observation.waits[0]!.result.resolve(outcome());
  await expect.poll(async () => (await state.store.list()).length).toBe(0);
  expect(state.delivery.prompts).toHaveLength(0);
});

test("permission checkpoint retains intent and completion reports after permission clears", async () => {
  const state = await scenario();
  await state.service.register(intent);
  await until(() => state.observation.waits.length === 1);
  const result = outcome("running");
  result.status = "permission";
  result.final!.pendingPermissions = [
    {
      id: "permission",
      name: "Write",
      input: { path: "file" },
      kind: "tool",
    } as (typeof result.final.pendingPermissions)[number],
  ];
  state.observation.waits[0]!.result.resolve(result);
  await until(() => state.delivery.prompts.length === 1);
  expect(state.delivery.prompts[0]).toContain("respond_to_permission");
  expect(await state.store.list()).toHaveLength(1);
  state.delivery.acknowledgments[0]!.resolve("steered");
  state.observation.permission.resolve();
  await until(() => state.observation.waits.length === 2);
  state.observation.waits[1]!.result.resolve(outcome("idle"));
  await until(() => state.delivery.prompts.length === 2);
});

test("coalesced unconditional follow-up survives detachment of a parent-owned creation", async () => {
  const first = await scenario();
  await first.service.register({ ...intent, requireParentOwnership: true });
  await first.service.register(intent, true);
  await first.service.close();
  const restarted = await scenario(first.home);
  await until(() => restarted.observation.waits.length === 1);
  const detached = outcome();
  detached.final!.labels = {};
  restarted.observation.waits[0]!.result.resolve(detached);
  await until(() => restarted.delivery.prompts.length === 1);
});

test("retiring automatic observations withdraws a queued notification and preserves explicit watches", async () => {
  const home = await mkdtemp(join(tmpdir(), "finish-retire-"));
  homes.push(home);
  const durable = createJsonFinishSubscriptionStore(home);
  const old = { ...intent, id: "automatic-parent:old-watch", requireParentOwnership: true };
  const unrelated = { ...old, id: "other-watch", childAgentId: "other-child" };
  const formerParent = {
    ...old,
    id: "automatic-parent:other-parent",
    callerAgentId: "other-parent",
  };
  const remoteChild = { ...old, id: "automatic-parent:remote-child", serverId: "other-host" };
  await durable.put(old);
  const firstDispatch = Promise.withResolvers<void>();
  const queue = createAgentMessageDelivery({
    schedule: () => () => {},
    dispatch: async () => {
      firstDispatch.resolve();
      return "turn_started";
    },
    onError: vi.fn(),
  });
  const observation = new Observation();
  let failRemoval = true;
  const service = createFinishSubscriptions({
    store: {
      ...durable,
      remove: async (id) => {
        if (failRemoval && id === old.id) throw new Error("Cannot remove old watch");
        await durable.remove(id);
      },
    },
    messages: () => queue,
    open: observation.open.bind(observation),
    callerIsActive: async () => true,
    serverId: "origin",
    logger: createTestLogger(),
  });
  services.push(service);
  await service.start();
  try {
    await until(() => observation.waits.length === 1);
    observation.waits[0]!.result.resolve(outcome("idle"));
    await until(() => queue.hasPending(intent.callerAgentId));
    const explicit = await service.register({ ...intent, requireParentOwnership: true }, true);
    await service.register({ ...unrelated, automaticParent: true }, true);
    await durable.put(formerParent);
    await durable.put(remoteChild);

    await expect(
      service.cancelAutomaticParent(intent.childAgentId, intent.callerAgentId),
    ).rejects.toThrow("Cannot remove old watch");
    expect(queue.hasPending(intent.callerAgentId)).toBe(false);
    expect(observation.waits[0]!.signal.aborted).toBe(true);

    failRemoval = false;
    await service.cancelAutomaticParent(intent.childAgentId, intent.callerAgentId);
    const saved = await durable.list();
    expect(saved).toEqual([
      expect.objectContaining(intent),
      expect.objectContaining({ childAgentId: unrelated.childAgentId }),
      formerParent,
      remoteChild,
    ]);
    expect(saved.some(({ id }) => id === old.id)).toBe(false);

    explicit.accept();
    await until(() => observation.waits.length === 2);
    observation.waits[1]!.result.resolve(outcome("idle"));
    await until(() => queue.hasPending(intent.callerAgentId));
    await queue.close();
    await firstDispatch.promise;
  } finally {
    await service.close();
    await queue.close();
  }
});

test("retiring automatic observations keeps a restored watch with no recorded source", async () => {
  const first = await scenario();
  const legacy = { ...intent, id: "legacy-watch", requireParentOwnership: true };
  await first.store.put(legacy);
  await first.service.close();
  const restarted = await scenario(first.home);
  await until(() => restarted.observation.waits.length === 1);
  await restarted.service.cancelAutomaticParent(intent.childAgentId, intent.callerAgentId);
  expect(await restarted.store.list()).toEqual([legacy]);
  restarted.observation.waits[0]!.result.resolve(outcome("idle"));
  await until(() => restarted.delivery.prompts.length === 1);
  restarted.delivery.acknowledgments[0]!.resolve("steered");
  await expect.poll(async () => await restarted.store.list()).toEqual([]);
});

test.each([false, true])(
  "an accepted automatic replacement carries forward a requested observation (pending: %s)",
  async (pending) => {
    const state = await scenario();
    const owned = { ...intent, requireParentOwnership: true };
    const registration = await state.service.register(owned, pending);
    const requested = (await state.store.list())[0]!;
    if (!pending) await until(() => state.observation.waits.length === 1);
    await state.service.register({ ...owned, automaticParent: true });
    registration.accept();
    await state.service.cancelAutomaticParent(intent.childAgentId, intent.callerAgentId);
    expect(await state.store.list()).toEqual([requested]);
    await until(() => state.observation.waits.some(({ signal }) => !signal.aborted));
    const current = state.observation.waits.find(({ signal }) => !signal.aborted)!;
    current.result.resolve(outcome("idle"));
    await until(() => state.delivery.prompts.length === 1);
    state.delivery.acknowledgments[0]!.resolve("steered");
    await expect.poll(async () => await state.store.list()).toEqual([]);
  },
);

test("reporting migration prevents an automatic registration that is writing to disk", async () => {
  const home = await mkdtemp(join(tmpdir(), "finish-retire-concurrent-"));
  homes.push(home);
  const durable = createJsonFinishSubscriptionStore(home);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const observation = new Observation();
  let explicit = false;
  const service = createFinishSubscriptions({
    store: {
      ...durable,
      put: async (record) => {
        entered.resolve();
        await release.promise;
        await durable.put(record);
      },
    },
    messages: () => new Delivery(),
    open: observation.open.bind(observation),
    callerIsActive: async () => true,
    serverId: "origin",
    logger: createTestLogger(),
  });
  services.push(service);
  await service.start();
  const registration = service.register({
    ...intent,
    requireParentOwnership: true,
    automaticParent: true,
    canRegister: () => !explicit,
  });
  await entered.promise;
  explicit = true;
  const retired = service.cancelAutomaticParent(intent.childAgentId, intent.callerAgentId);
  release.resolve();
  (await registration).accept();
  await retired;
  expect(observation.openedSignals).toHaveLength(0);
  expect(await durable.list()).toEqual([]);
  expect(service.hasPendingForCaller(intent.callerAgentId)).toBe(false);
});

test.each([{}, { "paseo.parent-agent-id": "new-parent" }])(
  "a child reassigned to %j suppresses a parent-owned subscription",
  async (labels) => {
    const state = await scenario();
    await state.service.register({ ...intent, requireParentOwnership: true });
    await until(() => state.observation.waits.length === 1);
    const finished = outcome();
    finished.final!.labels = labels;
    state.observation.waits[0]!.result.resolve(finished);
    await expect.poll(async () => (await state.store.list()).length).toBe(0);
    expect(state.delivery.prompts).toHaveLength(0);
  },
);

test("dispatch failure retains intent and retries the ordinary finish notification", async () => {
  const state = await scenario();
  await state.service.register(intent);
  await until(() => state.observation.waits.length === 1);
  state.observation.waits[0]!.result.resolve(outcome());
  await until(() => state.delivery.prompts.length === 1);
  state.delivery.acknowledgments[0]!.reject(new Error("Provider unavailable"));
  await until(() => state.delivery.prompts.length === 2);
  expect(await state.store.list()).toHaveLength(1);
  expect(state.observation.waits).toHaveLength(1);
  state.delivery.acknowledgments[1]!.resolve("steered");
  await expect.poll(async () => (await state.store.list()).length).toBe(0);
});

test("error and missing-child notifications never claim successful completion", async () => {
  const state = await scenario();
  await state.service.register(intent);
  await until(() => state.observation.waits.length === 1);
  state.observation.waits[0]!.result.resolve(outcome("error"));
  await until(() => state.delivery.prompts.length === 1);
  expect(state.delivery.prompts[0]).toContain("errored");
  await state.service.register({ ...intent, childAgentId: "missing-child" });
  await until(() => state.observation.waits.length === 2);
  state.observation.waits[1]!.result.resolve({
    status: "error",
    final: null,
    error: "Agent not found: missing-child",
    lastMessage: null,
  });
  await until(() => state.delivery.prompts.length === 2);
  expect(state.delivery.prompts[1]).toContain("is unavailable");
  expect(state.delivery.prompts[1]).not.toContain("finished");
});

test("finish notification limits a long last response and points to activity for the remainder", async () => {
  const state = await scenario();
  await state.service.register(intent);
  await until(() => state.observation.waits.length === 1);
  const result = outcome("idle");
  result.lastMessage = "x".repeat(4100);
  state.observation.waits[0]!.result.resolve(result);
  await until(() => state.delivery.prompts.length === 1);
  expect(state.delivery.prompts[0]).toContain("x".repeat(4000));
  expect(state.delivery.prompts[0]).not.toContain("x".repeat(4001));
  expect(state.delivery.prompts[0]).toContain("get_agent_activity");
});

test("three failed remote observations consume intent only after unavailable-notification acknowledgment", async () => {
  const state = await scenario();
  await state.service.register({ ...intent, serverId: "remote" });
  for (let attempt = 0; attempt < 3; attempt++) {
    await until(() => state.observation.waits.length === attempt + 1);
    expect(state.delivery.prompts).toEqual([]);
    state.observation.waits[attempt]!.result.reject(new HostObservationError("unreachable"));
  }
  await until(() => state.delivery.prompts.length === 1);
  expect(state.delivery.prompts[0]).toContain(
    "Could not observe child agent child on host remote after three failed attempts.",
  );
  expect(state.delivery.prompts[0]).toContain("Status of child agent child is unknown.");
  expect(state.delivery.prompts[0]).not.toContain("finished.");
  expect(await state.store.list()).toHaveLength(1);
  expect(state.observation.waits).toHaveLength(3);
  state.delivery.acknowledgments[0]!.resolve("steered");
  await expect.poll(async () => (await state.store.list()).length).toBe(0);
  await state.service.close();
  const restarted = await scenario(state.home);
  expect(restarted.observation.waits).toEqual([]);
  expect(restarted.delivery.prompts).toEqual([]);
});

test("connecting does not spend the remote failure budget and recovery before three failures still completes", async () => {
  const state = await scenario();
  await state.service.register({ ...intent, serverId: "remote" });
  for (let attempt = 0; attempt < 4; attempt++) {
    await until(() => state.observation.waits.length === attempt + 1);
    expect(state.delivery.prompts).toEqual([]);
    state.observation.waits[attempt]!.result.reject(new HostObservationError("connecting"));
  }
  for (let attempt = 4; attempt < 6; attempt++) {
    await until(() => state.observation.waits.length === attempt + 1);
    expect(state.delivery.prompts).toEqual([]);
    state.observation.waits[attempt]!.result.reject(new HostObservationError("unreachable"));
  }
  await until(() => state.observation.waits.length === 7);
  expect(state.delivery.prompts).toEqual([]);
  state.observation.waits[6]!.result.resolve(outcome("idle"));
  await until(() => state.delivery.prompts.length === 1);
  expect(state.delivery.prompts[0]).toContain("finished.");
});

test("removed-host notice retries parent dispatch without observing again or deleting unacknowledged intent", async () => {
  const state = await scenario();
  await state.service.register({ ...intent, serverId: "remote" });
  await until(() => state.observation.waits.length === 1);
  state.observation.waits[0]!.result.reject(new HostObservationError("removed"));
  await until(() => state.delivery.prompts.length === 1);
  expect(state.delivery.prompts[0]).toContain("Host remote was removed or is unavailable.");
  expect(state.delivery.prompts[0]).toContain("Status of child agent child is unknown.");
  state.delivery.acknowledgments[0]!.reject(new Error("Parent provider unavailable"));
  await until(() => state.delivery.prompts.length === 2);
  expect(state.delivery.prompts[1]).toBe(state.delivery.prompts[0]);
  expect(state.observation.waits).toHaveLength(1);
  expect(await state.store.list()).toHaveLength(1);
  state.delivery.acknowledgments[1]!.resolve("steered");
  await expect.poll(async () => (await state.store.list()).length).toBe(0);
});

test("failed removal after dispatch acknowledgment retries only storage, preserving the accepted outcome", async () => {
  const state = await scenario(undefined, 2, 1000);
  await state.service.register(intent);
  await until(() => state.observation.waits.length === 1);
  state.observation.waits[0]!.result.resolve(outcome("idle"));
  await until(() => state.delivery.prompts.length === 1);
  state.delivery.acknowledgments[0]!.resolve("steered");
  await expect.poll(async () => (await state.store.list()).length, { timeout: 10000 }).toBe(0);
  expect(state.delivery.prompts).toHaveLength(1);
  expect(state.delivery.prompts[0]).toContain("finished.");
  expect(state.observation.waits).toHaveLength(1);
});

test("shutdown during observation setup owns rejection of the already-canceled next result", async () => {
  const state = await scenario();
  const opening = deferred<void>();
  state.observation.opening = opening.promise;
  await state.service.register(intent);
  await until(() => state.observation.openedSignals.length === 1);
  const closing = state.service.close();
  await until(() => state.observation.openedSignals[0]!.aborted);
  opening.resolve();
  await closing;
  expect(await state.store.list()).toHaveLength(1);
  expect(state.delivery.prompts).toEqual([]);
});

test("remote finish intent protects its caller through registration, observation and delivery", async () => {
  const s = await scenario();
  let time = 61 * 60_000;
  let collected = false;
  const runtime = {
    identity: {},
    agentId: "parent",
    parentAgentId: undefined,
    provider: "test",
    sessionId: "parent",
    lastActivityAt: 0,
    isEligible: () => !collected,
    closeIfEligible: async (revalidate: () => boolean) => {
      if (!revalidate()) return false;
      collected = true;
      return true;
    },
  };
  const cleanup = createIdleRuntimeCleanup({
    enabled: true,
    logger: createTestLogger(),
    now: () => time,
    runtimes: () => (collected ? [] : [runtime]),
    isProtected: (agentId) => s.service.hasPendingForCaller(agentId),
    schedule: () => () => {},
  });
  const savedPut = s.store.put.bind(s.store);
  const writing = deferred<void>();
  s.store.put = async (record) => {
    await writing.promise;
    await savedPut(record);
  };
  const registration = s.service.register({ ...intent, serverId: "remote" }, true);
  const protectedDuringRegistration = s.service.hasPendingForCaller?.("parent") ?? false;
  writing.resolve();
  const accepted = await registration;
  expect(protectedDuringRegistration).toBe(true);
  expect((await cleanup.sweep()).collected).toEqual([]);
  expect(s.service.hasPendingForCaller("parent")).toBe(true);
  accepted.accept();
  await until(() => s.observation.waits.length === 1);
  expect(s.service.hasPendingForCaller("parent")).toBe(true);
  s.observation.waits[0]!.result.resolve(outcome());
  await until(() => s.delivery.prompts.length === 1);
  expect(s.service.hasPendingForCaller("parent")).toBe(true);
  s.delivery.acknowledgments[0]!.resolve("steered");
  await until(() => !s.service.hasPendingForCaller("parent"));
  expect(await s.store.list()).toEqual([]);
  time = 62 * 60_000;
  expect((await cleanup.sweep()).collected).toEqual([]);
  time = 122 * 60_000;
  expect((await cleanup.sweep()).collected).toHaveLength(1);
  await cleanup.close();
});

test("finish recovery protects callers before durable intent has loaded", async () => {
  const s = await scenario();
  await s.service.register({ ...intent, serverId: "remote" });
  await s.service.close();
  const loading = deferred<void>();
  const recovered = createFinishSubscriptions({
    store: {
      ...s.store,
      list: async () => {
        await loading.promise;
        return s.store.list();
      },
    },
    messages: () => s.delivery,
    open: s.observation.open.bind(s.observation),
    callerIsActive: async () => true,
    serverId: "origin",
    logger: createTestLogger(),
  });
  services.push(recovered);
  expect(recovered.hasPendingForCaller("parent")).toBe(true);
  const starting = recovered.start();
  expect(recovered.hasPendingForCaller("parent")).toBe(true);
  loading.resolve();
  await starting;
  expect(recovered.hasPendingForCaller("parent")).toBe(true);
  expect(recovered.hasPendingForCaller("unrelated")).toBe(false);
});

test("an undispatched follow-up does not block the running child's permission notification", async () => {
  const state = await scenario();
  await state.service.register(intent);
  await until(() => state.observation.waits.length === 1);
  await state.service.register(intent, true);
  const result = outcome("running");
  result.status = "permission";
  result.final!.pendingPermissions = [
    {
      id: "approval",
      provider: "codex",
      name: "Bash",
      kind: "tool",
      input: { command: "run tests" },
    } as NonNullable<typeof result.final>["pendingPermissions"][number],
  ];
  state.observation.waits[0]!.result.resolve(result);
  await until(() => state.delivery.prompts.length === 1);
  expect(state.delivery.prompts[0]).toContain("needs permission");
  expect(state.delivery.prompts[0]).toContain("approval");
  expect(await state.store.list()).toHaveLength(2);
});

test("explicit reports survive a restart and an unacknowledged pull without reaching old readers", async () => {
  const home = await mkdtemp(join(tmpdir(), "parent-report-recovery-"));
  homes.push(home);
  const open = () => {
    const service = createFinishSubscriptions({
      store: createJsonFinishSubscriptionStore(home),
      followups: {
        watches: createJsonFinishSubscriptionStore(home, "watches.json"),
        reports: createJsonFinishSubscriptionStore(home, "reports.json"),
        dispatch: async () => {
          throw new Error("The parent host owns dispatch");
        },
      },
      messages: () => new Delivery(),
      open: new Observation().open,
      callerIsActive: async () => true,
      serverId: "child-host",
      logger: createTestLogger(),
    });
    services.push(service);
    return service;
  };
  const first = open();
  await first.start();
  const pair = { childAgentId: "child", callerAgentId: "parent", callerServerId: "parent-host" };
  const address = { ...pair, sourceId: "parent-source" };
  const reportId = await first.queueParentReport(pair, {
    status: "blocked",
    title: "Review",
    summary: "Which API?",
  });
  await first.close();
  const restarted = open();
  await restarted.start();
  expect(await restarted.pullReports(address, [], true, "active")).toEqual({
    ownsBinding: true,
    reports: [],
  });
  const expected = {
    ownsBinding: true,
    reports: [
      expect.objectContaining({
        id: reportId,
        parentReportStatus: "blocked",
        prompt: "Report to parent (blocked):\n\nWhich API?",
      }),
    ],
  };
  expect(await restarted.pullReports(address, [], true, "active", true)).toEqual(expected);
  expect(
    await restarted.pullReports(
      { ...address, sourceId: "another-source" },
      [reportId],
      true,
      "active",
      true,
    ),
  ).toEqual({ ownsBinding: false, reports: [] });
  expect(await restarted.pullReports(address, [], true, "active", true)).toEqual(expected);
  expect(await restarted.pullReports(address, [reportId], true, "active", true)).toEqual({
    ownsBinding: true,
    reports: [],
  });
  expect(await restarted.pullReports(address, [], true, "active", true)).toEqual({
    ownsBinding: true,
    reports: [],
  });
});

test("push and pull confirm the same report while its push is still pending", async () => {
  const home = await mkdtemp(join(tmpdir(), "parent-report-identity-"));
  homes.push(home);
  const pushed = deferred<string>();
  const pair = { ...intent, callerServerId: "parent-host" };
  const address = { ...pair, sourceId: "parent-source" };
  const client = {
    async pushAgentFinishReport(_child: string, _parent: string, report: { id: string }) {
      pushed.resolve(report.id);
      return await new Promise<never>(() => {});
    },
  } as DaemonClient;
  const service = createFinishSubscriptions({
    store: createJsonFinishSubscriptionStore(home),
    followups: {
      watches: createJsonFinishSubscriptionStore(home, "watches.json"),
      reports: createJsonFinishSubscriptionStore(home, "reports.json"),
      dispatch: async () => {},
    },
    hosts: () => ({
      directory: async () => {
        throw new Error("Unexpected host listing");
      },
      use: async (_id, action) => action(client),
    }),
    serverId: "child-host",
    callerIsActive: async () => true,
    messages: () => new Delivery(),
    open: new Observation().open,
    logger: createTestLogger(),
  });
  services.push(service);
  await service.start();
  const id = await service.queueParentReport(pair, {
    status: "completed",
    title: "Child",
    summary: "Ready",
    turnId: "turn-1",
  });
  const pushedId = await pushed.promise;
  expect(decodeParentReportIdentity(pushedId)).toEqual({ id, turnId: "turn-1", finishedIds: [] });
  const pulled = await service.pullReports(address, [], true, "active", true);
  expect(pulled.reports).toMatchObject([{ id: pushedId }]);
  expect(await service.confirmParentReport(pair, pushedId)).toBe(true);
  expect(await service.confirmParentReport({ ...pair, childAgentId: "other" }, pushedId)).toBe(
    false,
  );
  expect(await service.pullReports(address, [pushedId], true, "archived", true)).toEqual({
    ownsBinding: false,
    reports: [],
  });
  expect(await service.confirmParentReport(pair, pushedId)).toBe(false);
});
