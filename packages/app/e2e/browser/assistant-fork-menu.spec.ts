import { execFileSync } from "node:child_process";
import { readFile, readdir, rename } from "node:fs/promises";
import { join } from "node:path";
import type { CreationSnapshot, WorkspaceCreateRequest } from "@getpaseo/protocol/messages";
import { expect, test as base, type Page } from "../support/fixtures";
import { selectModel } from "../support/helpers/app";
import { awaitAssistantMessage } from "../support/helpers/agent-stream";
import {
  expectChatHistoryAttachment,
  expectInFlightForkAvailable,
  expectLiveAssistantText,
  forkInFlightTurnToNewTab,
  forkMostRecentAssistantTurnToNewTab,
  forkMostRecentAssistantTurnToNewWorkspace,
  observeForkAttachment,
} from "../support/helpers/assistant-fork";
import {
  dropFileOnComposer,
  expectComposerDraft,
  expectComposerVisible,
  fillComposerDraft,
  resizeComposerViewport,
  submitMessage,
} from "../support/helpers/composer";
import { daemonWsRoutePattern, getE2EDaemonPort } from "../support/helpers/daemon-port";
import {
  openAgentRoute,
  seedMockAgentWorkspace,
  type MockAgentOptions,
  type MockAgentWorkspace,
} from "../support/helpers/mock-agent";
import { getServerId } from "../support/helpers/server-id";
import { seedSavedSettingsHosts } from "../support/helpers/settings";
import {
  expectWorkspaceIsolationSelected,
  openStartingRefPicker,
  selectBranchInPicker,
  selectWorkspaceIsolation,
  submitNewWorkspaceEmpty,
} from "../support/helpers/new-workspace";

const test = base.extend<{
  seedForkWorkspace: (options: MockAgentOptions) => Promise<MockAgentWorkspace>;
}>({
  seedForkWorkspace: async ({ browserName: _browserName }, provide) => {
    const sessions: MockAgentWorkspace[] = [];
    await provide(async (options) => {
      const session = await seedMockAgentWorkspace(options);
      sessions.push(session);
      return session;
    });
    await Promise.allSettled(sessions.map((session) => session.cleanup()));
  },
});

function observeWorkspaceRequests(page: Page): unknown[] {
  const requests: unknown[] = [];
  const sourcePort = String(getE2EDaemonPort());
  page.on("websocket", (socket) => {
    if (new URL(socket.url()).port !== sourcePort) return;
    socket.on("framesent", ({ payload }) => {
      if (typeof payload !== "string") return;
      const envelope = JSON.parse(payload);
      const request = envelope.message ?? envelope;
      if (request.type === "workspace.create.request") requests.push(request);
    });
  });
  return requests;
}

async function simulateLegacyForkHost(page: Page): Promise<void> {
  // These cases pin the history attachment fallback on a host without timeline Fork.
  await page.routeWebSocket(daemonWsRoutePattern(), (browser) => {
    const daemon = browser.connectToServer();
    daemon.onMessage((raw) => {
      if (typeof raw === "string") {
        const envelope = JSON.parse(raw);
        const message = envelope.message ?? envelope;
        if (message.type === "status" && message.payload?.status === "server_info") {
          delete message.payload.features?.agentSeamlessContextSwitch;
          browser.send(JSON.stringify(envelope));
          return;
        }
      }
      browser.send(raw);
    });
  });
}

function readStoredForkDraft(page: Page, draftId: string | null) {
  return page.evaluate((key) => localStorage.getItem(key), `paseo:workspace-fork-draft:${draftId}`);
}

async function holdInitialWorkspaceCreation(page: Page) {
  const requests: WorkspaceCreateRequest[] = [];
  const accepted = Promise.withResolvers<CreationSnapshot>();
  let holdFirstSocket = true;
  await page.routeWebSocket(daemonWsRoutePattern(), (browser) => {
    const daemon = browser.connectToServer();
    let original: WorkspaceCreateRequest | undefined;
    browser.onMessage((raw) => {
      if (typeof raw === "string") {
        const envelope = JSON.parse(raw);
        const request = envelope.message ?? envelope;
        if (request.type === "workspace.create.request") {
          requests.push(request);
          if (holdFirstSocket && !original) original = request;
        }
      }
      daemon.send(raw);
    });
    daemon.onMessage((raw) => {
      if (original && typeof raw === "string") {
        const envelope = JSON.parse(raw);
        const message = envelope.message ?? envelope;
        if (
          message.type === "workspace.create.update" &&
          message.payload.idempotencyKey === original.idempotencyKey
        ) {
          // The host emits accepted only after persisting the creation record. The old
          // connection never receives workspace_ready or the create response.
          if (message.payload.phase === "accepted") accepted.resolve(message.payload);
          return;
        }
        if (
          message.type === "workspace.create.response" &&
          message.payload.requestId === original.requestId
        ) {
          return;
        }
      }
      browser.send(raw);
    });
  });
  return {
    requests,
    accepted: accepted.promise,
    allowRetry() {
      holdFirstSocket = false;
    },
  };
}

test.describe("Timeline Fork", () => {
  test.describe.configure({ timeout: 180_000 });

  test("recovers an accepted worktree Fork after refreshing before workspace readiness", async ({
    page,
    seedForkWorkspace,
  }) => {
    test.setTimeout(120_000);
    const earlier = "emit 1 coalesced agent stream updates for the accepted fork turn.";
    const later = "emit 1 coalesced agent stream updates beyond the accepted fork turn.";
    const prompt = "Continue the accepted worktree Fork.";
    const filename = "accepted-fork-notes.txt";
    const selectedBranch = "fork-retry-base";
    const creation = await holdInitialWorkspaceCreation(page);
    const { requests } = creation;
    const session = await seedForkWorkspace({
      repoPrefix: "assistant-fork-accepted-worktree-",
      repo: { branches: [selectedBranch] },
      title: "Accepted worktree Fork",
      initialPrompt: earlier,
      model: "ten-second-stream",
    });
    const knownWorkspaces = new Set(
      (await session.client.fetchWorkspaces()).entries.map((w) => w.id),
    );
    const listWorktrees = () =>
      execFileSync("git", ["worktree", "list", "--porcelain"], {
        cwd: session.cwd,
        encoding: "utf8",
      })
        .split("\n")
        .filter((line) => line.startsWith("worktree "));
    const originalWorktrees = listWorktrees();
    const gitRev = (cwd: string, ref: string) =>
      execFileSync("git", ["rev-parse", ref], { cwd, encoding: "utf8" }).trim();
    const selectedCommit = gitRev(session.cwd, selectedBranch);
    expect(selectedCommit).not.toBe(gitRev(session.cwd, "main"));

    await openAgentRoute(page, session);
    await awaitAssistantMessage(page);
    expect((await session.client.waitForFinish(session.agentId, 45_000)).status).toBe("idle");
    await forkMostRecentAssistantTurnToNewWorkspace(page);
    await expect(page).toHaveURL(/\/new\?.*draftId=/);
    const draftId = new URL(page.url()).searchParams.get("draftId");
    await session.client.sendAgentMessage(session.agentId, later);
    expect((await session.client.waitForFinish(session.agentId, 45_000)).status).toBe("idle");
    await selectWorkspaceIsolation(page, "worktree");
    await expectWorkspaceIsolationSelected(page, "worktree");
    const basePicker = page.getByTestId("new-workspace-ref-picker-trigger");
    await expect(basePicker).toContainText("main");
    await openStartingRefPicker(page);
    await page.getByTestId("new-workspace-ref-picker-checkout").click();
    await selectBranchInPicker(page, selectedBranch);
    await expect(basePicker).toContainText(selectedBranch);
    await fillComposerDraft(page, prompt);
    await dropFileOnComposer(page, {
      name: filename,
      mimeType: "text/plain",
      buffer: Buffer.from("Retain this file while recovering the accepted worktree."),
    });
    const attachment = page.getByTestId("composer-file-attachment-pill");
    await expect(attachment).toContainText(filename);
    const submit = page.getByTestId("workspace-create-submit");
    await submit.click();
    const receipt = await creation.accepted;
    expect(receipt).toMatchObject({
      idempotencyKey: draftId,
      workspaceId: expect.any(String),
      agentId: expect.any(String),
    });
    expect(requests[0]).toMatchObject({
      idempotencyKey: draftId,
      source: {
        kind: "worktree",
        action: "checkout",
        refName: selectedBranch,
        worktreeSlug: expect.any(String),
      },
      agent: {
        forkFrom: { sourceAgentId: session.agentId },
        initialPrompt: prompt,
      },
    });
    await expect(page).toHaveURL(/\/new\?.*draftId=/);

    const draftUrl = page.url();
    creation.allowRetry();
    await page.reload();
    await expectComposerDraft(page, prompt);
    await expect(attachment).toContainText(filename);
    await expectWorkspaceIsolationSelected(page, "worktree");
    await expect(basePicker).toContainText(selectedBranch);
    const changedPrompt = "Continue the Fork using a changed prompt.";
    await fillComposerDraft(page, changedPrompt);
    await submit.click();

    await expect.poll(() => requests.length).toBe(2);
    expect(requests[1]).toMatchObject({
      idempotencyKey: draftId,
      source: requests[0]!.source,
      agent: { initialPrompt: changedPrompt },
    });
    await expect(
      page.getByText("workspace_request_key_conflict", { exact: true }).first(),
    ).toBeVisible();
    await expect(page).toHaveURL(draftUrl);
    await expectComposerDraft(page, changedPrompt);
    await expect(attachment).toContainText(filename);

    await fillComposerDraft(page, prompt);
    await openStartingRefPicker(page);
    await page.getByTestId("new-workspace-ref-picker-branch-off").click();
    await selectBranchInPicker(page, selectedBranch);
    await submit.click();
    await expect.poll(() => requests.length).toBe(3);
    expect(requests[2]).toMatchObject({
      idempotencyKey: draftId,
      source: {
        kind: "worktree",
        action: "branch-off",
        refName: `refs/heads/${selectedBranch}`,
        worktreeSlug:
          requests[0]!.source.kind === "worktree" ? requests[0]!.source.worktreeSlug : undefined,
      },
      agent: { initialPrompt: prompt },
    });
    await expect(
      page.getByText("workspace_request_key_conflict", { exact: true }).first(),
    ).toBeVisible();
    await expect(page).toHaveURL(draftUrl);
    await expect(attachment).toContainText(filename);

    const retryPage = await page.context().newPage();
    // A manually opened page does not get the page fixture's main daemon guard.
    await retryPage.route(/:6767\b/, (route) => route.abort());
    await retryPage.routeWebSocket(/:6767\b/, (socket) => socket.close());
    await resizeComposerViewport(retryPage, "portrait");
    const retryRequests = observeWorkspaceRequests(retryPage);
    await retryPage.goto(draftUrl);
    await expectComposerDraft(retryPage, prompt);
    await expect(retryPage.getByTestId("composer-file-attachment-pill")).toContainText(filename);
    await expectWorkspaceIsolationSelected(retryPage, "worktree");
    await expect(retryPage.getByTestId("new-workspace-ref-picker-trigger")).toContainText(
      selectedBranch,
    );
    // Retry after the original request has finished checking out the selected branch.
    const fetchWorkspaceEntries = async () => (await session.client.fetchWorkspaces()).entries;
    await expect
      .poll(fetchWorkspaceEntries)
      .toContainEqual(expect.objectContaining({ id: receipt.workspaceId }));
    await expect(retryPage.getByTestId("compact-shell")).toBeVisible();
    await openStartingRefPicker(retryPage);
    const occupiedBranch = retryPage.getByTestId(
      `new-workspace-ref-picker-branch-${selectedBranch}`,
    );
    await expect(occupiedBranch.getByText("In a worktree", { exact: true })).toBeVisible();
    await retryPage.keyboard.press("Escape");
    await expect(occupiedBranch).toBeHidden();
    await retryPage.getByTestId("workspace-create-submit").click();

    await expect.poll(() => retryRequests.length).toBe(1);
    const { requestId: _firstRequestId, ...acceptedIntent } = requests[0]!;
    const { requestId: _retryRequestId, ...retryIntent } =
      retryRequests[0] as WorkspaceCreateRequest;
    expect(retryIntent).toEqual(acceptedIntent);
    await expect(retryPage).toHaveURL(/\/workspace\//, { timeout: 30_000 });
    // The selected-tab marker lives in the wide layout's tab row.
    await resizeComposerViewport(retryPage, "landscape");
    await expect(retryPage.getByTestId(`workspace-tab-agent_${receipt.agentId}`)).toHaveAttribute(
      "aria-selected",
      "true",
      { timeout: 30_000 },
    );
    const userMessages = retryPage.getByTestId("user-message");
    await expect(userMessages.filter({ hasText: earlier })).toBeVisible();
    await expect(userMessages.filter({ hasText: later })).toHaveCount(0);
    const initialMessage = userMessages.filter({ hasText: prompt });
    await expect(initialMessage).toHaveCount(1);
    await expect(initialMessage).toContainText(filename);
    await expect.poll(() => readStoredForkDraft(retryPage, draftId)).toBeNull();

    const created = (await session.client.fetchWorkspaces()).entries.filter(
      (w) => !knownWorkspaces.has(w.id),
    );
    expect(created).toMatchObject([{ id: receipt.workspaceId, workspaceKind: "worktree" }]);
    expect(gitRev(created[0]!.workspaceDirectory, "HEAD")).toBe(selectedCommit);
    expect(listWorktrees().filter((entry) => !originalWorktrees.includes(entry))).toEqual([
      `worktree ${created[0]!.workspaceDirectory}`,
    ]);
    const agents = (await session.client.fetchAgents()).entries
      .map((entry) => entry.agent)
      .filter((agent) => agent.workspaceId === receipt.workspaceId);
    expect(agents.map((agent) => agent.id)).toEqual([receipt.agentId]);
  });

  for (const { label, changeModel, initialMain, retryMain } of [
    { label: "manually selected model", changeModel: true, initialMain: false, retryMain: false },
    { label: "main default switched on", changeModel: false, initialMain: false, retryMain: true },
    { label: "main default switched off", changeModel: false, initialMain: true, retryMain: false },
  ]) {
    test(`recovers the submitted Fork configuration with ${label}`, async ({
      page,
      seedForkWorkspace,
    }) => {
      const sourceModel = "ten-second-stream";
      const submittedModel = changeModel ? "max-only-thinking-stream" : sourceModel;
      const prompt = "Continue the Fork with its submitted configuration.";
      const mainPrompt = "Original test Main Control instructions.";
      const creation = await holdInitialWorkspaceCreation(page);
      const session = await seedForkWorkspace({
        repoPrefix: "assistant-fork-configuration-",
        title: "Fork configuration",
        initialPrompt: "emit 1 coalesced agent stream updates for the original turn.",
        model: sourceModel,
      });
      const setDefaultMain = async (enabled: boolean) => {
        await page.goto("/settings/chat");
        const toggle = page.getByRole("switch", { name: "Default main tab for new workspaces" });
        await expect(toggle).toBeVisible();
        if ((await toggle.isChecked()) !== enabled) await toggle.click();
        await expect(toggle).toHaveAttribute("aria-checked", String(enabled));
      };
      if (initialMain) {
        await setDefaultMain(true);
        await session.client.patchDaemonConfig({ mainControlAppendSystemPrompt: mainPrompt });
      }
      await openAgentRoute(page, session);
      await awaitAssistantMessage(page);
      expect((await session.client.waitForFinish(session.agentId, 45_000)).status).toBe("idle");
      await forkMostRecentAssistantTurnToNewWorkspace(page);
      await expect(page).toHaveURL(/\/new\?.*draftId=/);
      const draftUrl = page.url();
      await selectWorkspaceIsolation(page, "worktree");
      await expectWorkspaceIsolationSelected(page, "worktree");
      if (changeModel) await selectModel(page, "Max-only thinking stream");
      await fillComposerDraft(page, prompt);
      const submit = page.getByTestId("workspace-create-submit");
      await submit.click();

      const receipt = await creation.accepted;
      const first = creation.requests[0]!;
      expect(first.agent?.config.model).toBe(submittedModel);
      expect(first.mainAgent?.config.model).toBe(initialMain ? submittedModel : undefined);
      expect(receipt).toMatchObject({
        workspaceId: expect.any(String),
        agentId: expect.any(String),
      });
      const fetchAgents = async () =>
        (await session.client.fetchAgents()).entries
          .map(({ agent }) => agent)
          .filter((agent) => agent.workspaceId === receipt.workspaceId);
      await expect
        .poll(fetchAgents)
        .toContainEqual(expect.objectContaining({ id: receipt.agentId }));

      // Change the host prompt after the originally accepted Main Session has been stored.
      if (initialMain) {
        await session.client.patchDaemonConfig({
          mainControlAppendSystemPrompt: "Updated test Main Control instructions.",
        });
      }
      creation.allowRetry();
      if (initialMain === retryMain) {
        await page.reload();
      } else {
        await setDefaultMain(retryMain);
        await page.goto(draftUrl);
      }
      const waitForRestoredDraft = async () => {
        await expectComposerDraft(page, prompt);
        // Draft text can hydrate before the host's provider catalog and form selection.
        await expect(
          page.getByRole("button", {
            name: /^Select model \((Ten second stream|Max-only thinking stream)\)$/i,
          }),
        ).toBeVisible();
      };
      await waitForRestoredDraft();
      if (changeModel) {
        await selectModel(page, "Ten second stream");
        await submit.click();
        await expect.poll(() => creation.requests.length).toBe(2);
        expect(creation.requests[1]?.agent?.config.model).toBe(sourceModel);
        await expect(
          page.getByText("workspace_request_key_conflict", { exact: true }).first(),
        ).toBeVisible();
        await expectComposerDraft(page, prompt);
        await page.reload();
        await waitForRestoredDraft();
      }

      const retryRequestIndex = changeModel ? 2 : 1;
      await submit.click();
      await expect.poll(() => creation.requests.length).toBe(retryRequestIndex + 1);
      const { requestId: _firstRequestId, ...acceptedIntent } = first;
      const { requestId: _retryRequestId, ...retryIntent } = creation.requests[retryRequestIndex]!;
      expect(retryIntent).toEqual(acceptedIntent);
      await expect(page).toHaveURL(/\/workspace\//, { timeout: 30_000 });
      await expect(page.getByTestId(`workspace-tab-agent_${receipt.agentId}`)).toHaveAttribute(
        "aria-selected",
        "true",
        { timeout: 30_000 },
      );
      await expect(page.getByTestId("user-message").filter({ hasText: prompt })).toHaveCount(1);

      const agents = await fetchAgents();
      const initialAgent = agents.find((agent) => agent.id === receipt.agentId);
      expect(initialAgent?.model).toBe(submittedModel);
      const mainAgents = agents.filter((agent) => agent.id !== receipt.agentId);
      expect(mainAgents).toHaveLength(initialMain ? 1 : 0);
      if (initialMain) {
        const mainAgentId = mainAgents[0]!.id;
        const recordsDirectory = join(process.env.E2E_PASEO_HOME!, "agents");
        const files = await readdir(recordsDirectory, { recursive: true });
        const recordPath = files.find((name) => name.endsWith(`/${mainAgentId}.json`));
        expect(recordPath).toBeDefined();
        const record = JSON.parse(await readFile(join(recordsDirectory, recordPath!), "utf8"));
        expect(record.mainControlSystemPrompt).toBe(mainPrompt);
      }
    });
  }

  test("recovers an accepted Local Fork after a refresh and a default change in another tab", async ({
    page,
    seedForkWorkspace,
  }) => {
    const prompt = "Continue the accepted Local Fork.";
    const changedPrompt = "Try a different first prompt.";
    const filename = "accepted-local-fork.txt";
    const creation = await holdInitialWorkspaceCreation(page);
    const session = await seedForkWorkspace({
      repoPrefix: "assistant-fork-accepted-local-",
      title: "Accepted Local Fork",
      initialPrompt: "emit 1 coalesced agent stream updates for the original Local Fork turn.",
      model: "ten-second-stream",
    });
    const knownWorkspaces = new Set(
      (await session.client.fetchWorkspaces()).entries.map(({ id }) => id),
    );
    await openAgentRoute(page, session);
    await awaitAssistantMessage(page);
    expect((await session.client.waitForFinish(session.agentId, 45_000)).status).toBe("idle");
    await forkMostRecentAssistantTurnToNewWorkspace(page);
    await expect(page).toHaveURL(/\/new\?.*draftId=/);
    const draftUrl = page.url();
    const draftId = new URL(draftUrl).searchParams.get("draftId");
    expect(draftId).toBeTruthy();
    await selectWorkspaceIsolation(page, "local");
    await expectWorkspaceIsolationSelected(page, "local");
    await selectModel(page, "Max-only thinking stream");
    await fillComposerDraft(page, prompt);
    await dropFileOnComposer(page, {
      name: filename,
      mimeType: "text/plain",
      buffer: Buffer.from("Retain the original Local Fork attachment."),
    });
    const attachment = page.getByTestId("composer-file-attachment-pill");
    await expect(attachment).toContainText(filename);
    const submit = page.getByTestId("workspace-create-submit");
    await submit.click();

    const receipt = await creation.accepted;
    const first = creation.requests[0]!;
    expect(receipt).toMatchObject({ idempotencyKey: draftId, agentId: expect.any(String) });
    expect(first).toMatchObject({
      idempotencyKey: draftId,
      source: { kind: "directory", path: session.cwd },
      agent: {
        config: { model: "max-only-thinking-stream" },
        forkFrom: { sourceAgentId: session.agentId, boundaryMessageId: expect.any(String) },
        initialPrompt: prompt,
      },
    });
    expect(first.mainAgent).toBeUndefined();
    await expect(page).toHaveURL(draftUrl);

    creation.allowRetry();
    await page.reload();
    await expectComposerDraft(page, prompt);
    await expect(attachment).toContainText(filename);
    await expectWorkspaceIsolationSelected(page, "local");
    await fillComposerDraft(page, changedPrompt);
    await submit.click();
    const conflict = page.getByText("workspace_request_key_conflict", { exact: true }).first();
    await expect(conflict).toBeVisible();
    expect(creation.requests[1]).toMatchObject({
      idempotencyKey: draftId,
      source: first.source,
      agent: { initialPrompt: changedPrompt },
    });
    await expectComposerDraft(page, changedPrompt);
    await expect(attachment).toContainText(filename);
    await fillComposerDraft(page, prompt);

    const settings = await page.context().newPage();
    await settings.route(/:6767\b/, (route) => route.abort());
    await settings.routeWebSocket(/:6767\b/, (socket) => socket.close());
    await settings.goto(new URL("/settings/chat", draftUrl).href);
    const toggle = settings.getByRole("switch", { name: "Default main tab for new workspaces" });
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await settings.reload();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await settings.close();

    await page.reload();
    await expectComposerDraft(page, prompt);
    await expect(attachment).toContainText(filename);
    await expectWorkspaceIsolationSelected(page, "local");
    await submit.click();
    await expect.poll(() => creation.requests.length).toBe(3);
    const selectedTab = page.getByTestId(`workspace-tab-agent_${receipt.agentId}`);
    await expect(selectedTab.or(conflict)).toBeVisible({ timeout: 30_000 });
    await expect(conflict).toBeHidden();
    await expect(selectedTab).toHaveAttribute("aria-selected", "true");
    const { requestId: _firstRequestId, ...acceptedIntent } = first;
    const { requestId: _retryRequestId, ...retryIntent } = creation.requests[2]!;
    expect(retryIntent).toEqual(acceptedIntent);
    const initialMessage = page.getByTestId("user-message").filter({ hasText: prompt });
    await expect(initialMessage).toHaveCount(1);
    await expect(initialMessage).toContainText(filename);
    await expect.poll(() => readStoredForkDraft(page, draftId)).toBeNull();

    const created = (await session.client.fetchWorkspaces()).entries.filter(
      ({ id }) => !knownWorkspaces.has(id),
    );
    expect(created).toMatchObject([{ id: receipt.workspaceId, workspaceDirectory: session.cwd }]);
    const agents = (await session.client.fetchAgents()).entries
      .map(({ agent }) => agent)
      .filter(({ workspaceId }) => workspaceId === receipt.workspaceId);
    expect(agents.map(({ id, model }) => ({ id, model }))).toEqual([
      { id: receipt.agentId, model: "max-only-thinking-stream" },
    ]);
  });

  test("restores the selected Fork boundary before submitting a refreshed workspace draft", async ({
    page,
    seedForkWorkspace,
  }) => {
    const earlier = "emit 1 coalesced agent stream updates for the selected fork turn.";
    const later = "emit 1 coalesced agent stream updates for the excluded fork turn.";
    const draftText = "Continue from the selected turn.";
    const attachmentName = "fork-draft-notes.json";
    const requests = observeWorkspaceRequests(page);
    const session = await seedForkWorkspace({
      repoPrefix: "assistant-fork-reload-",
      title: "Assistant fork reload",
      initialPrompt: earlier,
      model: "ten-second-stream",
    });

    await openAgentRoute(page, session);
    await awaitAssistantMessage(page);
    await session.client.waitForFinish(session.agentId, 45_000);
    await forkMostRecentAssistantTurnToNewWorkspace(page);
    await expect(page).toHaveURL(/\/new\?.*draftId=/);
    const draftId = new URL(page.url()).searchParams.get("draftId");

    await session.client.sendAgentMessage(session.agentId, later);
    expect((await session.client.waitForFinish(session.agentId, 45_000)).status).toBe("idle");
    await fillComposerDraft(page, draftText);
    await dropFileOnComposer(page, {
      name: attachmentName,
      mimeType: "application/json",
      buffer: Buffer.from('{"note":"retained through Fork retry"}'),
    });
    const attachment = page.getByTestId("composer-file-attachment-pill");
    await expect(attachment).toContainText(attachmentName);
    await page.reload();
    await expectComposerDraft(page, draftText);
    await expect(attachment).toContainText(attachmentName);

    const submit = page.getByTestId("workspace-create-submit");
    const movedDirectory = `${session.cwd}-temporarily-moved`;
    await rename(session.cwd, movedDirectory);
    try {
      await submit.click();
      await expect(page.getByText(/Directory not found/).first()).toBeVisible({ timeout: 20_000 });
      await expect(page).toHaveURL(/\/new\?.*draftId=/);
      await expectComposerDraft(page, draftText);
      await expect(attachment).toContainText(attachmentName);
    } finally {
      await rename(movedDirectory, session.cwd);
    }
    await page.reload();
    await expectComposerDraft(page, draftText);
    await expect(attachment).toContainText(attachmentName);
    await submit.click();

    const forkRequest = expect.objectContaining({
      idempotencyKey: draftId,
      agent: expect.objectContaining({
        initialPrompt: draftText,
        forkFrom: expect.objectContaining({ sourceAgentId: session.agentId }),
        attachments: expect.arrayContaining([
          expect.objectContaining({ type: "uploaded_file", fileName: attachmentName }),
        ]),
      }),
    });
    await expect.poll(() => requests).toEqual([forkRequest, forkRequest]);
    await expect(page).toHaveURL(/\/workspace\//, { timeout: 30_000 });
    await expect(page.getByTestId("user-message").filter({ hasText: earlier })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByTestId("user-message").filter({ hasText: later })).toHaveCount(0);
    const newMessage = page.getByTestId("user-message").filter({ hasText: draftText });
    await expect(newMessage).toBeVisible();
    await expect(newMessage).toContainText(attachmentName);
    await expect.poll(() => readStoredForkDraft(page, draftId)).toBeNull();
  });
});

test.describe("Assistant fork menu with a legacy host", () => {
  test.describe.configure({ timeout: 180_000 });

  test.beforeEach(async ({ page }) => {
    await simulateLegacyForkHost(page);
  });

  test("forks a failed assistant turn that has no provider message id", async ({
    page,
    seedForkWorkspace,
  }) => {
    const session = await seedForkWorkspace({
      repoPrefix: "assistant-fork-failed-turn-",
      title: "Assistant fork failed turn",
      model: "ten-second-stream",
    });

    await openAgentRoute(page, session);
    await expectComposerVisible(page);
    await submitMessage(page, "Emit a synthetic turn failure.");
    await expect(page.getByText("[System Error] Requested mock provider failure")).toBeVisible({
      timeout: 30_000,
    });

    await forkMostRecentAssistantTurnToNewTab(page);
    await expectChatHistoryAttachment(page);
  });

  test("forks a streaming assistant turn without interrupting it", async ({
    page,
    seedForkWorkspace,
  }) => {
    const visibleBeforeFork = "where the auto-scroll logic actually lives";
    const visibleAfterFork = "the first useful step is to read the relevant files";
    const sourceAgentTitle = "Assistant fork in flight";
    const forkAttachment = observeForkAttachment(page);

    const session = await seedForkWorkspace({
      repoPrefix: "assistant-fork-in-flight-",
      title: sourceAgentTitle,
      model: "thirty-minute-stream",
    });

    await openAgentRoute(page, session);
    await expectComposerVisible(page);
    await submitMessage(page, "Walk me through the scroll anchor behavior.");

    await expectInFlightForkAvailable(page);
    await expectLiveAssistantText(page, visibleBeforeFork);

    await forkInFlightTurnToNewTab(page);
    await expectChatHistoryAttachment(page);
    expect(await forkAttachment.waitForText()).toContain(visibleBeforeFork);
    await expect(page.getByRole("button", { name: "Menu backdrop", exact: true })).toHaveCount(0);

    await page.getByRole("button", { name: sourceAgentTitle }).click();
    await expectLiveAssistantText(page, visibleAfterFork);
  });

  test("focuses a forked assistant turn in a new workspace draft tab", async ({
    page,
    seedForkWorkspace,
  }) => {
    const session = await seedForkWorkspace({
      repoPrefix: "assistant-fork-focused-tab-",
      title: "Assistant fork focused tab",
      initialPrompt: "emit 1 coalesced agent stream updates for initial assistant fork turn.",
      model: "ten-second-stream",
    });

    await openAgentRoute(page, session);
    await expectComposerVisible(page);
    await awaitAssistantMessage(page);
    await session.client.waitForFinish(session.agentId, 45_000);

    await submitMessage(page, "emit 1 coalesced agent stream updates while this tab is visible.");
    await session.client.waitForFinish(session.agentId, 45_000);
    await awaitAssistantMessage(page);

    const agentTab = page.getByTestId(`workspace-tab-agent_${session.agentId}`);
    await expect(agentTab).toHaveAttribute("aria-selected", "true");

    await forkMostRecentAssistantTurnToNewTab(page);

    const selectedTab = page
      .getByTestId("workspace-tabs-row")
      .getByRole("button")
      .and(page.locator('[aria-selected="true"]'));
    await expect(selectedTab).toHaveAttribute("data-testid", /^workspace-tab-draft_/, {
      timeout: 30_000,
    });
    await expect(agentTab).toHaveAttribute("aria-selected", "false");
    await expectChatHistoryAttachment(page);
  });

  test("keeps the fork attachment after submitting an existing-workspace draft tab", async ({
    page,
    seedForkWorkspace,
  }) => {
    const session = await seedForkWorkspace({
      repoPrefix: "assistant-fork-tab-submit-",
      title: "Assistant fork tab submit",
      initialPrompt: "emit 1 coalesced agent stream updates for assistant fork tab submit.",
      model: "ten-second-stream",
    });

    await openAgentRoute(page, session);
    await expectComposerVisible(page);
    await awaitAssistantMessage(page);
    await session.client.waitForFinish(session.agentId, 45_000);

    await forkMostRecentAssistantTurnToNewTab(page);
    await expectChatHistoryAttachment(page);

    await submitMessage(page, "");

    const userMessage = page.getByTestId("user-message").filter({ hasText: "Chat history" }).last();
    await expect(userMessage).toBeVisible({ timeout: 30_000 });
    await expect(userMessage).not.toContainText("Source agent:");
  });

  test("forks an assistant turn into New Workspace and keeps the attachment across host changes", async ({
    page,
    seedForkWorkspace,
  }) => {
    await seedSavedSettingsHosts(page, [
      {
        serverId: getServerId(),
        label: "localhost",
        endpoint: `127.0.0.1:${getE2EDaemonPort()}`,
      },
      {
        serverId: "secondary-assistant-fork-host",
        label: "Secondary host",
        // The host does not need to be reachable; this pins that the draft-scoped
        // attachment survives changing the selected target host.
        endpoint: "127.0.0.1:9",
      },
    ]);

    const session = await seedForkWorkspace({
      repoPrefix: "assistant-fork-workspace-",
      title: "Assistant fork workspace",
      initialPrompt: "emit 1 coalesced agent stream updates for assistant fork new workspace.",
      model: "ten-second-stream",
    });

    await openAgentRoute(page, session);
    await expectComposerVisible(page);
    await awaitAssistantMessage(page);
    await session.client.waitForFinish(session.agentId, 45_000);

    await forkMostRecentAssistantTurnToNewWorkspace(page);

    await expect(page).toHaveURL(/\/new\?.*draftId=/, { timeout: 30_000 });
    await expectChatHistoryAttachment(page);

    await page.getByTestId("host-picker-trigger").click();
    await page
      .getByTestId("new-workspace-host-picker-option-secondary-assistant-fork-host")
      .click();
    await expectChatHistoryAttachment(page);
  });

  test("keeps the fork attachment after the new agent receives its user message", async ({
    page,
    seedForkWorkspace,
  }) => {
    const session = await seedForkWorkspace({
      repoPrefix: "assistant-fork-submit-",
      title: "Assistant fork submit",
      initialPrompt: "emit 1 coalesced agent stream updates for assistant fork submit.",
      model: "ten-second-stream",
    });

    await openAgentRoute(page, session);
    await expectComposerVisible(page);
    await awaitAssistantMessage(page);
    await session.client.waitForFinish(session.agentId, 45_000);

    await forkMostRecentAssistantTurnToNewWorkspace(page);
    await expectChatHistoryAttachment(page);

    await page.reload();
    await expectChatHistoryAttachment(page);
    // The retained attachment can render before the host's model list has loaded.
    await expect(
      page.getByRole("button", { name: "Select model (Ten second stream)" }),
    ).toBeVisible();
    await submitNewWorkspaceEmpty(page);

    const userMessage = page.getByTestId("user-message").filter({ hasText: "Chat history" }).last();
    await expect(userMessage).toBeVisible({ timeout: 30_000 });
    await expect(userMessage).not.toContainText("Source agent:");
  });
});
