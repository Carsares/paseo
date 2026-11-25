import { fireEvent, within } from "@testing-library/dom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { i18n } from "@/i18n/i18next";
import { ProxySettingsForm, type ProxySettingsFormProps } from "./proxy-settings-form";
import type { ProxySaveResult, ProxySettingsAdapter, ProxyTestResult } from "./settings";

function passingTest(validationId: string): ProxyTestResult {
  return { status: "passed", receipt: { validationId, revision: 7, expiresInMs: 30000 } };
}

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  await i18n.changeLanguage("en");
});

async function render(props: ProxySettingsFormProps) {
  await act(async () => root.render(<ProxySettingsForm {...props} />));
  return within(container);
}

async function click(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element);
  });
}

it("translates an open form without reloading the draft", async () => {
  const load = vi.fn<ProxySettingsAdapter["load"]>().mockResolvedValue({
    status: "loaded",
    snapshot: {
      access: "edit",
      revision: 7,
      settings: {
        mode: "manual",
        endpoints: { kind: "unified", url: "https://proxy.example" },
        bypass: ["private.example"],
      },
      credentialSlots: [],
      supportsBypass: true,
    },
  });
  const adapter: ProxySettingsAdapter = {
    load,
    test: async () => ({ status: "failed" }),
    save: async () => ({ status: "failed" }),
  };
  const view = await render({ target: { kind: "device" }, adapter });
  await act(async () => {
    fireEvent.change(view.getByLabelText("Proxy URL"), { target: { value: "invalid" } });
    await i18n.changeLanguage("zh-CN");
  });
  expect(view.getByText("此设备")).toBeVisible();
  expect(view.getByText("手动配置 · 统一地址 · 1 条绕过规则")).toBeVisible();
  expect(view.getByLabelText<HTMLInputElement>("代理地址").value).toBe("invalid");
  expect(
    view.getByText("请输入 HTTP 或 HTTPS 地址。地址不能包含凭据、路径、查询参数或片段。"),
  ).toBeVisible();
  expect(load).toHaveBeenCalledOnce();

  await click(view.getByRole("button", { name: "直连" }));
  await click(view.getByRole("button", { name: "测试连接" }));
  expect(view.getByText("连接测试失败，请检查设置后重试。")).toBeVisible();
});

it.each([
  {
    language: "en",
    device: ["Proxy for HTTP", "Proxy for HTTPS"],
    host: ["Proxy for HTTP and WS", "Proxy for HTTPS and WSS"],
  },
  {
    language: "zh-CN",
    device: ["HTTP 代理地址", "HTTPS 代理地址"],
    host: ["HTTP 和 WS 代理地址", "HTTPS 和 WSS 代理地址"],
  },
])("labels split proxy addresses by target in $language", async ({ language, device, host }) => {
  await i18n.changeLanguage(language);
  const adapter: ProxySettingsAdapter = {
    load: async () => ({
      status: "loaded",
      snapshot: {
        access: "edit",
        revision: 7,
        settings: {
          mode: "manual",
          endpoints: {
            kind: "split",
            httpUrl: "http://proxy.example",
            httpsUrl: "https://proxy.example",
          },
          bypass: [],
        },
        credentialSlots: [],
        supportsBypass: false,
      },
    }),
    test: async () => ({ status: "failed" }),
    save: async () => ({ status: "failed" }),
  };
  const deviceView = await render({ target: { kind: "device" }, adapter });
  for (const label of device) expect(deviceView.getByLabelText(label)).toBeVisible();

  const hostView = await render({ target: { kind: "host", hostId: "a" }, adapter });
  for (const label of host) expect(hostView.getByLabelText(label)).toBeVisible();
});

it("shows a redacted saved summary while read-only", async () => {
  const adapter: ProxySettingsAdapter = {
    load: async () => ({
      status: "loaded",
      snapshot: {
        access: "read-only",
        revision: 7,
        settings: {
          mode: "manual",
          endpoints: { kind: "unified", url: "http://private-proxy.example:8080" },
          bypass: ["private-domain.example"],
        },
        credentialSlots: ["unified"],
        supportsBypass: true,
      },
    }),
    test: vi.fn<ProxySettingsAdapter["test"]>(async () => ({ status: "failed" })),
    save: vi.fn<ProxySettingsAdapter["save"]>(async () => ({ status: "failed" })),
  };
  const view = await render({
    target: { kind: "host", hostId: "a" },
    hostLabel: "Office",
    adapter,
  });
  expect(view.getByText("Office")).toBeVisible();
  expect(view.getByText("Stored")).toBeVisible();
  expect(view.getByText("You have read-only access to these settings.")).toBeVisible();
  expect(container.textContent).not.toContain("private-proxy.example");
  expect(container.textContent).not.toContain("private-domain.example");
  expect(view.queryByRole("button", { name: "Save" })).toBeNull();
  expect(adapter.test).not.toHaveBeenCalled();
  expect(adapter.save).not.toHaveBeenCalled();
});

it("lets a host on an insecure connection remove a saved credential but not enter a new one", async () => {
  const test = vi.fn<ProxySettingsAdapter["test"]>(async () => passingTest("remove-on-plain"));
  const adapter: ProxySettingsAdapter = {
    load: async () => ({
      status: "loaded",
      snapshot: {
        access: "edit",
        revision: 7,
        settings: {
          mode: "manual",
          endpoints: { kind: "unified", url: "https://proxy.example" },
          bypass: [],
        },
        credentialSlots: ["unified"],
        supportsBypass: true,
        supportsCredentialReplacement: false,
      },
    }),
    test,
    save: async () => ({ status: "failed" }),
  };
  const view = await render({ target: { kind: "host", hostId: "a" }, adapter });
  expect(view.queryByRole("button", { name: "Replace" })).toBeNull();
  expect(view.queryByLabelText("Proxy password")).toBeNull();
  expect(
    view.getByText("Connect securely to this host to enter new proxy credentials."),
  ).toBeVisible();
  await click(view.getByRole("button", { name: "Remove" }));
  await click(view.getByRole("button", { name: "Test connection" }));
  expect(test).toHaveBeenCalledWith(
    { kind: "host", hostId: "a" },
    expect.objectContaining({
      change: expect.objectContaining({ credentials: { unified: { action: "clear" } } }),
    }),
    expect.any(AbortSignal),
  );
});

it("gates saving on a successful test and shows a safe retry after transport failure", async () => {
  const test = vi.fn<ProxySettingsAdapter["test"]>();
  test.mockRejectedValueOnce(new Error("test-only-secret"));
  test.mockResolvedValueOnce(passingTest("first"));
  test.mockResolvedValueOnce(passingTest("latest"));
  const save = vi.fn<ProxySettingsAdapter["save"]>();
  save.mockResolvedValueOnce({ status: "retest-required" });
  save.mockResolvedValue({
    status: "saved",
    snapshot: {
      access: "edit",
      revision: 7,
      settings: { mode: "direct" },
      credentialSlots: [],
      supportsBypass: false,
    },
  });
  const adapter: ProxySettingsAdapter = {
    load: async () => ({
      status: "loaded",
      snapshot: {
        access: "edit",
        revision: 7,
        settings: { mode: "system" },
        credentialSlots: [],
        supportsBypass: false,
      },
    }),
    test,
    save,
  };
  const view = await render({ target: { kind: "device" }, adapter });
  const action = (name: string) => view.getByRole("button", { name });
  expect(action("System")).toBeVisible();
  expect(view.queryByRole("button", { name: "Inherit" })).toBeNull();
  await click(action("Direct"));
  expect(action("Save").getAttribute("aria-disabled")).toBe("true");

  await click(action("Test connection"));
  expect(view.getByText("Connection test failed. Check the settings and try again.")).toBeVisible();
  expect(container.textContent).not.toContain("test-only-secret");
  expect(save).not.toHaveBeenCalled();

  await click(action("Test connection"));
  await click(action("Save"));
  expect(
    view.getByText("The previous test is no longer valid. Test the connection again."),
  ).toBeVisible();
  expect(action("Save").getAttribute("aria-disabled")).toBe("true");

  await click(action("Test connection"));
  await click(action("Save"));
  expect(view.getByText("Proxy settings saved.")).toBeVisible();
  expect(test.mock.lastCall?.[1].expectedRevision).toBe(7);
  expect(save).toHaveBeenLastCalledWith(
    { kind: "device" },
    { validationId: "latest", revision: 7, expiresInMs: 30000 },
    expect.any(AbortSignal),
  );
});

it("starts from the new host's snapshot when the previous host save completes late", async () => {
  const pending = Promise.withResolvers<ProxySaveResult>();
  const save = vi.fn<ProxySettingsAdapter["save"]>(() => pending.promise);
  const adapter: ProxySettingsAdapter = {
    load: async () => ({
      status: "loaded",
      snapshot: {
        access: "edit",
        revision: 7,
        settings: { mode: "inherit" },
        credentialSlots: [],
        supportsBypass: true,
      },
    }),
    test: async () => passingTest("first-host"),
    save,
  };
  const view = await render({
    target: { kind: "host", hostId: "a" },
    hostLabel: "Office",
    adapter,
  });
  const action = (name: string) => view.getByRole("button", { name });
  await click(action("Direct"));
  await click(action("Test connection"));
  await click(action("Save"));
  expect(view.getByText("Saving proxy settings...")).toBeVisible();
  await render({ target: { kind: "host", hostId: "b" }, hostLabel: "Home", adapter });
  expect(save.mock.lastCall?.[0]).toEqual({ kind: "host", hostId: "a" });
  expect(save.mock.lastCall?.[2].aborted).toBe(true);
  await act(async () => {
    pending.resolve({
      status: "saved",
      snapshot: {
        access: "edit",
        revision: 7,
        settings: { mode: "direct" },
        credentialSlots: [],
        supportsBypass: true,
      },
    });
  });
  expect(view.getByText("Home")).toBeVisible();
  expect(action("Inherit").getAttribute("aria-selected")).toBe("true");
  expect(view.queryByText("Proxy settings saved.")).toBeNull();
});

it("starts replacement blank and requires a new test when credential intent changes", async () => {
  const test = vi
    .fn<ProxySettingsAdapter["test"]>()
    .mockResolvedValue(passingTest("credential-change"));
  const adapter: ProxySettingsAdapter = {
    load: async () => ({
      status: "loaded",
      snapshot: {
        access: "edit",
        revision: 7,
        settings: {
          mode: "manual",
          endpoints: { kind: "unified", url: "https://proxy.example" },
          bypass: [],
        },
        credentialSlots: ["unified"],
        supportsBypass: true,
      },
    }),
    test,
    save: async () => ({ status: "failed" }),
  };
  const view = await render({ target: { kind: "host", hostId: "a" }, adapter });
  const action = (name: string) => view.getByRole("button", { name });
  expect(view.queryByLabelText("Proxy password")).toBeNull();

  await click(action("Replace"));
  const password = view.getByLabelText<HTMLInputElement>("Proxy password");
  expect(password.type).toBe("password");
  expect(password.value).toBe("");
  await act(async () => {
    fireEvent.change(password, { target: { value: "test-only-replacement" } });
  });
  await click(action("Test connection"));
  expect(test.mock.lastCall?.[1].change.credentials).toEqual({
    unified: { action: "replace", credential: { username: "", password: "test-only-replacement" } },
  });
  expect(action("Save").getAttribute("aria-disabled")).not.toBe("true");
  expect(view.getByLabelText<HTMLInputElement>("Proxy password").value).toBe("");

  await click(action("Remove"));
  expect(view.queryByLabelText("Proxy password")).toBeNull();
  expect(action("Save").getAttribute("aria-disabled")).toBe("true");
  await click(action("Test connection"));
  expect(test.mock.lastCall?.[1].change.credentials).toEqual({ unified: { action: "clear" } });
});
