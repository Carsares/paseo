import { describe, expect, it, vi } from "vitest";
import type { ComposerAttachment } from "@/attachments/types";
import type { MessagePayload } from "@/composer/types";
import {
  WorkspaceCreateRequestSchema,
  AgentSnapshotPayloadSchema,
  type CreationSnapshot,
  type WorkspaceDescriptorPayload,
} from "@getpaseo/protocol/messages";
import { WORKSPACE_MAIN_ROLE, WORKSPACE_ROLE_LABEL } from "@getpaseo/protocol/agent-labels";
import { encodeImages } from "@/utils/encode-images";
import { submitAgentInput } from "@/composer/submit";
import { createOrRetryWorkspaceMain } from "./new-workspace/create-explicit-main";
import {
  readMainDraft,
  restoreMainDraftAtTarget,
  writeMainDraft,
  type MainDraftTarget,
} from "./new-workspace/main-draft";

vi.mock("@/attachments/store", () => ({
  getAttachmentStore: async () => ({
    async encodeBase64({ attachment }: { attachment: { id: string } }) {
      if (attachment.id === "unreadable") throw new Error("Image is missing");
      return "aGVsbG8=";
    },
  }),
}));
import {
  isEmptyWorkspaceSubmission,
  resolveEmptyWorkspaceMainProvider,
  runCreateEmptyWorkspace,
} from "./new-workspace-empty";

function payload(
  input: { text?: string; attachments?: ComposerAttachment[] } = {},
): MessagePayload {
  return { text: input.text ?? "", attachments: input.attachments ?? [], cwd: "/sample/repo" };
}

function createRecordingNavigate() {
  const recorded: Array<{ serverId: string; workspaceId: string; mainAgentId?: string }> = [];
  return {
    recorded,
    navigate: (serverId: string, workspaceId: string, mainAgentId?: string) => {
      recorded.push({ serverId, workspaceId, mainAgentId });
    },
  };
}

describe("runCreateEmptyWorkspace", () => {
  it("creates a workspace without prompt or attachments and navigates to it", async () => {
    const workspace = { id: "workspace-123" };
    const ensureWorkspace = vi.fn().mockResolvedValue({ workspace });
    const { navigate, recorded } = createRecordingNavigate();

    await runCreateEmptyWorkspace({
      payload: payload(),
      ensureWorkspace,
      serverId: "server-abc",
      navigate,
    });

    expect(ensureWorkspace).toHaveBeenCalledOnce();
    expect(ensureWorkspace).toHaveBeenCalledWith({
      cwd: "/sample/repo",
      prompt: "",
      attachments: [],
      withInitialAgent: false,
    });
    expect(recorded).toEqual([{ serverId: "server-abc", workspaceId: "workspace-123" }]);
  });

  it("opens the silent Main Tab when the host returns one", async () => {
    const workspace = { id: "workspace-123" };
    const ensureWorkspace = vi.fn().mockResolvedValue({ workspace, mainAgent: { id: "main-1" } });
    const { navigate, recorded } = createRecordingNavigate();

    await runCreateEmptyWorkspace({
      payload: payload(),
      ensureWorkspace,
      serverId: "server-abc",
      navigate,
    });

    expect(recorded).toEqual([
      { serverId: "server-abc", workspaceId: "workspace-123", mainAgentId: "main-1" },
    ]);
  });
});

describe("resolveEmptyWorkspaceMainProvider", () => {
  it("uses a ready provider on the selected host when the saved provider is unavailable", () => {
    expect(
      resolveEmptyWorkspaceMainProvider({
        selectedProvider: "claude",
        preferredProvider: "claude",
        entries: [
          { provider: "claude", enabled: false, status: "ready" },
          { provider: "codex", enabled: true, status: "loading" },
          { provider: "pi", enabled: true, status: "ready" },
        ],
      }),
    ).toBe("pi");
  });
});

describe("explicit main session in a new workspace", () => {
  const target: MainDraftTarget = {
    serverId: "host-a",
    projectId: "repo",
    sourceDirectory: "/repo",
    directory: "/worktrees/a",
    isolation: "existing",
  };
  const config = {
    provider: "codex",
    cwd: target.directory,
    model: "chosen-model",
    modeId: "chosen-mode",
    providerOptions: { selected: true },
  };
  const placement = {
    source: { kind: "directory" as const, path: target.directory, projectId: target.projectId },
  };
  const missingAgent = "Missing agent";
  const unavailable = "Creation outcome unavailable";
  const inProgress = "Creating agent";
  type Client = Parameters<typeof createOrRetryWorkspaceMain>[0]["client"];
  type CreateRequest = Parameters<Client["createWorkspace"]>[0];

  function workspace(id: string) {
    return { id, workspaceDirectory: target.directory } as WorkspaceDescriptorPayload;
  }

  function mainAgent(id: string, workspaceId: string) {
    return AgentSnapshotPayloadSchema.parse({
      id,
      workspaceId,
      provider: config.provider,
      cwd: config.cwd,
      model: config.model,
      status: "idle",
      createdAt: "2026-11-23T00:00:00Z",
      updatedAt: "2026-11-23T00:00:00Z",
      currentModeId: config.modeId,
      availableModes: [],
      pendingPermissions: [],
      lastUserMessageAt: null,
      persistence: null,
      title: null,
      capabilities: {
        supportsStreaming: true,
        supportsSessionPersistence: true,
        supportsDynamicModes: true,
        supportsMcpServers: false,
        supportsReasoningStream: false,
        supportsToolInvocations: true,
      },
      labels: { [WORKSPACE_ROLE_LABEL]: WORKSPACE_MAIN_ROLE },
    });
  }

  function harness() {
    const id = crypto.randomUUID();
    const createWorkspace = vi.fn<Client["createWorkspace"]>();
    const createAgent = vi.fn<Client["createAgent"]>();
    const findWorkspace = vi.fn<Client["findWorkspace"]>().mockResolvedValue(null);
    const getCreationSnapshot = vi.fn<Client["getCreationSnapshot"]>().mockResolvedValue(null);
    const fetchAgent = vi.fn<Client["fetchAgent"]>().mockResolvedValue(null);
    const prepareWorkspace = vi.fn().mockResolvedValue(placement);
    const assertSupported = vi.fn();
    const prepareAgent = vi
      .fn<Parameters<typeof createOrRetryWorkspaceMain>[0]["prepareAgent"]>()
      .mockResolvedValue({ config, initialPrompt: "hello", clientMessageId: "message-id" });
    const submit = async () =>
      createOrRetryWorkspaceMain({
        client: { createWorkspace, createAgent, findWorkspace, fetchAgent, getCreationSnapshot },
        target,
        previous: await readMainDraft(id),
        save: (draft) => writeMainDraft(id, draft),
        prepareAgent,
        prepareWorkspace,
        assertSupported,
        canCreateWorkspace: true,
        unavailableMessage: unavailable,
        inProgressMessage: inProgress,
        failedMessage: missingAgent,
      });
    return {
      id,
      submit,
      createWorkspace,
      createAgent,
      findWorkspace,
      fetchAgent,
      getCreationSnapshot,
      prepareWorkspace,
      prepareAgent,
      assertSupported,
    };
  }

  function complete(request: CreateRequest) {
    const parsed = WorkspaceCreateRequestSchema.parse({
      ...request,
      type: "workspace.create.request",
      requestId: "request",
    });
    return {
      workspace: workspace(parsed.workspaceId!),
      agent: mainAgent(parsed.agent!.agentId!, parsed.workspaceId!),
      requestId: "request",
      setupTerminalId: null,
      error: null,
    };
  }

  it.each(["", "Start here"])("uses the initial Main agent for prompt %j", async (prompt) => {
    const h = harness();
    h.prepareAgent.mockResolvedValue({
      config,
      initialPrompt: prompt,
      clientMessageId: "message-id",
    });
    h.createWorkspace.mockImplementation(async (request) => {
      expect(await readMainDraft(h.id)).toMatchObject({
        target,
        attempt: { workspaceId: request.workspaceId, kind: "workspace" },
      });
      return complete(request);
    });
    await h.submit();
    const request = h.createWorkspace.mock.calls[0]![0];
    expect(request.agent).toEqual({
      config,
      agentId: expect.any(String),
      workspaceRole: "main",
      ...(prompt ? { initialPrompt: prompt, clientMessageId: "message-id" } : {}),
    });
    expect(request.source).toEqual(placement.source);
    expect(request.mainAgent).toBeUndefined();
    expect(h.createAgent).not.toHaveBeenCalled();
  });

  it("restores exactly the persisted draft, host, project and existing worktree", async () => {
    const { id } = harness();
    await writeMainDraft(id, { target });
    const restored = await readMainDraft(id);
    expect(restored).toEqual({ target });
    expect(restoreMainDraftAtTarget(restored, target)).toEqual({ target });
    for (const other of [
      { ...target, directory: "/worktrees/b" },
      { ...target, directory: "/repo", isolation: "local" as const },
      { ...target, serverId: "host-b" },
      { ...target, projectId: "other" },
    ]) {
      expect(restoreMainDraftAtTarget(restored, other)).toBeNull();
    }
    expect(await readMainDraft("different-draft")).toBeNull();
    await writeMainDraft(id, null);
    expect(await readMainDraft(id)).toBeNull();
  });

  function receiptFor(request: CreateRequest, fields: Partial<CreationSnapshot>): CreationSnapshot {
    return {
      kind: "workspace",
      idempotencyKey: request.idempotencyKey!,
      revision: 2,
      phase: "accepted",
      workspaceId: request.workspaceId!,
      agentId: request.agent!.agentId!,
      error: null,
      ...fields,
    };
  }

  it("reads the original workspace and retries only its missing session", async () => {
    const h = harness();
    h.createWorkspace.mockImplementationOnce(async (request) => {
      const existing = workspace(request.workspaceId!);
      h.findWorkspace.mockResolvedValue(existing);
      h.getCreationSnapshot.mockResolvedValue(
        receiptFor(request, {
          phase: "failed",
          failedStage: "agent",
          workspace: existing,
          error: "Main already exists",
          errorCode: "workspace_main_exists",
          outcomeUnknown: false,
        }),
      );
      throw new Error("Connection lost before rejection arrived");
    });
    await expect(h.submit()).rejects.toThrow("Connection lost");
    const sent = h.createWorkspace.mock.calls[0]![0];
    h.prepareAgent.mockResolvedValue({
      config: { ...config, model: "edited-model" },
      initialPrompt: "hello",
    });
    h.createAgent.mockImplementation(async (request) =>
      mainAgent(request.agentId!, request.workspaceId!),
    );
    await expect(h.submit()).resolves.toMatchObject({ workspace: { id: sent.workspaceId } });
    expect(h.getCreationSnapshot).toHaveBeenCalledExactlyOnceWith("workspace", sent.idempotencyKey);
    expect(h.findWorkspace).toHaveBeenCalledWith(sent.workspaceId);
    expect(h.fetchAgent).toHaveBeenCalledWith(sent.agent!.agentId);
    expect(h.prepareWorkspace).toHaveBeenCalledTimes(1);
    expect(h.createWorkspace).toHaveBeenCalledTimes(1);
    expect(h.createAgent).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        workspaceId: sent.workspaceId,
        workspaceRole: "main",
        config: { ...config, model: "edited-model" },
        initialPrompt: "hello",
      }),
    );
  });

  it("keeps the worktree placement and requests a fresh ID after confirmed workspace rejection", async () => {
    const h = harness();
    const source = {
      kind: "worktree",
      cwd: "/repo",
      refName: "release",
      worktreeSlug: "saved-branch",
    };
    h.prepareWorkspace.mockResolvedValueOnce({ source });
    const claimedIds = new Set<string>();
    h.createWorkspace.mockImplementation(async (request) => {
      const id = request.workspaceId!;
      if (claimedIds.has(id)) throw new Error("workspace_id_conflict");
      claimedIds.add(id);
      if (claimedIds.size > 1) return complete(request);
      const creation = receiptFor(request, {
        phase: "failed",
        failedStage: "workspace",
        error: "Directory not found",
        outcomeUnknown: false,
      });
      h.getCreationSnapshot.mockResolvedValue(creation);
      return {
        workspace: null,
        requestId: "request",
        setupTerminalId: null,
        error: creation.error,
        creation,
      };
    });
    await expect(h.submit()).rejects.toThrow("Directory not found");
    await h.submit();
    const [first, second] = h.createWorkspace.mock.calls;
    expect(second![0].source).toEqual(source);
    expect(second![0].workspaceId).not.toBe(first![0].workspaceId);
    expect(second![0].idempotencyKey).not.toBe(first![0].idempotencyKey);
    expect(h.prepareWorkspace).toHaveBeenCalledTimes(1);
    expect(h.createAgent).not.toHaveBeenCalled();
  });

  it("holds the draft after a lost response even if an agent exists and its first message is unconfirmed", async () => {
    const h = harness();
    h.createWorkspace.mockImplementationOnce(async (request) => {
      const result = complete(request);
      h.findWorkspace.mockResolvedValue(result.workspace);
      h.fetchAgent.mockResolvedValue({ agent: result.agent, project: null });
      throw new Error("Connection lost");
    });
    const clearDraft = vi.fn();
    const setSendError = vi.fn();
    await expect(
      submitAgentInput({
        message: "hello",
        attachments: [],
        isAgentRunning: false,
        canSubmit: true,
        submitBehavior: "preserve-and-lock",
        submitMessage: async () => {
          await h.submit();
        },
        queueMessage: vi.fn(),
        clearDraft,
        setUserInput: vi.fn(),
        setAttachments: vi.fn(),
        setSendError,
        setIsProcessing: vi.fn(),
      }),
    ).resolves.toBe("failed");
    expect(clearDraft).not.toHaveBeenCalled();
    expect(setSendError).toHaveBeenLastCalledWith("Connection lost");
    await expect(h.submit()).rejects.toThrow(unavailable);
    expect(h.createWorkspace).toHaveBeenCalledTimes(1);
    expect(h.createAgent).not.toHaveBeenCalled();
  });

  it("reads the completed remote receipt and opens the original session without encoding or submitting again", async () => {
    const h = harness();
    h.createWorkspace.mockImplementationOnce(async (request) => {
      const result = complete(request);
      h.findWorkspace.mockResolvedValue(result.workspace);
      h.fetchAgent.mockResolvedValue({ agent: result.agent, project: null });
      h.getCreationSnapshot.mockResolvedValue(
        receiptFor(request, {
          phase: "completed",
          workspace: result.workspace,
          agent: result.agent,
        }),
      );
      throw new Error("Connection lost");
    });
    await expect(h.submit()).rejects.toThrow("Connection lost");
    const request = h.createWorkspace.mock.calls[0]![0];
    h.prepareAgent.mockRejectedValueOnce(new Error("Image disappeared"));
    await expect(h.submit()).resolves.toMatchObject({
      workspace: { id: request.workspaceId },
      agent: { id: request.agent?.agentId },
    });
    expect(h.getCreationSnapshot).toHaveBeenCalledExactlyOnceWith(
      "workspace",
      request.idempotencyKey,
    );
    expect(h.prepareAgent).toHaveBeenCalledTimes(1);
    expect(h.createWorkspace).toHaveBeenCalledTimes(1);
    expect(h.createAgent).not.toHaveBeenCalled();
  });

  it.each(["agent_ready", "prompt_started", "unknown"] as const)(
    "preserves an unresolved attempt at %s without issuing another creation",
    async (state) => {
      const h = harness();
      // Even an empty draft can still be starting after the agent appears.
      h.prepareAgent.mockResolvedValue({ config });
      h.createWorkspace.mockImplementationOnce(async (request) => {
        const result = complete(request);
        h.findWorkspace.mockResolvedValue(result.workspace);
        h.fetchAgent.mockResolvedValue({ agent: result.agent, project: null });
        h.getCreationSnapshot.mockResolvedValue(
          receiptFor(request, {
            phase: state === "unknown" ? "failed" : state,
            ...(state === "unknown" ? { outcomeUnknown: true, failedStage: "agent" } : {}),
            workspace: result.workspace,
            agent: result.agent,
          }),
        );
        throw new Error("Connection lost");
      });
      await expect(h.submit()).rejects.toThrow("Connection lost");
      const original = await readMainDraft(h.id);
      await expect(h.submit()).rejects.toThrow(state === "unknown" ? unavailable : inProgress);
      expect(await readMainDraft(h.id)).toEqual(original);
      expect(h.prepareAgent).toHaveBeenCalledTimes(1);
      expect(h.createWorkspace).toHaveBeenCalledTimes(1);
      expect(h.createAgent).not.toHaveBeenCalled();
    },
  );

  it("reads the agent receipt after reconnecting during an agent-only retry", async () => {
    const h = harness();
    h.createWorkspace.mockImplementationOnce(async (request) => {
      const existing = workspace(request.workspaceId!);
      h.findWorkspace.mockResolvedValue(existing);
      h.getCreationSnapshot.mockResolvedValueOnce(
        receiptFor(request, {
          phase: "failed",
          failedStage: "agent",
          workspace: existing,
          outcomeUnknown: false,
        }),
      );
      throw new Error("Workspace created, agent failed");
    });
    h.createAgent.mockImplementationOnce(async (request) => {
      const agent = mainAgent(request.agentId!, request.workspaceId!);
      h.fetchAgent.mockResolvedValue({ agent, project: null });
      h.getCreationSnapshot.mockResolvedValueOnce({
        kind: "agent",
        idempotencyKey: request.idempotencyKey!,
        revision: 4,
        phase: "completed",
        workspaceId: request.workspaceId!,
        agentId: agent.id,
        agent,
        error: null,
      });
      throw new Error("Connection lost");
    });
    await expect(h.submit()).rejects.toThrow("Workspace created, agent failed");
    await expect(h.submit()).rejects.toThrow("Connection lost");
    const agentRequest = h.createAgent.mock.calls[0]![0];
    await expect(h.submit()).resolves.toMatchObject({ agent: { id: agentRequest.agentId } });
    expect(h.getCreationSnapshot).toHaveBeenLastCalledWith("agent", agentRequest.idempotencyKey);
    expect(h.createAgent).toHaveBeenCalledTimes(1);
    expect(h.createWorkspace).toHaveBeenCalledTimes(1);
  });

  it("keeps the draft if a successful response contains an ordinary session", async () => {
    const h = harness();
    h.createWorkspace.mockImplementationOnce(async (request) => {
      const result = complete(request);
      const agent = { ...result.agent, labels: {} };
      h.findWorkspace.mockResolvedValue(result.workspace);
      h.fetchAgent.mockResolvedValue({ agent, project: null });
      h.getCreationSnapshot.mockResolvedValue(
        receiptFor(request, {
          phase: "completed",
          workspace: result.workspace,
          agent: result.agent,
        }),
      );
      return { ...result, agent };
    });
    await expect(h.submit()).rejects.toThrow(unavailable);
    await expect(h.submit()).rejects.toThrow(unavailable);
    expect(h.createWorkspace).toHaveBeenCalledTimes(1);
    expect(h.createAgent).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "blocks all writes when an image is missing (some valid: %s)",
    async (someValid) => {
      const h = harness();
      const image = (id: string) => ({
        id,
        mimeType: "image/png",
        storageType: "web-indexeddb" as const,
        storageKey: id,
        createdAt: 0,
      });
      const images = [...(someValid ? [image("readable")] : []), image("unreadable")];
      h.prepareAgent.mockImplementation(async () => ({
        config,
        images: await encodeImages(images, "Could not send image"),
      }));
      await expect(h.submit()).rejects.toThrow("Could not send image");
      expect(h.createWorkspace).not.toHaveBeenCalled();
      expect(h.createAgent).not.toHaveBeenCalled();
      expect(await readMainDraft(h.id)).toBeNull();
    },
  );
});

describe("isEmptyWorkspaceSubmission", () => {
  it("treats whitespace-only text with no attachments as empty, but any attachment as non-empty", () => {
    const attachment: ComposerAttachment = {
      kind: "image",
      metadata: {
        id: "image-1",
        mimeType: "image/png",
        storageType: "web-indexeddb",
        storageKey: "image-1",
        createdAt: 0,
      },
    };

    expect(isEmptyWorkspaceSubmission(payload({ text: " \n\t " }))).toBe(true);
    expect(isEmptyWorkspaceSubmission(payload({ attachments: [attachment] }))).toBe(false);
  });
});
