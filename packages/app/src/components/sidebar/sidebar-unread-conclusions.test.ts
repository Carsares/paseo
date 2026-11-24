import { describe, expect, it } from "vitest";
import type { Agent, WorkspaceDescriptor } from "@/stores/session-store";
import {
  areSidebarAttentionItemsEqual,
  selectSidebarUnreadConclusions,
  type SidebarAttentionItem,
  type SidebarAttentionSession,
} from "./sidebar-unread-conclusions";

function agent(overrides: Partial<Agent> & { id: string }): Agent {
  return {
    status: "idle",
    title: null,
    workspaceId: "ws-1",
    parentAgentId: null,
    archivedAt: null,
    background: false,
    requiresAttention: true,
    attentionReason: "finished",
    attentionTimestamp: new Date("2026-01-01T00:00:10Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  } as Agent;
}

function workspace(overrides: Partial<WorkspaceDescriptor> & { id: string }): WorkspaceDescriptor {
  return {
    projectDisplayName: "Paseo",
    projectCustomName: null,
    name: `Workspace ${overrides.id}`,
    title: null,
    archivingAt: null,
    ...overrides,
  } as WorkspaceDescriptor;
}

function session(
  agents: Agent[],
  workspaces: WorkspaceDescriptor[] = [workspace({ id: "ws-1" })],
): SidebarAttentionSession {
  return {
    agents: new Map(agents.map((entry) => [entry.id, entry])),
    workspaces: new Map(workspaces.map((entry) => [entry.id, entry])),
  };
}

function ids(sessions: Record<string, SidebarAttentionSession>): string[] {
  return selectSidebarUnreadConclusions(sessions).map((item) => `${item.serverId}/${item.agentId}`);
}

describe("selectSidebarUnreadConclusions", () => {
  it("collects finished root conversations from every host", () => {
    const sessions = {
      "host-a": session([agent({ id: "a1", title: "Fix login" })]),
      "host-b": session([agent({ id: "b1", title: "Add export" })]),
    };

    const items = selectSidebarUnreadConclusions(sessions);

    expect(items.map((item) => item.serverId).sort()).toEqual(["host-a", "host-b"]);
    expect(items.find((item) => item.serverId === "host-a")).toMatchObject({
      kind: "finished",
      agentId: "a1",
      workspaceId: "ws-1",
      workspaceKey: "host-a:ws-1",
      title: "Fix login",
      workspaceName: "Workspace ws-1",
      projectName: "Paseo",
    });
  });

  it("keeps only unread finished conversations", () => {
    const sessions = {
      host: session([
        agent({ id: "finished" }),
        agent({ id: "read", requiresAttention: false }),
        agent({ id: "error", attentionReason: "error" }),
        agent({ id: "permission", attentionReason: "permission" }),
        agent({ id: "no-reason", attentionReason: null }),
      ]),
    };

    expect(ids(sessions)).toEqual(["host/finished"]);
  });

  it("keeps only workspace root conversations", () => {
    const sessions = {
      host: session([
        agent({ id: "root" }),
        agent({ id: "child", parentAgentId: "root" }),
        agent({ id: "orphan-child", parentAgentId: "missing" }),
        // A subagent moved to another workspace is that workspace's root.
        agent({ id: "moved", parentAgentId: "root", workspaceId: "ws-2" }),
      ]),
    };
    sessions.host.workspaces.set("ws-2", workspace({ id: "ws-2" }));

    expect(ids(sessions).sort()).toEqual(["host/moved", "host/root"]);
  });

  it("excludes background, archived, and missing, archiving, or background workspaces", () => {
    const sessions = {
      host: session(
        [
          agent({ id: "ok" }),
          agent({ id: "background", background: true }),
          agent({ id: "archived", archivedAt: new Date() }),
          agent({ id: "no-workspace", workspaceId: "ws-missing" }),
          agent({ id: "archiving", workspaceId: "ws-archiving" }),
          agent({ id: "bg-workspace", workspaceId: "ws-bg" }),
        ],
        [
          workspace({ id: "ws-1" }),
          workspace({ id: "ws-archiving", archivingAt: "2026-01-01T00:00:00Z" }),
          workspace({ id: "ws-bg", background: true }),
        ],
      ),
    };

    expect(ids(sessions)).toEqual(["host/ok"]);
  });

  describe("dispatch transitions", () => {
    it.each(["running", "initializing"] as const)(
      "skips a conversation with a %s subagent",
      (status) => {
        const sessions = {
          host: session([
            agent({ id: "root" }),
            agent({ id: "child", parentAgentId: "root", status, requiresAttention: false }),
            agent({ id: "other" }),
          ]),
        };

        expect(ids(sessions)).toEqual(["host/other"]);
      },
    );

    it("skips a conversation whose grandchild is still working", () => {
      const sessions = {
        host: session([
          agent({ id: "root" }),
          agent({ id: "child", parentAgentId: "root", requiresAttention: false }),
          agent({
            id: "grandchild",
            parentAgentId: "child",
            status: "running",
            requiresAttention: false,
          }),
        ]),
      };

      expect(ids(sessions)).toEqual([]);
    });

    it("ignores archived subagents and idle subagents", () => {
      const sessions = {
        host: session([
          agent({ id: "root" }),
          agent({
            id: "archived-child",
            parentAgentId: "root",
            status: "running",
            archivedAt: new Date(),
            requiresAttention: false,
          }),
          agent({ id: "idle-child", parentAgentId: "root", requiresAttention: false }),
        ]),
      };

      expect(ids(sessions)).toEqual(["host/root"]);
    });

    it("skips a conversation with running background work", () => {
      const sessions = {
        host: session([
          agent({ id: "busy", backgroundWork: { count: 2, runningCount: 1 } }),
          agent({ id: "busy-by-count", backgroundWork: { count: 1 } }),
          agent({ id: "settled", backgroundWork: { count: 3, runningCount: 0 } }),
          agent({ id: "none", backgroundWork: { count: 0 } }),
        ]),
      };

      expect(ids(sessions).sort()).toEqual(["host/none", "host/settled"]);
    });

    it("skips a conversation with unsummarized subagent reports", () => {
      const sessions = {
        host: session([
          agent({
            id: "pending",
            pendingSubagentInbox: { count: 1, items: [] },
          }),
          agent({
            id: "drained",
            pendingSubagentInbox: { count: 0, items: [] },
          }),
        ]),
      };

      expect(ids(sessions)).toEqual(["host/drained"]);
    });

    it.each(["running", "initializing"] as const)(
      "skips a parent whose remote %s subagent on another host is still active",
      (status) => {
        const sessions = {
          "host-parent": session([agent({ id: "root" })]),
          "host-remote": session(
            [
              agent({
                id: "remote-child",
                workspaceId: "ws-remote",
                parentAgentId: null,
                status,
                requiresAttention: false,
                labels: {
                  "paseo.parent-agent-id": "root",
                  "paseo.parent-server-id": "host-parent",
                },
              }),
            ],
            [workspace({ id: "ws-remote" })],
          ),
        };

        expect(ids(sessions)).toEqual([]);
      },
    );

    it("does not surface a finished remote subagent as its own root and allows parent once remote child settles", () => {
      const sessions = {
        "host-parent": session([agent({ id: "root" })]),
        "host-remote": session(
          [
            agent({
              id: "remote-child",
              workspaceId: "ws-remote",
              parentAgentId: null,
              status: "idle",
              requiresAttention: true,
              attentionReason: "finished",
              labels: {
                "paseo.parent-agent-id": "root",
                "paseo.parent-server-id": "host-parent",
              },
            }),
          ],
          [workspace({ id: "ws-remote" })],
        ),
      };

      expect(ids(sessions)).toEqual(["host-parent/root"]);
    });
  });

  describe("ordering and titles", () => {
    it("sorts newest first by attention time, falling back to updatedAt", () => {
      const sessions = {
        host: session([
          agent({ id: "old", attentionTimestamp: new Date("2026-01-01T00:00:01Z") }),
          agent({ id: "new", attentionTimestamp: new Date("2026-01-01T00:00:30Z") }),
          agent({
            id: "fallback",
            attentionTimestamp: null,
            updatedAt: new Date("2026-01-01T00:00:20Z"),
          }),
        ]),
      };

      expect(ids(sessions)).toEqual(["host/new", "host/fallback", "host/old"]);
    });

    it("breaks timestamp ties with a stable key", () => {
      const at = new Date("2026-01-01T00:00:10Z");
      const sessions = {
        "host-b": session([agent({ id: "x", attentionTimestamp: at })]),
        "host-a": session([
          agent({ id: "z", attentionTimestamp: at }),
          agent({ id: "y", attentionTimestamp: at }),
        ]),
      };

      expect(ids(sessions)).toEqual(["host-a/y", "host-a/z", "host-b/x"]);
    });

    it("falls back from the agent title to the workspace title, then name", () => {
      const sessions = {
        host: session(
          [
            agent({ id: "titled", title: "  Fix login  " }),
            agent({ id: "blank", title: "   ", workspaceId: "ws-titled" }),
            agent({ id: "null-title", workspaceId: "ws-named" }),
          ],
          [
            workspace({ id: "ws-1" }),
            workspace({ id: "ws-titled", title: "Release prep" }),
            workspace({ id: "ws-named", name: "feature-x", projectCustomName: "Custom" }),
          ],
        ),
      };

      const byId = new Map<string, SidebarAttentionItem>();
      for (const item of selectSidebarUnreadConclusions(sessions)) byId.set(item.agentId, item);

      expect(byId.get("titled")?.title).toBe("Fix login");
      expect(byId.get("blank")?.title).toBe("Release prep");
      expect(byId.get("null-title")).toMatchObject({
        title: "feature-x",
        workspaceName: "feature-x",
        projectName: "Custom",
      });
    });
  });

  it("compares item lists by content", () => {
    const sessions = { host: session([agent({ id: "a" })]) };
    const first = selectSidebarUnreadConclusions(sessions);
    const second = selectSidebarUnreadConclusions(sessions);

    expect(first).not.toBe(second);
    expect(areSidebarAttentionItemsEqual(first, second)).toBe(true);
    expect(
      areSidebarAttentionItemsEqual(first, [
        { ...first[0]!, timestampMs: first[0]!.timestampMs + 1 },
      ]),
    ).toBe(false);
  });
});
