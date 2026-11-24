// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useRetainedPanelActive } from "@/components/retained-panel";
import type { SheetTab } from "@/stores/workspace-layout-store";
import { SheetTabs } from "../sheet-tabs";
import { createWorkspaceSheetStack } from "./stack";

const native = vi.hoisted(() => ({
  back: null as (() => boolean) | null,
  presents: 0,
}));
const harness = vi.hoisted(() => ({
  stack: null as ReturnType<typeof createWorkspaceSheetStack> | null,
  workspaceFocused: true,
}));
vi.mock("expo-router/react-navigation", () => ({ useIsFocused: () => true }));
vi.mock("@/components/adaptive-modal-sheet", () => ({
  FULL_SHEET_SNAP_POINTS: ["92%"],
  SheetBackground: () => null,
  SheetHandle: () => null,
}));
vi.mock("@/components/ui/isolated-bottom-sheet-modal", () => ({
  IsolatedBottomSheetModal: React.forwardRef(({ children }: { children: React.ReactNode }, ref) => {
    React.useImperativeHandle(ref, () => ({
      present: () => native.presents++,
    }));
    return <div data-modal>{children}</div>;
  }),
  systemBackPress: {
    subscribe: (listener: () => boolean) => {
      native.back = listener;
      return () => {
        if (native.back === listener) native.back = null;
      };
    },
  },
}));
vi.mock("@/components/ui/isolated-bottom-sheet-modal/visible-frame", () => ({
  SheetVisibleFrame: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/screens/workspace/sheet-pane", () => ({
  useWorkspaceSheetPages: () => harness.stack,
  useSheetPaneBridge: () => null,
  useSheetPaneHost: () => ({ isWorkspaceFocused: harness.workspaceFocused }),
  SheetPane: ({ sheet }: { sheet: SheetTab }) => <Activity name={sheet.tab.tabId} />,
}));
vi.mock("./page", () => ({
  WorkspacePagePane: ({
    page,
    onClose,
  }: {
    page: { render: (close: () => void) => React.ReactNode };
    onClose: () => void;
  }) => page.render(onClose),
}));

function Activity({ name }: { name: string }) {
  const active = useRetainedPanelActive();
  return (
    <div data-page={name} data-active={active}>
      <input aria-label={name} />
    </div>
  );
}

it("uses one modal and returns through conflict, commit and evidence without remounting team or chat", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  const stack = createWorkspaceSheetStack();
  harness.stack = stack;
  native.presents = 0;
  const closeEvidence = vi.fn(async () => stack.syncTabs([]));
  const evidence: SheetTab = {
    tab: { tabId: "evidence", target: { kind: "agent", agentId: "evidence" }, createdAt: 1 },
    parentTabId: null,
    policy: { openAsTab: true },
  };
  const getPage = (name: string) =>
    container.querySelector<HTMLDivElement>(`[data-page="${name}"]`)!;
  let canCloseConflict = false;
  const open = (name: string, canClose?: () => boolean) =>
    stack.push({
      key: name,
      title: name,
      render: () => <Activity name={name} />,
      canClose,
    });
  const back = async () => {
    await act(async () => expect(native.back?.()).toBe(true));
  };
  try {
    await act(async () =>
      root.render(
        <>
          <Activity name="chat" />
          <SheetTabs onCloseTab={closeEvidence} />
        </>,
      ),
    );
    const chat = getPage("chat");
    chat.querySelector("input")!.value = "Unsent chat message";
    chat.scrollTop = 72;

    await act(async () => open("team"));
    const team = getPage("team");
    team.scrollTop = 36;
    team.querySelector("input")!.value = "Team draft";
    await act(async () => stack.syncTabs([evidence]));
    await act(async () => open("commit"));
    await act(async () => open("conflict", () => canCloseConflict));

    expect(native.presents).toBe(1);
    expect(container.querySelectorAll("[data-modal]")).toHaveLength(1);
    expect(getPage("conflict").dataset.active).toBe("true");
    expect(getPage("commit").dataset.active).toBe("false");
    expect(getPage("evidence").dataset.active).toBe("false");
    expect(team.dataset.active).toBe("false");

    await back();
    expect(getPage("conflict").dataset.active).toBe("true");
    expect(getPage("commit").dataset.active).toBe("false");
    canCloseConflict = true;
    await back();
    expect(getPage("commit").dataset.active).toBe("true");
    await back();
    expect(getPage("evidence").dataset.active).toBe("true");
    await back();
    expect(closeEvidence).toHaveBeenCalledExactlyOnceWith("evidence");
    expect(getPage("team")).toBe(team);
    expect(team.dataset.active).toBe("true");
    expect(team.querySelector("input")!.value).toBe("Team draft");
    expect(team.scrollTop).toBe(36);
    await back();

    expect(container.querySelector("[data-modal]")).toBeNull();
    expect(native.back).toBeNull();
    expect(getPage("chat")).toBe(chat);
    expect(chat.querySelector("input")!.value).toBe("Unsent chat message");
    expect(chat.scrollTop).toBe(72);
  } finally {
    act(() => root.unmount());
    harness.stack = null;
    vi.unstubAllGlobals();
  }
});

it("keeps the top tab when its close is declined and absorbs Back while the prompt is open", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  const stack = createWorkspaceSheetStack();
  harness.stack = stack;
  const prompt = Promise.withResolvers<void>();
  const closeEvidence = vi.fn(() => prompt.promise);
  const evidence: SheetTab = {
    tab: { tabId: "scratch-file", target: { kind: "agent", agentId: "agent" }, createdAt: 1 },
    policy: { openAsTab: true },
    parentTabId: null,
  };
  stack.push({ key: "team", title: "Team", render: () => <Activity name="team" /> });
  stack.syncTabs([evidence]);
  try {
    await act(async () => root.render(<SheetTabs onCloseTab={closeEvidence} />));
    const top = container.querySelector('[data-page="scratch-file"]');
    expect(top?.getAttribute("data-active")).toBe("true");

    await act(async () => {
      expect(native.back?.()).toBe(true);
      expect(native.back?.()).toBe(true);
    });
    expect(closeEvidence).toHaveBeenCalledExactlyOnceWith(evidence.tab.tabId);

    await act(async () => prompt.resolve());
    expect(container.querySelector('[data-page="scratch-file"]')).toBe(top);
    expect(top?.getAttribute("data-active")).toBe("true");
    expect(container.querySelector('[data-page="team"]')?.getAttribute("data-active")).toBe(
      "false",
    );
  } finally {
    act(() => root.unmount());
    harness.stack = null;
    vi.unstubAllGlobals();
  }
});
