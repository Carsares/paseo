import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { transformFileSync } from "@babel/core";
import { expect, test } from "vitest";
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
    (id: string) =>
      id === "@react-native-async-storage/async-storage" ? asyncStorage : require(id),
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
