import { type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Query } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { installationActivity } from "../../provider-installation/installation-activity.js";
import { readInstallationActivityKeys } from "../../provider-installation/installation-target.js";
import { createTestLogger } from "../../../../test-utils/test-logger.js";
import * as spawnUtils from "../../../../utils/spawn.js";
import { ClaudeAgentClient } from "./agent.js";
import { discoverClaudeModels } from "./model-discovery.js";
import { claudeQuery, type ClaudeQueryFactory } from "./query.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(await realpath(tmpdir()), "paseo-claude-installation-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

test.skipIf(process.platform === "win32")(
  "requires the original install channel even for a versioned native-looking executable",
  async () => {
    const versions = path.join(root, ".local", "share", "claude", "versions");
    const bin = path.join(root, ".local", "bin");
    await mkdir(versions, { recursive: true });
    await mkdir(bin, { recursive: true });
    const executable = path.join(versions, "1.2.3");
    await writeFile(executable, Buffer.from("feedfacf", "hex"), { mode: 0o700 });
    const entry = path.join(bin, "claude");
    await symlink(executable, entry);
    vi.stubEnv("HOME", root);
    vi.stubEnv("PATH", bin);
    const spawn = vi.spyOn(spawnUtils, "spawnProcess");

    const { installation } = new ClaudeAgentClient({ logger: createTestLogger() });
    const signal = new AbortController().signal;
    await expect(installation.getMaintenance?.({ signal })).resolves.toMatchObject({
      kind: "manual",
      message: expect.stringContaining("installer or package manager"),
    });
    await expect(installation.update?.({ signal, report: vi.fn() })).resolves.toEqual({
      status: "failed",
      message: expect.stringContaining("installer or package manager"),
    });
    expect(spawn).not.toHaveBeenCalled();
  },
);

test("takes the installation lock at model discovery spawn and releases it on child close", async () => {
  const binary = path.join(root, "fake-claude.cjs");
  await writeFile(binary, "process.stdin.resume();\n", { mode: 0o700 });
  const keys = await readInstallationActivityKeys(binary);
  const target = { family: "test-target", keys };
  let child: ChildProcess | undefined;
  const model = { value: "fake", displayName: "Fake", description: "Test only" };
  const queryFactory: ClaudeQueryFactory = ({ options }) => {
    options.spawnClaudeCodeProcess?.({
      command: "node",
      args: [binary],
      cwd: root,
      env: {},
      signal: new AbortController().signal,
    });
    return { supportedModels: async () => [model], close() {} } as Query;
  };
  const spawn = vi.spyOn(spawnUtils, "spawnProcess");
  const discover = () =>
    discoverClaudeModels({ resolveBinary: async () => binary, env: {} }, (input, context) =>
      claudeQuery(input, {
        ...context,
        queryFactory,
        onChildProcess(process) {
          child = process;
          context.onChildProcess?.(process);
        },
      }),
    );

  const update = installationActivity.acquireUpdate(target);
  try {
    await expect(discover()).rejects.toThrow("being updated");
    expect(spawn).not.toHaveBeenCalled();
  } finally {
    update.release();
  }
  try {
    await expect(discover()).resolves.toEqual([model]);
    expect(() => installationActivity.acquireUpdate(target)).toThrow("in use");
  } finally {
    if (child) {
      const closed = once(child, "close");
      child.stdin?.end();
      await expect(closed).resolves.toEqual([0, null]);
    }
  }
  installationActivity.acquireUpdate(target).release();
});

test("constructing a Claude session does not hold an idle installation lock", async () => {
  const queryFactory = vi.fn<ClaudeQueryFactory>();
  const client = new ClaudeAgentClient({
    logger: createTestLogger(),
    queryFactory,
    // This test creates the object without performing version discovery or launch.
    resolveVersion: async () => "1.2.3",
    resolveBinary: async () => path.join(root, "missing"),
  });
  const session = await client.createSession({ provider: "claude", cwd: root });
  try {
    const update = installationActivity.acquireUpdate({ family: "claude", keys: [] });
    update.release();
    expect(queryFactory).not.toHaveBeenCalled();
  } finally {
    await session.close();
  }
});
