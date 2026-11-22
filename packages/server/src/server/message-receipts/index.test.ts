import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { MessageReceipts } from "./index.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "agent-requests-"));
  directories.push(directory);
  return { directory, requests: new MessageReceipts(directory) };
}

test("message retries survive reconstruction without submitting twice", async () => {
  const { requests, directory } = await fixture();
  let deliveries = 0;
  const input = {
    agentId: "agent",
    messageId: "arrival",
    request: { text: "hello" },
    send: async (beforeDispatch: () => Promise<void>) => {
      await beforeDispatch();
      deliveries++;
    },
  };
  await Promise.all([requests.send(input), requests.send(input)]);
  await new MessageReceipts(directory).send(input);
  expect(deliveries).toBe(1);
  await requests.send({ ...input, agentId: "another" });
  expect(deliveries).toBe(2);
});

test("ambiguous provider delivery is never blindly replayed after restart", async () => {
  const { requests, directory } = await fixture();
  let deliveries = 0;
  const input = {
    agentId: "agent",
    messageId: "arrival",
    request: {},
    send: async (beforeDispatch: () => Promise<void>) => {
      await beforeDispatch();
      deliveries++;
      throw new Error("connection lost");
    },
  };
  await expect(requests.send(input)).rejects.toThrow("connection lost");
  await expect(new MessageReceipts(directory).send(input)).rejects.toThrow(
    "agent_request_outcome_unknown",
  );
  expect(deliveries).toBe(1);
});

test("a send that fails before beforeDispatch can be retried with the same message", async () => {
  const { requests, directory } = await fixture();
  let available = false;
  let sends = 0;
  const input = {
    agentId: "agent",
    messageId: "message",
    request: {},
    send: async (beforeDispatch: () => Promise<void>) => {
      if (!available) throw new Error("mode change failed");
      await beforeDispatch();
      sends++;
    },
  };
  await expect(requests.send(input)).rejects.toThrow("mode change failed");
  available = true;
  await new MessageReceipts(directory).send(input);
  available = false;
  await requests.send(input);
  expect(sends).toBe(1);
});

test("a confirmed refusal can be retried after the pending receipt was saved", async () => {
  const { requests, directory } = await fixture();
  const refusal = new Error("replacement was refused");
  let attempts = 0;
  const input = {
    agentId: "agent",
    messageId: "completion",
    request: {},
    retryIfUnsent: (error: unknown) => error === refusal,
    send: async (beforeDispatch: () => Promise<void>) => {
      await beforeDispatch();
      if (++attempts === 1) throw refusal;
    },
  };
  await expect(requests.send(input)).rejects.toThrow(refusal);
  const restarted = new MessageReceipts(directory);
  await restarted.send(input);
  await restarted.send(input);
  expect(attempts).toBe(2);
});

test("retry repairs a completion write without repeating the accepted dispatch", async () => {
  const { requests, directory } = await fixture();
  let receipt: string;
  let sends = 0;
  const input = {
    agentId: "agent",
    messageId: "completion",
    request: {},
    retryIfUnsent: () => false,
    send: async (beforeDispatch: () => Promise<void>) => {
      await beforeDispatch();
      sends++;
      const [file] = await readdir(directory);
      receipt = path.join(directory, file!);
      await rename(receipt, `${receipt}.pending`);
      await mkdir(receipt);
    },
  };
  await expect(requests.send(input)).rejects.toThrow();
  await rm(receipt!, { recursive: true });
  await rename(`${receipt!}.pending`, receipt!);
  await requests.send(input);
  await new MessageReceipts(directory).send(input);
  expect(sends).toBe(1);
});

test("restart sees ordered, privately stored unsent entries and skips uncertain provider handoffs", async () => {
  const { requests, directory } = await fixture();
  const attempts: Promise<void>[] = [];
  for (const messageId of ["first", "uncertain", "declined", "last"]) {
    const admitted = Promise.withResolvers<void>();
    attempts.push(
      requests.sendQueued({
        agentId: "agent",
        request: { text: messageId },
        message: {
          messageId,
          prompt: messageId,
          source: { agentId: "sender" },
          activeTurnBehavior: "steer",
          unarchive: false,
        },
        async enqueue(handoff) {
          if (messageId === "uncertain" || messageId === "declined") await handoff.begin();
          if (messageId === "declined") await handoff.declined();
          return { dispatched: new Promise(() => {}) };
        },
        onQueued: admitted.resolve,
      }),
    );
    await admitted.promise;
  }
  const restarted = new MessageReceipts(directory);
  const queued = await restarted.queuedMessages();
  expect(queued.map((item) => item.queued.message.messageId)).toEqual([
    "first",
    "declined",
    "last",
  ]);
  const files = await readdir(directory);
  if (process.platform !== "win32") {
    const modes = await Promise.all(
      files.map(async (file) => (await stat(path.join(directory, file))).mode & 0o777),
    );
    expect(modes.filter((mode) => mode === 0o600)).toHaveLength(3);
  }
  const broken = path.join(directory, `${"a".repeat(64)}.json`);
  await writeFile(broken, "{");
  const unreadable = [];
  expect(await restarted.queuedMessages(() => unreadable.push(true))).toEqual(queued);
  expect(unreadable).toHaveLength(1);
  expect(await readFile(broken, "utf8")).toBe("{");
  for (const item of queued) {
    await restarted.resumeQueued(item, {
      async enqueue(handoff) {
        await handoff.begin();
        return { dispatched: Promise.resolve() };
      },
    });
  }
  expect(await restarted.queuedMessages()).toEqual([]);
  // The previous daemon's in-memory promises died without provider confirmation.
  expect(attempts).toHaveLength(4);
});

test("persistent queue records an unknown provider outcome without replayable content", async () => {
  const { requests, directory } = await fixture();
  const message = {
    messageId: "unknown-command",
    prompt: "/compact",
    source: { agentId: "sender" },
    activeTurnBehavior: "steer" as const,
    unarchive: false,
  };

  await requests.sendQueued({
    agentId: "agent",
    request: { prompt: message.prompt },
    message,
    async enqueue(handoff) {
      await handoff.begin();
      await handoff.onProviderOutcome?.("unknown");
      return { dispatched: Promise.resolve() };
    },
  });

  const restarted = new MessageReceipts(directory);
  expect(await restarted.queuedMessages()).toEqual([]);
  await expect(
    restarted.sendQueued({
      agentId: "agent",
      request: { prompt: message.prompt },
      message,
      enqueue: async () => ({ dispatched: Promise.resolve() }),
    }),
  ).rejects.toThrow("agent_request_outcome_unknown");
});

test("direct persistent receipt leaves an unknown provider outcome pending", async () => {
  const { requests, directory } = await fixture();
  const input = {
    agentId: "agent",
    messageId: "unknown-direct",
    request: { prompt: "/compact" },
    send: async (
      beforeDispatch: () => Promise<void>,
      _declined: () => Promise<void>,
      onProviderOutcome: (outcome: "accepted" | "unknown") => Promise<void>,
    ) => {
      await beforeDispatch();
      await onProviderOutcome("unknown");
    },
  };

  await requests.send(input);
  await expect(new MessageReceipts(directory).send(input)).rejects.toThrow(
    "agent_request_outcome_unknown",
  );
});

test("a queued provider refusal keeps the original message available for retry", async () => {
  const { requests, directory } = await fixture();
  const message = {
    messageId: "refused-command",
    prompt: "/compact",
    source: { agentId: "sender" },
    activeTurnBehavior: "steer" as const,
    unarchive: false,
  };
  const refusal = new Error("provider refused command");

  await expect(
    requests.sendQueued({
      agentId: "agent",
      request: { prompt: message.prompt },
      message,
      async enqueue(handoff) {
        await handoff.begin();
        await handoff.declined();
        return { dispatched: Promise.reject(refusal) };
      },
    }),
  ).rejects.toBe(refusal);

  const restarted = new MessageReceipts(directory);
  expect((await restarted.queuedMessages()).map((item) => item.queued.message.messageId)).toEqual([
    "refused-command",
  ]);
});
