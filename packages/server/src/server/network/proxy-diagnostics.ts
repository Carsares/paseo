import { once } from "node:events";
import type { WebSocket } from "ws";
import type { ProxyDiagnosticCoverage, ProxyTransport } from "./proxy-transport.js";

const TIMEOUT_MS = 8_000;

function waitForWebSocket(socket: WebSocket, signal: AbortSignal, upgrade?: string) {
  if (!upgrade) return once(socket, "open", { signal }).then(() => undefined);
  // The public relay upgrades cleartext to TLS. Verify its exact redirect as
  // evidence that the WS request reached port 80 without following it on this slot.
  const redirected = new Promise<void>((resolve, reject) => {
    socket.once("unexpected-response", (_request, response) => {
      response.destroy();
      if (response.statusCode === 308 && response.headers.location === upgrade) resolve();
      else reject(new Error("Unexpected WS diagnostic response"));
    });
  });
  return Promise.race([once(socket, "open", { signal }).then(() => undefined), redirected]);
}

export async function diagnoseProxy(
  transport: ProxyTransport,
  signal: AbortSignal,
): Promise<ProxyDiagnosticCoverage[]> {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]);
  const coverage: ProxyDiagnosticCoverage[] = [];
  for (const route of transport.diagnosticRoutes()) {
    const via = route.coverage.proxySlot === null ? "direct" : `${route.coverage.proxySlot} proxy`;
    const [http, webSocket] = route.coverage.checks;
    try {
      const response = await route.http(deadline);
      void response.body?.cancel().catch(() => undefined);
      const upgraded =
        route.upgrade &&
        response.status === 308 &&
        response.headers.get("location") === route.upgrade.http;
      if (response.status !== 200 && !upgraded) throw new Error();
    } catch {
      throw new Error(
        `Proxy diagnostic failed (${http.protocol.toUpperCase()} port ${http.port} via ${via})`,
      );
    }
    let socket: WebSocket | undefined;
    try {
      socket = route.webSocket(deadline);
      await waitForWebSocket(socket, deadline, route.upgrade?.webSocket);
    } catch {
      throw new Error(
        `Proxy diagnostic failed (${webSocket.protocol.toUpperCase()} port ${webSocket.port} via ${via})`,
      );
    } finally {
      socket?.terminate();
    }
    coverage.push(route.coverage);
  }
  return coverage;
}
