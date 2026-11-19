import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { expect, type Locator, type Page } from "@playwright/test";
import { test } from "../support/fixtures";
import { connectSeedClient } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import { createTempGitRepo } from "../support/helpers/workspace";
import {
  createIdleAgent,
  openSessions,
  resetSeededPageState,
  selectSessionsTab,
} from "../support/helpers/archive-tab";

/**
 * Prefix seeded titles with the same nonce to scope search to this spec's sessions.
 */
const NONCE = `hsq${randomUUID().replaceAll("-", "").slice(0, 8)}`;

const TITLES = {
  billing: `${NONCE} main Add Stripe billing`,
  unbilled: `${NONCE} main Unbilled usage report`,
  terminal: `${NONCE} main Terminal resize fix`,
} as const;
const WORKSPACE_TITLE = "Main history";
const RECENT_TITLES = [TITLES.unbilled, TITLES.billing, TITLES.terminal];

interface HistoryGroup {
  projectName: string;
  workspaceKey: string;
}

async function search(page: Page, query: string): Promise<void> {
  await page.getByTestId("sessions-search-input").fill(query);
}

function historyTitles(page: Page) {
  return page.getByTestId(/^agent-row-title-/).filter({ hasText: NONCE });
}

async function expectVisibleTitles(page: Page, titles: string[]): Promise<void> {
  await expect(historyTitles(page)).toHaveText(titles, { timeout: 30_000 });
}

function historyHeadings(page: Page, { projectName, workspaceKey }: HistoryGroup) {
  const project = page.getByTestId(/^history-project-header-/).filter({
    has: page.getByTestId(/^history-project-name-/).filter({ hasText: projectName }),
  });
  const workspace = page.getByTestId(`history-workspace-header-${workspaceKey}`);
  return { project, workspace };
}

async function verifyGroupedFiltering(page: Page, group: HistoryGroup): Promise<void> {
  await test.step("keeps sessions under one project and workspace in recent activity order", async () => {
    const { project, workspace } = historyHeadings(page, group);
    const headingsAndTitles = project.or(workspace).or(historyTitles(page));
    const headings = [new RegExp(group.projectName), new RegExp(WORKSPACE_TITLE)];
    await expect(headingsAndTitles).toHaveText([...headings, ...RECENT_TITLES], {
      timeout: 30_000,
    });

    await search(page, `${NONCE} billing`);
    await expect(headingsAndTitles).toHaveText([...headings, TITLES.billing], {
      timeout: 30_000,
    });

    await page.getByTestId("sessions-search-clear").click();
    await expect(page.getByTestId("sessions-search-input")).toHaveValue("");
    await expect(headingsAndTitles).toHaveText([...headings, ...RECENT_TITLES], {
      timeout: 30_000,
    });
  });
}

async function verifyHistorySurvivesReload(page: Page): Promise<void> {
  await test.step("reloads History without visiting a workspace to reconnect", async () => {
    await expectVisibleTitles(page, RECENT_TITLES);
    await page.reload();
    await expect(page.getByTestId("sessions-tab-archived")).toHaveAttribute(
      "aria-selected",
      "true",
      {
        timeout: 30_000,
      },
    );
    await selectSessionsTab(page, "active");
    await expectVisibleTitles(page, RECENT_TITLES);
    await expect(page.getByTestId("sessions-host-errors")).toBeHidden();
  });
}

async function verifyRecencyBeforeMatchStrength(page: Page): Promise<void> {
  await test.step("keeps newer partial matches before older stronger matches", async () => {
    await search(page, `${NONCE} bill`);
    await expectVisibleTitles(page, [TITLES.unbilled, TITLES.billing]);
  });
}

async function expectHighlight(field: Locator, text: RegExp): Promise<void> {
  const match = field.getByText(text);
  await expect(match).toBeVisible({ timeout: 30_000 });
  await expect(match).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
}

async function verifyExactAndTypoHighlights(page: Page): Promise<void> {
  await test.step("highlights exact and typo-resolved matches", async () => {
    await search(page, `${NONCE} billing`);
    await expectVisibleTitles(page, [TITLES.billing]);
    const title = historyTitles(page);
    await expectHighlight(title, /^billing$/);

    await search(page, `${NONCE} terminal`);
    await expectVisibleTitles(page, [TITLES.terminal]);

    await search(page, `${NONCE} bulling`);
    await expectVisibleTitles(page, [TITLES.billing]);
    await expectHighlight(title, /^billing$/);
  });
}

async function verifyAllSearchFieldHighlights(page: Page, group: HistoryGroup): Promise<void> {
  await test.step("highlights workspace, agent, project and branch independently", async () => {
    await search(page, `${NONCE} main`);
    await expectVisibleTitles(page, RECENT_TITLES);
    const { project, workspace } = historyHeadings(page, group);
    for (const field of [
      project.getByTestId(/^history-project-name-/),
      workspace.getByTestId(`history-workspace-name-${group.workspaceKey}`),
      workspace.getByTestId(`history-workspace-branch-${group.workspaceKey}`),
      historyTitles(page).first(),
    ]) {
      await expectHighlight(field, /^main$/i);
    }
  });
}

async function verifyEmptySearchAndRecovery(page: Page): Promise<void> {
  await test.step("distinguishes no matches from empty history", async () => {
    await search(page, `${NONCE} kubernetes`);
    const empty = page.getByTestId("sessions-empty");
    await expect(empty.getByText("No sessions match", { exact: true })).toBeVisible({
      timeout: 30_000,
    });

    await empty.getByRole("button", { name: "Clear search", exact: true }).click();
    await expectVisibleTitles(page, RECENT_TITLES);
  });
}

test.describe("History search", () => {
  let client: Awaited<ReturnType<typeof connectSeedClient>>;
  let tempRepo: { path: string; cleanup: () => Promise<void> };
  let projectId: string;
  let workspaceId: string;

  test.describe.configure({ timeout: 300_000 });

  test.beforeAll(async () => {
    tempRepo = await createTempGitRepo("main-sessions-search-");
    client = await connectSeedClient();
    const created = await client.createWorkspace({
      source: { kind: "directory", path: tempRepo.path },
      title: WORKSPACE_TITLE,
    });
    if (!created.workspace) {
      throw new Error(created.error ?? `Failed to create workspace ${tempRepo.path}`);
    }
    projectId = created.workspace.projectId;
    workspaceId = created.workspace.id;

    for (const title of [TITLES.terminal, TITLES.billing, TITLES.unbilled]) {
      await createIdleAgent(client, { cwd: tempRepo.path, workspaceId, title });
    }
  });

  test.afterAll(async () => {
    await client?.removeProject(projectId).catch(() => undefined);
    await client?.close().catch(() => undefined);
    await tempRepo?.cleanup();
  });

  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 390, height: 844 },
  ]) {
    test(`filters grouped history and highlights matches at ${viewport.width}px`, async ({
      page,
    }) => {
      await resetSeededPageState(page);
      await openSessions(page, { tab: "active" });
      await page.setViewportSize(viewport);

      const group = {
        projectName: basename(tempRepo.path),
        workspaceKey: `${getServerId()}:${workspaceId}`,
      };
      await verifyGroupedFiltering(page, group);

      await verifyHistorySurvivesReload(page);

      await verifyRecencyBeforeMatchStrength(page);

      await verifyExactAndTypoHighlights(page);

      await verifyAllSearchFieldHighlights(page, group);

      await verifyEmptySearchAndRecovery(page);
    });
  }
});
