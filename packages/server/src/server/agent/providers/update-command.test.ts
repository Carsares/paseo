import { spawn } from "node:child_process";
import { vi } from "vitest";
import { expect, test } from "vitest";
import type { AgentClientUpdateContext } from "../agent-sdk-types.js";
import { runUpdateCommand } from "./update-command.js";

vi.mock("node:child_process", { spy: true });

const supported = process.platform === "darwin" || process.platform === "linux";

test.skipIf(!supported)(
  "does not infer a verified installation update from exit zero or expose argv",
  async () => {
    const events: Parameters<AgentClientUpdateContext["report"]>[0][] = [];
    const result = await runUpdateCommand(
      {
        command: process.execPath,
        args: ["-e", "console.log('downloading credential secret-value')"],
        env: {},
      },
      { signal: new AbortController().signal, report: (event) => events.push(event) },
    );

    expect(result).toEqual({ status: "succeeded", outcome: "unverified" });
    expect(events).toEqual([
      { type: "message", text: "Running the verified native updater.\n" },
      { type: "message", text: "Updater is downloading files.\n" },
    ]);
  },
);

test.skipIf(!supported)(
  "terminates a background child that inherited a pipe when the updater deadline expires",
  async () => {
    // The descendant keeps the inherited output stream open after its parent exits.
    const startChild = [
      'const { spawn } = require("node:child_process");',
      'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 10000)"], { stdio: "inherit" });',
      "child.unref();",
    ].join("\n");
    const result = await runUpdateCommand(
      { command: process.execPath, args: ["-e", startChild], env: {}, deadlineMs: 750 },
      { signal: new AbortController().signal, report() {} },
    );

    expect(result).toEqual({ status: "failed", message: "The native command timed out." });
  },
);

test("rejects a relative updater and honors cancellation before spawning", async () => {
  const context = {
    signal: AbortSignal.abort(),
    report() {},
  };
  const relative = await runUpdateCommand({ command: "node", args: [], env: {} }, context);
  expect(relative).toEqual({
    status: "failed",
    message: "This platform or executable is unsupported for native updates.",
  });
  if (supported) {
    const canceled = await runUpdateCommand(
      { command: process.execPath, args: [], env: {} },
      context,
    );
    expect(canceled).toEqual({ status: "failed", message: "Update canceled." });
  }
});

test.skipIf(!supported)("calls the current-launch assertion before spawning", async () => {
  vi.mocked(spawn).mockClear();
  const stale = new Error("Provider configuration changed");
  await expect(
    runUpdateCommand(
      { command: process.execPath, args: [], env: {} },
      {
        signal: new AbortController().signal,
        report() {},
        assertCurrent() {
          throw stale;
        },
      },
    ),
  ).rejects.toBe(stale);
  expect(spawn).not.toHaveBeenCalled();
});
