import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectToDaemon } from "../../utils/client.js";
import { resolveImportCwd, runImportCommand } from "./import.js";

const importAgent = vi.fn();
const close = vi.fn();

vi.mock("../../utils/client.js", () => ({
  connectToDaemon: vi.fn(async () => ({
    importAgent,
    close,
  })),
  getDaemonHost: vi.fn(() => "ws://127.0.0.1:6767"),
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("PASEO_AGENT_ID", undefined);
});

afterEach(() => vi.unstubAllEnvs());

describe("resolveImportCwd", () => {
  it("uses the invoking process cwd when --cwd is omitted", () => {
    expect(resolveImportCwd(undefined, "/Volumes/data/dev/rolepai")).toBe(
      "/Volumes/data/dev/rolepai",
    );
  });
});

describe("runImportCommand", () => {
  it("uses explicit --cwd when provided", () => {
    expect(resolveImportCwd(" /tmp/project ", "/Volumes/data/dev/rolepai")).toBe("/tmp/project");
  });

  it("rejects an empty explicit --cwd", () => {
    expect(() => resolveImportCwd("  ", "/Volumes/data/dev/rolepai")).toThrow(
      expect.objectContaining({
        code: "INVALID_CWD",
      }),
    );
  });

  it("accepts pi as an import provider", async () => {
    importAgent.mockResolvedValueOnce({
      id: "agent-1",
      status: "idle",
      provider: "pi",
      cwd: "/tmp/project",
      title: "Imported Pi session",
    });

    const result = await runImportCommand(
      "pi-session-1",
      {
        daemonTarget: { kind: "endpoint", host: "example.test:12345" },
        provider: "pi",
        cwd: "/tmp/project",
      },
      {} as never,
    );

    expect(importAgent).toHaveBeenCalledWith({
      provider: "pi",
      sessionId: "pi-session-1",
      cwd: "/tmp/project",
    });
    expect(result.data.provider).toBe("pi");
  });

  it.each(["parent-agent", "", "  "])(
    "rejects session import before connecting when PASEO_AGENT_ID is %j",
    async (callerId) => {
      vi.stubEnv("PASEO_AGENT_ID", callerId);

      await expect(
        runImportCommand(
          "pi-session-1",
          {
            daemonTarget: { kind: "endpoint", host: "example.test:12345" },
            provider: "pi",
            cwd: "/tmp/project",
          },
          {} as never,
        ),
      ).rejects.toMatchObject({ code: "AGENT_WORKSPACE_CREATION_FORBIDDEN" });

      expect(connectToDaemon).not.toHaveBeenCalled();
      expect(importAgent).not.toHaveBeenCalled();
    },
  );
});
