import type { ProxyConfig } from "electron";
import { describe, expect, it } from "vitest";
import { createDesktopProxy, type ProxyPlan } from "./desktop-proxy.js";
import {
  chromiumConfig,
  chromiumProxyResult,
  desktopProxyPolicy,
  proxyForTarget,
} from "./policy.js";
import { createSessionProxyPort, type LiveProxyConfig } from "./session-proxy.js";
import type { StoredProxySettings } from "./storage.js";

const http = "http://proxy.example";
const https = "https://secure-proxy.example";
const probes = [new URL("http://probe.example"), new URL("https://probe.example")];
const routing = { pairedLanHosts: [], independentDirectLan: false, webSockets: false };
const policy = desktopProxyPolicy.parse({
  mode: "manual",
  routes: { kind: "split", http, https },
  bypass: ["*"],
});
const credentials = new Map([
  [http, { username: "plain", password: "placeholder" }],
  [https, { username: "tls", password: "placeholder" }],
]);
const plan: ProxyPlan = {
  policy,
  config: chromiumConfig(policy, routing),
  credentials,
  ...routing,
};

function fakeSession(forceDirect = false, manual = policy) {
  const effects: string[] = [];
  let config: ProxyConfig = { mode: "direct" };
  let failClose = false;
  let badRoute = false;
  const liveRoutes = new Map<string, string>();
  return {
    effects,
    liveRoutes,
    failClose() {
      failClose = true;
    },
    badRoute(value: boolean) {
      badRoute = value;
    },
    async setProxy(value: ProxyConfig) {
      config = value;
      effects.push("set " + config.mode);
    },
    async forceReloadProxyConfig() {
      effects.push("reload");
    },
    async resolveProxy(address: string) {
      effects.push("resolve");
      if (badRoute) return "PROXY unexpected.example:80";
      const liveRoute = config.mode === "pac_script" && liveRoutes.get(address);
      if (liveRoute) return liveRoute;
      if (config.mode === "direct") return "DIRECT";
      if (config.proxyBypassRules === "<-loopback>") {
        if (forceDirect) return "DIRECT";
        return chromiumProxyResult(config.proxyRules ?? "");
      }
      const configured = proxyForTarget(manual, new URL(address));
      return configured ? chromiumProxyResult(configured) : "DIRECT";
    },
    async closeAllConnections() {
      effects.push("close");
      if (failClose) throw new Error("cannot close");
    },
    async clearAuthCache() {
      effects.push("clear auth");
    },
  };
}

function setup(
  timeoutMs = 1_000,
  forceDirect = false,
  manual = policy,
  liveConfig?: () => LiveProxyConfig,
) {
  const target = fakeSession(false, manual);
  const candidates: ReturnType<typeof fakeSession>[] = [];
  const requests: Array<{ url: string; keys: string[] }> = [];
  let waitForAbort = false;
  let aborts = 0;
  let onResume: (() => void) | undefined;
  const port = createSessionProxyPort({
    target,
    probes,
    routing,
    baseline: { mode: "direct" },
    liveConfig,
    timeoutMs,
    createCandidate() {
      const value = fakeSession(forceDirect, manual);
      candidates.push(value);
      return value;
    },
    async probe(_candidate, url, scopedCredentials, signal) {
      requests.push({ url: url.href, keys: [...scopedCredentials.keys()] });
      if (!waitForAbort) return;
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            aborts++;
            reject(signal.reason);
          },
          { once: true },
        );
      });
    },
    pauseRequests() {
      target.effects.push("pause");
      return () => {
        target.effects.push("resume");
        onResume?.();
      };
    },
    isolate() {
      target.effects.push("isolate");
    },
  });
  return {
    port,
    target,
    candidates,
    requests,
    waitForAbort(value: boolean) {
      waitForAbort = value;
    },
    aborts: () => aborts,
    onResume(callback: () => void) {
      onResume = callback;
    },
  };
}

describe("Chromium session proxy adapter", () => {
  it("verifies an ordered control fallback list despite separator spacing", async () => {
    const origin = "wss://host.example";
    const fixture = setup(1_000, false, policy, () => ({
      config: { mode: "pac_script" },
      control: new Map([[origin, "HTTPS proxy.example:443;DIRECT"]]),
      paired: new Set(),
    }));
    fixture.target.liveRoutes.set(origin + "/ws", "HTTPS proxy.example:443; DIRECT");
    await fixture.port.apply(plan);
    fixture.port.resume();
    fixture.target.liveRoutes.set(origin + "/ws", "DIRECT;HTTPS proxy.example:443");
    await expect(fixture.port.apply(plan)).rejects.toThrow(/expected desktop proxy route/);
  });

  it("forces both configured endpoints despite wildcard bypass and scopes the probe credentials", async () => {
    const fixture = setup();
    await fixture.port.test(plan);
    expect(fixture.requests).toEqual([
      { url: probes[0].href, keys: [http] },
      { url: probes[1].href, keys: [https] },
    ]);
    expect(fixture.target.effects).toEqual([]);
    expect(
      fixture.candidates[0].effects.filter((entry) => entry === "set fixed_servers"),
    ).toHaveLength(3);
  });

  it("starts authentication cleanup even if close fails and discards the candidate", async () => {
    const fixture = setup();
    await fixture.port.test(plan);
    fixture.candidates[0].failClose();
    await expect(fixture.port.test(plan)).rejects.toThrow(/clean/);
    expect(fixture.candidates[0].effects.slice(-2)).toEqual(["close", "clear auth"]);
    await fixture.port.test(plan);
    expect(fixture.candidates).toHaveLength(2);
  });

  it("rejects a forced DIRECT route before sending a probe", async () => {
    const fixture = setup(1_000, true);
    await expect(fixture.port.test(plan)).rejects.toThrow(/expected desktop proxy route/);
    expect(fixture.requests).toEqual([]);
    expect(fixture.target.effects).toEqual([]);
  });

  it("cancels the active probe at the deadline and creates a new candidate next time", async () => {
    const fixture = setup(30);
    fixture.waitForAbort(true);
    await expect(fixture.port.test(plan)).rejects.toThrow(/timed out/);
    expect(fixture.aborts()).toBe(1);
    expect(fixture.candidates[0].effects.slice(-3)).toEqual(["close", "clear auth", "clear auth"]);
    fixture.waitForAbort(false);
    await fixture.port.test(plan);
    expect(fixture.candidates).toHaveLength(2);
  });

  it("cleans connections on activation and baseline restoration before resuming the scope", async () => {
    const fixture = setup();
    await fixture.port.apply(plan);
    expect(fixture.target.effects.filter((entry) => entry !== "resolve")).toEqual([
      "pause",
      "close",
      "clear auth",
      "clear auth",
      "set fixed_servers",
      "reload",
      "close",
      "clear auth",
      "clear auth",
    ]);
    fixture.port.resume();
    fixture.target.effects.length = 0;
    fixture.target.badRoute(true);
    await expect(fixture.port.apply(null)).rejects.toThrow(/expected desktop proxy route/);
    expect(() => fixture.port.resume()).toThrow(/verified route/);
    expect(fixture.target.effects).not.toContain("resume");
    fixture.target.badRoute(false);
    await fixture.port.apply(null);
    expect(fixture.target.effects.filter((entry) => entry === "pause")).toHaveLength(1);
    fixture.port.resume();
    expect(fixture.target.effects.at(-1)).toBe("resume");
  });
});

async function setupWrite() {
  const manual = desktopProxyPolicy.parse({ ...policy, bypass: [] });
  const session = setup(1_000, false, manual);
  const effects = session.target.effects;
  const writing = Promise.withResolvers<void>();
  const disk = Promise.withResolvers<void>();
  let saved: StoredProxySettings = {
    version: 1,
    revision: 7,
    scopes: { browser: { policy: manual, credentials: [] } },
  };
  const service = await createDesktopProxy({
    scopes: { browser: session.port },
    store: {
      async load() {
        return saved;
      },
      async save(value) {
        effects.push("writing");
        writing.resolve();
        await disk.promise;
        saved = value;
        effects.push("written");
      },
    },
    vault: {
      seal() {
        throw new Error("unexpected encryption");
      },
      open() {
        throw new Error("unexpected decryption");
      },
    },
  });
  expect(effects.at(-1)).toBe("resume");
  effects.length = 0;
  return {
    service,
    disk,
    writing: writing.promise,
    onResume: session.onResume,
    saved: () => saved,
    effects: () => effects.filter((effect) => /^(pause|resume|isolate|set |writ)/.test(effect)),
  };
}

describe("Desktop proxy persistence with the Chromium session adapter", () => {
  it("keeps the candidate paused until disk and memory both show the new policy", async () => {
    const fixture = await setupWrite();
    const receipt = await fixture.service.test({
      scope: "browser",
      policy: { mode: "direct" },
      expectedRevision: 7,
    });
    const commit = fixture.service.commit("browser", receipt);
    await fixture.writing;
    expect(fixture.effects()).toEqual(["pause", "set direct", "writing"]);
    expect(fixture.service.load("browser").revision).toBe(7);
    let revisionAtResume: number | undefined;
    fixture.onResume(() => {
      revisionAtResume = fixture.service.load("browser").revision;
    });
    fixture.disk.resolve();
    await expect(commit).resolves.toMatchObject({ policy: { mode: "direct" }, revision: 8 });
    expect(fixture.effects()).toEqual(["pause", "set direct", "writing", "written", "resume"]);
    expect(revisionAtResume).toBe(8);
  });

  it("restores the previous route before releasing the same pause on a failed write", async () => {
    const fixture = await setupWrite();
    const update = fixture.service.update({ scope: "browser", policy: { mode: "direct" } });
    await fixture.writing;
    expect(fixture.effects()).toEqual(["pause", "set direct", "writing"]);
    fixture.disk.reject(new Error("disk failed"));
    await expect(update).rejects.toThrow(/Could not apply/);
    expect(fixture.effects()).toEqual([
      "pause",
      "set direct",
      "writing",
      "set fixed_servers",
      "resume",
    ]);
    expect(fixture.service.load("browser").state?.policy.mode).toBe("manual");
    expect(fixture.saved().revision).toBe(7);
  });

  it("isolates on a failed resume after saving and retains the committed route", async () => {
    const fixture = await setupWrite();
    fixture.onResume(() => {
      throw new Error("could not release requests");
    });
    const update = fixture.service.update({ scope: "browser", policy: { mode: "direct" } });
    await fixture.writing;
    fixture.disk.resolve();
    await expect(update).rejects.toThrow(/was saved, but its session could not resume/);
    expect(fixture.effects()).toEqual([
      "pause",
      "set direct",
      "writing",
      "written",
      "resume",
      "isolate",
    ]);
    expect(fixture.saved()).toMatchObject({
      revision: 8,
      scopes: { browser: { policy: { mode: "direct" } } },
    });
    expect(() => fixture.service.load("browser")).toThrow(/unavailable/);
  });
});
