import { mkdir } from "node:fs/promises";
import path from "node:path";
import { app, session, type Session, type WebFrameMain } from "electron";
import { createElectronDesktopProxy } from "./electron.js";
import { createNativeControlRoutes, nativeControlPac, resolveRoute } from "./native-control.js";
import {
  chromiumProxyResult,
  isProtectedProxyHost,
  proxyForTarget,
  type DesktopProxyPolicy,
} from "./policy.js";

const launchProxySwitches = [
  "no-proxy-server",
  "proxy-auto-detect",
  "proxy-bypass-list",
  "proxy-pac-url",
  "proxy-server",
];

const probeUrls = {
  http: "http://connectivitycheck.gstatic.com/generate_204",
  https: "https://www.gstatic.com/generate_204",
};

const networkRequests = { urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] };

function installRequestGate(target: Session, baseline: Session) {
  let paused = false;
  let isolated = false;
  let generation = 0;
  let routingUpdate: Promise<void> | undefined;
  let finishRoutingUpdate: (() => void) | undefined;
  let policy: DesktopProxyPolicy | null = null;
  let controlRecovery = false;
  const control = createNativeControlRoutes(baseline);
  const started = new Map<number, number>();
  const navigations = new WeakMap<WebFrameMain, object>();
  const pairedByFrame = new Map<WebFrameMain, ReadonlySet<string>>();

  function pairedOrigins() {
    const origins = new Set<string>();
    for (const [frame, snapshot] of pairedByFrame) {
      if (frame.detached) {
        pairedByFrame.delete(frame);
        continue;
      }
      for (const origin of snapshot) origins.add(origin);
    }
    return origins;
  }

  function hasPairedOrigin(origin: string) {
    for (const [frame, snapshot] of pairedByFrame) {
      if (!frame.detached && snapshot.has(origin)) return true;
    }
    return false;
  }

  function stagePaired(frame: WebFrameMain, origins: readonly string[]) {
    const navigation = navigations.get(frame);
    return async () => {
      if (frame.detached || navigations.get(frame) !== navigation) {
        throw new Error("Paired LAN route owner is no longer available.");
      }
      const requested = new Set(origins);
      // Removing a permission takes effect even if the replacement cannot be applied.
      const retained = new Set(
        [...(pairedByFrame.get(frame) ?? [])].filter((origin) => requested.has(origin)),
      );
      // Keep the snapshot in system mode so a later manual switch can protect it.
      if (requested.size) pairedByFrame.set(frame, requested);
      else pairedByFrame.delete(frame);
      return () => {
        if (pairedByFrame.get(frame) !== requested) return;
        if (retained.size) pairedByFrame.set(frame, retained);
        else pairedByFrame.delete(frame);
      };
    };
  }

  async function cancelHttp(url: URL, current: number): Promise<boolean> {
    if (controlRecovery) {
      // Keep local UI and paired downloads available only on verified direct routes.
      if (!isProtectedProxyHost(url.hostname, []) && !hasPairedOrigin(url.origin)) return true;
      return (await resolveRoute(target, url.href)) !== "DIRECT" || current !== generation;
    }
    if (policy?.mode !== "manual") return false;
    if (hasPairedOrigin(url.origin)) {
      const route = await resolveRoute(target, url.href);
      return route !== "DIRECT" || current !== generation || !hasPairedOrigin(url.origin);
    }
    const proxy = proxyForTarget(policy, url);
    // A download capability token may only travel on a direct route.
    if (proxy && /^\/api\/files\/download\/?$/i.test(url.pathname)) return true;
    const expected = proxy ? chromiumProxyResult(proxy) : "DIRECT";
    return (await resolveRoute(target, url.href)) !== expected || current !== generation;
  }

  async function cancel(
    details: Pick<Electron.OnBeforeRequestListenerDetails, "url" | "resourceType" | "id" | "frame">,
    phase: "begin" | "send",
  ): Promise<boolean> {
    if (paused || isolated) return true;
    const current = generation;
    const url = URL.parse(details.url);
    if (!url) return true;
    if (details.resourceType === "webSocket" || url.protocol === "ws:" || url.protocol === "wss:") {
      if (phase === "send" && started.get(details.id) !== current) return true;
      const expected = control.authorize(details, phase);
      if (
        !expected ||
        (await resolveRoute(target, url.href)) !== expected ||
        current !== generation
      )
        return true;
      if (phase === "begin") started.set(details.id, current);
      return false;
    }
    return cancelHttp(url, current);
  }

  target.webRequest.onBeforeRequest(networkRequests, async (details, reply) => {
    // Updating the shared route table can start while a window is navigating.
    // Hold new requests until the replacement or rollback has been verified.
    if (routingUpdate) await routingUpdate;
    const blocked = await cancel(details, "begin").catch(() => true);
    reply({ cancel: blocked });
  });
  target.webRequest.onBeforeSendHeaders(networkRequests, async (details, reply) => {
    const blocked = await cancel(details, "send").catch(() => true);
    reply({ cancel: blocked });
  });
  function forget({ id }: { id: number }) {
    if (started.delete(id)) control.forget(id);
  }
  target.webRequest.onCompleted(networkRequests, forget);
  target.webRequest.onErrorOccurred(networkRequests, forget);

  return {
    canUseBaseline() {
      return !paused && !isolated && policy === null;
    },
    stage: control.stage,
    stagePaired,
    releaseFrame(frame: WebFrameMain) {
      control.releaseFrame(frame);
      navigations.set(frame, {});
      const removed = pairedByFrame.get(frame);
      pairedByFrame.delete(frame);
      return !!removed && [...removed].some((origin) => !hasPairedOrigin(origin));
    },
    liveConfig(plan: Parameters<typeof nativeControlPac>[0]) {
      const routes =
        plan.policy.mode === "system" ? new Map<string, string>() : control.routes(plan);
      const origins = plan.policy.mode === "manual" ? pairedOrigins() : new Set<string>();
      return {
        config: nativeControlPac(plan, routes, origins),
        control: routes,
        paired: origins,
        verificationRoutes: plan.controlRecovery ? control.verificationRoutes() : undefined,
      };
    },
    pauseRequests(routingOnly: boolean) {
      generation++;
      paused = true;
      if (routingOnly) {
        routingUpdate = new Promise<void>((resolve) => {
          finishRoutingUpdate = resolve;
        });
      }
      return () => {
        if (isolated) throw new Error("Main-window proxy session is isolated.");
        paused = false;
        finishRoutingUpdate?.();
        finishRoutingUpdate = undefined;
        routingUpdate = undefined;
      };
    },
    isolate() {
      generation++;
      isolated = true;
      finishRoutingUpdate?.();
      finishRoutingUpdate = undefined;
      routingUpdate = undefined;
    },
    onPolicyApplied(next: DesktopProxyPolicy | null, recovering: boolean) {
      policy = next;
      controlRecovery = recovering;
    },
  };
}

export async function startMainWindowProxy(onSettingsUnavailable: () => void) {
  const userData = app.getPath("userData");
  const target = session.defaultSession;
  const baseline = session.fromPartition("paseo-control-system-routes", { cache: false });
  const requestGate = installRequestGate(target, baseline);
  const baselineOnly = {
    backend: null,
    prepare: async (frame: WebFrameMain, url: URL) => {
      await requestGate.stage(frame, url)();
    },
    syncPaired: async (frame: WebFrameMain, origins: readonly string[]) => {
      await requestGate.stagePaired(frame, origins)();
    },
    releaseFrame: requestGate.releaseFrame,
  };
  // Electron cannot restore Chromium's command-line policy after setProxy().
  // Leave that session on its launch policy and decline edits for this launch.
  if (launchProxySwitches.some((flag) => app.commandLine.hasSwitch(flag))) {
    return baselineOnly;
  }

  let backend;
  try {
    await mkdir(userData, { recursive: true });
    backend = await createElectronDesktopProxy({
      settingsFile: path.join(userData, "device-proxy.json"),
      scopes: {
        mainWindow: {
          session: target,
          baseline: { mode: "system" },
          controlRoutes: "independent",
          webSockets: "disabled",
          pairedLanHosts: [],
          independentDirectLan: true,
          probeUrls,
          ...requestGate,
        },
      },
    });
  } catch (error) {
    // A failed apply only returns to this state after verified rollback and resume.
    if (!requestGate.canUseBaseline()) {
      requestGate.isolate();
      throw error;
    }
    onSettingsUnavailable();
    return baselineOnly;
  }
  return {
    backend,
    prepare: (frame: WebFrameMain, url: URL) =>
      backend.refreshRouting("mainWindow", requestGate.stage(frame, url)),
    syncPaired: (frame: WebFrameMain, origins: readonly string[]) =>
      backend.refreshRouting("mainWindow", requestGate.stagePaired(frame, origins)),
    releaseFrame(frame: WebFrameMain) {
      if (!requestGate.releaseFrame(frame)) return;
      void backend.refreshRouting("mainWindow", async () => () => undefined).catch(() => undefined);
    },
  };
}
