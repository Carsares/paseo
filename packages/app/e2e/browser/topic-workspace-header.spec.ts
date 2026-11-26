import { writeFile } from "node:fs/promises";
import type { Locator, Page, TestInfo } from "@playwright/test";
import { expect, test as base } from "../support/fixtures";
import { runWorkspaceActionFromCommandCenter } from "../support/helpers/command-center-workspace-actions";
import { openAgentRoute } from "../support/helpers/mock-agent";
import { renameModalInput, renameModalSubmit } from "../support/helpers/rename";
import { seedWorkspace } from "../support/helpers/seed-client";
import { selectWorkspaceInSidebar } from "../support/helpers/sidebar";
import { dragTabIntoExplorer, ensureExplorerSidebar } from "../support/helpers/workspace-tabs";

const title = "Topic workspace with a long title for compact header layout";
const direction = "Measure header layout before changing the workspace controls.";
const mainPrompt = "What should the Main Session check first?";
const specialistRole = "Layout specialist";
const specialistPrompt = "Check the compact header on a narrow viewport.";

const test = base.extend<{ topic: { workspaceId: string; mainId: string; specialistId: string } }>({
  topic: async ({ projectOwnership }, provide) => {
    void projectOwnership;
    const workspace = await seedWorkspace({
      repoPrefix: "topic-header-",
      title,
      topic: { summary: direction },
    });
    try {
      await workspace.client.renameProject(
        workspace.projectId,
        "Customer integration with a long project name",
      );
      const agentConfig = {
        provider: "mock",
        cwd: workspace.repoPath,
        workspaceId: workspace.workspaceId,
        modeId: "load-test",
        model: "e2e-fast-stream",
      };
      const main = await workspace.client.createAgent({
        ...agentConfig,
        workspaceRole: "main",
        title: "Header review main session",
        initialPrompt: mainPrompt,
      });
      const specialist = await workspace.client.createAgent({
        ...agentConfig,
        title: specialistRole,
        initialPrompt: specialistPrompt,
      });
      await workspace.client.setAgentParent(specialist.id, main.id);
      await workspace.client.setAgentResident(specialist.id, true, { role: specialistRole });
      await provide({
        workspaceId: workspace.workspaceId,
        mainId: main.id,
        specialistId: specialist.id,
      });
    } finally {
      await workspace.cleanup();
    }
  },
});

function visible(page: Page, testId: string): Locator {
  return page.getByTestId(testId).filter({ visible: true });
}

function member(page: Page, agentId: string): Locator {
  return visible(page, "workspace-team-directory").getByTestId(`team-directory-row-${agentId}`);
}

async function chooseDesktopMember(page: Page, agentId: string) {
  const directory = visible(page, "workspace-team-directory");
  if (!(await directory.isVisible())) {
    await visible(page, "topic-header-toggle-directory").click();
  }
  await expect(directory).toBeVisible();
  const row = member(page, agentId);
  if (!(await row.isVisible())) {
    await directory.getByTestId("team-directory-toggle-inactive").click();
  }
  await row.click();
}

async function openMain(page: Page, topic: { workspaceId: string; mainId: string }) {
  await openAgentRoute(page, { workspaceId: topic.workspaceId, agentId: topic.mainId });
  await expect(visible(page, "workspace-header-title")).toHaveText(title);
  await expect(visible(page, "topic-stream-list")).toBeVisible();
}

async function expectNoTopicRails(page: Page) {
  await expect(visible(page, "topic-header-direction-toggle")).toHaveCount(0);
  await expect(visible(page, "topic-header-direction-body")).toHaveCount(0);
  await expect(visible(page, "workspace-tabs-row")).toHaveCount(0);
}

async function expectHeaderFits(
  page: Page,
  info: TestInfo,
  controlTestId: string,
  desktop: boolean,
  minimumTitleWidth?: number,
) {
  const header = visible(page, "workspace-topic-header");
  const measureRect = (locator: Locator) =>
    locator.evaluate((element) => {
      const { x, y, width, height } = element.getBoundingClientRect();
      return { x, y, width, height };
    });
  const measure = async () => ({
    viewport: page.viewportSize()!.width,
    title: await measureRect(header.getByTestId("workspace-header-title")),
    team: await measureRect(header.getByTestId(controlTestId)),
    menu: await measureRect(header.getByTestId("workspace-header-menu-trigger")),
    mode: await measureRect(header.getByTestId("topic-stream-mode-switch")),
    header: await measureRect(header),
    documentWidth: await page.evaluate(() => document.documentElement.scrollWidth),
  });
  await writeFile(info.outputPath("header-bounds.json"), JSON.stringify(await measure(), null, 2));
  await page.screenshot({ path: info.outputPath("workspace-header.png") });
  // Keep exercising the compact menus even if the title is clipped at this width.
  const expectGeometry = expect.configure({ soft: !desktop && minimumTitleWidth === undefined });
  await expectGeometry(async () => {
    const view = await measure();
    const controls = { title: view.title, team: view.team, menu: view.menu, mode: view.mode };
    for (const [name, box] of Object.entries(controls)) {
      expect(box.x, `${name} starts inside the viewport`).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width, `${name} ends inside the viewport`).toBeLessThanOrEqual(
        view.viewport + 1,
      );
      expect(box.width, `${name} has visible width`).toBeGreaterThan(0);
    }
    const byPosition = Object.values(controls).sort((a, b) => a.x - b.x);
    for (let index = 1; index < byPosition.length; index++) {
      expect(byPosition[index - 1]!.x + byPosition[index - 1]!.width).toBeLessThanOrEqual(
        byPosition[index]!.x + 1,
      );
    }
    expect(view.documentWidth).toBeLessThanOrEqual(view.viewport);
    if (minimumTitleWidth !== undefined) {
      expect(view.title.width, "title keeps space when a terminal is open").toBeGreaterThanOrEqual(
        minimumTitleWidth,
      );
    }
    if (desktop) {
      // The controls, menu and title must overlap vertically in the same header row.
      expect(Math.max(...byPosition.map((box) => box.y))).toBeLessThan(
        Math.min(...byPosition.map((box) => box.y + box.height)),
      );
      for (const box of byPosition) {
        const centerY = box.y + box.height / 2;
        expect(centerY).toBeGreaterThanOrEqual(view.header.y);
        expect(centerY).toBeLessThanOrEqual(view.header.y + view.header.height);
      }
    }
  }).toPass({ timeout: 5_000 });
}

async function switchStreamModes(page: Page, collapsed: boolean) {
  const switcher = visible(page, "topic-stream-mode-switch");
  const selectMode = async (mode: "topics" | "timeline") => {
    if (collapsed) await switcher.click();
    await visible(page, `topic-stream-mode-${mode}`).click();
  };
  await selectMode("timeline");
  const timeline = visible(page, "agent-chat-scroll");
  await expect(timeline.getByText(mainPrompt, { exact: true })).toBeVisible();
  await expect(visible(page, "topic-stream-list")).toHaveCount(0);

  await selectMode("topics");
  await expect(visible(page, "topic-stream-list")).toBeVisible();
  await expect(timeline).toHaveCount(0);
}

test("desktop topic uses one header row and navigates through the team directory", async ({
  page,
  topic,
}, info) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await openMain(page, topic);
  await expectNoTopicRails(page);
  await expectHeaderFits(page, info, "topic-header-toggle-directory", true);

  await test.step("find the existing direction in the workspace overflow", async () => {
    await expect(page.getByText(direction, { exact: true })).toHaveCount(0);
    await visible(page, "workspace-header-menu-trigger").click();
    await visible(page, "workspace-header-direction").click();
    const dialog = visible(page, "workspace-direction-dialog");
    await expect(dialog.getByText(direction, { exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath("direction-dialog.png") });
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  });

  await test.step("switch between the main stream and specialist conversation", async () => {
    const directory = visible(page, "workspace-team-directory");
    await expect(directory).toBeVisible();
    const toggle = visible(page, "topic-header-toggle-directory");
    await toggle.click();
    await expect(directory).toHaveCount(0);
    await toggle.click();
    await member(page, topic.specialistId).click();
    await expect(
      visible(page, "agent-chat-scroll").getByText(specialistPrompt, { exact: true }),
    ).toBeVisible();
    await expect(visible(page, "topic-stream-list")).toHaveCount(0);
    await visible(page, "workspace-header-back-to-main").click();
    await expect(visible(page, "topic-stream-list")).toBeVisible();
    await expectNoTopicRails(page);
  });

  await test.step("round-trip through the stream mode control", async () => {
    await switchStreamModes(page, false);
  });

  await test.step("open a conversation draft using the team directory's plus button", async () => {
    await visible(page, "workspace-team-directory")
      .getByTestId("team-directory-create-resident")
      .click();
    await visible(page, "team-directory-create-conversation").click();
    await expect(visible(page, "topic-stream-list")).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "Message agent..." })).toBeEditable();
    await member(page, topic.mainId).click();
    await expect(visible(page, "topic-stream-list")).toBeVisible();
  });
});

test("topic directory jumps to the specialist's existing split pane", async ({ page, topic }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "platform", { get: () => "MacIntel" });
  });
  await openMain(page, topic);
  const specialist = member(page, topic.specialistId);
  await specialist.click();
  await runWorkspaceActionFromCommandCenter(page, "Split pane right");
  await expect(visible(page, "workspace-split-resize-handle")).toHaveCount(1);
  const mainPane = visible(page, "workspace-pane-main");
  const specialistTabId = `workspace-tab-agent_${topic.specialistId}`;
  await mainPane.getByTestId(specialistTabId).click();
  await page.keyboard.press("Meta+Alt+Shift+ArrowRight");
  const visibleSidePane = page
    .locator('[data-testid^="workspace-pane-"]:not([data-testid="workspace-pane-main"])')
    .filter({ visible: true });
  await expect(visibleSidePane.getByText(specialistPrompt, { exact: true })).toBeVisible();
  const specialistPaneId = await visibleSidePane.getAttribute("data-testid");
  if (!specialistPaneId) throw new Error("The specialist split pane has no test ID");
  const sidePane = page.getByTestId(specialistPaneId);
  const specialistMessage = sidePane.getByText(specialistPrompt, { exact: true });

  await member(page, topic.mainId).click();
  await expect(visible(page, "workspace-header-back-to-main")).toHaveCount(0);
  // The team drawer closes on navigation when the split uses the narrower desktop layout.
  await chooseDesktopMember(page, topic.specialistId);
  await expect(visible(page, "workspace-header-back-to-main")).toBeVisible();
  await expect(specialistMessage).toBeVisible();
  await expect(mainPane.getByTestId("topic-stream-list")).toBeVisible();

  await visible(page, "workspace-header-back-to-main").click();
  await expect(visible(page, "workspace-header-back-to-main")).toHaveCount(0);
  await expect(visible(page, "workspace-header-title")).toHaveCount(1);
  await expect(visible(page, "workspace-split-resize-handle")).toHaveCount(1);
  await expect(mainPane.getByTestId("topic-stream-list")).toBeVisible();
  await expect(specialistMessage).toBeVisible();

  const splitHandle = visible(page, "workspace-split-resize-handle");
  const mainStream = page.getByTestId("workspace-pane-main").getByTestId("topic-stream-list");
  const backToMain = visible(page, "workspace-header-back-to-main");

  await test.step("return to Main from the maximized specialist pane", async () => {
    await chooseDesktopMember(page, topic.specialistId);
    await sidePane.getByTestId("workspace-maximize-pane").click();
    await expect(splitHandle).toHaveCount(0);
    await expect(mainStream).toBeHidden();
    await expect(specialistMessage).toBeVisible();

    await backToMain.click();
    await expect(backToMain).toHaveCount(0);
    await expect(mainStream).toBeVisible();
    await expect(splitHandle).toHaveCount(1);
    await expect(specialistMessage).toBeVisible();
  });

  await test.step("select a specialist whose original pane is hidden by maximize", async () => {
    await mainPane.getByTestId("workspace-maximize-pane").click();
    await expect(splitHandle).toHaveCount(0);
    await expect(specialistMessage).toBeHidden();

    await chooseDesktopMember(page, topic.specialistId);
    await expect(backToMain).toBeVisible();
    await expect(splitHandle).toHaveCount(1);
    await expect(mainStream).toBeVisible();
    await expect(specialistMessage).toBeVisible();
  });
});

test("topic navigation brings sessions back from the Explorer dock", async ({ page, topic }) => {
  await page.setViewportSize({ width: 1900, height: 900 });
  await openMain(page, topic);
  await member(page, topic.specialistId).click();
  // Splitting exposes the draggable rails without moving either session out of the main pane.
  await runWorkspaceActionFromCommandCenter(page, "Split pane right");
  await expect(visible(page, "workspace-split-resize-handle")).toHaveCount(1);
  const explorer = await ensureExplorerSidebar(page);
  const mainPane = visible(page, "workspace-pane-main");
  const mainStream = mainPane.getByTestId("topic-stream-list");
  const specialistMessage = mainPane.getByText(specialistPrompt, { exact: true });
  const mainTabId = `agent_${topic.mainId}`;
  const specialistTabId = `agent_${topic.specialistId}`;

  await test.step("return to the Main Session parked in Explorer", async () => {
    await expect(mainPane.getByTestId(`workspace-tab-${mainTabId}`)).toBeVisible();
    await dragTabIntoExplorer(page, mainTabId);
    const dockedTab = explorer.getByTestId(`workspace-tab-${mainTabId}`);
    await expect(dockedTab).toBeVisible();
    await expect(mainPane.getByTestId(`workspace-tab-${mainTabId}`)).toHaveCount(0);

    await mainPane.getByTestId(`workspace-tab-${specialistTabId}`).click({
      position: { x: 12, y: 13 },
    });
    await expect(specialistMessage).toBeVisible();
    await visible(page, "workspace-header-back-to-main").click();
    await expect(mainStream).toBeVisible();
    await expect(dockedTab).toHaveCount(0);
  });

  await test.step("choose the docked specialist from the team directory", async () => {
    await expect(mainPane.getByTestId(`workspace-tab-${specialistTabId}`)).toBeVisible();
    await dragTabIntoExplorer(page, specialistTabId);
    const dockedTab = explorer.getByTestId(`workspace-tab-${specialistTabId}`);
    await expect(dockedTab).toBeVisible();
    await expect(mainPane.getByTestId(`workspace-tab-${specialistTabId}`)).toHaveCount(0);
    await expect(mainStream).toBeVisible();

    await chooseDesktopMember(page, topic.specialistId);
    await expect(specialistMessage).toBeVisible();
    await expect(dockedTab).toHaveCount(0);
  });
});

test("compact topic keeps the header within 320 px and opens its team sheet", async ({
  page,
  topic,
}, info) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openMain(page, topic);
  await page.setViewportSize({ width: 320, height: 844 });
  await expect(visible(page, "workspace-header-team")).toBeVisible();
  await expectNoTopicRails(page);
  await expectHeaderFits(page, info, "workspace-header-team", false);
  await switchStreamModes(page, true);

  const teamButton = visible(page, "workspace-header-team");
  const directory = visible(page, "workspace-team-directory");
  await expect(directory).toHaveCount(0);
  await teamButton.click();
  await expect(member(page, topic.specialistId)).toBeVisible();
  await page.screenshot({ path: info.outputPath("compact-team-sheet.png") });
  await member(page, topic.specialistId).click();
  await expect(directory).toHaveCount(0);
  await expect(
    visible(page, "agent-chat-scroll").getByText(specialistPrompt, { exact: true }),
  ).toBeVisible();
  await visible(page, "workspace-header-back-to-main").click();
  await expect(visible(page, "topic-stream-list")).toBeVisible();
  await expect(teamButton).toBeVisible();

  await test.step("switch workspaces through the compact navigation menu", async () => {
    const otherTitle = "Second topic for compact workspace navigation";
    const otherWorkspace = await seedWorkspace({
      repoPrefix: "topic-header-switch-target-",
      title: otherTitle,
      topic: { summary: "Review navigation between topic workspaces." },
    });
    try {
      const navigation = visible(page, "workspace-topic-header").getByTestId("menu-button");
      await navigation.click();
      await selectWorkspaceInSidebar(page, otherWorkspace.workspaceId);
      await expect(visible(page, "workspace-header-title")).toHaveText(otherTitle);
      await navigation.click();
      await selectWorkspaceInSidebar(page, topic.workspaceId);
      await expect(visible(page, "workspace-header-title")).toHaveText(title);
      await expect(visible(page, "topic-stream-list")).toBeVisible();
    } finally {
      await otherWorkspace.cleanup();
    }
  });
});

test("compact topic leaves room for its title and keeps an open terminal reachable", async ({
  context,
  page,
  topic,
}, info) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openMain(page, topic);
  await runWorkspaceActionFromCommandCenter(page, "New terminal");
  const terminalSurface = visible(page, "terminal-surface");
  await expect(terminalSurface).toBeVisible();
  const terminalTab = page
    .locator('[data-testid^="workspace-tab-terminal_"]')
    .filter({ visible: true });
  await expect(terminalTab).toHaveCount(1);
  const terminalTabId = await terminalTab.getAttribute("data-testid");
  if (!terminalTabId) throw new Error("The terminal tab has no test ID");
  const terminalKey = terminalTabId.replace("workspace-tab-", "");

  await page.setViewportSize({ width: 320, height: 844 });
  const team = visible(page, "workspace-header-team");
  await team.click();
  await member(page, topic.mainId).click();
  await expect(visible(page, "topic-stream-list")).toBeVisible();
  await expect(terminalSurface).toHaveCount(0);
  await expectNoTopicRails(page);
  await expectHeaderFits(page, info, "workspace-header-team", false, 50);

  // All three actions must be usable with the terminal still open.
  await team.click();
  await expect(member(page, topic.mainId)).toBeVisible();
  await member(page, topic.mainId).click();
  await switchStreamModes(page, true);
  await visible(page, "workspace-header-menu-trigger").click();
  await visible(page, "workspace-header-tabs").click();
  await visible(page, `workspace-header-tab-${terminalKey}`).click();
  await expect(terminalSurface).toBeVisible();
  await expect(visible(page, "topic-stream-list")).toHaveCount(0);

  await team.click();
  await member(page, topic.mainId).click();
  const mainStream = visible(page, "topic-stream-list");
  await expect(mainStream).toBeVisible();
  await expect(terminalSurface).toHaveCount(0);

  const workspaceMenu = visible(page, "workspace-header-menu-content");
  const workspaceTabs = visible(page, "workspace-header-tabs");
  const terminalOption = visible(page, `workspace-header-tab-${terminalKey}`);
  const terminalActions = visible(page, `workspace-header-tab-actions-${terminalKey}`);
  const actionId = `workspace-tab-menu-${terminalKey}`;
  const openTerminalActions = async () => {
    await visible(page, "workspace-header-menu-trigger").click();
    await workspaceTabs.click();
    await expect(terminalOption).toBeVisible();
    await expect(terminalActions).toBeVisible();
    await terminalActions.click();
    await expect(terminalSurface).toHaveCount(0);
  };

  const terminalId = terminalKey.replace(/^terminal_/, "");
  const readClipboard = () => page.evaluate(() => navigator.clipboard.readText());
  await test.step("copy and rename the background terminal from its own menu", async () => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await openTerminalActions();
    await visible(page, `${actionId}-copy-terminal-id`).click();
    await expect.poll(readClipboard).toBe(terminalId);
    await expect(mainStream).toBeVisible();
    await expect(terminalSurface).toHaveCount(0);

    await openTerminalActions();
    await visible(page, `${actionId}-rename`).click();
    const renameModal = `workspace-tab-rename-modal-terminal-${terminalId}`;
    const terminalTitle = "Background terminal for header review";
    await renameModalInput(page, renameModal).fill(terminalTitle);
    await renameModalSubmit(page, renameModal).click();
    await expect(renameModalInput(page, renameModal)).toHaveCount(0);
    await expect(mainStream).toBeVisible();
    await expect(terminalSurface).toHaveCount(0);

    await visible(page, "workspace-header-menu-trigger").click();
    await workspaceTabs.click();
    await expect(terminalOption).toHaveText(terminalTitle);
  });

  await test.step("close the background terminal while staying on Main", async () => {
    await terminalActions.click();
    await expect(terminalSurface).toHaveCount(0);
    const closeTerminal = visible(page, `${actionId}-close`);
    await expect(closeTerminal).toBeVisible();
    const confirmation = page.waitForEvent("dialog", { timeout: 10_000 }).then(async (dialog) => {
      const message = dialog.message();
      await dialog.accept();
      return message;
    });
    const [message] = await Promise.all([confirmation, closeTerminal.click()]);
    expect(message).toContain("Close terminal?");
    await expect(mainStream).toBeVisible();
    await expect(terminalSurface).toHaveCount(0);

    // The confirmation resolves before the bottom sheet finishes dismissing.
    await expect(page.getByTestId("workspace-header-menu-content")).toHaveCount(0);
    await visible(page, "workspace-header-menu-trigger").click();
    await expect(workspaceMenu).toBeVisible();
    // The terminal was the only tab outside the team directory.
    await expect(workspaceTabs).toHaveCount(0);
  });
});
