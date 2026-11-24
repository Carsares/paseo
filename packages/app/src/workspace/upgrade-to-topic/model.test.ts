import {
  PARENT_AGENT_ID_LABEL,
  WORKSPACE_MAIN_ROLE,
  WORKSPACE_ROLE_LABEL,
} from "@getpaseo/protocol/agent-labels";
import type { AgentSnapshotPayload, WorkspaceDescriptorPayload } from "@getpaseo/protocol/messages";
import { expect, it, vi } from "vitest";
import {
  canConfirmTopicUpgrade,
  canOfferTopicUpgrade,
  confirmTopicUpgrade,
  loadTopicUpgradePlan,
  type TopicUpgradeClient,
} from "./model";

const workspaceId = "history-workspace";
const topic = { mainAgentId: "second", summary: null, hideFromModel: false, revision: 1 };

it("offers the menu action only for an ordinary registered workspace", () => {
  const workspace = { id: workspaceId, workspaceDirectory: "/repo", archivingAt: null };
  const input = {
    cachedWorkspace: workspace,
    hostWorkspace: workspace,
    isConnected: true,
    supportsTopic: true,
  };
  expect(canOfferTopicUpgrade(input)).toBe(true);
  for (const hostWorkspace of [
    null,
    undefined,
    { ...workspace, topic },
    { ...workspace, internal: true },
    { ...workspace, background: true },
    { ...workspace, archivingAt: "2026-11-24T00:00:00.000Z" },
  ]) {
    expect(canOfferTopicUpgrade({ ...input, hostWorkspace })).toBe(false);
  }
  const oldHost = { ...input, supportsTopic: false, hostWorkspace: undefined };
  expect(canOfferTopicUpgrade(oldHost)).toBe(true);
  expect(canOfferTopicUpgrade({ ...input, isConnected: false, hostWorkspace: undefined })).toBe(
    true,
  );
  expect(canOfferTopicUpgrade({ ...oldHost, cachedWorkspace: { ...workspace, id: "/repo" } })).toBe(
    false,
  );
});

function agent(id: string, extra: Partial<AgentSnapshotPayload> = {}) {
  return {
    agent: {
      id,
      workspaceId,
      title: id,
      createdAt: "2026-11-24T00:00:00.000Z",
      provider: "codex",
      labels: {},
      status: "closed",
      ...extra,
    },
  };
}

function host({
  supported = true,
  permissions = ["workspace.read", "workspace.manage"],
}: { supported?: boolean; permissions?: string[] } = {}) {
  const getLastServerInfoMessage = vi.fn(() => ({
    features: { topicWorkbenchV1: supported, backgroundWorkspaces: true },
    permissions,
  }));
  const findWorkspace = vi
    .fn<(id: string) => Promise<Pick<WorkspaceDescriptorPayload, "id" | "topic"> | null>>()
    .mockResolvedValue({ id: workspaceId });
  const fetchAgentHistory = vi.fn(async ({ page }: { page: { cursor?: string } }) =>
    page.cursor
      ? {
          entries: [
            agent("second", { providerUnavailable: true }),
            agent("other", { workspaceId: "other-workspace" }),
            agent("archived", { archivedAt: "2026-11-24T00:00:00.000Z" }),
            agent("helper", { internal: true }),
          ],
          pageInfo: { nextCursor: null },
        }
      : {
          entries: [
            agent("first"),
            agent("child", { labels: { [PARENT_AGENT_ID_LABEL]: "first" } }),
          ],
          pageInfo: { nextCursor: "page-two" },
        },
  );
  const updateWorkspaceTopic = vi.fn<
    () => Promise<{ error: string | null; topic: WorkspaceDescriptorPayload["topic"] }>
  >(async () => ({ error: null, topic }));
  const client = {
    getLastServerInfoMessage,
    findWorkspace,
    fetchAgentHistory,
    updateWorkspaceTopic,
  } as unknown as TopicUpgradeClient;
  return { client, findWorkspace, fetchAgentHistory, updateWorkspaceTopic };
}

it("requires a choice across all pages and sends only the selected existing root", async () => {
  const { client, fetchAgentHistory, updateWorkspaceTopic } = host();
  const plan = await loadTopicUpgradePlan(client, workspaceId);
  expect(plan).toMatchObject({
    kind: "choose",
    candidates: [{ id: "first" }, { id: "second" }],
  });
  expect(fetchAgentHistory).toHaveBeenLastCalledWith({
    filter: { workspaceIds: [workspaceId], includeBackground: true },
    page: { limit: 200, cursor: "page-two" },
  });
  expect(canConfirmTopicUpgrade(plan, null)).toBe(false);
  expect(updateWorkspaceTopic).not.toHaveBeenCalled();
  await expect(confirmTopicUpgrade({ client, workspaceId, selectedId: "second" })).resolves.toEqual(
    {
      kind: "upgraded",
      topic,
    },
  );
  expect(updateWorkspaceTopic).toHaveBeenCalledExactlyOnceWith({
    workspaceId,
    upgradeToTopic: true,
    mainAgentId: "second",
  });
});

it("keeps the existing Main Session and asks the user to review a stale choice", async () => {
  const { client, fetchAgentHistory, updateWorkspaceTopic } = host();
  fetchAgentHistory.mockResolvedValue({
    entries: [
      agent("first"),
      agent("main", { labels: { [WORKSPACE_ROLE_LABEL]: WORKSPACE_MAIN_ROLE } }),
    ],
    pageInfo: { nextCursor: null },
  });
  await expect(
    confirmTopicUpgrade({ client, workspaceId, selectedId: "first" }),
  ).resolves.toMatchObject({
    kind: "review",
    plan: { kind: "choose", existingMainId: "main" },
  });
  expect(updateWorkspaceTopic).not.toHaveBeenCalled();
});

it("leaves an empty workspace unbound only after confirmation", async () => {
  const { client, fetchAgentHistory, updateWorkspaceTopic } = host();
  fetchAgentHistory.mockResolvedValue({ entries: [], pageInfo: { nextCursor: null } });
  await loadTopicUpgradePlan(client, workspaceId);
  expect(updateWorkspaceTopic).not.toHaveBeenCalled();
  const unbound = { ...topic, mainAgentId: null };
  updateWorkspaceTopic.mockResolvedValue({ error: null, topic: unbound });
  await expect(confirmTopicUpgrade({ client, workspaceId, selectedId: null })).resolves.toEqual({
    kind: "upgraded",
    topic: unbound,
  });
  expect(updateWorkspaceTopic).toHaveBeenCalledExactlyOnceWith({
    workspaceId,
    upgradeToTopic: true,
  });
});

it("does not read or write through unsupported or permission-limited hosts", async () => {
  for (const args of [{ supported: false }, { permissions: ["workspace.read"] }]) {
    const { client, findWorkspace, updateWorkspaceTopic } = host(args);
    await expect(
      confirmTopicUpgrade({ client, workspaceId, selectedId: "second" }),
    ).resolves.toEqual({
      kind: "review",
      plan: { kind: args.supported === false ? "unsupported" : "forbidden" },
    });
    expect(findWorkspace).not.toHaveBeenCalled();
    expect(updateWorkspaceTopic).not.toHaveBeenCalled();
  }
});

it("reconciles a lost response before another write", async () => {
  const { client, findWorkspace, updateWorkspaceTopic } = host();
  updateWorkspaceTopic.mockRejectedValueOnce(new Error("Transport not connected"));
  const input = { client, workspaceId, selectedId: "second" };
  await expect(confirmTopicUpgrade(input)).rejects.toThrow("Transport not connected");
  findWorkspace.mockResolvedValue({ id: workspaceId, topic });
  await expect(confirmTopicUpgrade(input)).resolves.toEqual({ kind: "upgraded", topic });
  expect(updateWorkspaceTopic).toHaveBeenCalledTimes(1);
});
