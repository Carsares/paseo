import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { transformFileSync } from "@babel/core";
import { expect, test } from "vitest";
import * as draftKeys from "./draft-keys";
import type * as StoreModule from "./workspace-draft-submission-store";

function createStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: async (key: string) => values.get(key) ?? null,
    setItem: async (key: string, value: string) => void values.set(key, value),
    removeItem: async (key: string) => void values.delete(key),
  };
}

// Exercise the emitted app code: plain TypeScript execution misses Expo's omit bug.
function loadProductionStores() {
  const filename = fileURLToPath(new URL("./workspace-draft-submission-store.ts", import.meta.url));
  const caller = { name: "metro", platform: "web", isDev: false, supportsStaticESM: false };
  const result = transformFileSync(filename, {
    cwd: fileURLToPath(new URL("../../", import.meta.url)),
    envName: "production",
    caller,
  });
  if (!result?.code) throw new Error("Expo produced no store code");
  const module = {
    exports: {} as typeof StoreModule,
  };
  const require = createRequire(import.meta.url);
  const asyncStorage = createStorage();
  new Function("require", "module", "exports", result.code)(
    (id: string) => {
      if (id === "@react-native-async-storage/async-storage") return asyncStorage;
      if (id === "./draft-keys") return draftKeys;
      return require(id);
    },
    module,
    module.exports,
  );
  return module.exports;
}

test("the production app consumes a draft once and leaves other drafts pending", () => {
  const { useWorkspaceDraftSubmissionStore: store } = loadProductionStores();
  const submission = {
    serverId: "server",
    workspaceId: "workspace",
    draftId: "draft-1",
    text: "hello",
    attachments: [],
    cwd: "/repo",
    provider: "codex",
    clientMessageId: "message",
    timestamp: 1,
  } as const;
  store.getState().setPending({ ...submission, attachments: [] });
  store.getState().setPending({ ...submission, attachments: [], draftId: "draft-2" });
  expect(store.getState().consumePending({ ...submission, workspaceId: "wrong" })).toBeNull();
  expect(store.getState().consumePending(submission)).toEqual(submission);
  expect(store.getState().consumePending(submission)).toBeNull();
  expect(Object.keys(store.getState().pendingByDraftId)).toEqual(["draft-2"]);
});

test("a new process restores a fork's host and boundary without replaying pending work", async () => {
  const storage = createStorage();
  const { createWorkspaceDraftSubmissionStore } = loadProductionStores();
  const writer = createWorkspaceDraftSubmissionStore(storage);
  const fork = {
    draftId: "draft-fork",
    sourceServerId: "host-1",
    sourceDirectory: "/repo",
    setup: {
      provider: "codex",
      cwd: "/repo/worktree",
      model: "model",
      modeId: null,
      thinkingOptionId: null,
      providerOptions: { approvals: "on-request" },
      forkFrom: {
        sourceAgentId: "source",
        boundaryMessageId: "message-1",
        boundaryCursor: { epoch: "epoch-1", seq: 7 },
      },
    },
  };
  await writer.getState().saveForkDraftSetup(fork);
  const secondWriter = createWorkspaceDraftSubmissionStore(storage);
  await secondWriter.getState().saveForkDraftSetup({
    ...fork,
    draftId: "draft-other",
    sourceServerId: "host-2",
  });
  writer.getState().setDraftSetup({
    draftId: "legacy",
    setup: { ...fork.setup, forkFrom: undefined },
  });
  writer.getState().setPending({
    serverId: "host-1",
    workspaceId: "workspace",
    draftId: fork.draftId,
    text: "Pending creation",
    attachments: [],
    cwd: "/repo",
    provider: "codex",
    clientMessageId: "pending-message",
    timestamp: 1,
    agentCreation: { result: new Promise(() => {}) },
  });

  const reader = createWorkspaceDraftSubmissionStore(storage);
  await reader.getState().hydrateDraftSetup(fork.draftId);
  expect(reader.getState().setupByDraftId).toEqual({
    "draft-fork": { setup: fork.setup, sourceDirectory: "/repo" },
  });
  expect(reader.getState().draftSetupStatusById).toEqual({
    "draft-fork": { sourceServerId: "host-1" },
  });
  expect(reader.getState().pendingByDraftId).toEqual({});

  const submission = {
    source: {
      kind: "worktree",
      cwd: "/repo",
      projectId: "project-1",
      worktreeSlug: "first-worktree",
      action: "branch-off",
      refName: "refs/heads/selected-base",
      branchName: "named-fork",
    },
    baseItem: {
      kind: "branch",
      refName: "refs/heads/selected-base",
      name: "selected-base",
      accessibilityLabel: "selected-base, local branch",
    },
    metadata: { issue: "PAS-101" },
  } satisfies StoreModule.ForkWorktreeSubmission;
  await expect(
    reader.getState().recordForkSubmission({
      draftId: fork.draftId,
      serverId: "host-2",
      worktree: { ...submission, source: { ...submission.source, worktreeSlug: "wrong-host" } },
    }),
  ).rejects.toThrow("The Fork draft is not available on this host.");
  const setup = reader.getState().setupByDraftId[fork.draftId];
  await expect(
    reader.getState().recordForkSubmission({
      draftId: fork.draftId,
      serverId: fork.sourceServerId,
      worktree: submission,
    }),
  ).resolves.toBe("first-worktree");
  expect(reader.getState().setupByDraftId[fork.draftId]).toBe(setup);

  const reloaded = createWorkspaceDraftSubmissionStore(storage);
  await reloaded.getState().hydrateDraftSetup(fork.draftId);
  expect(reloaded.getState().draftSetupStatusById[fork.draftId]).toEqual({
    sourceServerId: "host-1",
    worktreeSlug: "first-worktree",
    worktreeSubmission: submission,
  });
  await expect(
    reloaded.getState().recordForkSubmission({
      draftId: fork.draftId,
      serverId: fork.sourceServerId,
      worktree: {
        ...submission,
        source: {
          ...submission.source,
          worktreeSlug: "newly-generated-after-reload",
          branchName: "edited-fork",
        },
      },
    }),
  ).resolves.toBe("first-worktree");

  const afterEdit = createWorkspaceDraftSubmissionStore(storage);
  await afterEdit.getState().hydrateDraftSetup(fork.draftId);
  expect(afterEdit.getState().draftSetupStatusById[fork.draftId]).toEqual({
    sourceServerId: "host-1",
    worktreeSlug: "first-worktree",
    worktreeSubmission: submission,
  });

  // A destination workspace can finish in another process without loading /new.
  const destination = createWorkspaceDraftSubmissionStore(storage);
  await destination.getState().clearDraftSetup({ draftId: fork.draftId });
  const afterConsumption = createWorkspaceDraftSubmissionStore(storage);
  for (const id of [fork.draftId, "legacy", "draft-other"]) {
    await afterConsumption.getState().hydrateDraftSetup(id);
  }
  expect(afterConsumption.getState().setupByDraftId).toEqual({
    "draft-other": { setup: fork.setup, sourceDirectory: "/repo" },
  });
  expect(afterConsumption.getState().draftSetupStatusById["draft-other"]).toEqual({
    sourceServerId: "host-2",
  });
});

test.each([false, true])(
  "recovers the first worktree agent settings and main intent (%s)",
  async (createMainAgent) => {
    const storage = createStorage();
    const { createWorkspaceDraftSubmissionStore } = loadProductionStores();
    const writer = createWorkspaceDraftSubmissionStore(storage);
    const draftId = "submitted-fork";
    const sourceServerId = "fork-host";
    const forkSetup = {
      provider: "codex",
      cwd: "/source",
      modeId: "source-mode",
      model: "source-model",
      thinkingOptionId: null,
      providerOptions: { feature: false },
      forkFrom: { sourceAgentId: "source-agent", boundaryMessageId: "source-message" },
    };
    await writer.getState().saveForkDraftSetup({
      draftId,
      sourceServerId,
      sourceDirectory: "/source",
      setup: forkSetup,
    });

    const submission = {
      source: {
        kind: "worktree",
        cwd: "/source",
        projectId: "project",
        worktreeSlug: "reserved-worktree",
      },
      baseItem: null,
      metadata: {},
      agentIntent: {
        config: {
          provider: "codex",
          cwd: "/source",
          model: "submitted-model",
          thinkingOptionId: "high",
          providerOptions: { feature: true, nested: { value: ["some-setting"] } },
        },
        createMainAgent,
      },
    } satisfies StoreModule.ForkWorktreeSubmission;
    await writer
      .getState()
      .recordForkSubmission({ draftId, serverId: sourceServerId, worktree: submission });

    const reader = createWorkspaceDraftSubmissionStore(storage);
    await reader.getState().hydrateDraftSetup(draftId);
    await expect(
      reader.getState().recordForkSubmission({
        draftId,
        serverId: sourceServerId,
        worktree: {
          ...submission,
          agentIntent: {
            config: { provider: "claude", cwd: "/source", model: "edited-model" },
            createMainAgent: !createMainAgent,
          },
        },
      }),
    ).resolves.toBe("reserved-worktree");
    const retry = createWorkspaceDraftSubmissionStore(storage);
    await retry.getState().hydrateDraftSetup(draftId);
    expect(retry.getState().setupByDraftId[draftId]?.setup).toEqual(forkSetup);
    expect(retry.getState().draftSetupStatusById[draftId]).toEqual({
      sourceServerId,
      worktreeSlug: "reserved-worktree",
      worktreeSubmission: submission,
    });
  },
);

test("keeps the Local Fork intent when a later attempt selects a worktree", async () => {
  const storage = createStorage();
  const { createWorkspaceDraftSubmissionStore } = loadProductionStores();
  const draftId = "local-fork";
  const serverId = "fork-host";
  const writer = createWorkspaceDraftSubmissionStore(storage);
  await writer.getState().saveForkDraftSetup({
    draftId,
    sourceServerId: serverId,
    sourceDirectory: "/repo",
    setup: {
      provider: "codex",
      cwd: "/repo",
      model: "source-model",
      modeId: null,
      thinkingOptionId: null,
      providerOptions: {},
      forkFrom: { sourceAgentId: "agent", boundaryMessageId: "message" },
    },
  });
  const original = {
    config: { provider: "codex", cwd: "/repo", model: "local-model" },
    createMainAgent: false,
  };
  await writer.getState().recordForkSubmission({ draftId, serverId, agentIntent: original });

  const reader = createWorkspaceDraftSubmissionStore(storage);
  await reader.getState().hydrateDraftSetup(draftId);
  await expect(
    reader.getState().recordForkSubmission({
      draftId,
      serverId,
      worktree: {
        source: {
          kind: "worktree",
          cwd: "/repo",
          projectId: "project",
          worktreeSlug: "edited-worktree",
        },
        baseItem: null,
        metadata: {},
      },
      agentIntent: { config: { ...original.config, model: "edited-model" }, createMainAgent: true },
    }),
  ).resolves.toBe("edited-worktree");
  const reloaded = createWorkspaceDraftSubmissionStore(storage);
  await reloaded.getState().hydrateDraftSetup(draftId);
  expect(reloaded.getState().draftSetupStatusById[draftId]).toEqual({
    sourceServerId: serverId,
    agentIntent: original,
  });
});

const newDraft = { createWorktreeSlug: () => "first-worktree" };

test.each([
  { entered: "  Release 🚀  ", expected: "Release 🚀" },
  { entered: "   ", expected: "" },
])("restores the editor and first submitted title '$expected'", async ({ entered, expected }) => {
  const storage = createStorage();
  const { createWorkspaceDraftSubmissionStore } = loadProductionStores();
  const writer = createWorkspaceDraftSubmissionStore(storage).getState();
  const id = await writer.openDraftTitle(newDraft);
  await writer.editDraftTitle(id, entered);

  const restore = { creationDraftId: id, createWorktreeSlug: () => "different-worktree" };
  const reader = createWorkspaceDraftSubmissionStore(storage);
  expect(await reader.getState().openDraftTitle(restore)).toBe(id);
  expect(reader.getState().titlesById[id]).toEqual({
    draftId: id,
    worktreeSlug: "first-worktree",
    title: expected,
    submitted: false,
  });
  await expect(reader.getState().submitDraftTitle(id)).resolves.toBe(expected);
  await reader.getState().editDraftTitle(id, "later");
  const retry = createWorkspaceDraftSubmissionStore(storage);
  await retry.getState().openDraftTitle(restore);
  expect(retry.getState().titlesById[id]).toMatchObject({ title: expected, submitted: true });
  await expect(retry.getState().submitDraftTitle(id)).resolves.toBe(expected);
});

test("independent /new tabs sharing disk own distinct titles, request identities and lifetimes", async () => {
  const storage = createStorage();
  const { createWorkspaceDraftSubmissionStore } = loadProductionStores();
  const first = createWorkspaceDraftSubmissionStore(storage).getState();
  const second = createWorkspaceDraftSubmissionStore(storage);
  const [a, b] = await Promise.all([
    first.openDraftTitle(newDraft),
    second.getState().openDraftTitle({ createWorktreeSlug: () => "second-worktree" }),
  ]);
  expect(a).not.toBe(b);
  await first.editDraftTitle(a, "first");
  await first.submitDraftTitle(a);
  await second.getState().editDraftTitle(b, "second");
  expect(second.getState().titlesById[b]).toEqual({
    draftId: b,
    worktreeSlug: "second-worktree",
    title: "second",
    submitted: false,
  });
  const reloaded = createWorkspaceDraftSubmissionStore(storage).getState();
  expect(await reloaded.openDraftTitle({ ...newDraft, creationDraftId: b })).toBe(b);
  await first.finishDraftTitle(a);
  await expect(reloaded.submitDraftTitle(b)).resolves.toBe("second");
  const next = await first.openDraftTitle({ ...newDraft, creationDraftId: a });
  expect(next).not.toBe(a);
  await expect(first.submitDraftTitle(next)).resolves.toBe("");
});

test("a delayed blur write finishes before concurrent submissions freeze the title", async () => {
  const storage = createStorage();
  let release!: () => void;
  const write = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { createWorkspaceDraftSubmissionStore } = loadProductionStores();
  let delay = false;
  const store = createWorkspaceDraftSubmissionStore({
    ...storage,
    setItem: async (key, value) => {
      if (delay) await write;
      await storage.setItem(key, value);
    },
  });
  const { openDraftTitle, editDraftTitle, submitDraftTitle } = store.getState();
  const id = await openDraftTitle(newDraft);
  delay = true;
  const edit = editDraftTitle(id, "blurred");
  const first = submitDraftTitle(id);
  const lateEdit = editDraftTitle(id, "too late");
  const second = submitDraftTitle(id);
  release();
  await Promise.all([edit, lateEdit]);
  await expect(Promise.all([first, second])).resolves.toEqual(["blurred", "blurred"]);
  expect(store.getState().titlesById[id]).toMatchObject({ title: "blurred", submitted: true });
});

test("a failed snapshot write allows a retry and does not freeze the draft", async () => {
  const storage = createStorage();
  const { createWorkspaceDraftSubmissionStore } = loadProductionStores();
  let fail = false;
  const store = createWorkspaceDraftSubmissionStore({
    ...storage,
    setItem: async (key, value) => {
      if (fail) throw new Error("write failed");
      await storage.setItem(key, value);
    },
  });
  const id = await store.getState().openDraftTitle(newDraft);
  fail = true;
  await expect(store.getState().submitDraftTitle(id)).rejects.toThrow("write failed");
  expect(store.getState().titlesById[id]?.submitted).toBe(false);
  fail = false;
  await store.getState().editDraftTitle(id, "retry");
  await expect(store.getState().submitDraftTitle(id)).resolves.toBe("retry");
});

test("a stale window opened on the same draft restores the accepted title", async () => {
  const storage = createStorage();
  const { createWorkspaceDraftSubmissionStore } = loadProductionStores();
  const writer = createWorkspaceDraftSubmissionStore(storage).getState();
  const stale = createWorkspaceDraftSubmissionStore(storage).getState();
  const id = await writer.openDraftTitle(newDraft);
  await stale.openDraftTitle({ ...newDraft, creationDraftId: id });
  await writer.editDraftTitle(id, "accepted");
  await writer.submitDraftTitle(id);
  await stale.editDraftTitle(id, "too late");
  await expect(stale.submitDraftTitle(id)).resolves.toBe("accepted");
});

test("a Fork already submitted by an older client retries without a title", async () => {
  const { createWorkspaceDraftSubmissionStore } = loadProductionStores();
  const store = createWorkspaceDraftSubmissionStore(createStorage());
  const id = "old-fork";
  store.setState({
    draftSetupStatusById: { [id]: { sourceServerId: "fork-host", worktreeSlug: "old-slug" } },
  });
  expect(await store.getState().openDraftTitle({ ...newDraft, forkDraftId: id })).toBe(id);
  await store.getState().editDraftTitle(id, "not in original request");
  await expect(store.getState().submitDraftTitle(id)).resolves.toBe("");
});

test.each([undefined, "explicit"])(
  "destination success cleans title %j after a reload",
  async (forkDraftId) => {
    const storage = createStorage();
    const { createWorkspaceDraftSubmissionStore } = loadProductionStores();
    const writer = createWorkspaceDraftSubmissionStore(storage).getState();
    const id = await writer.openDraftTitle({ ...newDraft, forkDraftId });
    await writer.editDraftTitle(id, "submitted");
    await writer.submitDraftTitle(id);
    const destination = createWorkspaceDraftSubmissionStore(storage).getState();
    await destination.clearDraftSetup({ draftId: id });
    const reader = createWorkspaceDraftSubmissionStore(storage);
    const reopened = await reader
      .getState()
      .openDraftTitle({ ...newDraft, forkDraftId, creationDraftId: id });
    expect(reader.getState().titlesById[reopened]).toMatchObject({ title: "", submitted: false });
    if (!forkDraftId) expect(reopened).not.toBe(id);
  },
);
