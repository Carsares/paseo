import { AsyncLocalStorage } from "node:async_hooks";
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { createProxyPolicy } from "./proxy-policy.js";
import type { HostProxyRuntime } from "./proxy-runtime.js";

const control = new AsyncLocalStorage<true>();

export function onLegacyControlRoute<T>(run: () => T): T {
  return control.run(true, run);
}

export function installHostProxyDispatcher(
  runtime: HostProxyRuntime | undefined,
  trustedLanOrigins?: () => readonly string[],
): () => Promise<void> {
  const legacy = getGlobalDispatcher();
  const direct = new Agent();
  const localPolicy = createProxyPolicy({ bypass: [], trustedLanOrigins });
  // The global entry stays stable across saves. Each new dispatch selects the current revision.
  const dispatcher = legacy.compose(() => (options, handler) => {
    if (control.getStore()) return legacy.dispatch(options, handler);
    if (runtime?.available) return runtime.dispatcher()!.dispatch(options, handler);
    // Lost storage or an uncertain commit must leave local control reachable.
    if (localPolicy(options.origin ?? "").bypass) return direct.dispatch(options, handler);
    throw new Error("Host proxy runtime unavailable");
  });
  setGlobalDispatcher(dispatcher);
  return async () => {
    if (getGlobalDispatcher() === dispatcher) setGlobalDispatcher(legacy);
    await direct.destroy();
  };
}
