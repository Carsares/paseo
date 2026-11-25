import { describe, expect, it } from "vitest";
import type { WebFrameMain } from "electron";
import { createDesktopProxy, type DesktopProxyScopePort, type ProxyPlan } from "./desktop-proxy.js";
import { createNativeControlRoutes } from "./native-control.js";
import {
  chromiumConfig,
  desktopProxyPolicy,
  matchingCredentials,
  proxyForTarget,
  proxyUrl,
} from "./policy.js";
import { proxyVault, type DesktopProxyStore, type StoredProxySettings } from "./storage.js";

const manual = {
  mode: "manual",
  routes: { kind: "unified", url: "https://proxy.example:8443" },
};
const replacement = {
  action: "replace",
  proxyUrl: manual.routes.url,
  credentials: { username: "test-user", password: "test-password" },
};
const split = {
  mode: "manual",
  routes: { kind: "split", http: "http://proxy.example", https: "https://secure.example" },
};
const httpCredential = { username: "http-user", password: "http-password" };
const httpsCredential = { username: "", password: "https-password" };
const splitCredentials = {
  http: { action: "replace", credential: httpCredential },
  https: { action: "replace", credential: httpsCredential },
};

function setup() {
  const sessions: string[] = [];
  const checkedPlans: ProxyPlan[] = [];
  let saved: StoredProxySettings = { version: 1, scopes: {} };
  let failTest = false;
  let failSave = false;
  let failRestore = false;
  let time = 0;
  let loadCount = 0;
  let sealCount = 0;
  const sealed = new Map<string, typeof replacement.credentials>();
  const store: DesktopProxyStore = {
    async load() {
      loadCount++;
      return saved;
    },
    async save(settings) {
      sessions.push("save");
      if (failSave) throw new Error("disk write failed");
      saved = settings;
    },
  };
  function scope(name: string): DesktopProxyScopePort {
    return {
      routing: { pairedLanHosts: [], independentDirectLan: false, webSockets: false },
      async test(plan) {
        checkedPlans.push(plan);
        sessions.push(`test ${name} ${plan.policy.mode}`);
        if (failTest) throw new Error("candidate failed");
      },
      async apply(plan) {
        sessions.push(`apply ${name} ${plan?.policy.mode ?? "baseline"}`);
        if (failRestore && plan?.policy.mode === "manual") throw new Error("restore failed");
      },
      resume() {},
      isolate() {
        sessions.push("isolate " + name);
      },
    };
  }
  const vault = {
    seal: (value: typeof replacement.credentials) => {
      sealCount++;
      const token = Buffer.from(sealCount === 1 ? "ciphertext" : "ciphertext" + sealCount).toString(
        "base64",
      );
      sealed.set(token, value);
      return token;
    },
    open(token: string) {
      const value = sealed.get(token);
      if (!value) throw new Error("Unknown ciphertext");
      return value;
    },
  };
  return {
    sessions,
    checkedPlans,
    store,
    vault,
    scopes: { browser: scope("browser"), updater: scope("updater") },
    saved: () => saved,
    loadCount: () => loadCount,
    sealCount: () => sealCount,
    now: () => time,
    advance: (milliseconds: number) => {
      time += milliseconds;
    },
    failRestore: () => {
      failRestore = true;
    },
    failTest: () => {
      failTest = true;
    },
    failSave: () => {
      failSave = true;
    },
  };
}

describe("desktop proxy policy", () => {
  it.each([
    "socks5://proxy.example:1080",
    "http://user:password@proxy.example",
    "http://@proxy.example",
    "https://proxy.example/",
    "https://proxy.example?",
    "https://proxy.example#",
    "https://proxy.example;direct://",
    "https://proxy.example\n",
    "https://proxy.example:0",
  ])("rejects unsupported proxy URL %j", (url) => {
    expect(proxyUrl.safeParse(url).success).toBe(false);
  });

  it("keeps HTTP and HTTPS proxy types and restricts custom bypass to exact paired hosts", () => {
    const policy = desktopProxyPolicy.parse(manual);
    const config = chromiumConfig(policy, {
      pairedLanHosts: ["box.lan", "192.168.1.50", "fd00::1234"],
      independentDirectLan: false,
      webSockets: true,
    });
    expect(config).toEqual({
      mode: "fixed_servers",
      proxyRules: "https://proxy.example:8443",
      proxyBypassRules:
        "<-loopback>,127.0.0.0/8,[::1],localhost,localhost.,*.localhost,*.localhost.,box.lan,box.lan.,192.168.1.50,[::ffff:192.168.1.50],[fd00::1234]",
    });
    expect(() =>
      chromiumConfig(policy, {
        pairedLanHosts: ["<-loopback>"],
        independentDirectLan: false,
        webSockets: true,
      }),
    ).toThrow(/Invalid paired LAN hostname/);
  });

  it("uses direct and system modes only with a safe route for paired hosts", () => {
    const routing = { pairedLanHosts: ["box.lan"], independentDirectLan: false, webSockets: true };
    expect(chromiumConfig({ mode: "direct" }, routing)).toEqual({ mode: "direct" });
    expect(() => chromiumConfig({ mode: "system" }, routing)).toThrow(
      /independent direct transport/,
    );
    expect(chromiumConfig({ mode: "system" }, { ...routing, independentDirectLan: true })).toEqual({
      mode: "system",
    });
  });

  it("restricts distinct split routes to HTTP(S)-only sessions", () => {
    const policy = desktopProxyPolicy.parse(split);
    const routing = { pairedLanHosts: [], independentDirectLan: false, webSockets: true };
    expect(() => chromiumConfig(policy, routing)).toThrow(/HTTP\(S\)-only/);
    expect(chromiumConfig(policy, { ...routing, webSockets: false })).toMatchObject({
      mode: "fixed_servers",
      proxyRules: "http=http://proxy.example;https=https://secure.example",
    });
    const same = desktopProxyPolicy.parse({
      ...split,
      routes: { ...split.routes, https: split.routes.http },
    });
    expect(chromiumConfig(same, routing).proxyRules).toBe(split.routes.http);
  });
});

describe("desktop proxy bypass", () => {
  it("compiles only explicit loopback, paired and user bypass rules", () => {
    const policy = desktopProxyPolicy.parse({
      ...split,
      bypass: [
        ".corp.example:443",
        "192.0.2.0/24",
        "[2001:db8::]/32",
        "[fd00:1::1]:8443",
        "192.0.3.1:8080",
      ],
    });
    const pairedLanHosts = ["box.lan", "fe80::2"];
    const routing = { pairedLanHosts, independentDirectLan: false, webSockets: false };
    for (const url of [
      "https://corp.example",
      "https://sub.corp.example.",
      "http://sub.corp.example:443",
      "http://192.0.2.9",
      "https://[::ffff:192.0.2.8]",
      "https://[2001:db8::1]",
      "https://[fd00:1::1]:8443",
      "http://192.0.3.1:8080",
      "https://box.lan.",
      "http://[fe80::2]",
      "http://[::ffff:127.6.1.1]",
      "http://sub.localhost.",
    ]) {
      expect(proxyForTarget(policy, new URL(url), pairedLanHosts)).toBeNull();
    }
    expect(proxyForTarget(policy, new URL("http://corp.example"))).toBe(split.routes.http);
    for (const url of [
      "https://notcorp.example",
      "https://192-0-2-9.example",
      "https://[fe80::1]",
      "https://169.254.23.4",
      "https://[fd00:1::1]",
    ]) {
      expect(proxyForTarget(policy, new URL(url), pairedLanHosts)).toBe(split.routes.https);
    }
    expect(chromiumConfig(policy, routing).proxyBypassRules?.split(",")).toEqual([
      "<-loopback>",
      "127.0.0.0/8",
      "[::1]",
      "localhost",
      "localhost.",
      "*.localhost",
      "*.localhost.",
      "box.lan",
      "box.lan.",
      "[fe80::2]",
      "corp.example:443",
      "corp.example.:443",
      "*.corp.example:443",
      "*.corp.example.:443",
      "192.0.2.0/24",
      "2001:db8::/32",
      "[fd00:1::1]:8443",
      "192.0.3.1:8080",
      "[::ffff:192.0.3.1]:8080",
    ]);
  });

  it.each([
    "<-loopback>",
    "<local>",
    "direct://",
    "*.foo.*",
    "host;*",
    "host,other",
    "host\n",
    "x:0",
    "x:65536",
    "not-an-ip/24",
    "192.0.2.1/33",
    "::ffff:192.0.2.1/95",
    "x');alert('",
  ])("rejects unsupported bypass rule %j", (rule) => {
    expect(desktopProxyPolicy.safeParse({ ...manual, bypass: [rule] }).success).toBe(false);
  });
});

describe("desktop proxy updates", () => {
  it.each([true, false])(
    "recovers a changed system control route only after verification (%s)",
    async (verified) => {
      const fixture = setup();
      const frame = { detached: false, url: "paseo://app/" } as WebFrameMain;
      const target = new URL("wss://relay.example/ws?role=client&serverId=fixture&v=2");
      const events: string[] = [];
      let system = "DIRECT";
      const routes = createNativeControlRoutes({ resolveProxy: async () => system });
      const port: DesktopProxyScopePort = {
        routing: fixture.scopes.browser.routing,
        test: async (plan) => {
          routes.routes(plan);
        },
        async apply(plan, routingOnly) {
          if (!plan) throw new Error("unexpected baseline");
          events.push(routingOnly ? "refresh" : `apply ${plan.policy.mode}`);
          if (plan.controlRecovery) {
            expect(routes.verificationRoutes().get(target.href)).toBe(system);
            if (!verified) throw new Error("system route verification failed");
          } else {
            routes.routes(plan);
          }
        },
        resume: () => {
          events.push("resume");
        },
        isolate: () => {
          events.push("isolate");
        },
      };
      const service = await createDesktopProxy({ ...fixture, scopes: { mainWindow: port } });
      await service.update({ scope: "mainWindow", policy: manual, credentials: replacement });
      const old = fixture.saved();
      system = "HTTPS proxy.example:8443";
      events.length = 0;
      const pending = service.refreshRouting("mainWindow", routes.stage(frame, target));
      if (!verified) {
        await expect(pending).rejects.toThrow();
        expect(events).toEqual(["refresh", "apply system", "isolate"]);
        expect(routes.verificationRoutes().size).toBe(0);
        expect(() => service.load("mainWindow")).toThrow();
      } else {
        await pending;
        expect(events).toEqual(["refresh", "apply system", "resume"]);
        expect(service.load("mainWindow")).toMatchObject({ suspended: true, revision: 1 });
        expect(routes.authorize({ id: 1, url: target.href, frame }, "begin")).toBe(system);
      }
      expect(fixture.saved()).toBe(old);
    },
  );

  it("leaves both scopes untouched on startup and never activates a failed candidate", async () => {
    const fixture = setup();
    const service = await createDesktopProxy(fixture);
    expect(service.state("browser")).toBeNull();
    expect(fixture.sessions).toEqual([]);
    fixture.failTest();
    await expect(service.update({ scope: "browser", policy: manual })).rejects.toThrow(/candidate/);
    expect(fixture.sessions).toEqual(["test browser manual"]);
    expect(service.state("browser")).toBeNull();
  });

  it("restores the old policy when persistence fails after activation", async () => {
    const fixture = setup();
    const service = await createDesktopProxy(fixture);
    await service.update({ scope: "browser", policy: manual });
    fixture.failSave();
    await expect(service.update({ scope: "browser", policy: { mode: "direct" } })).rejects.toThrow(
      /Could not apply/,
    );
    expect(fixture.sessions).toEqual([
      "test browser manual",
      "apply browser manual",
      "save",
      "test browser direct",
      "apply browser direct",
      "save",
      "apply browser manual",
    ]);
    expect(service.state("browser")?.policy).toEqual(manual);
    expect(service.state("updater")).toBeNull();
  });

  it("returns credential presence only, keeps by default, and clears without reloading disk", async () => {
    const fixture = setup();
    const service = await createDesktopProxy(fixture);
    const input = { scope: "browser", policy: manual };
    const state = await service.update({ ...input, credentials: replacement });
    expect(state).toEqual({
      policy: manual,
      credentialUrls: [manual.routes.url],
      credentialSlots: ["unified"],
    });
    expect(fixture.saved().scopes.browser?.credentials).toEqual([
      { proxyUrl: manual.routes.url, encrypted: "Y2lwaGVydGV4dA==" },
    ]);
    expect((await service.update(input)).credentialUrls).toEqual([manual.routes.url]);
    const cleared = await service.update({
      ...input,
      credentials: { action: "clear", proxyUrl: manual.routes.url },
    });
    expect(cleared.credentialUrls).toEqual([]);
    expect(fixture.saved().scopes.browser?.credentials).toEqual([]);
    expect(fixture.loadCount()).toBe(1);
  });

  it("deletes credential ciphertext when changing modes and never resurrects it", async () => {
    const fixture = setup();
    const service = await createDesktopProxy(fixture);
    await service.update({ scope: "browser", policy: manual, credentials: replacement });
    const direct = await service.update({ scope: "browser", policy: { mode: "direct" } });
    expect(direct.credentialUrls).toEqual([]);
    expect(fixture.saved().scopes.browser?.credentials).toEqual([]);
    expect(fixture.checkedPlans.at(-1)?.credentials.size).toBe(0);
    await service.update({ scope: "browser", policy: manual });
    expect(fixture.checkedPlans.at(-1)?.credentials.size).toBe(0);
  });

  it("checks both replacements in memory, then validates, applies and saves both together", async () => {
    const fixture = setup();
    const service = await createDesktopProxy(fixture);
    const input = { scope: "browser", policy: split, credentials: splitCredentials };
    await service.test({ ...input, expectedRevision: 0 });
    expect(fixture.sessions).toEqual(["test browser manual"]);
    expect(fixture.sealCount()).toBe(0);
    expect(service.state("browser")).toBeNull();
    const state = await service.update(input);
    expect(fixture.sessions).toEqual([
      "test browser manual",
      "test browser manual",
      "apply browser manual",
      "save",
    ]);
    expect(fixture.sealCount()).toBe(2);
    expect(state.credentialSlots).toEqual(["http", "https"]);
    const expected = [
      [split.routes.http, httpCredential],
      [split.routes.https, httpsCredential],
    ];
    expect(fixture.checkedPlans.map((plan) => [...plan.credentials])).toEqual([expected, expected]);
    expect(fixture.saved().scopes.browser?.credentials).toHaveLength(2);
  });

  it("commits the exact tested plan once without taking a second copy of its credentials", async () => {
    const fixture = setup();
    const service = await createDesktopProxy(fixture);
    const input = { scope: "browser", policy: split, credentials: splitCredentials };
    const receipt = await service.test({ ...input, expectedRevision: 0 });
    await expect(service.commit("updater", receipt)).rejects.toThrow(/no longer current/);
    await expect(service.commit("browser", { ...receipt, revision: 42 })).rejects.toThrow(
      /no longer current/,
    );
    const state = await service.commit("browser", receipt);
    expect(state.revision).toBe(1);
    expect(state.credentialSlots).toEqual(["http", "https"]);
    expect(fixture.sessions).toEqual(["test browser manual", "apply browser manual", "save"]);
    expect(fixture.sealCount()).toBe(2);
    await expect(service.commit("browser", receipt)).rejects.toThrow(/no longer current/);
  });

  it("rejects superseded, expired and pre-update receipts", async () => {
    const fixture = setup();
    const service = await createDesktopProxy(fixture);
    const input = { scope: "browser", policy: manual, expectedRevision: 0 };
    const first = await service.test(input);
    const expired = await service.test(input);
    await expect(service.commit("browser", first)).rejects.toThrow(/no longer current/);
    fixture.advance(expired.expiresInMs);
    await expect(service.commit("browser", expired)).rejects.toThrow(/expired/);
    const beforeOtherWrite = await service.test(input);
    await service.update({ scope: "updater", policy: manual });
    await expect(service.commit("browser", beforeOtherWrite)).rejects.toThrow(/no longer current/);
  });

  it("rejects a draft from a stale load when an earlier queued save advances the revision", async () => {
    const fixture = setup();
    const service = await createDesktopProxy(fixture);
    const snapshot = service.load("browser");
    expect(snapshot).toEqual({ state: null, revision: 0 });
    const newerSave = service.update({ scope: "updater", policy: { mode: "direct" } });
    const olderTest = service.test({
      scope: "browser",
      policy: manual,
      expectedRevision: snapshot.revision,
    });
    await expect(olderTest).rejects.toMatchObject({ code: "revision-conflict" });
    await newerSave;
    expect(fixture.sessions).toEqual(["test updater direct", "apply updater direct", "save"]);
    expect(service.load("browser")).toEqual({ state: null, revision: 1 });

    const reopened = await createDesktopProxy(fixture);
    const current = reopened.load("browser");
    expect(current).toEqual({ state: null, revision: 1 });
    const receipt = await reopened.test({
      scope: "browser",
      policy: manual,
      expectedRevision: current.revision,
    });
    expect(receipt.revision).toBe(current.revision);
  });

  it("isolates just the affected scope when persistence and rollback both fail", async () => {
    const fixture = setup();
    const service = await createDesktopProxy(fixture);
    await service.update({ scope: "browser", policy: manual });
    fixture.failSave();
    fixture.failRestore();
    await expect(service.update({ scope: "browser", policy: { mode: "direct" } })).rejects.toThrow(
      /restore/,
    );
    expect(fixture.sessions.at(-1)).toBe("isolate browser");
    expect(() => service.state("browser")).toThrow(/unavailable/);
    expect(service.state("updater")).toBeNull();
  });

  it("removes replaced addresses while keeping credentials for the unchanged slot", async () => {
    const fixture = setup();
    const service = await createDesktopProxy(fixture);
    await service.update({ scope: "browser", policy: split, credentials: splitCredentials });
    const policy = { ...split, routes: { ...split.routes, http: "http://replacement.example" } };
    await expect(service.update({ scope: "browser", policy })).rejects.toThrow(
      /replacing or clearing/,
    );
    const state = await service.update({
      scope: "browser",
      policy,
      credentials: { http: { action: "clear" }, https: { action: "keep" } },
    });
    expect(state.credentialSlots).toEqual(["https"]);
    expect(state.credentialUrls).toEqual([split.routes.https]);
    expect([...(fixture.checkedPlans.at(-1)?.credentials ?? [])]).toEqual([
      [split.routes.https, httpsCredential],
    ]);
    await service.update({
      scope: "browser",
      policy: { mode: "direct" },
      credentials: { https: { action: "clear" } },
    });
    expect(service.state("browser")?.credentialUrls).toEqual([]);
  });

  it("rejects distinct credentials for shared proxy addresses before probing", async () => {
    const fixture = setup();
    const service = await createDesktopProxy(fixture);
    for (const https of ["http://proxy.example", "https://proxy.example:80"]) {
      const policy = { ...split, routes: { ...split.routes, https } };
      await expect(
        service.test({
          scope: "browser",
          policy,
          credentials: splitCredentials,
          expectedRevision: 0,
        }),
      ).rejects.toThrow(/require match|require identical/);
    }
    expect(fixture.sessions).toEqual([]);
    const policy = { ...split, routes: { ...split.routes, https: split.routes.http } };
    const both = { http: splitCredentials.http, https: splitCredentials.http };
    const state = await service.update({ scope: "browser", policy, credentials: both });
    expect(state.credentialSlots).toEqual(["http", "https"]);
    expect(fixture.sealCount()).toBe(1);
  });

  it.each([
    { username: "", password: "" },
    { username: "a:b", password: "pw" },
    { username: "a", password: "pw\n" },
    { username: "a", password: "b".repeat(1025) },
  ])("rejects invalid replacement credentials", async (credential) => {
    const fixture = setup();
    const service = await createDesktopProxy(fixture);
    await expect(
      service.test({
        scope: "browser",
        policy: manual,
        expectedRevision: 0,
        credentials: { unified: { action: "replace", credential } },
      }),
    ).rejects.toThrow(/Invalid desktop proxy settings/);
    expect(fixture.sessions).toEqual([]);
  });

  it("only answers matching proxy authentication challenges in the credentials given to the scope", () => {
    const scopeCredentials: ProxyPlan["credentials"] = new Map([
      [manual.routes.url, replacement.credentials],
    ]);
    const auth = { isProxy: true, host: "PROXY.example", port: 8443 };
    expect(matchingCredentials(scopeCredentials, auth)).toEqual(replacement.credentials);
    expect(matchingCredentials(scopeCredentials, { ...auth, isProxy: false })).toBeUndefined();
    expect(
      matchingCredentials(scopeCredentials, { ...auth, host: "other.example" }),
    ).toBeUndefined();
    expect(matchingCredentials(scopeCredentials, { ...auth, port: 8080 })).toBeUndefined();
    expect(matchingCredentials(new Map(), auth)).toBeUndefined();
  });

  it("rejects Linux basic_text and validates encryption before returning ciphertext", () => {
    const storage = {
      isEncryptionAvailable: () => true,
      getSelectedStorageBackend: () => "basic_text" as const,
      encryptString: () => Buffer.from("encrypted"),
      decryptString: () => "wrong data",
    };
    expect(() => proxyVault(storage, "linux").seal(replacement.credentials)).toThrow(
      /Secure proxy credential storage is unavailable/,
    );
    expect(() => proxyVault(storage, "darwin").seal(replacement.credentials)).toThrow(
      /Could not verify secure proxy credential storage/,
    );
  });
});
