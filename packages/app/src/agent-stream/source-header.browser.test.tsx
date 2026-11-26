import React, { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { within } from "@testing-library/dom";
import { ComposerQuoteProvider } from "@/assistant-selection-copy/composer-quote";
import { KeyboardActionDispatcherProvider } from "@/keyboard/keyboard-action-dispatcher-context";
import type { AgentSourceGroup, AgentSourceInfo } from "./agent-interactions";
import { AgentSourceHeader, UnreadAgentSourceContext } from "./source-header";
import { DisclosureRow } from "./disclosure";
import type { StreamViewportHandle } from "./strategy";
import { i18n as testI18n } from "@/i18n/i18next";

const navigateToAgent = vi.hoisted(() => vi.fn());

vi.mock("@/utils/navigate-to-agent", () => ({
  navigateToAgent,
  openForkSourceAgent: vi.fn(),
}));
void testI18n;

const addQuoteAttachment = vi.fn();
const quoteTarget = { addQuoteAttachment };

const AGENT_UUID = "3f2b8a1e-9c4d-4e6f-8a7b-1c2d3e4f5a6b";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  navigateToAgent.mockReset();
  addQuoteAttachment.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function source(overrides: Partial<AgentSourceInfo> & Pick<AgentSourceInfo, "sender">) {
  return {
    event: "message",
    text: "Reviewed the change.",
    status: "message",
    ...overrides,
  } satisfies AgentSourceInfo;
}

function sourceGroup(sources?: AgentSourceInfo[]): AgentSourceGroup {
  return {
    firstItemId: "message-1",
    itemCount: 2,
    requiresExpansion: false,
    sources: sources ?? [
      source({ sender: { id: "child-1", title: "Reviewer" } }),
      source({
        event: "finished",
        sender: { id: "child-2", serverId: "server-2", title: "Tester" },
        text: "Tests passed.",
        status: "completed",
      }),
    ],
  };
}

function view() {
  return within(container);
}

it("opens and closes source details through a single disclosure hold per click", () => {
  const holdRow = vi.fn<StreamViewportHandle["holdRow"]>((_rowId, apply) => apply());
  const group = sourceGroup();

  function Harness() {
    const [expanded, setExpanded] = useState(false);
    const viewportRef = useRef({ holdRow, scrollToBottom() {}, prepareForViewportChange() {} });
    return (
      <DisclosureRow rowId="source-block" viewportRef={viewportRef}>
        <AgentSourceHeader
          group={group}
          fallbackServerId="server-1"
          expanded={expanded}
          onExpandedChange={setExpanded}
        />
        {expanded ? <span>Deep text in the report</span> : null}
      </DisclosureRow>
    );
  }
  act(() => root.render(<Harness />));
  expect(view().queryByText("Deep text in the report")).toBeNull();
  const toggle = view().getByTestId("agent-source-details");
  expect(toggle.textContent).toBe("View details");
  act(() => toggle.click());
  expect(view().getByText("Deep text in the report")).toBeTruthy();
  expect(view().getByTestId("agent-source-details").textContent).toBe("Collapse");
  act(() => view().getByTestId("agent-source-details").click());
  expect(view().queryByText("Deep text in the report")).toBeNull();
  expect(holdRow.mock.calls.map(([rowId, , edge]) => [rowId, edge])).toEqual([
    ["source-block", "top"],
    ["source-block", "top"],
  ]);
});

it("renders each source as a card row with its real status and title", () => {
  act(() => root.render(<AgentSourceHeader group={sourceGroup()} fallbackServerId="server-1" />));

  expect(
    view()
      .getAllByTestId("agent-source-title")
      .map((title) => title.textContent),
  ).toEqual(["Reviewer", "Tester"]);
  const entries = view().getAllByTestId("agent-source-entry");
  expect(within(entries[0]!).getByText("Message")).toBeTruthy();
  expect(within(entries[1]!).getByText("Completed")).toBeTruthy();
});

it("routes an old message through the current host and keeps explicit hosts", () => {
  act(() => root.render(<AgentSourceHeader group={sourceGroup()} fallbackServerId="server-1" />));

  const open = view().getAllByTestId("agent-source-tag");
  expect(open.map((button) => button.getAttribute("aria-label"))).toEqual([
    "Open subagent",
    "Open subagent",
  ]);
  act(() => open[0]!.click());
  expect(navigateToAgent).toHaveBeenCalledExactlyOnceWith({
    serverId: "server-1",
    agentId: "child-1",
  });
  act(() => open[1]!.click());
  expect(navigateToAgent).toHaveBeenLastCalledWith({
    serverId: "server-2",
    agentId: "child-2",
  });
});

it("shows a short id instead of a title that is only the agent id", () => {
  const group = sourceGroup([
    source({ sender: { id: AGENT_UUID, title: AGENT_UUID } }),
    source({ sender: { id: "child-9", title: "child-9" }, status: "completed" }),
  ]);
  act(() => root.render(<AgentSourceHeader group={group} fallbackServerId="server-1" />));

  expect(
    view()
      .getAllByTestId("agent-source-title")
      .map((title) => title.textContent),
  ).toEqual(["3f2b8a1e", "child-9"]);
});

it("previews the conclusion only while a collapsible card is collapsed", () => {
  const group = sourceGroup([
    source({
      sender: { id: "child-1", title: "Reviewer" },
      text: "Report to parent (completed):\n\n## Result\n- **All** `tests` pass",
      status: "completed",
    }),
  ]);
  function render(expanded: boolean | undefined, onExpandedChange?: () => void) {
    act(() =>
      root.render(
        <AgentSourceHeader
          group={group}
          fallbackServerId="server-1"
          expanded={expanded}
          onExpandedChange={onExpandedChange}
        />,
      ),
    );
  }

  render(false, vi.fn());
  expect(view().getByTestId("agent-source-preview").textContent).toBe("Result All tests pass");
  render(true, vi.fn());
  expect(view().queryByTestId("agent-source-preview")).toBeNull();
  render(undefined);
  expect(view().queryByTestId("agent-source-preview")).toBeNull();
  expect(view().queryByTestId("agent-source-details")).toBeNull();
});

it("paints the unread stripe only on the newest group while the context names it", () => {
  const group = sourceGroup();
  function render(unreadGroupId: string | null) {
    act(() =>
      root.render(
        <UnreadAgentSourceContext.Provider value={unreadGroupId}>
          <AgentSourceHeader group={group} fallbackServerId="server-1" />
        </UnreadAgentSourceContext.Provider>,
      ),
    );
  }

  render(null);
  expect(view().queryByTestId("agent-source-unread")).toBeNull();
  render("another-group");
  expect(view().queryByTestId("agent-source-unread")).toBeNull();
  render("message-1");
  expect(view().getByTestId("agent-source-unread")).toBeTruthy();
});

it("offers quote reply only inside a composer that accepts quotes", () => {
  const group = sourceGroup([
    source({
      sender: { id: "child-1", title: "Reviewer" },
      text: "Report to parent (completed):\n\nReviewed the change.",
      status: "completed",
    }),
  ]);
  act(() => root.render(<AgentSourceHeader group={group} fallbackServerId="server-1" />));
  expect(view().queryByTestId("agent-source-quote")).toBeNull();

  act(() =>
    root.render(
      <KeyboardActionDispatcherProvider>
        <ComposerQuoteProvider target={quoteTarget}>
          <AgentSourceHeader group={group} fallbackServerId="server-1" />
        </ComposerQuoteProvider>
      </KeyboardActionDispatcherProvider>,
    ),
  );
  const quote = view().getByTestId("agent-source-quote");
  expect(quote.getAttribute("aria-label")).toBe("Quote reply");
  act(() => quote.click());
  expect(addQuoteAttachment).toHaveBeenCalledExactlyOnceWith(
    "[Reviewer] Reviewed the change.",
    "Reviewer",
  );
});

const inertQuoteTarget = { addQuoteAttachment: vi.fn() };

it("hides quote reply for a report with nothing but the template", () => {
  const group = sourceGroup([
    source({
      sender: { id: "child-1", title: "Reviewer" },
      text: "Agent child-1 (Reviewer) was closed.",
      status: "closed",
    }),
    source({
      sender: { id: AGENT_UUID },
      text: `Agent ${AGENT_UUID} finished.\n\nServer: srv-1`,
      status: "finished",
    }),
  ]);
  act(() =>
    root.render(
      <KeyboardActionDispatcherProvider>
        <ComposerQuoteProvider target={inertQuoteTarget}>
          <AgentSourceHeader
            group={group}
            fallbackServerId="server-1"
            expanded={false}
            onExpandedChange={vi.fn()}
          />
        </ComposerQuoteProvider>
      </KeyboardActionDispatcherProvider>,
    ),
  );

  expect(view().queryByTestId("agent-source-quote")).toBeNull();
  expect(view().queryByTestId("agent-source-preview")).toBeNull();
});

it("forwards source topic metadata when quoting a topic-linked subagent report", () => {
  const group = sourceGroup([
    source({
      sender: { id: "child-1", title: "Reviewer" },
      text: "Report to parent (completed):\n\nReviewed the change.",
      status: "completed",
      taskId: "T-42",
      rootMessageId: "m-42",
    }),
  ]);
  act(() =>
    root.render(
      <KeyboardActionDispatcherProvider>
        <ComposerQuoteProvider target={quoteTarget}>
          <AgentSourceHeader group={group} fallbackServerId="server-1" />
        </ComposerQuoteProvider>
      </KeyboardActionDispatcherProvider>,
    ),
  );
  act(() => view().getByTestId("agent-source-quote").click());
  expect(addQuoteAttachment).toHaveBeenCalledExactlyOnceWith(
    "[Reviewer] Reviewed the change.",
    "Reviewer",
    {
      topicKey: "task:T-42",
      taskId: "T-42",
      rootMessageId: "m-42",
    },
  );
});
