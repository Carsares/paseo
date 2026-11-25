import { BUILTIN_PROVIDER_IDS } from "@getpaseo/protocol/provider-manifest";
import { chooseModel, startWithoutRememberedModel } from "../support/helpers/model-memory";
import {
  composerLocator,
  dropFileOnComposer,
  enterComposerFullscreen,
  expectAttachmentPill,
  exitComposerFullscreen,
  resizeComposerViewport,
} from "../support/helpers/composer";
import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { daemonWsRoutePattern, getE2EDaemonPort } from "../support/helpers/daemon-port";
import {
  delayBrowserWorkspaceCreatedResponse,
  expectNewWorkspaceDraft,
  expectNewWorkspaceProjectSelected,
  fillNewWorkspaceDraft,
  loadSessionMessageReaders,
  openGlobalNewWorkspaceComposer,
  openNewWorkspaceComposer,
  selectNewWorkspaceHost,
  selectNewWorkspaceProject,
} from "../support/helpers/new-workspace";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import { seedSavedSettingsHosts } from "../support/helpers/settings";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";

const DRAFT = `Please investigate the workspace startup failure.

Trace the request from the app through the daemon, preserve the existing behavior, and explain the root cause before making changes.`;

const topicTest = test.extend({
  e2eDaemonEnvironment: { PASEO_WORKBENCH_COMPAT: "0" },
  e2eDaemonConfig: {
    version: 1,
    agents: {
      providers: Object.fromEntries(BUILTIN_PROVIDER_IDS.map((id) => [id, { enabled: false }])),
    },
  },
});

topicTest(
  "restores topic fields on resize and refresh before sending an attachment-only question",
  async ({ page }) => {
    const project = await seedWorkspace({ repoPrefix: "topic-draft-restore-", git: false });
    const frames = await loadSessionMessageReaders();
    const requests: NonNullable<ReturnType<typeof frames.client>>[] = [];
    page.on("websocket", (ws) => {
      if (!daemonWsRoutePattern().test(ws.url())) return;
      ws.on("framesent", ({ payload }) => {
        const message = frames.client(payload);
        if (message?.type === "workspace.create.request") requests.push(message);
      });
    });
    try {
      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await openNewWorkspaceComposer(page, project);
      const title = page.getByTestId("new-topic-title");
      const direction = page.getByTestId("new-topic-direction");
      const hidden = page.getByRole("switch", { name: "Hide topic information from the model" });
      const firstQuestion = page.getByRole("button", { name: "Attach a first question" });
      const topicTitle = "Recovered topic";
      const topicDirection = "Read the attached evidence.";
      await title.fill(topicTitle);
      await direction.fill(topicDirection);
      await hidden.click();
      await firstQuestion.click();
      await expect(composerLocator(page)).toBeVisible();
      const draftId = new URL(page.url()).searchParams.get("creationDraftId");
      expect(draftId).toBeTruthy();

      await resizeComposerViewport(page, "portrait");
      await expect(title).toHaveValue(topicTitle);
      await expect(direction).toHaveValue(topicDirection);
      await resizeComposerViewport(page, "landscape");
      await page.reload();
      await expect(title).toHaveValue(topicTitle);
      await expect(direction).toHaveValue(topicDirection);
      await expect(hidden).toBeChecked();
      await expect(composerLocator(page)).toBeVisible();
      expect(new URL(page.url()).searchParams.get("creationDraftId")).toBe(draftId);

      await expect(
        page.getByRole("button", { name: "Select model (Ten second stream)" }),
      ).toBeVisible();
      await dropFileOnComposer(page, {
        name: "evidence.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("Attachment only"),
      });
      await expectAttachmentPill(page, "composer-file-attachment-pill");
      const submit = page.getByTestId("topic-create-submit");
      await expect(submit).toHaveAccessibleName("Create and ask");
      await submit.click();
      await page.waitForURL((url) => url.pathname.includes("/workspace/"));
      expect(requests).toEqual([
        expect.objectContaining({
          type: "workspace.create.request",
          title: topicTitle,
          topic: { summary: topicDirection, hideFromModel: true },
          agent: expect.objectContaining({
            initialPrompt: "",
            clientMessageId: `${draftId}:initial-message`,
            workspaceRole: "main",
            attachments: [
              expect.objectContaining({
                type: "uploaded_file",
                fileName: "evidence.txt",
                mimeType: "text/plain",
                size: Buffer.byteLength("Attachment only"),
              }),
            ],
          }),
        }),
      ]);
      await openGlobalNewWorkspaceComposer(page);
      await expect(title).toHaveValue("");
      await firstQuestion.click();
      await expect(page.getByTestId("composer-file-attachment-pill")).toHaveCount(0);
    } finally {
      await project.cleanup();
    }
  },
);

topicTest(
  "a late topic receipt preserves the draft edited in another browser page",
  async ({ page }) => {
    const project = await seedWorkspace({ repoPrefix: "topic-draft-ownership-", git: false });
    const nextProject = await seedWorkspace({ repoPrefix: "topic-next-draft-", git: false });
    const delayed = await delayBrowserWorkspaceCreatedResponse(page);
    const nextPage = await page.context().newPage();
    await nextPage.route(/:(6767)\b/, (route) => route.abort());
    await nextPage.routeWebSocket(/:(6767)\b/, (ws) =>
      ws.close({ code: 1008, reason: "Blocked connection to localhost:6767 during e2e." }),
    );
    const nextPrompt = "Keep this new draft when the previous topic finishes.";
    try {
      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await openNewWorkspaceComposer(page, project);
      await page.getByTestId("new-topic-title").fill("First topic");
      await page.getByRole("button", { name: "Attach a first question" }).click();
      await fillNewWorkspaceDraft(page, DRAFT);
      await page.getByTestId("topic-create-submit").click();
      await delayed.waitForCreateRequest();

      await gotoAppShell(nextPage);
      await waitForSidebarHydration(nextPage);
      await openNewWorkspaceComposer(nextPage, nextProject);
      await nextPage.getByTestId("new-topic-title").fill("New topic");
      await nextPage.getByRole("button", { name: "Attach a first question" }).click();
      await fillNewWorkspaceDraft(nextPage, nextPrompt);
      await expect
        .poll(() => nextPage.evaluate(() => localStorage.getItem("paseo-drafts")))
        .toContain(nextPrompt);
      delayed.release();
      await page.waitForURL((url) => url.pathname.includes("/workspace/"));
      await nextPage.reload();
      await expectNewWorkspaceDraft(nextPage, nextPrompt);
    } finally {
      delayed.release();
      await nextPage.close();
      await nextProject.cleanup();
      await project.cleanup();
    }
  },
);

test.describe("New workspace composer draft", () => {
  test.describe.configure({ timeout: 240_000 });

  test("keeps the draft when the project changes", async ({ page }) => {
    const firstProject: SeededWorkspace = await seedWorkspace({
      repoPrefix: "new-workspace-draft-project-a-",
    });
    const secondProject: SeededWorkspace = await seedWorkspace({
      repoPrefix: "new-workspace-draft-project-b-",
    });

    try {
      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await openNewWorkspaceComposer(page, {
        projectKey: firstProject.projectKey,
        projectDisplayName: firstProject.projectDisplayName,
      });
      await expectNewWorkspaceProjectSelected(page, firstProject.projectDisplayName);

      await fillNewWorkspaceDraft(page, DRAFT);

      await selectNewWorkspaceProject(page, {
        projectKey: secondProject.projectKey,
        projectDisplayName: secondProject.projectDisplayName,
      });

      await expectNewWorkspaceDraft(page, DRAFT);
    } finally {
      await secondProject.cleanup();
      await firstProject.cleanup();
    }
  });

  test("keeps the draft when the host changes", async ({ page }) => {
    const project: SeededWorkspace = await seedWorkspace({
      repoPrefix: "new-workspace-draft-host-",
    });
    const secondaryServerId = "new-workspace-draft-secondary-host";

    try {
      await seedSavedSettingsHosts(page, [
        {
          serverId: getServerId(),
          label: "Primary host",
          endpoint: `127.0.0.1:${getE2EDaemonPort()}`,
        },
        {
          serverId: secondaryServerId,
          label: "Secondary host",
          endpoint: "127.0.0.1:9",
        },
      ]);

      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await openGlobalNewWorkspaceComposer(page);

      await fillNewWorkspaceDraft(page, DRAFT);
      await selectNewWorkspaceHost(page, "Secondary host");

      await expectNewWorkspaceDraft(page, DRAFT);
    } finally {
      await project.cleanup();
    }
  });

  test("does not restore a submitted draft after deferred publication", async ({ page }) => {
    const project = await seedWorkspace({ repoPrefix: "new-workspace-submitted-draft-" });

    try {
      await startWithoutRememberedModel(page);
      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await openNewWorkspaceComposer(page, {
        projectKey: project.projectKey,
        projectDisplayName: project.projectDisplayName,
      });

      await chooseModel(page, "mock", "Ten second stream");
      const composer = page.getByRole("textbox", { name: "Message agent..." });
      const createButton = page.getByTestId("workspace-create-submit");
      await expect(composer).toBeEditable({ timeout: 30_000 });
      await expect(createButton).toBeEnabled({ timeout: 30_000 });

      await composer.evaluate((element, draft) => {
        if (!(element instanceof HTMLTextAreaElement)) {
          throw new Error("Composer input is not a textarea");
        }
        const valueSetter = Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype,
          "value",
        )?.set;
        if (!valueSetter) throw new Error("Textarea value setter is unavailable");
        valueSetter.call(element, draft);
        element.dispatchEvent(
          new InputEvent("input", {
            bubbles: true,
            data: draft,
            inputType: "insertText",
          }),
        );
        const button = document.querySelector('[data-testid="workspace-create-submit"]');
        if (!(button instanceof HTMLElement)) {
          throw new Error("Create button is unavailable");
        }
        button.click();
      }, DRAFT);

      await page.waitForURL((url) => url.pathname.includes("/workspace/"), { timeout: 30_000 });
      await openGlobalNewWorkspaceComposer(page);
      await expectNewWorkspaceDraft(page, "");
    } finally {
      await project.cleanup();
    }
  });
});

test("fullscreen creation returns inline and keeps submission locked when reopened", async ({
  page,
}) => {
  const project = await seedWorkspace({ repoPrefix: "fullscreen-submit-pending-" });
  const delay = await delayBrowserWorkspaceCreatedResponse(page);
  try {
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await openNewWorkspaceComposer(page, project);
    await resizeComposerViewport(page, "portrait");
    await fillNewWorkspaceDraft(page, DRAFT);
    await enterComposerFullscreen(page);
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await delay.waitForCreateRequest();

    await test.step("submission returns inline with the original draft and spinner", async () => {
      await expect(page.getByTestId("composer-fullscreen")).toHaveCount(0);
      await expect(composerLocator(page)).toHaveValue(DRAFT);
      await expect(composerLocator(page)).not.toBeEditable();
      await expect(page.getByRole("button", { name: "Create", exact: true })).toBeDisabled();
      await expect(page.getByRole("progressbar")).toBeVisible();
    });
    await test.step("fullscreen can reopen while pending without unlocking or duplicating submission", async () => {
      await enterComposerFullscreen(page);
      await expect(page.getByTestId("composer-fullscreen")).toBeVisible();
      await expect(composerLocator(page)).toHaveValue(DRAFT);
      await expect(composerLocator(page)).not.toBeEditable();
      await expect(page.getByRole("button", { name: "Create", exact: true })).toBeDisabled();
      await expect(page.getByRole("progressbar")).toBeVisible();
      await exitComposerFullscreen(page);
    });
    delay.release();
    await page.waitForURL((url) => url.pathname.includes("/workspace/"));
    await expect(composerLocator(page)).toHaveValue("");
    await expect(composerLocator(page)).toBeEditable();
    expect(delay.agentRequests).toHaveLength(1);
  } finally {
    delay.release();
    await project.cleanup();
  }
});
