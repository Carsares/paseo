import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { connect, type AddressInfo, type Socket } from "node:net";
import { fetch } from "undici";
import { afterEach, expect, test } from "vitest";
import { WebSocketServer } from "ws";
import { diagnoseProxy } from "./proxy-diagnostics.js";
import { createProxyPolicy } from "./proxy-policy.js";
import { parseHostProxySettings } from "./proxy-settings.js";
import { ProxyTransport } from "./proxy-transport.js";

const servers: Server[] = [];
const transports: ProxyTransport[] = [];
const connections = new Set<Socket>();

afterEach(async () => {
  await Promise.all(transports.splice(0).map((transport) => transport.close()));
  for (const socket of connections) socket.destroy();
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))),
  );
});

async function listen(server: Server) {
  server.on("connection", (socket) => {
    connections.add(socket);
    socket.once("close", () => connections.delete(socket));
  });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as AddressInfo).port;
}

async function proxy(originPort?: number) {
  const requests: { target: string | undefined; authorization: string | undefined }[] = [];
  const server = createServer();
  server.on("connect", (request, socket, head) => {
    requests.push({ target: request.url, authorization: request.headers["proxy-authorization"] });
    if (!originPort) {
      socket.end("HTTP/1.1 407 hidden-proxy-detail\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    const upstream = connect(originPort, "127.0.0.1", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.once("error", () => socket.destroy());
    socket.once("error", () => upstream.destroy());
    socket.once("close", () => upstream.destroy());
  });
  return { url: `http://127.0.0.1:${await listen(server)}`, requests };
}

test("shares loopback, trusted paired origins and explicit bypass rules across both schemes", () => {
  const policy = createProxyPolicy({
    bypass: [
      "*.Bücher.example:443",
      "203.0.113.0/24",
      "[2001:db8::]/32",
      "[::ffff:198.51.100.0]/120",
      "172.20.0.0/16",
    ],
    trustedLanOrigins: ["https://Paired.Example.:7443", "http://192.168.56.7:6767"],
  });
  for (const address of [
    "http://0x7f00002a",
    "ws://[::ffff:127.0.0.2]",
    "https://[0:0::1]",
    "wss://project.LOCALHOST.",
    "wss://paired.example:7443/ws",
    "ws://[::ffff:192.168.56.7]:6767/ws",
    "https://172.20.0.2",
    "https://sub.xn--bcher-kva.example/",
    "ws://203.0.113.12",
    "http://[2001:db8::1]",
    "https://198.51.100.7",
  ])
    expect(policy(address).bypass, address).toBe(true);
  for (const address of [
    "ws://paired.example:7443",
    "wss://sub.paired.example:7443",
    "https://paired.example:8443",
    "wss://192.168.56.7:6767",
    "http://192.168.56.7:6768",
    "http://192.168.56.8:6767",
    "http://10.2.3.4",
    "wss://172.21.0.2",
    "http://169.254.1.2",
    "ws://[fd00::3]",
    "https://[fe80::1]",
    "http://sub.bücher.example",
    "https://notbücher.example",
    "https://localhost.invalid",
    "http://203.0.114.12",
    "http://[2001:db9::1]",
    "https://198.51.101.7",
  ])
    expect(policy(address).bypass, address).toBe(false);
  expect(policy("ws://example.com").target).toBe("http");
  expect(policy("wss://example.com").target).toBe("https");
});

test("inherits legacy NO_PROXY host and port rules without using manual CIDR rules", () => {
  const rules = ["*.Corporate.Example:0443", "10.23.0.0/16", "[fd00::]/8", "[2001:db8::1]:80"];
  const inherited = createProxyPolicy({ bypass: [], environmentBypass: rules.join(", ") });
  for (const address of [
    "https://sub.corporate.example",
    "wss://corporate.example",
    "http://[2001:db8::1]",
    "ws://project.localhost",
  ])
    expect(inherited(address).bypass, address).toBe(true);
  for (const address of [
    "http://sub.corporate.example",
    "wss://corporate.example:444",
    "wss://notcorporate.example",
    "https://[2001:db8::1]",
    "http://10.23.2.3",
    "ws://[fd00::2]",
    "wss://10.23.2.3",
    "https://[fd00::2]",
  ])
    expect(inherited(address).bypass, address).toBe(false);
  const manual = createProxyPolicy({ bypass: rules });
  expect(manual("http://10.23.2.3").bypass).toBe(true);
  expect(manual("ws://[fd00::2]").bypass).toBe(true);
  const wildcard = createProxyPolicy({ bypass: [], environmentBypass: "corporate.example, *" });
  expect(wildcard("wss://any.example").bypass).toBe(true);
});

test.each([
  "http://user:private@proxy.invalid",
  "https://@proxy.invalid",
  "http://proxy.invalid/?",
  "http://proxy.invalid/#",
  "http://proxy.invalid/./",
  "http://proxy.invalid:0",
  "socks5://proxy.invalid",
])("rejects non-origin proxy syntax without echoing it", (url) => {
  expect(() => parseHostProxySettings({ mode: "manual", proxy: { kind: "unified", url } })).toThrow(
    /^Invalid host proxy settings$/,
  );
});

test("splits authentication by target and does not forward proxy credentials to either origin", async () => {
  const originAuthorization: (string | undefined)[] = [];
  const origin = createServer((request, response) => {
    originAuthorization.push(request.headers["proxy-authorization"]);
    response.end("http-origin");
  });
  const webSockets = new WebSocketServer({ server: origin });
  webSockets.on("connection", (socket, request) => {
    originAuthorization.push(request.headers["proxy-authorization"]);
    socket.send("websocket-origin");
  });
  const port = await listen(origin);
  const insecureProxy = await proxy(port);
  const secureProxy = await proxy();
  const transport = new ProxyTransport(
    {
      mode: "manual",
      proxy: { kind: "split", httpUrl: insecureProxy.url, httpsUrl: secureProxy.url },
    },
    {
      http: { username: "insecure", password: "example" },
      https: { username: "secure", password: "example" },
    },
    [],
  );
  transports.push(transport);
  const domain = "test-origin.invalid";
  const http = await fetch(`http://${domain}:${port}`, { dispatcher: transport.dispatcher });
  expect(await http.text()).toBe("http-origin");
  const websocket = transport.webSocket(`ws://${domain}:${port}`);
  expect(String((await once(websocket, "message"))[0])).toBe("websocket-origin");
  expect(originAuthorization).toEqual([undefined, undefined]);
  expect(insecureProxy.requests).toEqual(
    Array.from({ length: 2 }, () => ({
      target: `${domain}:${port}`,
      authorization: `Basic ${Buffer.from("insecure:example").toString("base64")}`,
    })),
  );
  await expect(fetch(`https://${domain}/`, { dispatcher: transport.dispatcher })).rejects.toThrow();
  const rejected = transport.webSocket(`wss://${domain}/`);
  const [error] = await once(rejected, "error");
  expect(error.message).toBe("WebSocket proxy tunnel refused");
  expect(secureProxy.requests).toEqual(
    Array.from({ length: 2 }, () => ({
      target: `${domain}:443`,
      authorization: `Basic ${Buffer.from("secure:example").toString("base64")}`,
    })),
  );
  const closed = once(websocket, "close");
  await transport.close();
  await expect(closed).resolves.toEqual([1006, Buffer.alloc(0)]);
  await new Promise<void>((done) => webSockets.close(() => done()));
});

test("diagnostics still exercise the configured proxy when normal routing bypasses the fixed host", async () => {
  const recorder = await proxy();
  const transport = new ProxyTransport(
    {
      mode: "manual",
      proxy: { kind: "unified", url: recorder.url },
      bypass: ["*"],
    },
    {},
    [],
  );
  transports.push(transport);
  await expect(diagnoseProxy(transport, AbortSignal.timeout(1_000))).rejects.toThrow(
    /^Proxy diagnostic failed \(HTTPS port 443 via unified proxy\)$/,
  );
  expect(recorder.requests).toEqual([{ target: "relay.paseo.sh:443", authorization: undefined }]);
});

test("split proxy diagnostics label HTTPS and WSS on port 443 for both configured slots", () => {
  const transport = new ProxyTransport(
    {
      mode: "manual",
      proxy: { kind: "split", httpUrl: "http://proxy.example", httpsUrl: "http://proxy.example" },
    },
    {},
    [],
  );
  transports.push(transport);
  const checks = [
    { protocol: "https", port: 443 },
    { protocol: "wss", port: 443 },
  ];
  expect(transport.diagnosticRoutes().map((route) => route.coverage)).toEqual([
    { proxySlot: "http", checks },
    { proxySlot: "https", checks },
  ]);
});

test("canceling a WSS handshake after CONNECT releases the proxy socket", async () => {
  const approved = Promise.withResolvers<void>();
  const terminated = Promise.withResolvers<void>();
  const proxyServer = createServer();
  proxyServer.on("connect", (_request, socket) => {
    socket.once("end", () => {
      socket.end();
      terminated.resolve();
    });
    socket.once("data", () => approved.resolve()); // Wait for the client to start TLS negotiation.
    socket.resume();
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
  });
  const port = await listen(proxyServer);
  const transport = new ProxyTransport(
    {
      mode: "manual",
      proxy: { kind: "unified", url: `http://127.0.0.1:${port}` },
    },
    {},
    [],
  );
  transports.push(transport);
  const controller = new AbortController();
  const socket = transport.webSocket("wss://target.invalid/", controller.signal);
  const error = once(socket, "error");
  await approved.promise;
  controller.abort();
  await error;
  await terminated.promise;
}, 3_000);
