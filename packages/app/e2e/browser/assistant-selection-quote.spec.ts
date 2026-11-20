import { expect, test, type Page } from "../support/fixtures";
import {
  assistantMessageBlocks,
  selectAssistantTextRange,
} from "../support/helpers/assistant-selection";
import {
  openAgentRoute,
  seedMockAgentWorkspace,
  type MockAgentWorkspace,
} from "../support/helpers/mock-agent";

const ASSISTANT_MARKDOWN = [
  "Intro paragraph with **bold words** and a [docs link](https://example.com/docs).",
  "",
  "- First point",
  "- Second point",
  "",
  "```ts",
  "const quoted = true;",
  "```",
  "",
  "Closing paragraph.",
].join("\n");

function composer(page: Page) {
  return page.getByRole("textbox", { name: "Message agent..." });
}

function quoteButton(page: Page) {
  return page.getByRole("button", { name: "Quote", exact: true });
}

function quoteCards(page: Page) {
  return page.getByTestId("composer-quote-card");
}

async function openIdleAgent(page: Page, repoPrefix: string): Promise<MockAgentWorkspace> {
  const agent = await seedMockAgentWorkspace({
    repoPrefix,
    title: "Assistant selection quote",
    initialPrompt: "Render the quote fixture.",
    featureValues: { mockAssistantResponse: ASSISTANT_MARKDOWN },
  });
  await agent.client.waitForAgentUpsert(
    agent.agentId,
    (snapshot) => snapshot.status === "idle",
    30_000,
  );
  await openAgentRoute(page, agent);
  await expect(assistantMessageBlocks(page).getByText("Closing paragraph.")).toBeVisible();
  return agent;
}

test("quoting selections adds cards without changing or sending the draft", async ({
  context,
  page,
}) => {
  const agent = await openIdleAgent(page, "assistant-selection-quote-");
  try {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await composer(page).fill("Draft start");

    await selectAssistantTextRange(page, "Intro paragraph", "const quoted = true;");
    await expect(quoteButton(page)).toBeVisible();

    // Copy works as before while the button shows, and Quote reads the same Markdown.
    await page.keyboard.press("ControlOrMeta+c");
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toContain("**bold words**");
    expect(copied).toContain("[docs link](https://example.com/docs)");
    expect(copied).toContain("- First point\n- Second point");
    expect(copied).toContain("```ts\nconst quoted = true;\n```");

    await quoteButton(page).click();
    await expect(quoteButton(page)).toHaveCount(0);
    await expect(composer(page)).toBeFocused();
    await expect(composer(page)).toHaveValue("Draft start");
    await expect(quoteCards(page)).toHaveCount(1);
    await expect(quoteCards(page).first()).toContainText(copied);

    // Quote another selection through its context menu, with a different focus owner.
    await assistantMessageBlocks(page)
      .getByText("Closing paragraph.")
      .dblclick({ position: { x: 5, y: 5 } });
    await page
      .getByRole("button", { name: /^(Copy turn|Copied)$/ })
      .last()
      .focus();
    await assistantMessageBlocks(page).getByText("Closing paragraph.").dispatchEvent("contextmenu");
    await page.getByTestId("assistant-selection-context-menu-quote").click();
    await expect(page.getByTestId("assistant-selection-context-menu")).toHaveCount(0);
    await expect(quoteCards(page)).toHaveCount(2);
    await expect(quoteCards(page).last()).toContainText("Closing");
    await expect(composer(page)).toHaveValue("Draft start");
    await expect(composer(page)).toBeFocused();

    await expect(page.getByTestId("user-message")).toHaveCount(1);
  } finally {
    await agent.cleanup();
  }
});

test("Enter adds the quote card when the selection owns the key", async ({ page }) => {
  const agent = await openIdleAgent(page, "assistant-selection-quote-enter-");
  try {
    // A real double-click, as a reader selects: focus leaves the composer.
    await assistantMessageBlocks(page)
      .getByText("Closing paragraph.")
      .dblclick({ position: { x: 5, y: 5 } });
    await expect(quoteButton(page)).toBeVisible();
    await expect(composer(page)).not.toBeFocused();

    // Enter with a modifier is not Quote's.
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.press("ControlOrMeta+Enter");
    await page.keyboard.press("Alt+Enter");
    await expect(quoteCards(page)).toHaveCount(0);
    await expect(quoteButton(page)).toBeVisible();

    await page.keyboard.press("Enter");
    await expect(quoteButton(page)).toHaveCount(0);
    await expect(composer(page)).toBeFocused();
    await expect(composer(page)).toHaveValue("");
    await expect(quoteCards(page)).toHaveCount(1);
    await expect(quoteCards(page).first()).toContainText("Closing");
    await page.keyboard.type("typed without the mouse");
    await expect(composer(page)).toHaveValue("typed without the mouse");
    await expect(page.getByTestId("user-message")).toHaveCount(1);
  } finally {
    await agent.cleanup();
  }
});

test("Enter stays with the composer and a focused button while the Quote button shows", async ({
  context,
  page,
}) => {
  const agent = await openIdleAgent(page, "assistant-selection-quote-enter-focus-");
  try {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);

    // A focused button presses on Enter, as it does without a selection.
    await assistantMessageBlocks(page)
      .getByText("Closing paragraph.")
      .dblclick({ position: { x: 5, y: 5 } });
    await expect(quoteButton(page)).toBeVisible();
    await page.getByRole("button", { name: "Copy turn" }).last().focus();
    await expect(quoteButton(page)).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "Copied" })).toBeVisible();
    await expect(quoteCards(page)).toHaveCount(0);

    // Selecting by script leaves focus in the composer, where Enter still sends.
    await composer(page).fill("Sent with Enter");
    await selectAssistantTextRange(page, "First point", "First point");
    await expect(quoteButton(page)).toBeVisible();
    await expect(composer(page)).toBeFocused();
    await page.keyboard.press("Enter");

    await expect(quoteCards(page)).toHaveCount(0);
    await expect(composer(page)).toHaveValue("");
    await expect(
      page.getByTestId("user-message").filter({ hasText: "Sent with Enter" }),
    ).toBeVisible();
  } finally {
    await agent.cleanup();
  }
});

test("holding Enter on a selection adds one quote and sends nothing until a fresh press", async ({
  page,
}) => {
  const agent = await openIdleAgent(page, "assistant-selection-quote-held-enter-");
  try {
    await composer(page).fill("Draft start");
    await assistantMessageBlocks(page)
      .getByText("Closing paragraph.")
      .dblclick({ position: { x: 5, y: 5 } });
    await expect(quoteButton(page)).toBeVisible();
    await expect(composer(page)).not.toBeFocused();

    // Pressing a key that is already down repeats it, as holding it does.
    await page.keyboard.down("Enter");
    await expect(composer(page)).toBeFocused();
    for (let repeat = 0; repeat < 5; repeat++) {
      await page.keyboard.down("Enter");
    }
    await page.keyboard.up("Enter");
    await expect(composer(page)).toHaveValue("Draft start");
    await expect(quoteCards(page)).toHaveCount(1);
    await expect(quoteCards(page).first()).toContainText("Closing");
    await expect(page.getByTestId("user-message")).toHaveCount(1);

    // Released, Enter sends again, and the draft goes out whole as one message.
    await page.keyboard.type(" and more");
    await page.keyboard.press("Enter");
    const sent = page.getByTestId("user-message").filter({ hasText: "Draft start and more" });
    await expect(sent).toHaveCount(1);
    await expect(sent.getByTestId("user-message-quote-block")).toContainText("Closing");
    await expect(composer(page)).toHaveValue("");
    await expect(quoteCards(page)).toHaveCount(0);
  } finally {
    await agent.cleanup();
  }
});

test("Escape dismisses the quote button and keeps the selection", async ({ page }) => {
  const agent = await openIdleAgent(page, "assistant-selection-quote-escape-");
  try {
    await selectAssistantTextRange(page, "First point", "First point");
    await expect(quoteButton(page)).toBeVisible();

    // The button does not hold back the chat's find shortcut.
    await page.keyboard.press("ControlOrMeta+f");
    const find = page.getByRole("textbox", { name: "Find in pane", exact: true });
    await expect(find).toBeFocused();
    // Focusing find moves the selection out of the message, which takes the button away.
    await expect(quoteButton(page)).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(find).toHaveCount(0);

    await selectAssistantTextRange(page, "First point", "First point");
    await expect(quoteButton(page)).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(quoteButton(page)).toHaveCount(0);
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("First point");
    await expect(composer(page)).toHaveValue("");
    await expect(quoteCards(page)).toHaveCount(0);
    await expect(page.getByTestId("user-message")).toHaveCount(1);
  } finally {
    await agent.cleanup();
  }
});

const STREAMED_RESPONSE = [
  "Early passage to quote.",
  "",
  "The reply keeps arriving one word at a time while the passage is quoted,",
  "so the message is still growing when the card goes into the composer.",
  "",
  "More words follow here to keep the stream open for a while longer.",
  "",
  "stream-end-sentinel",
].join("\n");

test("quoting works while the message is still streaming", async ({ page }) => {
  test.setTimeout(120_000);
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "assistant-selection-quote-stream-",
    title: "Assistant selection quote stream",
    featureValues: {
      mockStreamingAssistantResponse: STREAMED_RESPONSE,
      mockStreamingAssistantIntervalMs: 300,
    },
  });
  try {
    await openAgentRoute(page, agent);
    await agent.client.sendAgentMessage(agent.agentId, "Stream a reply to quote");
    await expect(assistantMessageBlocks(page).getByText("Early passage to quote.")).toBeVisible({
      timeout: 30_000,
    });

    await selectAssistantTextRange(page, "Early passage", "to quote.");
    await quoteButton(page).click();
    await expect(composer(page)).toBeFocused();
    await expect(composer(page)).toHaveValue("");
    await expect(quoteCards(page)).toHaveCount(1);
    await expect(quoteCards(page).first()).toContainText("Early passage to quote.");
    await page.keyboard.type("noted mid-stream");
    await expect(composer(page)).toHaveValue("noted mid-stream");
    await expect(page.getByTestId("user-message")).toHaveCount(1);
    await expect(page.getByText("stream-end-sentinel")).toHaveCount(0);
    await agent.client.waitForFinish(agent.agentId, 60_000);
  } finally {
    await agent.cleanup();
  }
});
