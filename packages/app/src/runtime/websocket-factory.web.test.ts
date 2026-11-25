import {
  createWebSocketTransportFactory,
  defaultWebSocketFactory,
} from "@getpaseo/client/internal/daemon-client-websocket-transport";
import { afterEach, expect, it, vi } from "vitest";
import { createAppWebSocketFactory } from "./websocket-factory.web";

const { getDesktopHost, getHostRuntimeStore } = vi.hoisted(() => ({
  getDesktopHost: vi.fn(),
  getHostRuntimeStore: vi.fn(),
}));
vi.mock("@/desktop/host", () => ({ getDesktopHost }));
vi.mock("./host-runtime", () => ({ getHostRuntimeStore }));

class TestCloseEvent extends Event {
  readonly code: number;
  readonly reason: string;
  readonly wasClean: boolean;

  constructor(type: string, init?: CloseEventInit) {
    super(type, init);
    this.code = init?.code ?? 0;
    this.reason = init?.reason ?? "";
    this.wasClean = init?.wasClean ?? false;
  }
}

class NativeSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly CLOSED = 3;
  readyState = NativeSocket.CONNECTING;
  bufferedAmount = 0;
  binaryType: BinaryType = "blob";
  send = vi.fn();
  close = vi.fn((code?: number, reason?: string) => {
    this.readyState = NativeSocket.CLOSED;
    this.dispatchEvent(new CloseEvent("close", { code, reason }));
  });

  constructor(
    readonly url: string,
    readonly protocols?: string[],
  ) {
    super();
    sockets.push(this);
  }

  open() {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }
}

const sockets: NativeSocket[] = [];

function attachDesktop() {
  const listeners = new Set<() => void>();
  const hosts = {
    getHosts: vi.fn(() => [] as object[]),
    getSnapshot: vi.fn(),
    subscribeAll: vi.fn((listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    subscribeHostList: vi.fn(() => () => undefined),
  };
  const invoke = vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>(
    async () => ({ status: "ready" }),
  );
  getDesktopHost.mockReturnValue({ nativeControlWebSocket: true, invoke });
  getHostRuntimeStore.mockReturnValue(hosts);
  vi.stubGlobal("WebSocket", NativeSocket);
  vi.stubGlobal("CloseEvent", TestCloseEvent);
  return { invoke, hosts, refresh: () => listeners.forEach((listener) => listener()) };
}

afterEach(() => {
  getDesktopHost.mockReset();
  getHostRuntimeStore.mockReset();
  vi.unstubAllGlobals();
  sockets.length = 0;
});

it("preserves the browser factory without native desktop route support", () => {
  for (const host of [null, { platform: "darwin", invoke: vi.fn() }]) {
    getDesktopHost.mockReturnValue(host);
    expect(createAppWebSocketFactory()).toBe(defaultWebSocketFactory);
  }
});

it("gets the route ready before opening a native socket and passes its binary frames", async () => {
  const { invoke } = attachDesktop();
  const routeReady = Promise.withResolvers<unknown>();
  invoke.mockImplementation((command) =>
    command === "prepare_native_control_websocket"
      ? routeReady.promise
      : Promise.resolve({ status: "ready" }),
  );
  const url = "wss://relay.example.test/ws?role=client&serverId=test&v=2";
  const connect = createWebSocketTransportFactory(createAppWebSocketFactory());
  const transport = connect({ url, protocols: ["paseo.bearer.example"] });
  const frames = vi.fn();
  transport.onMessage(frames);
  await vi.waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("prepare_native_control_websocket", { url }),
  );
  expect(sockets).toHaveLength(0);

  routeReady.resolve({ status: "ready" });
  await vi.waitFor(() => expect(sockets).toHaveLength(1));
  const socket = sockets[0]!;
  expect(socket.url).toBe(url);
  expect(socket.protocols).toEqual(["paseo.bearer.example"]);
  expect(socket.binaryType).toBe("arraybuffer");
  socket.open();
  const frame = Uint8Array.of(1, 2, 3).buffer;
  transport.send(frame);
  socket.dispatchEvent(new MessageEvent("message", { data: frame }));
  expect(socket.send).toHaveBeenCalledWith(frame);
  expect(frames).toHaveBeenCalledWith(frame, true);
});

it("does not open a native socket when the desktop rejects the route or the caller closes", async () => {
  const { invoke } = attachDesktop();
  const pending = Promise.withResolvers<unknown>();
  const first = "ws://127.0.0.1:6768/ws";
  const second = "ws://127.0.0.1:6769/ws";
  invoke.mockImplementation(async (command, args) => {
    if (command !== "prepare_native_control_websocket") return { status: "ready" };
    return args?.url === first ? { status: "unavailable" } : pending.promise;
  });
  const connect = createWebSocketTransportFactory(createAppWebSocketFactory());
  const rejected = connect({ url: first });
  const rejectedError = vi.fn();
  const rejectedClose = vi.fn();
  rejected.onError(rejectedError);
  rejected.onClose(rejectedClose);
  await vi.waitFor(() =>
    expect(rejectedClose).toHaveBeenCalledWith(expect.objectContaining({ code: 1006 })),
  );
  expect(rejectedError).toHaveBeenCalledOnce();

  const canceled = connect({ url: second });
  const canceledClose = vi.fn();
  canceled.onClose(canceledClose);
  await vi.waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("prepare_native_control_websocket", { url: second }),
  );
  canceled.close(4001, "closed");
  pending.resolve({ status: "ready" });
  await pending.promise;
  await Promise.resolve();
  expect(canceledClose).toHaveBeenCalledWith(
    expect.objectContaining({ code: 4001, reason: "closed" }),
  );
  expect(sockets).toHaveLength(0);
});

it("publishes only the current identity-matched LAN origin and clears it when the host goes offline", async () => {
  const { hosts, invoke, refresh } = attachDesktop();
  const profile = (serverId: string, endpoint: string, useTls: boolean) => ({
    serverId,
    connections: [{ type: "directTcp", id: "active", endpoint, useTls }],
  });
  hosts.getHosts.mockReturnValue([
    profile("home", "192.168.12.4:8765", true),
    profile("public", "host.example.test:8765", false),
    profile("mismatched", "192.168.12.5:8765", false),
  ]);
  hosts.getSnapshot.mockImplementation((serverId) => ({
    connectionStatus: "online",
    activeConnectionId: "active",
    client: {
      getLastServerInfoMessage: () => ({
        serverId: serverId === "mismatched" ? "other" : serverId,
      }),
    },
  }));
  createAppWebSocketFactory();
  await vi.waitFor(() =>
    expect(invoke).toHaveBeenLastCalledWith("sync_paired_lan_origins", {
      origins: ["https://192.168.12.4:8765"],
    }),
  );
  hosts.getSnapshot.mockReturnValue({ connectionStatus: "offline" });
  refresh();
  await vi.waitFor(() =>
    expect(invoke).toHaveBeenLastCalledWith("sync_paired_lan_origins", { origins: [] }),
  );
});
