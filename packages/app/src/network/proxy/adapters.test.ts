import { afterEach, expect, it, vi } from "vitest";
import { invokeDesktopCommand } from "@/desktop/electron/invoke";
import { createDeviceProxyAdapter } from "./device-adapter";
import { createHostProxyAdapter } from "./host-adapter";
import type { ProxyTestInput } from "./settings";

vi.mock("@/desktop/electron/invoke");

afterEach(() => vi.resetAllMocks());

const target = { kind: "host", hostId: "office" } as const;
const device = { kind: "device" } as const;
const receipt = { validationId: "test-id", revision: 3, expiresInMs: 500 };
const change: ProxyTestInput["change"] = {
  settings: {
    mode: "manual",
    endpoints: { kind: "unified", url: "https://proxy.example" },
    bypass: [],
  },
  credentials: { unified: { action: "clear" } },
};

type HostClient = Parameters<typeof createHostProxyAdapter>[0]["client"];

it("passes the exact device bridge payloads and omits expiry from saves", async () => {
  const invoke = vi.mocked(invokeDesktopCommand);
  invoke.mockResolvedValueOnce({ status: "unavailable" });
  invoke.mockResolvedValueOnce({ status: "passed", receipt });
  invoke.mockResolvedValueOnce({ status: "retest-required" });
  const adapter = createDeviceProxyAdapter();
  const signal = new AbortController().signal;

  await adapter.load(device, signal);
  await expect(adapter.test(device, { change, expectedRevision: 3 }, signal)).resolves.toEqual({
    status: "passed",
    receipt,
  });
  await expect(adapter.save(device, receipt, signal)).resolves.toEqual({
    status: "retest-required",
  });

  expect(invoke.mock.calls).toEqual([
    ["get_device_proxy", {}],
    ["test_device_proxy", { change, expectedRevision: 3 }],
    ["set_device_proxy", { validationId: "test-id", revision: 3 }],
  ]);
});

it("maps the host proxy fields and sends only the verification ID and revision on commit", async () => {
  const snapshot = {
    revision: 3,
    access: "edit",
    settings: { mode: "manual", proxy: { kind: "unified", url: "https://proxy.example" } },
    supportsBypass: true,
    supportsCredentialReplacement: true,
    credentialSlots: [],
  } as const;
  const client = {
    canSendOutboundProxyCredentials: vi.fn(() => false),
    getOutboundProxy: vi.fn<HostClient["getOutboundProxy"]>().mockResolvedValue({
      status: "loaded",
      snapshot: { ...snapshot, credentialSlots: [] },
    }),
    testOutboundProxy: vi.fn<HostClient["testOutboundProxy"]>().mockResolvedValue({
      status: "passed",
      receipt: { verificationId: "test-id", revision: 3, expiresInMs: 500 },
    }),
    setOutboundProxy: vi.fn<HostClient["setOutboundProxy"]>().mockResolvedValue({
      status: "saved",
      snapshot: { ...snapshot, revision: 4, credentialSlots: [] },
    }),
  };
  const adapter = createHostProxyAdapter({ hostId: target.hostId, client, isCurrent: () => true });
  const signal = new AbortController().signal;

  await expect(adapter.load(target, signal)).resolves.toMatchObject({
    status: "loaded",
    snapshot: { settings: change.settings, revision: 3, supportsCredentialReplacement: false },
  });
  expect(client.getOutboundProxy).toHaveBeenCalledWith({});
  await expect(adapter.test(target, { change, expectedRevision: 3 }, signal)).resolves.toEqual({
    status: "passed",
    receipt,
  });
  expect(client.testOutboundProxy).toHaveBeenCalledWith({
    expectedRevision: 3,
    settings: { ...snapshot.settings, bypass: [] },
    credentials: change.credentials,
  });
  await expect(adapter.save(target, receipt, signal)).resolves.toMatchObject({
    status: "saved",
    snapshot: { settings: change.settings, revision: 4 },
  });
  expect(client.setOutboundProxy).toHaveBeenCalledWith({ verificationId: "test-id", revision: 3 });
  await expect(
    adapter.test(
      target,
      {
        expectedRevision: 4,
        change: {
          ...change,
          credentials: {
            unified: { action: "replace", credential: { username: "u", password: "p" } },
          },
        },
      },
      signal,
    ),
  ).resolves.toEqual({ status: "denied" });
  expect(client.testOutboundProxy).toHaveBeenCalledOnce();
});

it("blocks another host or canceled request and discards results from a replaced connection", async () => {
  const pending = Promise.withResolvers<Awaited<ReturnType<HostClient["testOutboundProxy"]>>>();
  const client = {
    canSendOutboundProxyCredentials: vi.fn(() => true),
    getOutboundProxy: vi.fn<HostClient["getOutboundProxy"]>(),
    testOutboundProxy: vi.fn<HostClient["testOutboundProxy"]>(() => pending.promise),
    setOutboundProxy: vi.fn<HostClient["setOutboundProxy"]>(),
  };
  let isCurrent = true;
  const adapter = createHostProxyAdapter({
    hostId: target.hostId,
    client,
    isCurrent: () => isCurrent,
  });
  const controller = new AbortController();
  const other = { kind: "host", hostId: "home" } as const;

  await expect(adapter.save(other, receipt, controller.signal)).resolves.toEqual({
    status: "unavailable",
  });
  expect(client.setOutboundProxy).not.toHaveBeenCalled();

  const result = adapter.test(target, { change, expectedRevision: 3 }, controller.signal);
  expect(client.testOutboundProxy).toHaveBeenCalledOnce();
  isCurrent = false;
  pending.resolve({
    status: "passed",
    receipt: { verificationId: "test-id", revision: 3, expiresInMs: 500 },
  });
  await expect(result).resolves.toEqual({ status: "unavailable" });

  isCurrent = true;
  controller.abort();
  await expect(adapter.load(target, controller.signal)).resolves.toEqual({ status: "unavailable" });
  expect(client.getOutboundProxy).not.toHaveBeenCalled();
});
