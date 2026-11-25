import type { AddressInfo, Socket } from "node:net";
import { TLSSocket } from "node:tls";

export function isProtectedProxyIngress(listener: string | AddressInfo | null, socket: Socket) {
  // The listener address is supplied by Node for this server. An absent peer
  // address alone would not prove an IPC connection.
  if (typeof listener === "string") return socket.remoteAddress === undefined;
  return socket instanceof TLSSocket && socket.encrypted;
}
