import { describe, expect, it } from "vitest";
import { openProxyForm, type ProxyFormModel } from "./form-model";
import {
  parseBypass,
  parseProxyOrigin,
  type ProxySnapshot,
  type ProxyTestResult,
} from "./settings";

const manual: ProxySnapshot = {
  access: "edit",
  revision: 7,
  settings: {
    mode: "manual",
    endpoints: {
      kind: "split",
      httpUrl: "http://first.example:8080",
      httpsUrl: "https://second.example:8443",
    },
    bypass: [".corp.example"],
  },
  credentialSlots: ["http"],
  supportsBypass: true,
};

function passingTest(validationId: string): ProxyTestResult {
  return { status: "passed", receipt: { validationId, revision: 7, expiresInMs: 1000 } };
}

function load(model: ProxyFormModel, snapshot = manual) {
  model.completeLoad(model.beginLoad(), { status: "loaded", snapshot });
}

function beginTest(model: ProxyFormModel) {
  const request = model.beginTest();
  if (!request) throw new Error("Expected the draft to be testable");
  return request;
}

describe("proxy form validation", () => {
  it.each([
    "socks5://proxy.example",
    "http://user:pass@proxy.example",
    "http://@proxy.example",
    "http://proxy.example/a/..",
    "http://proxy.example/?",
    "http://proxy.example/#",
    "http://proxy.example\\secret",
    "http://proxy.example:0",
    "http://proxy.example:65536",
  ])("rejects %s as an origin", (value) => {
    expect(parseProxyOrigin(value)).toBeNull();
  });

  it("canonicalizes an HTTP origin and validates bypass networks and ports", () => {
    expect(parseProxyOrigin(" HTTPS://Proxy.Example:443/ ")).toBe("https://proxy.example");
    expect(parseBypass("*.example:443, 192.0.2.0/24\n[2001:db8::]/64 [::1]:80")).toEqual([
      "*.example:443",
      "192.0.2.0/24",
      "[2001:db8::]/64",
      "[::1]:80",
    ]);
    expect(parseBypass("http://intranet.example")).toBeNull();
    expect(parseBypass("example:65536")).toBeNull();
    expect(parseBypass("192.0.2.0/33")).toBeNull();
    expect(parseBypass("[2001:db8::]/129")).toBeNull();
  });
});

describe("proxy form model", () => {
  it("requires a test of the latest draft even when a previous test passes late", () => {
    const model = openProxyForm({ kind: "host", hostId: "host-a" });
    load(model);
    model.setMode("system");
    expect(model.beginTest()).toBeNull();
    model.setText("bypass", "one.example");
    const old = beginTest(model);
    model.setText("bypass", "two.example");
    const latest = beginTest(model);
    model.completeTest(old.ticket, passingTest("stale"));
    expect(model.beginSave()).toBeNull();
    expect(latest.input.expectedRevision).toBe(7);
    const passed = passingTest("current");
    model.completeTest(latest.ticket, passed);
    expect(JSON.stringify(model.getState())).not.toContain("validationId");
    expect(model.beginSave()).toEqual({
      ticket: expect.any(Number),
      receipt: { validationId: "current", revision: 7, expiresInMs: 1000 },
    });
    model.setText("bypass", "edit-while-saving.example");
    expect(model.getState()).toMatchObject({ draft: { bypass: "two.example" } });
  });

  it("keeps credentials bound to their slot and origin, and sends secrets only in a request", () => {
    const model = openProxyForm({ kind: "host", hostId: "host-a" });
    load(model);
    model.setText("httpUrl", "http://new.example:8080");
    expect(model.getState()).toMatchObject({ credentialErrors: { http: { action: true } } });
    expect(model.beginTest()).toBeNull();
    model.setCredentialAction("http", "clear");
    model.setCredentialAction("https", "replace");
    model.setSecret("https", "password", "test-only-secret");
    expect(JSON.stringify(model.getState())).not.toContain("test-only-secret");
    const test = beginTest(model);
    expect(test.input.change.credentials).toEqual({
      http: { action: "clear" },
      https: { action: "replace", credential: { username: "", password: "test-only-secret" } },
    });
    model.completeTest(test.ticket, { status: "denied" });
    expect(model.getState()).toMatchObject({
      snapshot: { access: "read-only" },
      draft: { credentialActions: { http: "keep", https: "keep" } },
    });
    expect(model.beginTest()).toBeNull();
  });

  it("ignores a save result from a closed form and rejects unsanitized snapshots", () => {
    const model = openProxyForm({ kind: "host", hostId: "host-a" });
    load(model);
    model.setMode("direct");
    const test = beginTest(model);
    model.completeTest(test.ticket, passingTest("before-close"));
    const save = model.beginSave();
    if (!save) throw new Error("Expected a save after a passing test");
    model.close();
    load(model);
    model.completeSave(save.ticket, {
      status: "saved",
      snapshot: { ...manual, settings: { mode: "direct" } },
    });
    expect(model.getState()).toMatchObject({ snapshot: { settings: { mode: "manual" } } });
    load(model, {
      ...manual,
      settings: {
        mode: "manual",
        endpoints: { kind: "unified", url: "http://user:pass@proxy.example" },
        bypass: [],
      },
    });
    expect(model.getState()).toEqual({ status: "load-failed", issue: "unavailable" });
  });

  it("rejects a receipt from another revision and expires a valid receipt before saving", () => {
    let now = 0;
    const model = openProxyForm({ kind: "host", hostId: "host-a" }, () => now);
    load(model);
    model.setMode("direct");
    const old = beginTest(model);
    model.completeTest(old.ticket, {
      status: "passed",
      receipt: { validationId: "older-revision", revision: 6, expiresInMs: 1000 },
    });
    expect(model.beginSave()).toBeNull();

    const current = beginTest(model);
    model.completeTest(current.ticket, passingTest("expires"));
    now = 1000;
    expect(model.beginSave()).toBeNull();
    expect(model.getState()).toMatchObject({
      activity: { status: "retest-required" },
      canSave: false,
    });
    expect(model.beginTest()).not.toBeNull();
  });
});
