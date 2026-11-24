import { type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { query, type Options, type Query, type SpawnOptions } from "@anthropic-ai/claude-agent-sdk";

import {
  createProviderEnvSpec,
  type ProviderRuntimeSettings,
} from "../../provider-launch-config.js";
import { buildSelfNodeCommand, createExternalProcessEnv } from "../../../paseo-env.js";
import { spawnProcess } from "../../../../utils/spawn.js";

import { acquireInstallationProcess } from "../../provider-installation/installation-activity.js";
import { readInstallationActivityKeys } from "../../provider-installation/installation-target.js";

// Keep the raw SDK query import in this module only. Claude process launch behavior
// must stay shared between production and tests so Windows .cmd/.bat handling cannot
// diverge from the daemon path.

export type ClaudeOptions = Options;
export type ClaudeQueryInput = Parameters<typeof query>[0] & { options: ClaudeOptions };
export type ClaudeQueryFactory = (input: ClaudeQueryInput) => Query;

export interface ClaudeQueryContext {
  runtimeSettings?: ProviderRuntimeSettings;
  launchEnv?: Record<string, string>;
  queryFactory?: ClaudeQueryFactory;
  installationKeys?: readonly string[];
  assertCanSpawn?: () => void;
  /** Called with the spawned child process so the caller can tree-kill it on close. */
  onChildProcess?: (child: ChildProcess) => void;
}

function isChildProcessWithStreams(child: ChildProcess): child is ChildProcessWithoutNullStreams {
  return child.stdin !== null && child.stdout !== null && child.stderr !== null;
}

function resolveClaudeSpawnCommand(
  spawnOptions: SpawnOptions,
  runtimeSettings?: ProviderRuntimeSettings,
): { command: string; args: string[] } {
  const commandConfig = runtimeSettings?.command;
  if (!commandConfig || commandConfig.mode === "default") {
    return {
      command: spawnOptions.command,
      args: [...spawnOptions.args],
    };
  }

  if (commandConfig.mode === "append") {
    return {
      command: spawnOptions.command,
      args: [...spawnOptions.args, ...(commandConfig.args ?? [])],
    };
  }

  return {
    command: commandConfig.argv[0],
    args: [...commandConfig.argv.slice(1), ...spawnOptions.args],
  };
}

function applyRuntimeSettingsToClaudeOptions(
  options: ClaudeOptions,
  context: ClaudeQueryContext,
): ClaudeOptions {
  const { runtimeSettings, launchEnv, onChildProcess, assertCanSpawn } = context;
  const installationKeys = context.installationKeys ?? [];
  const opaque = runtimeSettings?.command?.mode === "replace";
  const stderr = options.stderr;
  return {
    ...options,
    spawnClaudeCodeProcess: (spawnOptions) => {
      const resolved = resolveClaudeSpawnCommand(spawnOptions, runtimeSettings);
      // When the SDK passes a default JS runtime ("node"/"bun"), replace it with
      // process.execPath — the actual node binary running the daemon. This avoids
      // PATH lookup failures in the managed runtime bundle.
      // When the SDK passes a native binary path (from pathToClaudeCodeExecutable)
      // or the user overrides the command via runtime settings, use that directly.
      const isDefaultRuntime = resolved.command === "node" || resolved.command === "bun";
      const providerEnvSpec = createProviderEnvSpec({
        baseEnv: spawnOptions.env,
        runtimeSettings,
        overlays: [launchEnv],
      });
      // Session-open hooks may explicitly supply a client identity. Keep inherited
      // SDK/parent identities cleared while honoring this launch-only contribution.
      providerEnvSpec.envOverlay.CLAUDE_CODE_ENTRYPOINT = launchEnv?.CLAUDE_CODE_ENTRYPOINT;
      const providerEnv = createExternalProcessEnv(spawnOptions.env, providerEnvSpec.envOverlay);
      const selfNodeCommand = isDefaultRuntime
        ? buildSelfNodeCommand(resolved.args, providerEnv)
        : null;
      const command = selfNodeCommand?.command ?? resolved.command;
      const args = selfNodeCommand?.args ?? resolved.args;
      const cwd = spawnOptions.cwd ?? process.cwd();
      const env = selfNodeCommand?.env ?? providerEnv;
      const executable = isDefaultRuntime ? args[0] : command;
      // The SDK can choose a different executable. Use a specific scope only
      // when the argument it hands us matches the prepared literal path.
      const keys = executable === options.pathToClaudeCodeExecutable ? installationKeys : [];
      assertCanSpawn?.();
      const child = spawnClaudeProcess(command, args, {
        cwd,
        env,
        keys,
        opaque,
        signal: spawnOptions.signal,
        // Passing SDK JSON through a Windows shell would strip its quotes.
        shell: false,
      });
      onChildProcess?.(child);
      if (typeof stderr === "function") {
        child.stderr?.on("data", (chunk: Buffer | string) => {
          stderr(chunk.toString());
        });
      }
      if (!isChildProcessWithStreams(child)) {
        throw new Error("Claude process was spawned without stdio streams");
      }
      return child;
    },
  };
}

function spawnClaudeProcess(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    keys: readonly string[];
    opaque: boolean;
    signal?: AbortSignal;
    shell?: boolean;
  },
): ChildProcess {
  const { keys, opaque, ...launch } = options;
  return acquireInstallationProcess(
    { family: "claude", keys, opaque: opaque || !keys.length },
    () =>
      spawnProcess(command, args, {
        ...launch,
        envMode: "internal",
        stdio: ["pipe", "pipe", "pipe"],
      }),
  );
}

/** Version and auth probes also execute the configured provider's CLI. */
export async function execClaudeProbe(
  command: string,
  args: string[],
  options: { runtimeSettings?: ProviderRuntimeSettings; signal?: AbortSignal },
): Promise<{ stdout: string; stderr: string }> {
  const deadline = AbortSignal.timeout(5_000);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  signal.throwIfAborted();
  const opaque = options.runtimeSettings?.command?.mode === "replace";
  const keys = opaque ? [] : await readInstallationActivityKeys(command);
  signal.throwIfAborted();
  const envSpec = createProviderEnvSpec({ runtimeSettings: options.runtimeSettings });
  const child = spawnClaudeProcess(command, args, {
    cwd: process.cwd(),
    env: createExternalProcessEnv(process.env, envSpec.envOverlay),
    keys,
    opaque,
    signal,
  });
  return new Promise((resolve, reject) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const maxBuffer = 1024 * 1024;
    const collect = (stream: NodeJS.ReadableStream | null, buffer: Buffer[]) => {
      let size = 0;
      stream?.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size <= maxBuffer) buffer.push(chunk);
        else if (size - chunk.length <= maxBuffer) {
          child.kill();
          reject(new Error("Claude probe output exceeded its limit"));
        }
      });
    };
    collect(child.stdout, stdout);
    collect(child.stderr, stderr);
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    child.once("error", reject);
    child.once("close", (code, exitSignal) => {
      signal.removeEventListener("abort", abort);
      const output = {
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (code === 0) resolve(output);
      else
        reject(
          Object.assign(new Error("Claude probe did not complete"), output, {
            code,
            signal: exitSignal,
          }),
        );
    });
  });
}

export function claudeQuery(input: ClaudeQueryInput, context: ClaudeQueryContext = {}): Query {
  const launchQuery = context.queryFactory ?? query;
  return launchQuery({
    ...input,
    options: applyRuntimeSettingsToClaudeOptions(input.options, context),
  });
}
