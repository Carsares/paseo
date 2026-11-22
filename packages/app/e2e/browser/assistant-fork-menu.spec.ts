import { rename } from "node:fs/promises";
import { expect, test as base, type Page } from "../support/fixtures";
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
import { submitNewWorkspaceEmpty } from "../support/helpers/new-workspace";

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

test.describe("Timeline Fork", () => {
  test.describe.configure({ timeout: 180_000 });

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
    await submitNewWorkspaceEmpty(page);

    const userMessage = page.getByTestId("user-message").filter({ hasText: "Chat history" }).last();
    await expect(userMessage).toBeVisible({ timeout: 30_000 });
    await expect(userMessage).not.toContainText("Source agent:");
  });
});
