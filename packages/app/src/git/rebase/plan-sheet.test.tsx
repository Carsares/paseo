// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PlanRow } from "./plan-model";
import { PlanSheet } from "./plan-sheet";

const { approve, input } = vi.hoisted(() => ({
  approve: vi.fn(),
  input: { change: (_value: string) => {} },
}));

vi.mock("react-native", () => ({
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("../graph/sheet", () => ({
  GraphSheet: ({ children, footer }: { children: ReactNode; footer: ReactNode }) => (
    <div>
      {children}
      {footer}
    </div>
  ),
}));
vi.mock("../graph/ui", () => ({
  styles: {},
  GraphMessage: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  GraphInput: ({ onChangeText }: { onChangeText: (value: string) => void }) => {
    input.change = onChangeText;
    return null;
  },
  errorMessage: (error: Error) => error.message,
}));
vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    disabled,
    onPress,
  }: {
    children: ReactNode;
    disabled?: boolean;
    onPress: () => void;
  }) => (
    <button type="button" disabled={disabled} onClick={onPress}>
      {children}
    </button>
  ),
}));
vi.mock("@/components/ui/select-field", () => ({ SelectField: () => null }));
vi.mock("@/components/draggable-list", () => ({
  DraggableList: ({
    data,
    renderItem,
  }: {
    data: PlanRow[];
    renderItem: (row: { item: PlanRow; index: number }) => ReactNode;
  }) => data.map((item, index) => <div key={item.sha}>{renderItem({ item, index })}</div>),
  DraggableListHandle: () => null,
}));
vi.mock("@/utils/confirm-dialog", () => ({ confirmDialog: approve }));

let mount: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  mount = document.createElement("div");
  document.body.append(mount);
  root = createRoot(mount);
  approve.mockReset().mockResolvedValue(true);
});
afterEach(() => {
  act(() => root.unmount());
  mount.remove();
});

const head = "a".repeat(40);
const onto = "b".repeat(40);
const first = "c".repeat(40);
const second = "d".repeat(40);
const target = { cwd: "/workspace", targetRepoRoot: "/workspace/repo" };
const repo = {
  repoRoot: target.targetRepoRoot,
  currentBranch: "topic",
  headSha: head,
  repoId: "repo",
  displayName: "Repo",
  operationState: "idle" as const,
};
const plan = {
  cwd: target.cwd,
  repoRoot: repo.repoRoot,
  requestId: "plan",
  headSha: head,
  ontoSha: onto,
  isPushedRange: false,
  error: null,
  entries: [
    { sha: first, subject: "One" },
    { sha: second, subject: "Two" },
  ],
};
const close = () => {};

function button(name: string): HTMLButtonElement | undefined {
  return Array.from(mount.querySelectorAll("button")).find(
    (item) => item.textContent === "gitWorkbench.graph." + name,
  );
}

async function click(name: string) {
  const action = button(name);
  expect(action?.disabled).toBe(false);
  await act(async () => action?.click());
}

function mockDaemon(currentBranch: string) {
  const execute = vi.fn().mockResolvedValue({
    success: true,
    cwd: target.cwd,
    repoRoot: repo.repoRoot,
    rebaseId: "new",
    error: null,
  });
  const build = vi
    .fn()
    .mockResolvedValueOnce(plan)
    .mockResolvedValueOnce({ ...plan, conflictPaths: [] });
  const client = {
    checkoutGitRebaseBuildPlan: build,
    checkoutGitRebaseExecute: execute,
    checkoutGitReposDiscover: vi
      .fn()
      .mockResolvedValue({ error: null, repos: [{ ...repo, currentBranch }] }),
  } as unknown as DaemonClient;
  return { client, execute, build };
}

async function setup(currentBranch = "topic") {
  const { client, execute, build } = mockDaemon(currentBranch);
  const onResult = vi.fn();
  await act(async () =>
    root.render(
      <PlanSheet
        client={client}
        cwd={target.cwd}
        repo={repo}
        enabled
        onClose={close}
        onResult={onResult}
        ontoOptions={[]}
      />,
    ),
  );
  act(() => input.change("main"));
  await click("buildPlan");
  return { execute, build, onResult };
}

it("retains edited order through preflight and sends the pinned commit IDs after confirmation", async () => {
  const { execute, build, onResult } = await setup();
  await click("moveLater");
  await click("preflight");
  expect(build.mock.calls[1]).toEqual([{ ...target, ontoRef: "main", dryRun: true }]);
  expect(execute).not.toHaveBeenCalled();
  await click("execute");
  expect(approve).toHaveBeenCalledOnce();
  expect(execute).toHaveBeenCalledExactlyOnceWith({
    ...target,
    ontoRef: onto,
    expectedHeadSha: head,
    steps: [
      { type: "pick", sha: second },
      { type: "pick", sha: first },
    ],
  });
  expect(onResult).toHaveBeenCalledOnce();
});

it("disarms the plan if the checkout switches to another branch at the same HEAD", async () => {
  const { execute } = await setup("another-branch");
  await click("execute");
  expect(execute).not.toHaveBeenCalled();
  expect(button("execute")?.disabled).toBe(true);
  expect(mount.textContent).toContain("gitWorkbench.graph.staleHead");
});

it("ignores a confirmation that arrives after the plan closes", async () => {
  const approval = Promise.withResolvers<boolean>();
  approve.mockReturnValue(approval.promise);
  const { execute } = await setup();
  await click("execute");
  expect(approve).toHaveBeenCalledOnce();
  await act(async () => root.render(null));
  await act(async () => approval.resolve(true));
  expect(execute).not.toHaveBeenCalled();
});
