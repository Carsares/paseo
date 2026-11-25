import { describe, expect, it } from "vitest";
import type { TFunction } from "i18next";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import { resolveActiveTopicCompletedAt } from "@/stores/sidebar-topic-completion-store";
import {
  buildTopicGroups,
  buildWorkspaceTopicFacts,
  deriveTopicStatusClassification,
  type TopicWorkspaceFacts,
} from "./sidebar-topic-view-model";

const t = ((key: string) => key) as unknown as TFunction;

function makeEntry(
  id: string,
  overrides: Partial<SidebarWorkspaceEntry> = {},
): SidebarWorkspaceEntry {
  return {
    workspaceKey: `srv:${id}`,
    workspaceId: id,
    serverId: "srv",
    projectViewKey: "srv:proj-1",
    projectName: "Paseo",
    projectRootPath: "/repo",
    workspaceDirectory: "/repo",
    workspaceDirectoryLabel: "/repo",
    projectKind: "git",
    workspaceKind: "local_checkout",
    name: id,
    title: id,
    pinnedAt: null,
    labels: [],
    currentBranch: "main",
    statusBucket: "done",
    statusEnteredAt: new Date("2026-11-25T08:00:00.000Z"),
    archivingAt: null,
    diffStat: null,
    prHint: null,
    archiveHasUncommittedChanges: null,
    archiveUnpushedCommitCount: null,
    scripts: [],
    hasRunningScripts: false,
    ...overrides,
  };
}

function makeFacts(overrides: Partial<TopicWorkspaceFacts> = {}): TopicWorkspaceFacts {
  return {
    isTopic: true,
    setupStatus: null,
    createdAt: new Date("2026-11-25T07:00:00.000Z"),
    lastUserMessageAt: new Date("2026-11-25T07:30:00.000Z"),
    completedAt: null,
    pendingDurableCount: 0,
    hasSubagentPendingPermission: false,
    hasActiveWorkspaceAgent: false,
    ...overrides,
  };
}

describe("sidebar-topic-view-model", () => {
  it("classifies approvals, subagent permissions, errors, unread conclusions, and fresh quiet topics into pending_action", () => {
    expect(
      deriveTopicStatusClassification(
        makeEntry("perm", { statusBucket: "done" }),
        makeFacts({ hasSubagentPendingPermission: true }),
      ),
    ).toMatchObject({ bucket: "pending_action", pendingReason: "approval" });

    expect(
      deriveTopicStatusClassification(
        makeEntry("durable", { statusBucket: "running" }),
        makeFacts({ pendingDurableCount: 2 }),
      ),
    ).toMatchObject({ bucket: "pending_action", pendingReason: "approval" });

    expect(
      deriveTopicStatusClassification(
        makeEntry("setup-blocked", { statusBucket: "done" }),
        makeFacts({ setupStatus: "blocked" }),
      ),
    ).toMatchObject({ bucket: "pending_action", pendingReason: "failed" });

    expect(
      deriveTopicStatusClassification(
        makeEntry("unread", { statusBucket: "attention" }),
        makeFacts(),
      ),
    ).toMatchObject({ bucket: "pending_action", pendingReason: "unread_conclusion" });

    expect(
      deriveTopicStatusClassification(
        makeEntry("quiet", { statusBucket: "done" }),
        makeFacts({ lastUserMessageAt: null }),
      ),
    ).toMatchObject({ bucket: "pending_action", pendingReason: "awaiting_first_prompt" });
  });

  it("keeps started idle topics in in_progress until explicitly marked completed, and reactivates on newer prompt", () => {
    const entry = makeEntry("active-topic", { statusBucket: "done" });
    expect(deriveTopicStatusClassification(entry, makeFacts())).toMatchObject({
      bucket: "in_progress",
      isActivelyWorking: false,
    });

    const completedFacts = buildWorkspaceTopicFacts({
      workspace: {
        id: "active-topic",
        topic: { summary: "Design", hideFromModel: false, revision: 1 },
        createdAt: new Date("2026-11-25T07:00:00.000Z"),
        lastUserMessageAt: new Date("2026-11-25T07:30:00.000Z"),
      } as never,
      workspaceAgents: [],
      completedAtIso: "2026-11-25T08:00:00.000Z",
      pendingDurableCount: 0,
    });
    expect(deriveTopicStatusClassification(entry, completedFacts).bucket).toBe("completed");

    // Only work/approval signals strictly newer than completedAtIso clear active completion
    expect(
      resolveActiveTopicCompletedAt({
        completedAtIso: "2026-11-25T08:00:00.000Z",
        latestReactivationAtMs: Date.parse("2026-11-25T08:05:00.000Z"),
      }),
    ).toBeNull();
    expect(
      resolveActiveTopicCompletedAt({
        completedAtIso: "2026-11-25T08:00:00.000Z",
        latestReactivationAtMs: Date.parse("2026-11-25T07:59:00.000Z"),
      }),
    ).toEqual(new Date("2026-11-25T08:00:00.000Z"));

    // Clearing an old unread conclusion (status === "done", statusEnteredAt > completedAt) must NOT reopen
    const doneAfterAttentionClear = buildWorkspaceTopicFacts({
      workspace: {
        id: "active-topic",
        status: "done",
        statusEnteredAt: new Date("2026-11-25T08:10:00.000Z"),
        topic: { summary: "Design", hideFromModel: false, revision: 1 },
        createdAt: new Date("2026-11-25T07:00:00.000Z"),
        lastUserMessageAt: new Date("2026-11-25T07:30:00.000Z"),
      } as never,
      workspaceAgents: [],
      completedAtIso: "2026-11-25T08:00:00.000Z",
      pendingDurableCount: 0,
    });
    expect(doneAfterAttentionClear.completedAt).toEqual(new Date("2026-11-25T08:00:00.000Z"));

    // Marking a topic with an older unread conclusion completed immediately moves it to completed
    const attentionEntry = makeEntry("unread-topic", {
      statusBucket: "attention",
      statusEnteredAt: new Date("2026-11-25T07:50:00.000Z"),
    });
    const completedOverOldAttention = buildWorkspaceTopicFacts({
      workspace: {
        id: "unread-topic",
        status: "attention",
        statusEnteredAt: new Date("2026-11-25T07:50:00.000Z"),
        topic: { summary: "Design", hideFromModel: false, revision: 1 },
        createdAt: new Date("2026-11-25T07:00:00.000Z"),
        lastUserMessageAt: new Date("2026-11-25T07:30:00.000Z"),
      } as never,
      workspaceAgents: [],
      completedAtIso: "2026-11-25T08:00:00.000Z",
      pendingDurableCount: 0,
    });
    expect(deriveTopicStatusClassification(attentionEntry, completedOverOldAttention).bucket).toBe(
      "completed",
    );

    // Persisted lastWorkAtIso recorded while host was filtered out invalidates older completedAtIso
    const reopenedByRecordedWork = buildWorkspaceTopicFacts({
      workspace: {
        id: "unread-topic",
        status: "done",
        statusEnteredAt: new Date("2026-11-25T08:12:00.000Z"),
        topic: { summary: "Design", hideFromModel: false, revision: 1 },
        createdAt: new Date("2026-11-25T07:00:00.000Z"),
        lastUserMessageAt: new Date("2026-11-25T07:30:00.000Z"),
      } as never,
      workspaceAgents: [],
      completedAtIso: "2026-11-25T08:00:00.000Z",
      lastWorkAtIso: "2026-11-25T08:10:00.000Z",
      pendingDurableCount: 0,
    });
    expect(reopenedByRecordedWork.completedAt).toBeNull();
  });

  it("orders topic groups as pending_action -> in_progress -> completed and ranks urgency within groups", () => {
    const doneTopic = makeEntry("t-completed");
    const idleInProgress = makeEntry("t-idle-progress");
    const runningTopic = makeEntry("t-running", { statusBucket: "running" });
    const quietNew = makeEntry("t-quiet");
    const unreadConclusion = makeEntry("t-unread", { statusBucket: "attention" });
    const needsApproval = makeEntry("t-approval", { statusBucket: "needs_input" });

    const facts = new Map<string, TopicWorkspaceFacts>([
      [doneTopic.workspaceKey, makeFacts({ completedAt: new Date("2026-11-25T09:00:00.000Z") })],
      [
        idleInProgress.workspaceKey,
        makeFacts({ lastUserMessageAt: new Date("2026-11-25T09:10:00.000Z") }),
      ],
      [
        runningTopic.workspaceKey,
        makeFacts({ lastUserMessageAt: new Date("2026-11-25T08:10:00.000Z") }),
      ],
      [quietNew.workspaceKey, makeFacts({ lastUserMessageAt: null })],
      [unreadConclusion.workspaceKey, makeFacts()],
      [needsApproval.workspaceKey, makeFacts()],
    ]);

    const groups = buildTopicGroups({
      workspaces: [
        doneTopic,
        idleInProgress,
        quietNew,
        runningTopic,
        unreadConclusion,
        needsApproval,
      ],
      factsByWorkspaceKey: facts,
      projectNamesByViewKey: new Map([["srv:proj-1", "Paseo"]]),
      workspaceSort: "lastPrompt",
      t,
    });

    expect(groups.map((group) => group.bucket)).toEqual([
      "pending_action",
      "in_progress",
      "completed",
    ]);
    expect(groups[0]?.rows.map((row) => row.workspaceId)).toEqual([
      "t-approval",
      "t-unread",
      "t-quiet",
    ]);
    expect(groups[1]?.rows.map((row) => row.workspaceId)).toEqual(["t-running", "t-idle-progress"]);
    expect(groups[2]?.rows.map((row) => row.workspaceId)).toEqual(["t-completed"]);
  });
});
