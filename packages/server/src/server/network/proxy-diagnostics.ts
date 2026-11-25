import { once } from "node:events";
import type { WebSocket } from "ws";
import type { ProxyDiagnosticCoverage, ProxyTransport } from "./proxy-transport.js";

const TIMEOUT_MS = 8_000;

export async function diagnoseProxy(
  transport: ProxyTransport,
  signal: AbortSignal,
): Promise<ProxyDiagnosticCoverage[]> {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]);
  const coverage: ProxyDiagnosticCoverage[] = [];
  for (const route of transport.diagnosticRoutes()) {
    const via = route.coverage.proxySlot === null ? "direct" : `${route.coverage.proxySlot} proxy`;
    try {
      const response = await route.https(deadline);
      void response.body?.cancel().catch(() => undefined);
      if (response.status !== 200) throw new Error();
    } catch {
      throw new Error(`Proxy diagnostic failed (HTTPS port 443 via ${via})`);
    }
    let socket: WebSocket | undefined;
    try {
      socket = route.webSocket(deadline);
      await once(socket, "open", { signal: deadline });
    } catch {
      throw new Error(`Proxy diagnostic failed (WSS port 443 via ${via})`);
    } finally {
      socket?.terminate();
    }
    coverage.push(route.coverage);
  }
  return coverage;
}
