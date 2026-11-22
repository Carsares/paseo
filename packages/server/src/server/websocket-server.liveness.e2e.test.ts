import pino from "pino";
import { expect, test, vi } from "vitest";
import { WebSocket, type RawData } from "ws";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "./test-utils/index.js";
import { WSOutboundMessageSchema, type WSOutboundMessage } from "./messages.js";
import { MAX_PHYSICAL_SOCKET_BUFFERED_BYTES } from "./websocket/physical-socket.js";

const BURST_MESSAGE_COUNT = 32;
const TEST_TIMEOUT_MS = 30_000;

interface SocketClose {
  code: number;
  reason: string;
}

class ResumedPhysicalSocketSession {
  private replacement: WebSocket | null = null;

  private constructor(
    private readonly daemon: TestPaseoDaemon,
    private readonly original: WebSocket,
    private readonly physicalSocket: WebSocket,
    readonly logs: string[],
  ) {}

  static async launch(): Promise<ResumedPhysicalSocketSession> {
    const logs: string[] = [];
    const logger = pino(
      { level: "warn" },
      {
        write(line) {
          logs.push(JSON.parse(line).msg);
        },
      },
    );
    const daemon = await createTestPaseoDaemon({ logger });
    const serverSocket = Promise.withResolvers<WebSocket>();
    const send = WebSocket.prototype.send;
    const spy = vi
      .spyOn(WebSocket.prototype, "send")
      .mockImplementation(function (this: WebSocket, data, options, callback) {
        if (data === '{"type":"pong"}') serverSocket.resolve(this);
        send.call(
          this,
          data,
          typeof options === "function" ? undefined : options,
          typeof options === "function" ? options : callback,
        );
      });
    try {
      const original = await connectSocket(daemon.port, "stale-physical-socket");
      return new ResumedPhysicalSocketSession(daemon, original, await serverSocket.promise, logs);
    } catch (error) {
      await daemon.close();
      throw error;
    } finally {
      spy.mockRestore();
    }
  }

  async abandonOriginal(): Promise<void> {
    this.original.pause();
  }

  async resumeSameClient(): Promise<void> {
    this.replacement = await connectSocket(this.daemon.port, "stale-physical-socket");
  }

  async sendBurstToOriginal(): Promise<SocketClose> {
    const originalClose = waitForClose(this.original);
    // Model a client at the buffer limit without allocating 64 MiB on real sockets.
    const buffered = vi.spyOn(this.physicalSocket, "bufferedAmount", "get");
    buffered.mockReturnValue(MAX_PHYSICAL_SOCKET_BUFFERED_BYTES);
    try {
      for (let index = 0; index < BURST_MESSAGE_COUNT; index++) {
        this.original.send('{"type":"ping"}');
      }
      this.original.resume();
      return await originalClose;
    } finally {
      buffered.mockRestore();
    }
  }

  async replacementRoundTrip(): Promise<void> {
    const replacement = this.requireReplacement();
    const requestId = "replacement-still-active";
    await sendAndWait(
      replacement,
      {
        type: "session",
        message: { type: "ping", requestId, clientSentAt: 1 },
      },
      (message) =>
        message.type === "session" &&
        message.message.type === "pong" &&
        message.message.payload.requestId === requestId,
    );
  }

  async close(): Promise<void> {
    this.original.terminate();
    this.replacement?.terminate();
    await this.daemon.close();
  }

  private requireReplacement(): WebSocket {
    if (!this.replacement) throw new Error("Replacement socket is not connected");
    return this.replacement;
  }
}

test(
  "a resumed stale socket is bounded and removed without disrupting its replacement",
  async () => {
    const session = await ResumedPhysicalSocketSession.launch();
    try {
      await session.abandonOriginal();
      await session.resumeSameClient();

      const originalClose = await session.sendBurstToOriginal();

      expect(originalClose).toEqual({ code: 1006, reason: "" });
      expect(session.logs.filter((msg) => msg.startsWith("Closing physical WebSocket"))).toEqual([
        "Closing physical WebSocket at outbound high-water mark",
      ]);
      expect(session.logs).not.toContain("ws_send_failed");
      await session.replacementRoundTrip();
    } finally {
      await session.close();
    }
  },
  TEST_TIMEOUT_MS,
);

async function connectSocket(port: number, clientId: string): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await waitForOpen(socket);
  await sendAndWait(
    socket,
    {
      type: "hello",
      clientId,
      clientType: "browser",
      protocolVersion: 1,
    },
    (message) =>
      message.type === "session" &&
      message.message.type === "status" &&
      message.message.payload.status === "server_info",
  );
  await sendAndWait(socket, { type: "ping" }, (message) => message.type === "pong");
  return socket;
}

function sendAndWait(
  socket: WebSocket,
  message: unknown,
  matches: (message: WSOutboundMessage) => boolean,
): Promise<WSOutboundMessage> {
  const response = waitForMessage(socket, matches);
  socket.send(JSON.stringify(message));
  return response;
}

function waitForOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
}

function waitForClose(socket: WebSocket): Promise<SocketClose> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off("close", onClose);
      reject(new Error("Timed out waiting for WebSocket to close"));
    }, TEST_TIMEOUT_MS);
    const onClose = (code: number, reason: Buffer) => {
      clearTimeout(timeout);
      resolve({ code, reason: reason.toString() });
    };
    socket.once("close", onClose);
  });
}

function waitForMessage(
  socket: WebSocket,
  matches: (message: WSOutboundMessage) => boolean,
): Promise<WSOutboundMessage> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for WebSocket message"));
    }, TEST_TIMEOUT_MS);
    const onMessage = (data: RawData) => {
      const parsed = WSOutboundMessageSchema.safeParse(JSON.parse(data.toString()));
      if (!parsed.success || !matches(parsed.data)) return;
      cleanup();
      resolve(parsed.data);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("WebSocket closed before the expected message arrived"));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("message", onMessage);
      socket.off("close", onClose);
    };
    socket.on("message", onMessage);
    socket.on("close", onClose);
  });
}
