import type { WebFrameMain } from "electron";
import { describe, expect, it } from "vitest";
import type { ProxyPlan } from "./desktop-proxy.js";
import {
  chromiumRoute,
  createNativeControlRoutes,
  parseControlSocketTarget,
} from "./native-control.js";

const url = new URL("wss://host.example/ws?serverId=fixture&role=client&v=2");
const system = "HTTPS proxy.example:443;DIRECT";
const direct: ProxyPlan = {
  policy: { mode: "direct" },
  config: { mode: "direct" },
  credentials: new Map(),
  pairedLanHosts: [],
  webSockets: false,
};
const makeFrame = () => ({ detached: false, url: "paseo://app/" }) as WebFrameMain;

describe("native desktop control routes", () => {
  it("normalizes Chromium fallback separators without changing the route order", () => {
    expect(chromiumRoute("HTTPS proxy.example:443; SOCKS5 [::1]:1080; DIRECT")).toBe(
      "HTTPS proxy.example:443;SOCKS5 [::1]:1080;DIRECT",
    );
    expect(chromiumRoute("DIRECT; HTTPS proxy.example:443")).not.toBe(system);
    expect(() => chromiumRoute("PROXY proxy.example:65536;DIRECT")).toThrow(/Unsupported/);
  });

  it("reserves one exact socket request for its owning frame", async () => {
    const routes = createNativeControlRoutes({ resolveProxy: async () => system });
    const frame = makeFrame();
    const request = { id: 1, url: url.href, frame };
    await routes.stage(frame, url)();
    expect(routes.routes(direct)).toEqual(new Map([["wss://host.example", system]]));
    expect(routes.authorize({ ...request, frame: makeFrame() }, "begin")).toBeNull();
    expect(routes.authorize({ ...request, url: "wss://host.example/ws" }, "begin")).toBeNull();
    expect(routes.authorize(request, "begin")).toBe(system);
    expect(routes.authorize({ ...request, id: 2 }, "begin")).toBeNull();
    expect(routes.authorize({ ...request, id: 2 }, "send")).toBeNull();
    expect(routes.authorize(request, "send")).toBe(system);
    routes.forget(1);
    expect(routes.routes(direct)).toEqual(new Map());
    expect(routes.authorize(request, "send")).toBeNull();
  });

  it("rejects a device credential endpoint shared with the system control chain", async () => {
    const routes = createNativeControlRoutes({ resolveProxy: async () => system });
    const undo = await routes.stage(makeFrame(), url)();
    const conflicting = {
      ...direct,
      credentials: new Map([
        ["https://proxy.example", { username: "fixture", password: "fixture" }],
      ]),
    };
    expect(() => routes.routes(conflicting)).toThrow(/shares a device proxy credential endpoint/);
    undo();
    expect(routes.verificationRoutes().size).toBe(0);
    expect(() => routes.routes(conflicting)).toThrow(/shares a device proxy credential endpoint/);
  });

  it("protects known control routes after their handshake leases are consumed", async () => {
    const routes = createNativeControlRoutes({ resolveProxy: async () => system });
    const manual: ProxyPlan = {
      ...direct,
      policy: { mode: "manual", routes: { kind: "unified", url: "http://proxy.example:443" } },
      credentials: new Map([
        ["http://proxy.example:443", { username: "fixture", password: "fixture" }],
      ]),
    };
    const first = makeFrame();
    const second = makeFrame();
    for (const [id, frame] of [first, second].entries()) {
      await routes.stage(frame, url)();
      const request = { id, url: url.href, frame };
      expect(routes.authorize(request, "begin")).toBe(system);
      expect(routes.authorize(request, "send")).toBe(system);
      routes.forget(id);
    }
    expect(routes.routes(direct).size).toBe(0);
    expect(routes.authorize({ id: 2, url: url.href, frame: second }, "begin")).toBeNull();
    routes.releaseFrame(first);
    expect(() => routes.routes(manual)).toThrow(/shares a device proxy credential endpoint/);

    await routes.stage(second, url)();
    expect(routes.authorize({ id: 3, url: url.href, frame: second }, "begin")).toBe(system);
    routes.forget(3);
    routes.releaseFrame(second);
    expect(routes.verificationRoutes().size).toBe(0);
    expect(() => routes.routes(manual)).toThrow(/shares a device proxy credential endpoint/);
  });

  it("rejects conflicting system routes that Chromium would key to the same authority", async () => {
    let systemRoute = system;
    const routes = createNativeControlRoutes({ resolveProxy: async () => systemRoute });
    await routes.stage(makeFrame(), url)();
    systemRoute = "DIRECT";
    await expect(routes.stage(makeFrame(), new URL("wss://host.example/ws"))()).rejects.toThrow(
      /unavailable/,
    );
    expect(routes.routes(direct)).toEqual(new Map([["wss://host.example", system]]));
  });

  it("retains no pending or queued permission after the owning document navigates", async () => {
    const routes = createNativeControlRoutes({ resolveProxy: async () => system });
    const frame = makeFrame();
    await routes.stage(frame, url)();
    const delayed = routes.stage(frame, url);
    routes.releaseFrame(frame);
    await expect(delayed()).rejects.toThrow(/unavailable/);
    expect(routes.authorize({ id: 1, url: url.href, frame }, "begin")).toBeNull();
  });
});

describe("native control socket targets", () => {
  it.each([
    "https://daemon.example/ws",
    "ws://@daemon.example/ws",
    "ws://daemon.example:0/ws",
    "ws://daemon.example/other",
    "ws://daemon.example/ws#fragment",
    "ws://daemon.example/ws?role=server&serverId=paired&v=2",
    "ws://daemon.example/ws?role=client&serverId=paired&v=2&v=1",
    "ws://daemon.example/ws?token=secret",
  ])("rejects disallowed destination %s", (target) => {
    expect(parseControlSocketTarget(target)).toBeNull();
  });

  it("accepts direct IPv6 and relay client targets", () => {
    expect(parseControlSocketTarget("ws://[::1]:6768/ws")?.href).toBe("ws://[::1]:6768/ws");
    const relay = "wss://relay.example/ws?serverId=paired&role=client&v=2";
    expect(parseControlSocketTarget(relay)?.href).toBe(relay);
  });
});
