/** @vitest-environment jsdom */
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { CheckoutGitRepo } from "@getpaseo/protocol/messages";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  createGitGraphNavigationIntentStore,
  GitGraphNavigationIntentProvider,
} from "@/screens/workspace/topic-header/git-graph-intent";
import { gitGraphPanelRegistration } from "./panel";

const runtime = vi.hoisted(() => ({
  active: true,
  tabId: "tab-git-1",
  connected: true,
  client: {
    checkoutGitReposDiscover: vi.fn<DaemonClient["checkoutGitReposDiscover"]>(),
    checkoutGitRefsList: vi.fn<DaemonClient["checkoutGitRefsList"]>(),
  },
}));

vi.mock("lucide-react-native", () => ({
  GitFork: () => null,
}));
vi.mock("./sheet", () => ({
  GraphSheet: () => null,
}));
vi.mock("./ui", () => ({
  styles: {},
  GraphInput: () => null,
  GraphMessage: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  RepoDot: () => null,
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));
vi.mock("@/components/ui/button", () => ({
  Button: ({ children, onPress }: { children?: React.ReactNode; onPress?: () => void }) => (
    <button type="button" onClick={onPress}>
      {children}
    </button>
  ),
}));
vi.mock("@/components/ui/switch", () => ({
  Switch: () => null,
}));
vi.mock("react-i18next", async (original) => ({
  ...(await original<typeof import("react-i18next")>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/components/retained-panel", () => ({
  useRetainedPanelActive: () => runtime.active,
}));
vi.mock("@/constants/layout", async (original) => ({
  ...(await original<typeof import("@/constants/layout")>()),
  useIsCompactFormFactor: () => false,
}));
vi.mock("@/hooks/use-is-local-daemon", () => ({
  useIsLocalDaemon: () => false,
}));
vi.mock("@/mobile-panels/provider", () => ({
  useBlockMobilePanelOpenGestures: () => {},
}));
vi.mock("@/panels/pane-context", () => ({
  usePaneContext: () => ({
    serverId: "srv-1",
    workspaceId: "ws-1",
    tabId: runtime.tabId,
  }),
}));
vi.mock("@/runtime/host-features", () => ({
  useHostFeature: () => true,
}));
vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => runtime.client,
  useHostRuntimeIsConnected: () => runtime.connected,
}));
vi.mock("@/stores/session-store-hooks", () => ({
  useWorkspaceDirectory: () => "/ws",
}));
vi.mock("@/workspace/desktop-open-targets", () => ({
  openDesktopTarget: vi.fn(),
  useDesktopOpenTargets: () => ({ targets: [] }),
}));
vi.mock("../rebase/use-working-tree", () => ({
  useRebaseWorkingTree: () => ({ isSuccess: false, isFetching: false, data: undefined }),
}));
vi.mock("./use-log", () => ({
  useGraphLog: () => ({
    isFetching: false,
    isSuccess: true,
    isPending: false,
    error: null,
    commits: [],
    hasMore: false,
    loadMore: vi.fn(),
  }),
}));
vi.mock("./commit-list", () => ({
  CommitList: () => <div data-testid="mock-commit-list" />,
}));
vi.mock("./detail", () => ({
  CommitDetail: () => null,
  CommitFileSheet: () => null,
}));
vi.mock("./refs", () => ({
  RefBrowser: () => null,
}));
vi.mock("../rebase/plan-sheet", () => ({
  PlanSheet: ({ repo }: { repo: CheckoutGitRepo }) => (
    <div data-testid="mock-plan-sheet">{repo.repoRoot}</div>
  ),
}));
vi.mock("../rebase/conflict-sheet", () => ({
  ConflictSheet: ({ repo }: { repo: CheckoutGitRepo }) => (
    <div data-testid="mock-conflict-sheet">{repo.repoRoot}</div>
  ),
}));

const GitGraphPanel = gitGraphPanelRegistration.component;

function makeRepo(
  repoId: string,
  repoRoot: string,
  operationState: CheckoutGitRepo["operationState"],
): CheckoutGitRepo {
  return {
    repoId,
    displayName: repoId,
    repoRoot,
    headSha: "abc123",
    currentBranch: "feat/test",
    operationState,
  };
}

function renderGraph(store = createGitGraphNavigationIntentStore()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  runtime.client.checkoutGitRefsList.mockResolvedValue({
    requestId: "refs-1",
    cwd: "/ws",
    error: null,
    refs: [],
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <GitGraphNavigationIntentProvider store={store}>
        <GitGraphPanel />
      </GitGraphNavigationIntentProvider>
    </QueryClientProvider>,
  );
  return { ...view, store, queryClient };
}

afterEach(() => {
  cleanup();
  runtime.active = true;
  runtime.tabId = "tab-git-1";
  runtime.connected = true;
  runtime.client.checkoutGitReposDiscover.mockReset();
  runtime.client.checkoutGitRefsList.mockReset();
});

it("focuses the conflicting repository, opens the conflict sheet, and consumes the one-shot intent", async () => {
  const store = createGitGraphNavigationIntentStore();
  store.submitConflictIntent({ tabId: "tab-git-1", repoRoot: "/ws/repo-b" });
  runtime.client.checkoutGitReposDiscover.mockResolvedValue({
    requestId: "disc-1",
    cwd: "/ws",
    mode: "multi",
    error: null,
    repos: [
      makeRepo("repo-a", "/ws/repo-a", "idle"),
      makeRepo("repo-b", "/ws/repo-b", "rebase_paused"),
    ],
  });

  renderGraph(store);

  const sheet = await screen.findByTestId("mock-conflict-sheet");
  expect(sheet.textContent).toBe("/ws/repo-b");
  expect(store.getIntent()).toBeNull();
  expect(runtime.client.checkoutGitReposDiscover).toHaveBeenCalledTimes(1);
});

it("rediscovers an already-open graph and skips opening conflicts when the repo is no longer paused", async () => {
  const store = createGitGraphNavigationIntentStore();
  runtime.client.checkoutGitReposDiscover
    .mockResolvedValueOnce({
      requestId: "disc-1",
      cwd: "/ws",
      mode: "multi",
      error: null,
      repos: [
        makeRepo("repo-a", "/ws/repo-a", "idle"),
        makeRepo("repo-b", "/ws/repo-b", "rebase_paused"),
      ],
    })
    .mockResolvedValueOnce({
      requestId: "disc-2",
      cwd: "/ws",
      mode: "multi",
      error: null,
      repos: [makeRepo("repo-a", "/ws/repo-a", "idle"), makeRepo("repo-b", "/ws/repo-b", "idle")],
    });

  renderGraph(store);
  await waitFor(() => expect(runtime.client.checkoutGitReposDiscover).toHaveBeenCalledTimes(1));
  expect(screen.queryByTestId("mock-conflict-sheet")).toBeNull();

  act(() => {
    store.submitConflictIntent({ tabId: "tab-git-1", repoRoot: "/ws/repo-b" });
  });

  await waitFor(() => expect(runtime.client.checkoutGitReposDiscover).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(store.getIntent()).toBeNull());
  expect(screen.queryByTestId("mock-conflict-sheet")).toBeNull();
});

it("ignores intents when inactive or targeting another tab", async () => {
  const store = createGitGraphNavigationIntentStore();
  runtime.active = false;
  store.submitConflictIntent({ tabId: "tab-git-1", repoRoot: "/ws/repo-b" });
  runtime.client.checkoutGitReposDiscover.mockResolvedValue({
    requestId: "disc-1",
    cwd: "/ws",
    mode: "single",
    error: null,
    repos: [makeRepo("repo-b", "/ws/repo-b", "rebase_paused")],
  });

  renderGraph(store);
  await Promise.resolve();
  expect(screen.queryByTestId("mock-conflict-sheet")).toBeNull();
  expect(store.getIntent()).not.toBeNull();

  cleanup();
  runtime.active = true;
  const wrongTabStore = createGitGraphNavigationIntentStore();
  wrongTabStore.submitConflictIntent({ tabId: "tab-other", repoRoot: "/ws/repo-b" });
  renderGraph(wrongTabStore);
  await waitFor(() => expect(runtime.client.checkoutGitReposDiscover).toHaveBeenCalledTimes(1));
  expect(screen.queryByTestId("mock-conflict-sheet")).toBeNull();
  expect(wrongTabStore.getIntent()?.tabId).toBe("tab-other");
});

it("has zero conflict side effects when opened normally without a conflict intent", async () => {
  runtime.client.checkoutGitReposDiscover.mockResolvedValue({
    requestId: "disc-1",
    cwd: "/ws",
    mode: "multi",
    error: null,
    repos: [
      makeRepo("repo-a", "/ws/repo-a", "idle"),
      makeRepo("repo-b", "/ws/repo-b", "rebase_paused"),
    ],
  });

  renderGraph();
  await waitFor(() => expect(runtime.client.checkoutGitReposDiscover).toHaveBeenCalledTimes(1));
  expect(screen.queryByTestId("mock-conflict-sheet")).toBeNull();
});
