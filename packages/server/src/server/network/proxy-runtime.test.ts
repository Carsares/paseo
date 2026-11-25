import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { EncryptedProxyCredentialStore } from "./proxy-credential-store.js";
import { diagnoseProxy } from "./proxy-diagnostics.js";
import { handleHostProxyRequest } from "./host-proxy-rpc.js";
import { HostProxyRuntime, type StoredHostProxySettings } from "./proxy-runtime.js";
import { parseHostProxySettings } from "./proxy-settings.js";

vi.mock("./proxy-diagnostics.js", () => ({ diagnoseProxy: vi.fn() }));

const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const dispose of cleanup.splice(0).toReversed()) await dispose();
  vi.resetAllMocks();
  vi.useRealTimers();
});

async function setup() {
  vi.useFakeTimers({ toFake: ["performance"] });
  const directory = await mkdtemp(join(tmpdir(), "paseo-proxy-secrets-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const key = randomBytes(32);
  const credentials = new EncryptedProxyCredentialStore(directory, async () => key);
  let stored: StoredHostProxySettings | undefined;
  const settings = {
    load: async () => structuredClone(stored),
    compareAndSet: vi.fn(async (expected: number, next: StoredHostProxySettings) => {
      if (expected !== (stored?.revision ?? 0)) return false;
      stored = structuredClone(next);
      return true;
    }),
  };
  const open = async () => {
    const runtime = await HostProxyRuntime.open({ settings, credentials });
    cleanup.push(() => runtime.close());
    return runtime;
  };
  return { runtime: await open(), directory, credentials, settings, open };
}

const manual = parseHostProxySettings({
  mode: "manual",
  proxy: { kind: "unified", url: "HTTP://Proxy.Example:80/" },
});

test.each([false, true])(
  "a proxy receipt binds its source with credential transport support %s",
  async (supportsCredentialReplacement) => {
    const { runtime } = await setup();
    const source = {};
    const signal = new AbortController().signal;
    const scope = {
      runtime,
      source,
      signal,
      authorized: true,
      allowCredentialReplacement: supportsCredentialReplacement,
      canManage: () => true,
    };
    const result = await handleHostProxyRequest({
      ...scope,
      request: {
        type: "daemon.network.test_proxy.request",
        requestId: "test",
        expectedRevision: 0,
        settings: { mode: "direct" },
      },
    });
    if (
      result.type !== "daemon.network.test_proxy.response" ||
      result.payload.result.status !== "passed"
    ) {
      throw new Error("Expected a proxy receipt");
    }
    const { verificationId, revision } = result.payload.result.receipt;
    const request = {
      type: "daemon.network.set_proxy.request",
      requestId: "save",
      verificationId,
      revision,
    } as const;
    await expect(handleHostProxyRequest({ ...scope, source: {}, request })).resolves.toMatchObject({
      payload: { requestId: "save", result: { status: "retest-required" } },
    });
    await expect(handleHostProxyRequest({ ...scope, request })).resolves.toMatchObject({
      payload: {
        requestId: "save",
        result: {
          status: "saved",
          snapshot: { revision: 1, access: "edit", supportsCredentialReplacement },
        },
      },
    });
    await expect(
      handleHostProxyRequest({
        ...scope,
        canManage: () => false,
        request: { type: "daemon.network.get_proxy.request", requestId: "read" },
      }),
    ).resolves.toMatchObject({
      payload: {
        requestId: "read",
        result: {
          status: "loaded",
          snapshot: { access: "read-only", supportsCredentialReplacement },
        },
      },
    });
  },
);

test("new credentials require protected ingress and denial does not start diagnostics", async () => {
  const { runtime } = await setup();
  const credentials = {
    unified: {
      action: "replace",
      credential: { username: "fixture", password: "fixture-password" },
    },
  } as const;
  const options = {
    runtime,
    source: {},
    signal: new AbortController().signal,
    authorized: true,
    allowCredentialReplacement: false,
    canManage: () => true,
    request: {
      type: "daemon.network.test_proxy.request",
      requestId: "replacement",
      settings: { mode: "manual", proxy: { kind: "unified", url: "http://proxy.example" } },
      expectedRevision: 0,
      credentials,
    },
  } as const;
  await expect(handleHostProxyRequest(options)).resolves.toMatchObject({
    payload: { requestId: "replacement", result: { status: "denied" } },
  });
  expect(diagnoseProxy).not.toHaveBeenCalled();
  await expect(
    handleHostProxyRequest({ ...options, allowCredentialReplacement: true }),
  ).resolves.toMatchObject({ payload: { result: { status: "passed" } } });
  vi.advanceTimersByTime(2_000);
  for (const action of ["keep", "clear"] as const) {
    await expect(
      handleHostProxyRequest({
        ...options,
        request: { ...options.request, credentials: { unified: { action } } },
      }),
    ).resolves.toMatchObject({ payload: { result: { status: "passed" } } });
    vi.advanceTimersByTime(2_000);
  }
});

test("validates the exact candidate and retires the old transport only after a durable commit", async () => {
  const { runtime, settings } = await setup();
  const before = runtime.dispatcher()!;
  vi.mocked(diagnoseProxy).mockResolvedValueOnce([
    {
      proxySlot: "unified",
      checks: [
        { protocol: "https", port: 443 },
        { protocol: "wss", port: 443 },
      ],
    },
  ]);
  const candidate = await runtime.validate(0, manual);
  expect(candidate).toEqual({
    validationId: expect.any(String),
    revision: 0,
    expiresInMs: 60_000,
    diagnostics: [
      {
        proxySlot: "unified",
        checks: [
          { protocol: "https", port: 443 },
          { protocol: "wss", port: 443 },
        ],
      },
    ],
  });
  await expect(runtime.validate(0, { mode: "direct" })).rejects.toThrow("rate limited");
  await expect(runtime.apply(1, candidate.validationId)).rejects.toThrow("revision changed");
  await expect(runtime.apply(0, "unrelated-validation")).rejects.toThrow("validation is required");
  expect(runtime.dispatcher()).toBe(before);

  settings.compareAndSet.mockResolvedValueOnce(false);
  await expect(runtime.apply(0, candidate.validationId)).rejects.toThrow("Could not commit");
  expect(runtime.dispatcher()).toBe(before);
  expect(await settings.load()).toBeUndefined();
  await expect(runtime.apply(0, candidate.validationId)).rejects.toThrow("validation is required");

  vi.advanceTimersByTime(2_000);
  const next = await runtime.validate(0, manual);
  await expect(runtime.apply(0, next.validationId)).resolves.toMatchObject({
    revision: 1,
    settings: manual,
    canRollback: true,
  });
  expect(runtime.dispatcher()).not.toBe(before);
  expect(() =>
    before.dispatch({ origin: "https://unused.invalid", path: "/", method: "GET" }, {}),
  ).toThrow("transport closed");

  vi.advanceTimersByTime(2_000);
  const rollback = await runtime.validateRollback(1);
  await expect(runtime.apply(1, rollback.validationId)).resolves.toMatchObject({
    revision: 2,
    settings: { mode: "inherit" },
  });
  expect((await settings.load())?.current).toEqual({ settings: { mode: "inherit" } });
});

test("rejects control plane overrides and keeps existing routing if diagnostics fail", async () => {
  const { runtime, settings } = await setup();
  for (const route of ["relay", "hub", "routed"] as const) {
    expect(runtime.dispatcher(route)).toBeUndefined();
    await expect(
      runtime.validate(0, { ...manual, controlPlane: { [route]: "override" } }),
    ).rejects.toThrow("requires authenticated recovery support");
  }
  expect(diagnoseProxy).not.toHaveBeenCalled();
  const diagnose = Promise.withResolvers<Awaited<ReturnType<typeof diagnoseProxy>>>();
  vi.mocked(diagnoseProxy).mockReturnValueOnce(diagnose.promise);
  const active = runtime.validate(0, manual);
  await expect(runtime.validate(0, { mode: "direct" })).rejects.toThrow("already running");
  diagnose.reject(new Error("Proxy diagnostic failed"));
  await expect(active).rejects.toThrow("Proxy diagnostic failed");
  expect(runtime.read()).toMatchObject({ revision: 0, settings: { mode: "inherit" } });
  expect(settings.compareAndSet).not.toHaveBeenCalled();
});

test("an expired diagnostic cannot change active settings", async () => {
  const { runtime, settings } = await setup();
  const pending = await runtime.validate(0, manual);
  vi.advanceTimersByTime(pending.expiresInMs);
  await expect(runtime.apply(0, pending.validationId)).rejects.toThrow("validation is required");
  expect(settings.compareAndSet).not.toHaveBeenCalled();
});

test("persists only an encrypted credential reference and erases it when cleared", async () => {
  const { runtime, directory, credentials, settings, open } = await setup();
  const secret = "example-proxy-passphrase";
  const install = await runtime.validate(0, manual, {
    unified: { action: "replace", credential: { username: "proxy-user", password: secret } },
  });
  const active = await runtime.apply(0, install.validationId);
  expect(active.credentialConfigured).toEqual({ unified: true, http: false, https: false });
  const stored = (await settings.load())!;
  expect(JSON.stringify([active, stored, install])).not.toContain(secret);
  const reference = stored.current.credentialId!;
  const [filename] = await readdir(directory);
  expect(filename).toBe(`${reference}.enc`);
  expect(await readFile(join(directory, filename!), "utf8")).not.toContain(secret);
  const wrongKey = new EncryptedProxyCredentialStore(directory, async () => randomBytes(32));
  await expect(wrongKey.read(reference)).rejects.toThrow(
    "Could not read encrypted proxy credentials",
  );
  const reopened = await open();
  expect(reopened.read()).toEqual(active);
  await reopened.close();

  vi.advanceTimersByTime(2_000);
  await expect(
    runtime.validate(1, {
      mode: "manual",
      proxy: { kind: "unified", url: "http://a-different-proxy.example" },
    }),
  ).rejects.toThrow("replacing or clearing its credentials");
  const keep = await runtime.validate(1, manual);
  await expect(runtime.apply(1, keep.validationId)).resolves.toMatchObject({
    credentialConfigured: { unified: true },
  });

  vi.advanceTimersByTime(2_000);
  const clear = await runtime.validate(2, manual, { unified: { action: "clear" } });
  await expect(runtime.apply(2, clear.validationId)).resolves.toMatchObject({
    credentialConfigured: { unified: false },
    canRollback: false,
  });
  await expect(credentials.read(reference)).rejects.toThrow(
    "Could not read encrypted proxy credentials",
  );
  expect(await readdir(directory)).toEqual([]);
});

test("credential cleanup failure cannot restore a cleared credential and is retried on reopen", async () => {
  const { runtime, credentials, directory, open } = await setup();
  const install = await runtime.validate(0, manual, {
    unified: { action: "replace", credential: { username: "test", password: "example" } },
  });
  await runtime.apply(0, install.validationId);
  vi.advanceTimersByTime(2_000);
  const clear = await runtime.validate(1, manual, { unified: { action: "clear" } });
  vi.spyOn(credentials, "remove").mockRejectedValueOnce(new Error("Could not unlink"));
  await expect(runtime.apply(1, clear.validationId)).resolves.toMatchObject({
    credentialConfigured: { unified: false },
    canRollback: false,
    credentialCleanupPending: true,
  });
  expect(await readdir(directory)).toHaveLength(1);
  const restarted = await open();
  expect(restarted.read()).toMatchObject({ revision: 2, credentialCleanupPending: false });
  expect(await readdir(directory)).toEqual([]);
});

test("changing an authenticated proxy address retires its credential even with a replacement", async () => {
  const { runtime, settings, directory } = await setup();
  const first = await runtime.validate(0, manual, {
    unified: { action: "replace", credential: { username: "proxy-user", password: "old" } },
  });
  await runtime.apply(0, first.validationId);
  const oldId = (await settings.load())?.current.credentialId;

  vi.advanceTimersByTime(2_000);
  const replacement = await runtime.validate(
    1,
    { mode: "manual", proxy: { kind: "unified", url: "https://new-proxy.example" } },
    { unified: { action: "replace", credential: { username: "proxy-user", password: "new" } } },
  );
  await expect(runtime.apply(1, replacement.validationId)).resolves.toMatchObject({
    credentialConfigured: { unified: true },
    canRollback: false,
  });
  const stored = await settings.load();
  expect(stored?.retiredCredentialIds).toEqual([oldId]);
  expect(await readdir(directory)).toEqual([`${stored?.current.credentialId}.enc`]);
});

test("retries only this writer's abandoned credential after a rejected commit", async () => {
  const { runtime, credentials, directory, open, settings } = await setup();
  const otherId = await credentials.write({
    unified: { username: "test", password: "other-writer" },
  });
  const rejected = await runtime.validate(0, manual, {
    unified: { action: "replace", credential: { username: "test", password: "example" } },
  });
  settings.compareAndSet.mockResolvedValueOnce(false);
  const remove = vi
    .spyOn(credentials, "remove")
    .mockRejectedValueOnce(new Error("Could not unlink"));
  await expect(runtime.apply(0, rejected.validationId)).rejects.toThrow(
    /^Could not commit host proxy settings: revision changed$/,
  );
  expect(runtime.read()).toMatchObject({ revision: 0, credentialCleanupPending: true });
  expect(await settings.load()).toBeUndefined();
  const abandonedId = remove.mock.calls[0]![0];
  expect(abandonedId).not.toBe(otherId);
  expect(await readdir(directory)).toHaveLength(2);

  vi.advanceTimersByTime(2_000);
  const candidate = await runtime.validate(0, { mode: "direct" });
  remove.mockRejectedValueOnce(new Error("Still could not unlink"));
  await expect(runtime.apply(0, candidate.validationId)).resolves.toMatchObject({
    revision: 1,
    credentialCleanupPending: true,
  });
  expect((await settings.load())?.retiredCredentialIds).toEqual([abandonedId]);
  const restarted = await open();
  expect(restarted.read().credentialCleanupPending).toBe(false);
  expect(await readdir(directory)).toEqual([`${otherId}.enc`]);
});
