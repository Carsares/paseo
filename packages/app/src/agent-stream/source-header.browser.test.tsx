import React, { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { within } from "@testing-library/dom";
import type { AgentSourceGroup } from "./agent-interactions";
import { AgentSourceHeader } from "./source-header";
import { DisclosureRow } from "./disclosure";
import type { StreamViewportHandle } from "./strategy";
import { i18n as testI18n } from "@/i18n/i18next";

const navigateToAgent = vi.hoisted(() => vi.fn());

vi.mock("@/utils/navigate-to-agent", () => ({
  navigateToAgent,
  openForkSourceAgent: vi.fn(),
}));
void testI18n;

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  navigateToAgent.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

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
  const toggle = within(view().getByTestId("agent-source-details")).getByRole("button");
  act(() => toggle.click());
  expect(view().getByText("Deep text in the report")).toBeTruthy();
  act(() => within(view().getByTestId("agent-source-details")).getByRole("button").click());
  expect(view().queryByText("Deep text in the report")).toBeNull();
  expect(holdRow.mock.calls.map(([rowId, , edge]) => [rowId, edge])).toEqual([
    ["source-block", "top"],
    ["source-block", "top"],
  ]);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function sourceGroup(): AgentSourceGroup {
  return {
    firstItemId: "message-1",
    itemCount: 2,
    requiresExpansion: false,
    sources: [
      {
        event: "message",
        sender: { id: "child-1", title: "Reviewer" },
        text: "Reviewed the change.",
        status: "message",
      },
      {
        event: "finished",
        sender: { id: "child-2", serverId: "server-2", title: "Tester" },
        text: "Tests passed.",
        status: "completed",
      },
    ],
  };
}

function view() {
  return within(container);
}

it("shows each source's real status and routes an old message through the current host", () => {
  act(() => root.render(<AgentSourceHeader group={sourceGroup()} fallbackServerId="server-1" />));

  const tags = view().getAllByTestId("agent-source-tag");
  expect(tags.map((tag) => tag.textContent)).toEqual(["Reviewer · Message", "Tester · Completed"]);

  act(() => tags[0]!.click());
  expect(navigateToAgent).toHaveBeenCalledExactlyOnceWith({
    serverId: "server-1",
    agentId: "child-1",
  });
  act(() => tags[1]!.click());
  expect(navigateToAgent).toHaveBeenLastCalledWith({
    serverId: "server-2",
    agentId: "child-2",
  });
});
