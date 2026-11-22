import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { WebSocket, type RawData } from "ws";
import { ChunkedTransport } from "@getpaseo/protocol/chunked-transport";
import { WebSocketRuntimeMetricsWindow } from "./websocket/runtime-metrics.js";
import {
  decodeFileTransferFrame,
  FileTransferOpcode,
} from "@getpaseo/protocol/binary-frames/index";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "./test-utils/index.js";
import { WSOutboundMessageSchema, type WSOutboundMessage } from "./messages.js";

const TEST_TIMEOUT_MS = 30_000;
const FILE_SIZE = 8 * 1024 * 1024 + 123;

let daemon: TestPaseoDaemon | undefined;
const temporaryDirectories: string[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await daemon?.close();
  daemon = undefined;
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

test(
  "a large file stays ordered, source-scoped, and does not block another socket",
  async () => {
    const cwd = mkdtempSync(join(tmpdir(), "paseo-large-file-transfer-"));
    temporaryDirectories.push(cwd);
    const expected = Buffer.alloc(FILE_SIZE);
    for (let index = 0; index < expected.length; index += 1) expected[index] = index % 251;
    writeFileSync(join(cwd, "large.bin"), expected);

    daemon = await createTestPaseoDaemon();
    const source = await connectSocket(daemon.port, "shared-file-client");
    const unrelated = await connectSocket(daemon.port, "shared-file-client");
    sockets.push(source, unrelated);

    let unrelatedBinaryFrames = 0;
    unrelated.on("message", (_data, isBinary) => {
      if (isBinary) unrelatedBinaryFrames += 1;
    });

    const transfer = receiveFileTransfer(source, "req-large-file");
    source.send(
      JSON.stringify({
        type: "session",
        message: {
          type: "file_explorer_request",
          cwd,
          path: "large.bin",
          mode: "file",
          acceptBinary: true,
          requestId: "req-large-file",
        },
      }),
    );

    await sendAndWait(
      unrelated,
      {
        type: "session",
        message: { type: "ping", requestId: "req-unrelated", clientSentAt: 1 },
      },
      (message) =>
        message.type === "session" &&
        message.message.type === "pong" &&
        message.message.payload.requestId === "req-unrelated",
    );

    const frames = await transfer;
    const chunks = frames.flatMap((frame) =>
      frame.opcode === FileTransferOpcode.FileChunk ? [frame.payload] : [],
    );
    expect(frames[0]?.opcode).toBe(FileTransferOpcode.FileBegin);
    expect(frames.at(-1)?.opcode).toBe(FileTransferOpcode.FileEnd);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.byteLength <= 256 * 1024)).toBe(true);
    expect(Buffer.compare(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))), expected)).toBe(
      0,
    );
    expect(source.readyState).toBe(WebSocket.OPEN);
    expect(unrelated.readyState).toBe(WebSocket.OPEN);
    expect(unrelatedBinaryFrames).toBe(0);
  },
  TEST_TIMEOUT_MS,
);

async function connectSocket(
  port: number,
  clientId: string,
  capabilities?: Record<string, unknown>,
): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  await sendAndWait(
    socket,
    { type: "hello", clientId, clientType: "browser", protocolVersion: 1, capabilities },
    (message) =>
      message.type === "session" &&
      message.message.type === "status" &&
      message.message.payload.status === "server_info",
  );
  return socket;
}

function receiveFileTransfer(source: WebSocket, requestId: string) {
  return new Promise<NonNullable<ReturnType<typeof decodeFileTransferFrame>>[]>(
    (resolve, reject) => {
      const frames: NonNullable<ReturnType<typeof decodeFileTransferFrame>>[] = [];
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("Timed out waiting for file transfer"));
      }, TEST_TIMEOUT_MS);
      const onMessage = (data: RawData, isBinary: boolean) => {
        if (!isBinary) return;
        const frame = decodeFileTransferFrame(new Uint8Array(data as Buffer));
        if (!frame || frame.requestId !== requestId) return;
        frames.push(frame);
        if (frame.opcode === FileTransferOpcode.FileEnd) {
          cleanup();
          resolve(frames);
        }
      };
      const onClose = () => {
        cleanup();
        reject(new Error("Socket closed during file transfer"));
      };
      const cleanup = () => {
        clearTimeout(timeout);
        source.off("message", onMessage);
        source.off("close", onClose);
      };
      source.on("message", onMessage);
      source.on("close", onClose);
    },
  );
}

function sendAndWait(
  socket: WebSocket,
  message: unknown,
  matches: (message: WSOutboundMessage) => boolean,
): Promise<WSOutboundMessage> {
  const response = new Promise<WSOutboundMessage>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for WebSocket message"));
    }, TEST_TIMEOUT_MS);
    const onMessage = (data: RawData, isBinary: boolean) => {
      if (isBinary) return;
      const parsed = WSOutboundMessageSchema.safeParse(JSON.parse(data.toString()));
      if (!parsed.success || !matches(parsed.data)) return;
      cleanup();
      resolve(parsed.data);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("message", onMessage);
    };
    socket.on("message", onMessage);
  });
  socket.send(JSON.stringify(message));
  return response;
}

test("an awaited timeline framing overflow closes the actual daemon socket", async () => {
  const { createHostClient } = await import("@getpaseo/client/node");
  const { createPaseoApi } = await import("@getpaseo/client");
  const { default: pino } = await import("pino");
  const { Writable } = await import("node:stream");
  const messages: string[] = [];
  const logger = pino(
    { level: "warn" },
    new Writable({
      write(chunk, _encoding, done) {
        messages.push(JSON.parse(chunk.toString()).msg);
        done();
      },
    }),
  );
  daemon = await createTestPaseoDaemon({ logger });
  const client = createHostClient(`127.0.0.1:${daemon.port}`, {
    clientId: "framing-seed",
    reconnect: { enabled: false },
  });
  await client.connect();
  const api = createPaseoApi(client);
  try {
    const workspace = await api.workspaces.create({
      source: { kind: "directory", path: daemon.staticDir },
    });
    const agents = [];
    const text = "x".repeat(240 * 1024);
    for (const [index, rows] of [350, 90].entries()) {
      const agent = await workspace.agents.create({
        config: { provider: "claude/claude-test", modeId: "full-access" },
        title: `Framing overflow ${index}`,
      });
      agents.push(agent.id);
      for (let row = 0; row < rows; row++)
        await daemon.daemon.agentManager.appendTimelineItem(agent.id, {
          type: "user_message",
          text,
        });
    }
    const source = await connectSocket(daemon.port, "framing-overflow", {
      binary_chunking_v1: true,
    });
    sockets.push(source);
    const closed = new Promise<void>((resolve) => source.once("close", () => resolve()));
    const firstChunk = new Promise<void>((resolve) => {
      const listener = (data: RawData, binary: boolean) => {
        if (!binary || (data as Buffer)[0] !== 0x31) return;
        source.off("message", listener);
        source.pause();
        resolve();
      };
      source.on("message", listener);
    });
    const fetch = (agentId: string, requestId: string) =>
      source.send(
        JSON.stringify({
          type: "session",
          message: {
            type: "fetch_agent_timeline_request",
            requestId,
            agentId,
            direction: "tail",
            projection: "canonical",
            limit: 0,
          },
        }),
      );
    fetch(agents[0]!, "first");
    await firstChunk;
    fetch(agents[1]!, "overflow");
    await expect
      .poll(() => messages.includes("Closing physical WebSocket after outbound framing failure"), {
        timeout: 15000,
      })
      .toBe(true);
    expect(messages).not.toContain("Closing physical WebSocket at outbound high-water mark");
    source.resume();
    await closed;
  } finally {
    await api.dispose();
    await client.close();
  }
}, 60000);

test("malformed chunk metadata closes the daemon socket with a protocol error", async () => {
  daemon = await createTestPaseoDaemon();
  const source = await connectSocket(daemon.port, "invalid-framing", { binary_chunking_v1: true });
  sockets.push(source);
  const closed = new Promise<number>((resolve) => source.once("close", (code) => resolve(code)));
  source.send(new Uint8Array([0x31, 2, 0, 3, 65]));
  expect(await closed).toBe(1002);
});

test.each([
  { state: "open", closeCode: 1006, writeFails: true },
  { state: "closing", closeCode: 1000, writeFails: true },
  { state: "disconnected with no write callback", closeCode: 1000, writeFails: false },
])(
  "a failed file write while $state cancels queued replies and allows reconnect",
  async ({ state, closeCode, writeFails }) => {
    const { default: pino } = await import("pino");
    const messages: { msg: string; err?: { code?: string } }[] = [];
    const logger = pino(
      { level: "warn" },
      {
        write(line) {
          messages.push(JSON.parse(line));
        },
      },
    );
    const cwd = mkdtempSync(join(tmpdir(), "paseo-interrupted-file-transfer-"));
    temporaryDirectories.push(cwd);
    writeFileSync(join(cwd, "file.bin"), Buffer.alloc(512 * 1024));
    daemon = await createTestPaseoDaemon({ logger });

    const clientId = "interrupted-transfer";
    const burst = 32;
    const originalSend = WebSocket.prototype.send;
    const transportSend = vi.spyOn(ChunkedTransport.prototype, "send");
    const recordBinary = vi.spyOn(
      WebSocketRuntimeMetricsWindow.prototype,
      "recordOutboundBinaryFrame",
    );
    const recordJson = vi.spyOn(WebSocketRuntimeMetricsWindow.prototype, "recordOutboundMessage");
    const writeStarted = Promise.withResolvers<{
      socket: WebSocket;
      failWrite: (error: Error) => void;
    }>();
    const physicalFileWrites: number[] = [];
    const physicalSend = vi
      .spyOn(WebSocket.prototype, "send")
      .mockImplementation(function (this: WebSocket, data, options, callback) {
        const frame = data instanceof Uint8Array ? decodeFileTransferFrame(data) : null;
        const done = typeof options === "function" ? options : callback;
        if (frame?.requestId === "interrupted-file") {
          physicalFileWrites.push(frame.opcode);
          if (frame.opcode === FileTransferOpcode.FileBegin) {
            if (!done) throw new Error("The file writer did not await physical completion");
            writeStarted.resolve({ socket: this, failWrite: done });
            return;
          }
        }
        originalSend.call(this, data, typeof options === "function" ? undefined : options, done);
      });
    try {
      const source = await connectSocket(daemon.port, clientId);
      sockets.push(source);
      const closed = new Promise<number>((resolve) => source.once("close", resolve));
      source.send(
        JSON.stringify({
          type: "session",
          message: {
            type: "file_explorer_request",
            cwd,
            path: "file.bin",
            mode: "file",
            acceptBinary: true,
            requestId: "interrupted-file",
          },
        }),
      );
      const { socket, failWrite } = await writeStarted.promise;
      for (let index = 0; index < burst; index++) {
        source.send(
          JSON.stringify({
            type: "session",
            message: { type: "ping", requestId: `queued-after-file-${index}`, clientSentAt: 1 },
          }),
        );
      }
      await expect
        .poll(
          () =>
            transportSend.mock.calls.filter(
              ([data]) =>
                typeof data === "string" && data.includes('"requestId":"queued-after-file-'),
            ).length,
        )
        .toBe(burst);

      if (state !== "open") socket.close(1000);
      if (writeFails) failWrite(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
      expect(await closed).toBe(closeCode);
      const replacement = await connectSocket(daemon.port, clientId);
      sockets.push(replacement);
      await sendAndWait(
        replacement,
        { type: "session", message: { type: "ping", requestId: "reconnected", clientSentAt: 1 } },
        (message) =>
          message.type === "session" &&
          message.message.type === "pong" &&
          message.message.payload.requestId === "reconnected",
      );

      expect(physicalFileWrites).toEqual([FileTransferOpcode.FileBegin]);
      expect(recordBinary).not.toHaveBeenCalled();
      expect(
        recordJson.mock.calls.filter(
          ([message]) =>
            message.type === "session" &&
            ((message.message.type === "pong" &&
              message.message.payload.requestId.startsWith("queued-after-file-")) ||
              (message.message.type === "file_explorer_response" &&
                message.message.payload.requestId === "interrupted-file")),
        ),
      ).toHaveLength(0);
      await expect
        .poll(() =>
          messages.filter(({ msg }) => msg.startsWith("Failed to fulfill file explorer request")),
        )
        .toHaveLength(1);
      expect(
        messages.filter(
          ({ msg }) => msg === "Closing physical WebSocket after outbound framing failure",
        ),
      ).toMatchObject(writeFails ? [{ err: { code: "EPIPE" } }] : []);
      expect(
        messages.filter(
          ({ msg }) =>
            msg === "ws_send_failed" ||
            msg === "Failed to emit source frame" ||
            msg === "ws_application_delivery_denied" ||
            msg === "ws_application_binary_delivery_denied",
        ),
      ).toEqual([]);
    } finally {
      physicalSend.mockRestore();
      transportSend.mockRestore();
      recordBinary.mockRestore();
      recordJson.mockRestore();
    }
  },
);
