import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import type { AgentClient, AgentSession } from "../agent-sdk-types.js";
import { ClaudeAgentClient } from "./claude/agent.js";
import { CodexAppServerAgentClient } from "./codex-app-server-agent.js";
import { CopilotACPAgentClient } from "./copilot-acp-agent.js";
import { OmpAgentClient } from "./omp/agent.js";
import { OpenCodeRuntimeClient } from "./opencode/runtime-client.js";
import { PiRpcAgentClient } from "./pi/agent.js";
import type { LatestReleaseLookup } from "./release-check.js";
import type { ProviderUpdateReport } from "@getpaseo/plugin/server/provider";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

/** A command that prints `banner` for `--version`, the way the real CLI does. */
async function versionCommand(banner: string): Promise<[string, string]> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paseo-update-check-"));
  roots.push(root);
  const script = path.join(root, "cli.mjs");
  await fs.writeFile(script, `console.log(${JSON.stringify(banner)});\n`);
  return [process.execPath, script];
}

async function recordCommand(): Promise<{
  argv: [string, string];
  recordedArgs: () => Promise<string[]>;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paseo-updater-"));
  roots.push(root);
  const script = path.join(root, "cli.mjs");
  const record = path.join(root, "args.json");
  await fs.writeFile(
    script,
    `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(record)}, JSON.stringify(process.argv.slice(2)));\n`,
  );
  return {
    argv: [process.execPath, script],
    recordedArgs: async () => JSON.parse(await fs.readFile(record, "utf8")) as string[],
  };
}

async function runUpdate(client: AgentClient) {
  const output: ProviderUpdateReport[] = [];
  const result = await client.installation?.update?.({
    signal: new AbortController().signal,
    report: (event) => output.push(event),
  });
  return { result, output };
}

function releases(latest: string) {
  const lookups: string[] = [];
  const lookup: LatestReleaseLookup = async ({ executablePath }) => {
    lookups.push(executablePath);
    return latest;
  };
  return { lookup, lookups };
}

/** Checks the way the daemon does: with the version the inspection reported. */
async function check(client: AgentClient) {
  const signal = new AbortController().signal;
  const inspection = await client.installation?.inspect?.({ signal });
  const installedVersion = inspection?.status === "installed" ? inspection.version : undefined;
  return client.installation?.checkForUpdates?.({ installedVersion, signal });
}

const providers = [
  {
    name: "Codex",
    banner: (version: string) => `codex-cli ${version}`,
    client: (argv: [string, string], lookupLatestRelease: LatestReleaseLookup) =>
      new CodexAppServerAgentClient(
        createTestLogger(),
        { command: { mode: "replace", argv } },
        { lookupLatestRelease },
      ),
  },
  {
    name: "Claude Code",
    banner: (version: string) => `${version} (Claude Code)`,
    client: (argv: [string, string], lookupLatestRelease: LatestReleaseLookup) =>
      new ClaudeAgentClient({
        logger: createTestLogger(),
        runtimeSettings: { command: { mode: "replace", argv } },
        lookupLatestRelease,
      }),
  },
];

describe.each(providers)("$name update", ({ client }) => {
  test("does not run the updater through a configured wrapper", async () => {
    const updater = await recordCommand();
    const agent = client(updater.argv, releases("9.9.9").lookup);
    await expect(
      agent.installation?.getMaintenance?.({ signal: new AbortController().signal }),
    ).resolves.toMatchObject({ kind: "manual" });
    await expect(runUpdate(agent)).resolves.toMatchObject({ result: { status: "failed" } });
    await expect(updater.recordedArgs()).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe.each(providers)("$name update check", ({ banner, client }) => {
  test("reports the newer release as available, version as published", async () => {
    const argv = await versionCommand(banner("0.165.0"));
    const { lookup, lookups } = releases("0.168.0");
    await expect(check(client(argv, lookup))).resolves.toEqual({
      status: "available",
      versions: ["0.168.0"],
    });
    expect(lookups).toEqual([await fs.realpath(process.execPath)]);
  });

  test("reports current when the installed release is the latest or newer", async () => {
    const argv = await versionCommand(banner("2.1.323"));
    await expect(check(client(argv, releases("2.1.323").lookup))).resolves.toEqual({
      status: "current",
    });
    await expect(check(client(argv, releases("2.1.311").lookup))).resolves.toEqual({
      status: "current",
    });
  });

  test("is inconclusive when the release channel answers something unreadable", async () => {
    const argv = await versionCommand(banner("2.1.323"));
    await expect(check(client(argv, releases("<html>").lookup))).resolves.toEqual({
      status: "unknown",
      message: "Unrecognized release <html>",
    });
  });
});

describe("Codex prerelease update check", () => {
  const codex = providers[0]!;
  const client = codex.client;
  const banner = codex.banner;

  test("orders a prerelease before the release with the same numbers", async () => {
    const prerelease = await versionCommand(banner("0.200.0-alpha.1"));
    await expect(check(client(prerelease, releases("0.200.0").lookup))).resolves.toEqual({
      status: "available",
      versions: ["0.200.0"],
    });
    const release = await versionCommand(banner("0.200.0"));
    await expect(check(client(release, releases("0.200.0-alpha.1").lookup))).resolves.toEqual({
      status: "current",
    });
  });

  test("is inconclusive between two prereleases of the same release", async () => {
    const argv = await versionCommand(banner("0.200.0-alpha.1"));
    await expect(check(client(argv, releases("0.200.0-alpha.2").lookup))).resolves.toEqual({
      status: "unknown",
      message: "Cannot compare 0.200.0-alpha.1 with 0.200.0-alpha.2",
    });
  });
});

test("Claude Code is inconclusive when a wrapper command hides its version", async () => {
  const argv = await versionCommand("cux 0.4.1");
  const { lookup, lookups } = releases("2.1.323");
  await expect(check(providers[1]!.client(argv, lookup))).resolves.toEqual({
    status: "unknown",
    message: "The configured command does not report its version",
  });
  expect(lookups).toEqual([]);
});

test.skipIf(process.platform === "win32")(
  "Codex reports the later default installation when the first script has no interpreter",
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paseo-codex-installation-"));
    roots.push(root);
    const stale = path.join(root, "stale");
    const installed = path.join(root, "installed");
    await Promise.all([fs.mkdir(stale), fs.mkdir(installed)]);
    const missingInterpreter = path.join(root, "missing-interpreter");
    const executable = path.join(installed, "codex");
    await Promise.all([
      fs.writeFile(path.join(stale, "codex"), "#!" + missingInterpreter + "\n", { mode: 0o700 }),
      fs.writeFile(executable, "#!/bin/sh\nprintf 'codex-cli 0.200.0\\n'\n", { mode: 0o700 }),
    ]);
    const latest = releases("0.201.0");
    const codex = new CodexAppServerAgentClient(
      createTestLogger(),
      { env: { PATH: [stale, installed].join(path.delimiter), CODEX_HOME: root } },
      { lookupLatestRelease: latest.lookup },
    );
    await expect(check(codex)).resolves.toEqual({ status: "available", versions: ["0.201.0"] });
    expect(latest.lookups).toEqual([await fs.realpath(executable)]);
  },
);

/**
 * A command that answers `--version` with `banner` and any other invocation with `rest`, the way
 * a CLI answers both its version and its update check.
 */
async function cliCommand(input: { banner: string; rest: string }): Promise<[string, string]> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paseo-cli-"));
  roots.push(root);
  const script = path.join(root, "cli.mjs");
  await fs.writeFile(
    script,
    [
      `const args = process.argv.slice(2);`,
      `console.log(args.at(-1) === "--version" ? ${JSON.stringify(input.banner)} : ${JSON.stringify(input.rest)});`,
    ].join("\n"),
  );
  return [process.execPath, script];
}

function inspect(client: AgentClient) {
  return client.installation?.inspect?.({ signal: new AbortController().signal });
}

const selfUpdatingClis = [
  {
    name: "Copilot",
    banner: "GitHub Copilot CLI 1.0.110.\nRun 'copilot update' to check for updates.",
    version: "1.0.110",
    client: (argv: [string, string]) =>
      new CopilotACPAgentClient({
        logger: createTestLogger(),
        runtimeSettings: { command: { mode: "replace", argv } },
      }),
  },
  {
    name: "OpenCode",
    banner: "1.19.5",
    version: "1.19.5",
    client: (argv: [string, string]) =>
      new OpenCodeRuntimeClient(createTestLogger(), {
        command: { mode: "replace", argv },
        env: { XDG_STATE_HOME: path.dirname(argv[1]), PASEO_OPENCODE_SERVER_URL: "" },
      }),
  },
  {
    name: "Pi",
    banner: "1.3.0",
    version: "1.3.0",
    client: (argv: [string, string]) =>
      new PiRpcAgentClient({
        logger: createTestLogger(),
        runtimeSettings: { command: { mode: "replace", argv } },
      }),
  },
  {
    name: "Oh My Pi",
    banner: "omp/18.6.1",
    version: "18.6.1",
    client: (argv: [string, string]) =>
      new OmpAgentClient({
        logger: createTestLogger(),
        runtimeSettings: { command: { mode: "replace", argv } },
      }),
  },
];

describe.each(selfUpdatingClis)("$name installation", (cli) => {
  test("reports the version the CLI prints", async () => {
    const argv = await versionCommand(cli.banner);
    await expect(inspect(cli.client(argv))).resolves.toEqual({
      status: "installed",
      version: cli.version,
    });
  });

  test("uses manual maintenance and does not launch the configured updater", async () => {
    const updater = await recordCommand();
    const client = cli.client(updater.argv);
    await expect(
      client.installation.getMaintenance?.({ signal: new AbortController().signal }),
    ).resolves.toMatchObject({ kind: "manual" });
    await expect(runUpdate(client)).resolves.toMatchObject({
      result: { status: "failed" },
      output: [],
    });
    await expect(updater.recordedArgs()).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("is not installed when the command is missing", async () => {
    const client = cli.client(["/nonexistent/paseo-cli", "--flag"]);
    await expect(inspect(client)).resolves.toEqual({ status: "not_installed" });
  });
});

// The agent spawn looks the bare command up on the provider's PATH, so the installation does too.
test("Copilot reports the copy on the provider's PATH", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paseo-provider-path-"));
  roots.push(dir);
  if (process.platform === "win32") {
    await fs.writeFile(
      path.join(dir, "copilot.cmd"),
      "@echo off\r\necho GitHub Copilot CLI 9.9.9.\r\n",
    );
  } else {
    await fs.writeFile(path.join(dir, "copilot"), "#!/bin/sh\necho 'GitHub Copilot CLI 9.9.9.'\n", {
      mode: 0o755,
    });
  }
  const client = new CopilotACPAgentClient({
    logger: createTestLogger(),
    runtimeSettings: { env: { PATH: dir } },
  });
  await expect(inspect(client)).resolves.toEqual({ status: "installed", version: "9.9.9" });
});

test.skipIf(process.platform === "win32")(
  "Copilot resolves availability without a process and only runs guarded diagnostic queries",
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paseo-copilot-diagnostic-"));
    roots.push(root);
    const invocations = path.join(root, "invocations");
    await fs.writeFile(
      path.join(root, "copilot"),
      [
        "#!/bin/sh",
        'printf "%s %s\\n" "$COPILOT_AUTO_UPDATE" "$*" >> "$COPILOT_TEST_LOG"',
        'printf "GitHub Copilot CLI 0.0.418.\\n"',
        'if [ "$*" = "--no-auto-update version" ]; then printf "Update available: 1.0.115\\n"; fi',
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    const client = new CopilotACPAgentClient({
      logger: createTestLogger(),
      runtimeSettings: {
        env: { PATH: root, COPILOT_TEST_LOG: invocations, COPILOT_AUTO_UPDATE: "true" },
      },
    });

    expect(await client.isAvailable()).toBe(true);
    await expect(fs.stat(invocations)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await client.getDiagnostic()).diagnostic).toContain("GitHub Copilot CLI 0.0.418.");
    await expect(inspect(client)).resolves.toEqual({ status: "installed", version: "0.0.418" });
    await expect(
      client.installation.checkForUpdates!({
        signal: new AbortController().signal,
        installedVersion: "0.0.418",
      }),
    ).resolves.toEqual({ status: "available", versions: ["1.0.115"] });
    expect((await fs.readFile(invocations, "utf8")).trim().split("\n")).toEqual([
      "false --no-auto-update --version",
      "false --no-auto-update --version",
      "false --no-auto-update version",
    ]);
  },
);

test
  .skipIf(process.platform === "win32")
  .each(["metadata", "history", "interactive", "new"] as const)(
  "Copilot starts %s with automatic updates disabled and no preceding version process",
  async (purpose) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paseo-copilot-acp-resume-"));
    roots.push(root);
    const executable = path.join(root, "copilot");
    const script = path.join(root, "acp.mjs");
    await fs.writeFile(
      executable,
      [
        "#!/bin/sh",
        'printf "%s %s\\n" "$COPILOT_AUTO_UPDATE" "$*" >> "$0.calls"',
        'if [ "$1" = "--version" ]; then exit 0; fi',
        'exec "$COPILOT_TEST_NODE" "$COPILOT_TEST_SCRIPT" "$@"',
      ].join("\n") + "\n",
      { mode: 0o755 },
    );
    await fs.writeFile(
      script,
      `
    import { createInterface } from "node:readline";
    createInterface({ input: process.stdin }).on("line", (line) => {
      const { id, method } = JSON.parse(line);
      if (id === undefined) return;
      const result = method === "initialize"
        ? { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { close: {} } } }
        : method === "session/new" ? { sessionId: "new" } : {};
      console.log(JSON.stringify({ jsonrpc: "2.0", id, result }));
    });
  `,
    );
    const client = new CopilotACPAgentClient({
      logger: createTestLogger(),
      runtimeSettings: {
        command: { mode: "replace", argv: [executable] },
        env: {
          COPILOT_TEST_NODE: process.execPath,
          COPILOT_TEST_SCRIPT: script,
          COPILOT_AUTO_UPDATE: "true",
        },
      },
    });
    const launchContext = { env: { COPILOT_AUTO_UPDATE: "true" } };
    let session: AgentSession | undefined;
    try {
      if (purpose === "metadata") {
        await client.listImportableSessions();
      } else if (purpose === "new") {
        session = await client.createSession({ provider: "copilot", cwd: root }, launchContext);
      } else {
        session = await client.resumeSession(
          { provider: "copilot", sessionId: "saved", metadata: { cwd: root } },
          undefined,
          launchContext,
          { purpose },
        );
      }
      expect(await fs.readFile(executable + ".calls", "utf8")).toBe("false --acp\n");
    } finally {
      await session?.close();
    }
  },
);

test("Pi checks the release its own update check reads", async () => {
  const argv = await versionCommand("1.3.0");
  const { lookup, lookups } = releases("1.5.2");
  const client = new PiRpcAgentClient({
    logger: createTestLogger(),
    runtimeSettings: { command: { mode: "replace", argv } },
    lookupLatestRelease: lookup,
  });
  await expect(check(client)).resolves.toEqual({ status: "available", versions: ["1.5.2"] });
  expect(lookups).toEqual([await fs.realpath(process.execPath)]);
});

describe("Oh My Pi update check", () => {
  async function ompCheck(answer: string) {
    const argv = await cliCommand({ banner: "omp/18.6.1", rest: answer });
    return check(
      new OmpAgentClient({
        logger: createTestLogger(),
        runtimeSettings: { command: { mode: "replace", argv } },
      }),
    );
  }

  test("reads the answer of `omp update --check`", async () => {
    await expect(ompCheck("\u001b[32mNew version available: 18.7.0\u001b[0m")).resolves.toEqual({
      status: "available",
      versions: ["18.7.0"],
    });
    await expect(ompCheck("Already up to date")).resolves.toEqual({ status: "current" });
  });

  test("passes through an install that another tool keeps up to date", async () => {
    await expect(ompCheck("omp is kept up to date by mise")).resolves.toEqual({
      status: "unknown",
      message: "omp is kept up to date by mise",
    });
  });
});

describe("Copilot update check", () => {
  const banner = "GitHub Copilot CLI 0.0.418\n";
  const unknown = {
    status: "unknown",
    message: "Copilot did not report whether an update is available.",
  };
  const cases = [
    {
      name: "reads the available version from Copilot's own release channel",
      stdout: banner + "Update available: 1.0.115\nRun 'copilot update' to update",
      exitCode: 0,
      expected: { status: "available", versions: ["1.0.115"] },
    },
    {
      name: "reads an explicit current response",
      stdout: banner + "You are already on the latest version.",
      exitCode: 0,
      expected: { status: "current" },
    },
    {
      name: "does not mistake the installed version or update instructions for a result",
      stdout: banner + "Run 'copilot update' to check for updates.",
      exitCode: 0,
      expected: unknown,
    },
    {
      name: "ignores output from failed or unsupported commands",
      stdout: banner + "Update available: 1.0.115",
      exitCode: 1,
      expected: unknown,
    },
  ];

  test.each(cases)("$name", async ({ stdout, exitCode, expected }) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paseo-copilot-check-"));
    roots.push(root);
    const script = path.join(root, "cli.mjs");
    const invocations = path.join(root, "invocations");
    await fs.writeFile(
      script,
      [
        'import { appendFileSync } from "node:fs";',
        "const args = process.argv.slice(2);",
        `appendFileSync(${JSON.stringify(invocations)}, JSON.stringify([args, process.env.COPILOT_AUTO_UPDATE]) + "\\n");`,
        `if (args.at(-1) === "--version") console.log(${JSON.stringify(banner)});`,
        `else { console.log(${JSON.stringify(stdout)}); process.exitCode = ${exitCode}; }`,
      ].join("\n"),
    );
    const client = new CopilotACPAgentClient({
      logger: createTestLogger(),
      runtimeSettings: {
        command: { mode: "replace", argv: [process.execPath, script, "--wrapper-flag"] },
        env: { COPILOT_AUTO_UPDATE: "true" },
      },
    });
    await expect(check(client)).resolves.toEqual(expected);
    expect(
      (await fs.readFile(invocations, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual([
      [["--wrapper-flag", "--no-auto-update", "--version"], "false"],
      [["--wrapper-flag", "--no-auto-update", "version"], "false"],
    ]);
  });
});

test("OpenCode declares no update check", () => {
  const argv: [string, string] = [process.execPath, "cli.mjs"];
  expect(selfUpdatingClis[1]!.client(argv).installation.checkForUpdates).toBeUndefined();
});
