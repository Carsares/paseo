import { describe, expect, test, vi } from "vitest";

import { watchScopedProviderProcess } from "./scoped-provider-process.js";

const START = "Wed Nov 25 04:00:00 2026";
const NEXT_START = "Wed Nov 25 04:00:01 2026";
const GROUP = 1001;
const TABLE_BASE = `1 1 0 1 1 S ${START}\n`;

function linuxProcessTable(read: () => string) {
  const signals: Array<[number, NodeJS.Signals | 0]> = [];
  const stop = watchScopedProviderProcess(GROUP, {
    platform: "linux",
    commandRunner: {
      async exec(command, args) {
        expect(command).toBe("ps");
        if (args.includes("-L")) {
          return { stdout: TABLE_BASE + read(), stderr: "" };
        }
        throw new Error("Unexpected per-process signal lookup");
      },
    },
    kill(pid, signal) {
      signals.push([pid, signal]);
    },
  }).stop;
  return { signals, stop };
}

describe("scoped provider process termination on Linux", () => {
  test("releases a group of exited processes and ignores exited or reused descendant PIDs", async () => {
    let reads = 0;
    const { signals, stop } = linuxProcessTable(() => {
      reads++;
      return reads <= 2
        ? `1001 1001 1 1001 1001 S ${START}
           1002 1002 1001 1002 1002 S ${START}
           1003 1003 1002 1003 1003 S ${START}`
        : `1001 1001 1 1001 1001 Z ${START}
           1002 1002 1 1002 1002 Z ${START}
           1003 1003 1 1003 1003 S ${NEXT_START}
           1011 1011 1 1001 1001 X ${START}`;
    });
    const release = vi.fn();
    await expect(stop(release)).resolves.toBe(true);
    expect(release).toHaveBeenCalledOnce();
    expect(signals).toEqual([
      [-GROUP, "SIGKILL"],
      [-GROUP, 0],
    ]);
  });

  test.each([
    [
      "a live thread under an exited leader",
      `1001 1001 1 1001 1001 Z ${START}
                                            1010 1010 1 1001 1001 Z ${START}
                                            1010 1012 1 1001 1001 D ${START}`,
    ],
    ["an unreadable row", `1001 1001 1 1001 1001 Z ${START}\ntruncated row`],
    ["a group with no visible members", ""],
  ])("holds installation activity with %s until cleanup can be verified", async (_case, rows) => {
    let readableExit = false;
    const { stop } = linuxProcessTable(() =>
      readableExit ? `1001 1001 1 1001 1001 Z ${START}` : rows,
    );
    const release = vi.fn();
    await expect(stop(release)).resolves.toBe(false);
    expect(release).not.toHaveBeenCalled();
    readableExit = true;
    await vi.waitFor(() => expect(release).toHaveBeenCalledOnce(), { timeout: 2_000 });
  });
});
