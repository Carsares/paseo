/** @vitest-environment jsdom */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  MutableDaemonConfigSchema,
  parseServerInfoStatusPayload,
  type MutableDaemonConfigPatch,
} from "@getpaseo/protocol/messages";
import { validateWSOutboundMessage } from "@getpaseo/protocol/validation/ws-outbound";
import { daemonConfigQueryKey } from "@/data/daemon-config";
import { en } from "@/i18n/resources/en";
import { toDaemonServerInfo, useSessionStore } from "@/stores/session-store";
import { HostAgentsPage } from "./host-page";

const connectedHosts = vi.hoisted(() => new Map<string, unknown>());

vi.mock("@/runtime/host-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/runtime/host-runtime")>()),
  useHosts: () => [...connectedHosts.keys()].map((serverId) => ({ serverId })),
  useHostRuntimeClient: (serverId: string) => connectedHosts.get(serverId) ?? null,
  useHostRuntimeIsConnected: (serverId: string) => connectedHosts.has(serverId),
}));

vi.mock("@/agent-profiles", () => ({ AgentProfilesSection: () => null }));
vi.mock("@/agent-skills", () => ({ AgentSkillsSection: () => null }));
vi.mock("@/provider-settings", () => ({ ProviderList: () => null }));
vi.mock("@/usage", () => ({ HostUsageSection: () => null }));
vi.mock("./browser-tools-card", () => ({ BrowserToolsOptInCard: () => null }));
vi.mock("./paseo-tools-card", () => ({ PaseoToolsCard: () => null }));
vi.mock("./restart-recovery-card", () => ({ RestartRecoveryCard: () => null }));
vi.mock("./idle-runtime-cleanup-card", () => ({ IdleRuntimeCleanupCard: () => null }));

const promptCopy = en.settings.host.orchestration.mainControlSystemPrompt;
const commonCopy = en.settings.host.orchestration.systemPrompt;
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

function connectHost(serverId: string, supported: boolean | undefined, prompt?: string) {
  let config = MutableDaemonConfigSchema.parse({
    mcp: { injectIntoAgents: false },
    appendSystemPrompt: "General prompt",
    ...(prompt === undefined ? {} : { mainControlAppendSystemPrompt: prompt }),
  });
  const patchDaemonConfig = vi.fn(async (patch: MutableDaemonConfigPatch) => {
    config = MutableDaemonConfigSchema.parse({ ...config, ...patch });
    return { config };
  });
  const getDaemonConfig = vi.fn(async () => ({ config }));
  connectedHosts.set(serverId, { getDaemonConfig, patchDaemonConfig });
  const parsed = validateWSOutboundMessage({
    type: "session",
    message: {
      type: "status",
      payload: {
        status: "server_info",
        serverId,
        ...(supported === undefined
          ? {}
          : { features: { mainControlAppendSystemPrompt: supported } }),
      },
    },
  });
  if (!parsed.success || parsed.data.type !== "session" || parsed.data.message.type !== "status") {
    throw new Error("Invalid server_info envelope");
  }
  const info = parseServerInfoStatusPayload(parsed.data.message.payload);
  if (!info) throw new Error("Invalid server_info payload");
  const store = useSessionStore.getState();
  store.initializeSession(serverId, null);
  store.updateSessionServerInfo(serverId, toDaemonServerInfo(info));
  return { getDaemonConfig, patchDaemonConfig };
}

function page(serverId: string) {
  return (
    <QueryClientProvider client={queryClient}>
      <HostAgentsPage serverId={serverId} />
    </QueryClientProvider>
  );
}

async function openMainControlPrompt() {
  const edit = screen.getByTestId("host-page-main-control-system-prompt-edit");
  await waitFor(() => expect(edit.getAttribute("aria-disabled")).not.toBe("true"));
  fireEvent.click(edit);
  return screen.getByLabelText<HTMLTextAreaElement>(promptCopy.sheetTitle);
}

afterEach(() => {
  cleanup();
  queryClient.clear();
  connectedHosts.clear();
  useSessionStore.setState({ sessions: {} });
});

it("shows the main control prompt only for hosts advertising support and closes it on host change", async () => {
  const { patchDaemonConfig: patchFirstHost } = connectHost("first", true, "First host prompt");
  connectHost("second", true, "Second host prompt");
  connectHost("disabled", false, "Hidden prompt");
  const { patchDaemonConfig: patchOldHost } = connectHost("old", undefined);

  const { rerender } = render(page("first"));
  expect(screen.getByTestId("host-page-append-system-prompt-card").nextElementSibling).toBe(
    screen.getByTestId("host-page-main-control-system-prompt-card"),
  );
  const firstInput = await openMainControlPrompt();
  expect(firstInput.value).toBe("First host prompt");
  fireEvent.change(firstInput, { target: { value: "Unsaved draft" } });

  rerender(page("second"));
  expect(screen.queryByLabelText(promptCopy.sheetTitle)).toBeNull();
  expect((await openMainControlPrompt()).value).toBe("Second host prompt");
  expect(patchFirstHost).not.toHaveBeenCalled();

  for (const serverId of ["disabled", "old"]) {
    rerender(page(serverId));
    expect(screen.queryByText(promptCopy.title)).toBeNull();
    expect(screen.getAllByText(commonCopy.title)).toHaveLength(1);
  }

  const edit = screen.getByTestId("host-page-append-system-prompt-edit");
  await waitFor(() => expect(edit.getAttribute("aria-disabled")).not.toBe("true"));
  fireEvent.click(edit);
  const generalInput = screen.getByLabelText<HTMLTextAreaElement>(commonCopy.accessibilityLabel);
  expect(generalInput.value).toBe("General prompt");
  fireEvent.change(generalInput, { target: { value: "Different general prompt" } });
  fireEvent.click(screen.getByRole("button", { name: commonCopy.save }));
  await waitFor(() => expect(screen.queryByLabelText(commonCopy.accessibilityLabel)).toBeNull());
  expect(patchOldHost.mock.calls).toEqual([[{ appendSystemPrompt: "Different general prompt" }]]);
});

it("preserves a draft on config readback and saves an empty prompt without sending other fields", async () => {
  const { patchDaemonConfig: patch } = connectHost("host", true, "Saved prompt");
  render(page("host"));
  const input = await openMainControlPrompt();
  fireEvent.change(input, { target: { value: "Draft prompt" } });

  await act(async () => {
    queryClient.setQueryData(daemonConfigQueryKey("host"), {
      ...queryClient.getQueryData<object>(daemonConfigQueryKey("host")),
      mainControlAppendSystemPrompt: "Updated elsewhere",
    });
  });
  expect(input.value).toBe("Draft prompt");
  const save = screen.getByRole("button", { name: commonCopy.save });
  fireEvent.click(save);
  await waitFor(() => expect(screen.queryByLabelText(promptCopy.sheetTitle)).toBeNull());
  expect(patch).toHaveBeenNthCalledWith(1, { mainControlAppendSystemPrompt: "Draft prompt" });

  const reopened = await openMainControlPrompt();
  await act(async () => {
    queryClient.setQueryData(daemonConfigQueryKey("host"), {
      ...queryClient.getQueryData<object>(daemonConfigQueryKey("host")),
      mainControlAppendSystemPrompt: "Replaced while open",
    });
  });
  expect(reopened.value).toBe("Draft prompt");
  expect(screen.getByRole("button", { name: commonCopy.save }).getAttribute("aria-disabled")).toBe(
    "true",
  );
  const reset = screen.getByRole("button", { name: commonCopy.reset });
  await waitFor(() => expect(reset.getAttribute("aria-disabled")).not.toBe("true"));
  fireEvent.click(reset);
  const resetInput = screen.getByLabelText<HTMLTextAreaElement>(promptCopy.sheetTitle);
  expect(resetInput.value).toBe("Replaced while open");

  fireEvent.change(resetInput, { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: commonCopy.save }));
  await waitFor(() => expect(screen.queryByLabelText(promptCopy.sheetTitle)).toBeNull());
  expect(patch).toHaveBeenNthCalledWith(2, { mainControlAppendSystemPrompt: "" });
  expect((await openMainControlPrompt()).value).toBe("");
});

it("keeps the draft in the sheet when a save fails and retries it", async () => {
  const { patchDaemonConfig: patch } = connectHost("host", true, "Saved prompt");
  patch.mockRejectedValueOnce(new Error("Save rejected"));
  render(page("host"));
  const input = await openMainControlPrompt();
  fireEvent.change(input, { target: { value: "Retry this draft" } });

  fireEvent.click(screen.getByRole("button", { name: commonCopy.save }));
  const error = await screen.findByRole("alert");
  expect(error.textContent).toBe(en.common.errors.unableToSave);
  expect(input.value).toBe("Retry this draft");

  fireEvent.click(screen.getByRole("button", { name: commonCopy.save }));
  await waitFor(() => expect(screen.queryByLabelText(promptCopy.sheetTitle)).toBeNull());
  expect(patch.mock.calls).toEqual([
    [{ mainControlAppendSystemPrompt: "Retry this draft" }],
    [{ mainControlAppendSystemPrompt: "Retry this draft" }],
  ]);
});

it("offers a retry after reading settings fails, without opening an empty editor", async () => {
  const { getDaemonConfig } = connectHost("host", true, "Saved prompt");
  getDaemonConfig.mockRejectedValueOnce(new Error("Read rejected"));
  render(page("host"));

  expect(
    screen.getByTestId("host-page-main-control-system-prompt-edit").getAttribute("aria-disabled"),
  ).toBe("true");
  expect(screen.queryByLabelText(promptCopy.sheetTitle)).toBeNull();
  const readError = await screen.findByRole("alert");
  expect(readError.textContent).toContain(commonCopy.loadFailed);
  fireEvent.click(screen.getByRole("button", { name: en.common.actions.retry }));

  expect((await openMainControlPrompt()).value).toBe("Saved prompt");
  expect(getDaemonConfig).toHaveBeenCalledTimes(2);
});

it("keeps edits made while the previous prompt is saving", async () => {
  const { patchDaemonConfig: patch } = connectHost("host", true, "Saved prompt");
  let completeSave: (() => void) | undefined;
  patch.mockImplementationOnce(async ({ mainControlAppendSystemPrompt }) => {
    await new Promise<void>((resolve) => {
      completeSave = resolve;
    });
    return {
      config: MutableDaemonConfigSchema.parse({
        mcp: { injectIntoAgents: false },
        mainControlAppendSystemPrompt,
      }),
    };
  });
  render(page("host"));
  const input = await openMainControlPrompt();
  fireEvent.change(input, { target: { value: "First save" } });
  fireEvent.click(screen.getByRole("button", { name: commonCopy.save }));
  expect(
    (await screen.findByRole("button", { name: commonCopy.saving })).getAttribute("aria-disabled"),
  ).toBe("true");
  fireEvent.change(input, { target: { value: "New draft" } });
  await act(async () => {
    if (!completeSave) throw new Error("Save did not start");
    completeSave();
  });

  expect(screen.getByLabelText<HTMLTextAreaElement>(promptCopy.sheetTitle).value).toBe("New draft");
  fireEvent.click(await screen.findByRole("button", { name: commonCopy.save }));
  await waitFor(() => expect(screen.queryByLabelText(promptCopy.sheetTitle)).toBeNull());
  expect(patch.mock.calls).toEqual([
    [{ mainControlAppendSystemPrompt: "First save" }],
    [{ mainControlAppendSystemPrompt: "New draft" }],
  ]);
});
