import type { WebSocketFactory } from "@getpaseo/client/internal/daemon-client-transport-types";

export function createPreparedWebSocketFactory(
  prepare: (url: string) => Promise<void>,
): WebSocketFactory {
  return (url, options) => {
    const events = new EventTarget();
    let socket: WebSocket | undefined;
    let closed = false;
    let binaryType: BinaryType = "arraybuffer";

    function finish(event: CloseEvent) {
      if (closed) return;
      closed = true;
      events.dispatchEvent(event);
    }

    async function open() {
      await Promise.resolve();
      if (closed) return;
      await prepare(url);
      if (closed) return;
      socket = new WebSocket(url, options?.protocols);
      socket.binaryType = binaryType;
      socket.addEventListener("open", () => events.dispatchEvent(new Event("open")));
      socket.addEventListener("message", ({ data }) =>
        events.dispatchEvent(new MessageEvent("message", { data })),
      );
      socket.addEventListener("error", () => events.dispatchEvent(new Event("error")));
      socket.addEventListener("close", ({ code, reason, wasClean }) =>
        finish(new CloseEvent("close", { code, reason, wasClean })),
      );
    }
    void open().catch(() => {
      if (closed) return;
      events.dispatchEvent(new Event("error"));
      finish(new CloseEvent("close", { code: 1006 }));
    });

    return {
      get readyState() {
        return closed ? WebSocket.CLOSED : (socket?.readyState ?? WebSocket.CONNECTING);
      },
      get bufferedAmount() {
        return socket?.bufferedAmount ?? 0;
      },
      get binaryType() {
        return binaryType;
      },
      set binaryType(value: string) {
        if (value !== "arraybuffer" && value !== "blob") return;
        binaryType = value;
        if (socket) socket.binaryType = value;
      },
      send(data) {
        if (!socket) throw new Error("Desktop control connection is not open");
        socket.send(data);
      },
      close(code, reason) {
        if (socket) socket.close(code, reason);
        else finish(new CloseEvent("close", { code: code ?? 1000, reason }));
      },
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
    };
  };
}
