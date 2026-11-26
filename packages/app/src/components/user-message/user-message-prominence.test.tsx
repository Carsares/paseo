/**
 * @vitest-environment jsdom
 */
import { MessageOuterSpacingProvider, UserMessage } from "@/components/message";
import { ToastProvider } from "@/contexts/toast-context";
import { i18n } from "@/i18n/i18next";
import { APP_SETTINGS_QUERY_KEY, DEFAULT_CLIENT_SETTINGS } from "@/hooks/use-settings/storage";
import { formatMessageTimestamp } from "@/utils/time";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { UserMessageExpansionContext } from "./expansion-context";
import { createUserMessageExpansion } from "./expansion";

const timestamp = new Date(2020, 0, 2, 15, 4);

function renderPrompt(
  props: Partial<ComponentProps<typeof UserMessage>> = {},
  userMessageAlignment = DEFAULT_CLIENT_SETTINGS.userMessageAlignment,
) {
  const expansion = createUserMessageExpansion();
  const client = new QueryClient();
  client.setQueryData(APP_SETTINGS_QUERY_KEY, { ...DEFAULT_CLIENT_SETTINGS, userMessageAlignment });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <UserMessageExpansionContext.Provider value={expansion}>
          <MessageOuterSpacingProvider disableOuterSpacing>
            <UserMessage
              itemId="prompt"
              message="Explain this change."
              timestamp={timestamp.getTime()}
              isFirstInGroup
              {...props}
            />
          </MessageOuterSpacingProvider>
        </UserMessageExpansionContext.Provider>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

afterEach(async () => {
  cleanup();
  await i18n.changeLanguage("en");
});

describe("UserMessage prominence", () => {
  it.each([
    ["en", "Your prompt"],
    ["zh-CN", "你的提问"],
  ])("labels the start of a turn in %s when outer spacing is disabled", async (language, label) => {
    await i18n.changeLanguage(language);
    const { getByTestId } = renderPrompt();
    const divider = getByTestId("user-message-turn-divider");
    const turnLabel = getByTestId("user-message-turn-label");

    expect(divider.parentElement).toBe(getByTestId("user-message"));
    expect(divider.contains(turnLabel)).toBe(true);
    expect(turnLabel.textContent).toBe(`${label} · ${formatMessageTimestamp(timestamp)}`);
  });

  it("omits the divider for a prompt within a group", () => {
    const { queryByTestId } = renderPrompt({ isFirstInGroup: false });

    expect(queryByTestId("user-message-turn-divider")).toBeNull();
  });

  it("omits the divider when the first message has no content", () => {
    const { queryByTestId } = renderPrompt({ message: " " });

    expect(queryByTestId("user-message-turn-divider")).toBeNull();
  });

  it.each([
    ["an attachment", { attachments: [{ type: "text", mimeType: "text/plain", text: "Notes" }] }],
    [
      "an image",
      {
        images: [
          {
            id: "image",
            mimeType: "image/png",
            storageType: "web-indexeddb",
            storageKey: "image.png",
            createdAt: timestamp.getTime(),
          },
        ],
      },
    ],
  ] satisfies [string, Partial<ComponentProps<typeof UserMessage>>][])(
    "shows the divider when the first message contains only %s",
    (_kind, props) => {
      const { queryByTestId } = renderPrompt({ message: "", ...props });

      expect(queryByTestId("user-message-turn-divider")).not.toBeNull();
    },
  );

  it("shows only the timestamp in the divider for a prompt sent by an agent", () => {
    const { getByTestId } = renderPrompt({ sender: { id: "other-agent", title: "Reviewer" } });

    expect(getByTestId("user-message-turn-label").textContent).toBe(
      formatMessageTimestamp(timestamp),
    );
  });

  it("left-aligns only the user's messages when the preference is left", () => {
    const prompt = renderPrompt({}, "left");
    expect(getComputedStyle(prompt.getByTestId("user-message-content")).alignSelf).toBe(
      "flex-start",
    );
    prompt.unmount();

    const agent = renderPrompt({ sender: { id: "agent", title: "Reviewer" } }, "left");
    expect(getComputedStyle(agent.getByTestId("user-message-content")).alignSelf).toBe("flex-end");
  });

  it("right-aligns and caps content without setting a fixed width for short prompts", () => {
    const { getByTestId } = renderPrompt();
    const contentStyle = getComputedStyle(getByTestId("user-message-content"));
    const bubbleStyle = getComputedStyle(getByTestId("user-message-bubble"));

    expect(contentStyle.alignSelf).toBe("flex-end");
    expect(contentStyle.alignItems).toBe("flex-end");
    expect(contentStyle.maxWidth).toBe("85%");
    expect(["auto", ""]).toContain(contentStyle.width);
    expect(["auto", ""]).toContain(bubbleStyle.width);
    expect(bubbleStyle.borderLeftWidth).toBe("3px");
  });
});
