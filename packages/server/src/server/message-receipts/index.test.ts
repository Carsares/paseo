import { mkdir, mkdtemp, readdir, rename, rm } from "node:fs/promises";
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
