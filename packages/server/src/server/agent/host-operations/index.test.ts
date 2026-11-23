import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  MAIN_PRIOR_MODE_ID_LABEL,
  PARENT_REPORTING_LABEL,
  EXPLICIT_PARENT_REPORTING,
  parentAddressLabels,
  WORKSPACE_MAIN_ROLE,
  WORKSPACE_ROLE_LABEL,
} from "@getpaseo/protocol/agent-labels";
import { afterEach, expect, test, vi } from "vitest";

import { createHostResolver, type HostOperations } from "./index.js";
import { buildStoredAgentPayload } from "../agent-projections.js";

type Handler = ((event?: unknown) => void) | null;

/** A connected host from before background agents: background workspaces, no background agents. */
class OlderHostSocket {
  readyState = 1;
  readonly requests: Array<Record<string, unknown>> = [];
  onopen: Handler = null;
  onmessage: Handler = null;
  onclose: Handler = null;
  onerror: Handler = null;
  private readonly createSent = Promise.withResolvers<Record<string, unknown>>();
  private readonly workspaceCreateSent = Promise.withResolvers<Record<string, unknown>>();

  constructor() {
    queueMicrotask(() => this.onopen?.());
  }

  createRequest(): Promise<Record<string, unknown>> {
    return this.createSent.promise;
  }

  workspaceCreateRequest(): Promise<Record<string, unknown>> {
    return this.workspaceCreateSent.promise;
  }

  send(data: string): void {
    const frame = JSON.parse(data);
    if (frame.type === "hello") {
      this.reply({
        type: "status",
        payload: {
          status: "server_info",
          serverId: "srv_older",
          hostname: null,
          version: null,
          features: {
            providerUsageList: true,
            providersSnapshotCwd: true,
            ownedSubscriptions: true,
            backgroundWorkspaces: true,
          },
        },
      });
      return;
    }
    if (frame.type !== "session") return;
    const message = frame.message;
    this.requests.push(message);
    if (message.type === "fetch_workspaces_request") {
      this.reply({
        type: "fetch_workspaces_response",
        payload: {
          requestId: message.requestId,
          entries: [workspace],
          pageInfo: emptyPage,
        },
      });
    }
    if (message.type === "create_agent_request") this.createSent.resolve(message);
    if (message.type === "workspace.create.request") this.workspaceCreateSent.resolve(message);
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.({ code: 1000, reason: "closed" });
  }

  private reply(message: object): void {
    this.onmessage?.({ data: JSON.stringify({ type: "session", message }) });
  }
}

const emptyPage = { nextCursor: null, prevCursor: null, hasMore: false };

const workspace = {
  id: "workspace_older",
  projectId: "project_older",
  projectDisplayName: "Older",
  projectRootPath: "/repo/older",
  workspaceDirectory: "/repo/older",
  projectKind: "git",
  workspaceKind: "directory",
  name: "older",
  archivingAt: null,
  status: "done",
  statusEnteredAt: null,
  activityAt: "2026-05-16T00:00:00.000Z",
  scripts: [],
  gitRuntime: null,
  githubRuntime: null,
};

const clients: DaemonClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

async function olderHost() {
  const socket = new OlderHostSocket();
  const client = new DaemonClient({
    url: "ws://older.test",
    clientId: "older-host-test",
    webSocketFactory: () => socket,
    reconnect: { enabled: false },
  });
  clients.push(client);
  await client.connect();
  return { client, socket };
}

interface Caller {
  background: boolean;
  provider: string;
  currentModeId: string | null;
  labels?: Record<string, string>;
  config: Record<string, never>;
}

function resolverFor(client: DaemonClient, caller: Caller | null) {
  return createHostResolver({
    serverId: "origin",
    callerAgentId: caller ? "caller" : undefined,
    caller: () => caller,
    local: {} as HostOperations,
    hosts: () => ({
      directory: async () => ({ self: { serverId: "origin", label: "Origin" }, hosts: [] }),
      use: (_serverId, action) => action(client),
    }),
  });
}

const visibleCodexCaller: Caller = {
  background: false,
  provider: "codex",
  currentModeId: "full-access",
  config: {},
};

const createArgs = {
  workspaceId: workspace.id,
  provider: "codex/gpt-5.4",
  title: "Helper",
  initialPrompt: "Summarize",
};

test("remote permission responses carry the caller scope and require the matching pending request", async () => {
  const id = "child";
  const agent = buildStoredAgentPayload(
    {
      id,
      provider: "codex",
      cwd: "/repo",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      labels: parentAddressLabels({ agentId: "caller", serverId: "origin" }),
    },
    ["codex"],
    (_provider, own) => own ?? {},
  );
  agent.pendingPermissions = [{ id: "pending", provider: "codex", name: "Approve", kind: "tool" }];
  const respondToPermissionAndWait = vi.fn(async () => {});
  const client = {
    fetchAgent: async () => ({ agent }),
    respondToPermissionAndWait,
  } as unknown as DaemonClient;
  const resolver = createHostResolver({
    serverId: "origin",
    callerAgentId: "caller",
    caller: () => visibleCodexCaller,
    local: {} as HostOperations,
    hosts: () => ({
      directory: async () => ({ self: { serverId: "origin", label: "Origin" }, hosts: [] }),
      use: (serverId, action, _signal, directParentAgentId) => {
        expect(serverId).toBe("remote");
        expect(directParentAgentId).toBe("caller");
        return action(client);
      },
    }),
  });
  const response = { behavior: "deny" };
  const respond = (requestId: string) =>
    resolver.use(
      "remote",
      (host) => host.respondToPermission({ agentId: id, requestId, response }, {}),
      "caller",
    );
  await expect(respond("stale")).rejects.toThrow("no longer pending");
  await expect(respond("pending")).resolves.toMatchObject({ structuredContent: { success: true } });
  agent.labels = parentAddressLabels({ agentId: "caller", serverId: "other-host" });
  await expect(respond("pending")).rejects.toThrow("direct subagents");
  expect(respondToPermissionAndWait).toHaveBeenCalledExactlyOnceWith(id, "pending", response);
});

test("a visible caller still creates agents on a host without background agents", async () => {
  const { client, socket } = await olderHost();
  const creating = resolverFor(client, visibleCodexCaller).use("srv_older", (host) =>
    host.createAgent(createArgs, {} as never),
  );
  creating.catch(() => {});

  const request = await socket.createRequest();
  expect(request).toMatchObject({ workspaceId: workspace.id });
  expect(request).not.toHaveProperty("background");
});

test("a background caller's remote child asks the host to update instead of turning visible", async () => {
  const { client, socket } = await olderHost();

  await expect(
    resolverFor(client, { ...visibleCodexCaller, background: true }).use("srv_older", (host) =>
      host.createAgent(createArgs, {} as never),
    ),
  ).rejects.toThrow("Update the host to use background agents.");
  expect(socket.requests.map((request) => request.type)).not.toContain("create_agent_request");
});

async function forwardedMode(caller: Caller | null, args: Record<string, unknown> = createArgs) {
  const { client, socket } = await olderHost();
  const creating = resolverFor(client, caller).use("srv_older", (host) =>
    host.createAgent(args, {} as never),
  );
  creating.catch(() => {});
  const request = (await socket.createRequest()) as { config: { modeId?: string } };
  return request.config.modeId;
}

test("a remote child of the same provider starts in its caller's mode", async () => {
  expect(await forwardedMode(visibleCodexCaller)).toBe("full-access");
});

test("an explicit mode wins over the caller's mode on a remote host", async () => {
  expect(
    await forwardedMode(visibleCodexCaller, { ...createArgs, settings: { modeId: "auto" } }),
  ).toBe("auto");
});

test("a remote child of another provider leaves its mode to the host", async () => {
  expect(await forwardedMode({ ...visibleCodexCaller, provider: "claude" })).toBeUndefined();
});

test("a remote create without a caller agent leaves its mode to the host", async () => {
  expect(await forwardedMode(null)).toBeUndefined();
});

test.each([
  { currentModeId: "read-only", priorMode: "full-access", expected: "full-access" },
  { currentModeId: "workspace-write", priorMode: "full-access", expected: "workspace-write" },
  { currentModeId: "read-only", priorMode: null, expected: "read-only" },
])(
  "a remote child inherits $expected from a Main Control caller",
  async ({ currentModeId, priorMode, expected }) => {
    expect(
      await forwardedMode({
        ...visibleCodexCaller,
        currentModeId,
        labels: {
          [WORKSPACE_ROLE_LABEL]: WORKSPACE_MAIN_ROLE,
          ...(priorMode ? { [MAIN_PRIOR_MODE_ID_LABEL]: priorMode } : {}),
        },
      }),
    ).toBe(expected);
  },
);

async function forwardedWorktreeSource(args: Record<string, unknown>) {
  const { client, socket } = await olderHost();
  const creating = resolverFor(client, null).use("srv_older", (host) =>
    host.createWorkspace({ isolation: "worktree", path: "/repo/older", ...args }, {} as never),
  );
  creating.catch(() => {});
  const request = (await socket.workspaceCreateRequest()) as { source: Record<string, unknown> };
  return request.source;
}

test("a remote worktree for a pull request without a mode checks the pull request out", async () => {
  expect(await forwardedWorktreeSource({ prNumber: 42 })).toMatchObject({
    action: "checkout",
    githubPrNumber: 42,
  });
});

test("a remote worktree without a mode or pull request branches off", async () => {
  expect(await forwardedWorktreeSource({ baseBranch: "main" })).toMatchObject({
    action: "branch-off",
  });
});

test("a remote worktree that branches off a pull request is refused, as on the local host", async () => {
  const { client, socket } = await olderHost();

  await expect(
    resolverFor(client, null).use("srv_older", (host) =>
      host.createWorkspace(
        { isolation: "worktree", path: "/repo/older", mode: "branch-off", prNumber: 42 },
        {} as never,
      ),
    ),
  ).rejects.toThrow("branch, prNumber, and forge require a checkout mode");
  expect(socket.requests.map((request) => request.type)).not.toContain("workspace.create.request");
});

test("a destination without explicit reporting support receives no creation request", async () => {
  const { client, socket } = await olderHost();
  const resolver = resolverFor(client, visibleCodexCaller);
  await expect(
    resolver.use("srv_older", (host) =>
      host.createAgent(
        {
          ...createArgs,
          labels: { [PARENT_REPORTING_LABEL]: EXPLICIT_PARENT_REPORTING },
          notifyOnFinish: true,
        },
        {},
      ),
    ),
  ).rejects.toThrow("Update the destination Paseo host to use explicit parent reporting.");
  expect(socket.requests.map(({ type }) => type)).not.toContain("create_agent_request");
});

test.each([false, true])(
  "negotiates queued direct delegation and completion ownership (%s)",
  async (modern) => {
    const { client } = await olderHost();
    const serverInfo = client.getLastServerInfoMessage()!;
    serverInfo.features!.agentDirectParentQueuedDelivery = modern;
    serverInfo.features!.agentFinishReportPull = modern;
    const destination = "srv_older";
    const agent = buildStoredAgentPayload(
      {
        id: "child",
        provider: "codex",
        cwd: "/repo",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        labels: parentAddressLabels({ agentId: "caller", serverId: "origin" }),
      },
      ["codex"],
      (_provider, own) => own ?? {},
    );
    vi.spyOn(client, "fetchAgent").mockResolvedValue({ agent, project: null });
    const send = vi
      .spyOn(client, "sendMessage")
      .mockResolvedValue(modern ? { deliveryStatus: "queued" } : {});
    const prepareLegacyNotification = vi.fn(async () => {});
    await expect(
      resolverFor(client, visibleCodexCaller).use(destination, (host) =>
        host.sendPrompt(
          {
            agentId: agent.id,
            prompt: "Delegate the task",
            requireParentOwnership: true,
            notifyOnFinish: true,
            prepareLegacyNotification,
          },
          {},
        ),
      ),
    ).resolves.toMatchObject({
      structuredContent: { success: true, ...(modern ? { deliveryStatus: "queued" } : {}) },
    });
    expect(prepareLegacyNotification).toHaveBeenCalledTimes(modern ? 0 : 1);
    expect(send).toHaveBeenCalledWith(
      agent.id,
      "Delegate the task",
      expect.objectContaining(
        modern ? { notifyDirectParentOnFinish: true } : { waitForDispatch: true },
      ),
    );
  },
);
