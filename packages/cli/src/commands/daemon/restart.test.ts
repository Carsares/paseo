import { Command } from "commander";
import { expect, test, vi } from "vitest";
import { connectToDaemon } from "../../utils/client.js";
import { runRestartCommand } from "./restart.js";

vi.mock("../../utils/client.js", () => ({ connectToDaemon: vi.fn() }));

test.each(["lifecycle_prepare_failed", "DAEMON_CONNECTION_LOST"])(
  "a restart preserving agents reports %s without accepting a new PID as proof",
  async (code) => {
    const error = Object.assign(new Error("Agent recovery was not confirmed"), { code });
    const close = vi.fn(async () => {});
    const connect = vi.mocked(connectToDaemon);
    connect.mockClear();
    connect.mockResolvedValue({
      getLastServerInfoMessage: () => ({
        status: "server_info",
        serverId: "test-daemon",
        version: "0.16.0",
        features: { resumeAgentsOnStop: true },
      }),
      getDaemonStatus: async () => ({ pid: 1 }),
      restartServer: async () => {
        throw error;
      },
      close,
    } as Awaited<ReturnType<typeof connectToDaemon>>);

    await expect(
      runRestartCommand(
        { daemonTarget: { kind: "endpoint", host: "127.0.0.1:1" }, resumeAgents: true },
        new Command("restart"),
      ),
    ).rejects.toBe(error);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  },
);
