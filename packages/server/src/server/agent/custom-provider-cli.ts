import { spawn, type ChildProcessByStdio } from "node:child_process";
import { constants } from "node:fs";
import { mkdir, mkdtemp, open, readlink, realpath, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { isDeepStrictEqual } from "node:util";
import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import type {
  CustomProviderCliDraft,
  MutableDaemonConfig,
  MutableDaemonConfigPatch,
} from "@getpaseo/protocol/messages";
import {
  BUILTIN_PROVIDER_IDS,
  DEV_AGENT_PROVIDER_DEFINITIONS,
  SPECIALIZED_ACP_PROVIDER_IDS,
} from "@getpaseo/protocol/provider-manifest";
import { z } from "zod";

import type { DaemonConfigStore } from "../daemon-config-store.js";
import {
  supportsScopedProviderProcess,
  watchScopedProviderProcess,
} from "./scoped-provider-process.js";
import {
  findInstallationLaunchPath,
  readInstallationActivityKeys,
} from "./provider-installation/installation-target.js";
import { installationActivity } from "./provider-installation/installation-activity.js";
import {
  createProviderEnv,
  ProviderOverrideSchema,
  type ProviderOverride,
} from "./provider-launch-config.js";
import { findCodexLaunchFile } from "./providers/codex-app-server-agent.js";
import { resolveOpenCodeHomeDir } from "./providers/opencode/paths.js";
import { buildPiLaunch } from "./providers/pi/runtime.js";
import { buildOmpLaunch } from "./providers/omp/runtime.js";
import {
  assertLaunchFiles,
  bindCustomProviderLaunch,
  bindOpenCodeDiscovery,
  captureLaunchDirectory,
  captureLaunchFile,
  type LaunchFileIdentity,
} from "./scoped-custom-provider-launch.js";

type Operation = "locate" | "test" | "save";
type FailureStatus = "invalid" | "unavailable" | "unsupported" | "blocked" | "failed";

interface Result {
  status: "ok" | FailureStatus;
  path?: string;
  reason?: "reload_required";
}

interface Dependencies {
  configStore: DaemonConfigStore;
  signal?: AbortSignal;
  isRegisteredProvider: (id: string) => boolean;
  isPluginProvider: (id: string) => boolean;
}

type ProviderOverrides = Record<string, ProviderOverride>;
type ProviderConfig = MutableDaemonConfig["providers"];

interface ProviderDraft {
  adapter: string;
  patch: ProviderOverride;
  command?: string[];
  env: NodeJS.ProcessEnv;
  validateForSave: boolean;
}

interface Executable {
  file: string;
  real: string;
  args: string[];
}

type HandshakeProcess = ChildProcessByStdio<Writable, Readable, null>;

const PROBE_TIMEOUT_MS = 3_000;
const MAX_REPLY_BYTES = 64 * 1024;
const RESERVED_IDS = new Set([
  ...BUILTIN_PROVIDER_IDS,
  ...DEV_AGENT_PROVIDER_DEFINITIONS.map((provider) => provider.id),
  "acp",
  "constructor",
  "prototype",
]);
const FORM_ADAPTERS = new Set([...BUILTIN_PROVIDER_IDS, "acp"]);
const DISCOVERY_ADAPTERS = new Set(["acp", "claude", "codex", "copilot", "omp", "opencode", "pi"]);
const SHELL_LAUNCHERS = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "fish",
  "ksh",
  "ash",
  "cmd",
  "powershell",
  "pwsh",
]);
const SYSTEM_BUSYBOX_PATHS = new Set(["/bin/busybox", "/usr/bin/busybox"]);
const BLOCKED_LAUNCHERS = new Set([
  "npm",
  "npx",
  "npm-cli",
  "npx-cli",
  "npm-exec",
  "pnpm-cli",
  "pnpm",
  "pnpx",
  "yarn",
  "yarnpkg",
  "bun",
  "bunx",
  "uv",
  "uvx",
  "pipx",
  "pip-run",
  "corepack",
  "volta",
  "mise",
  "deno",
  "curl",
  "wget",
  "env",
  "busybox",
  ...SHELL_LAUNCHERS,
  "wsl",
]);
const InitializeReply = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.literal(1),
  result: z.object({ protocolVersion: z.literal(PROTOCOL_VERSION) }),
  error: z.never().optional(),
});

class RejectedOperation extends Error {
  readonly status: FailureStatus;
  readonly reason: Result["reason"];

  constructor(status: FailureStatus, reason?: Result["reason"]) {
    super(status);
    this.status = status;
    this.reason = reason;
  }
}

function overrideFor(
  providers: ProviderConfig | undefined,
  id: string,
): ProviderOverride | undefined {
  if (!providers || !Object.hasOwn(providers, id)) return undefined;
  const parsed = ProviderOverrideSchema.safeParse(providers[id]);
  if (!parsed.success) throw new RejectedOperation("invalid");
  return parsed.data;
}

function defaultCommand(adapter: string): string {
  if (adapter === "pi") return process.env.PI_COMMAND ?? process.env.PI_ACP_PI_COMMAND ?? "pi";
  if (adapter === "omp") return process.env.OMP_COMMAND ?? "omp";
  return adapter;
}

function validateDraft(draft: CustomProviderCliDraft): void {
  const { providerId, env } = draft;
  const validId = /^[a-z][a-z0-9-]*$/u.test(providerId) && providerId.length <= 128;
  if (!validId || Object.hasOwn(Object.prototype, providerId) || providerId === "prototype") {
    throw new RejectedOperation("invalid");
  }
  if (draft.label !== undefined && !draft.label.trim()) throw new RejectedOperation("invalid");
  for (const [key, value] of Object.entries(env ?? {})) {
    const validKey = key !== "" && !key.includes("=") && !key.includes("\0");
    const reserved = Object.hasOwn(Object.prototype, key) || key === "prototype";
    if (!validKey || reserved || value.includes("\0")) {
      throw new RejectedOperation("invalid");
    }
  }
}

function validCommand(command: string[]): boolean {
  const executable = command[0];
  if (!executable || executable !== executable.trim()) return false;
  if (/[\\/]/u.test(executable) && !path.isAbsolute(executable)) return false;
  if (/^[~$'"]|[\r\n]/u.test(executable)) return false;
  return command.every((arg) => !arg.includes("\0"));
}

function resolveAdapter(
  draft: CustomProviderCliDraft,
  dependencies: Dependencies,
  existing: ProviderOverride | undefined,
): string {
  const { providerId, mode } = draft;
  const builtin = BUILTIN_PROVIDER_IDS.includes(providerId);
  const plugin = dependencies.isPluginProvider(providerId);
  if (mode === "create") {
    if (
      RESERVED_IDS.has(providerId) ||
      (draft.extends === "acp" && SPECIALIZED_ACP_PROVIDER_IDS.includes(providerId)) ||
      plugin ||
      dependencies.isRegisteredProvider(providerId) ||
      existing
    ) {
      throw new RejectedOperation("invalid");
    }
    if (!draft.extends || !draft.label) throw new RejectedOperation("invalid");
    if (FORM_ADAPTERS.has(draft.extends)) {
      return draft.extends;
    }
    throw new RejectedOperation("invalid");
  }
  if (plugin) throw new RejectedOperation("unsupported");
  const inheritedFrom = existing?.extends;
  if (draft.extends !== undefined && draft.extends !== inheritedFrom) {
    throw new RejectedOperation("invalid");
  }
  if (builtin) return providerId;
  if (!inheritedFrom && dependencies.isRegisteredProvider(providerId)) {
    throw new RejectedOperation("unsupported");
  }
  if (inheritedFrom && FORM_ADAPTERS.has(inheritedFrom)) {
    return inheritedFrom;
  }
  throw new RejectedOperation("invalid");
}

function submittedOverride(
  draft: CustomProviderCliDraft,
  existing?: ProviderOverride,
): ProviderOverride {
  const patch: ProviderOverride = {};
  if (draft.mode === "create") patch.extends = draft.extends;
  if (draft.label !== undefined) patch.label = draft.label;
  if (draft.description !== undefined) patch.description = draft.description;
  if (draft.command !== undefined && !isDeepStrictEqual(draft.command, existing?.command)) {
    if (!validCommand(draft.command)) throw new RejectedOperation("invalid");
    patch.command = draft.command;
  }
  if (draft.env && Object.keys(draft.env).length > 0) patch.env = draft.env;
  return patch;
}

function prepareDraft(
  draft: CustomProviderCliDraft,
  dependencies: Dependencies,
  current: MutableDaemonConfig,
  persistedProviders?: ProviderOverrides,
): ProviderDraft {
  const { providerId } = draft;
  const existing =
    overrideFor(persistedProviders, providerId) ?? overrideFor(current.providers, providerId);
  const adapter = resolveAdapter(draft, dependencies, existing);
  const patch = submittedOverride(draft, existing);
  let base: ProviderOverride | undefined;
  if (adapter !== "acp" && adapter !== providerId) {
    base = overrideFor(persistedProviders, adapter) ?? overrideFor(current.providers, adapter);
  }
  const command = patch.command ?? existing?.command ?? base?.command;
  const env = createProviderEnv({ overlays: [base?.env, existing?.env, patch.env] });
  if (adapter === "acp" && !command) throw new RejectedOperation("invalid");
  return {
    adapter,
    patch,
    command,
    env,
    validateForSave:
      draft.mode === "create" || patch.command !== undefined || patch.env !== undefined,
  };
}

function launcherName(file: string): string {
  return path.win32
    .basename(file)
    .toLowerCase()
    .replace(/(?:\.(?:exe|com|cmd|bat|ps1|[cm]?js|py|sh))+$/u, "");
}

function blockedLauncher(file: string): boolean {
  return BLOCKED_LAUNCHERS.has(launcherName(file));
}

function isScriptInterpreter(file: string): boolean {
  return /^(?:node(?:js)?|python(?:[23](?:\.\d+)?)?)$/u.test(launcherName(file));
}

function blockedArguments(file: string, args: string[]): boolean {
  const name = launcherName(file);
  if (BUILTIN_PROVIDER_IDS.includes(name)) {
    return args.some((arg) => /^(?:--)?(?:update|upgrade|install)$/iu.test(arg));
  }
  return (
    isScriptInterpreter(file) &&
    args.some(
      (arg) => blockedLauncher(arg) || /^(?:-[ceimp]|--(?:eval|print|run))(?:=|$)/u.test(arg),
    )
  );
}

/** Identifies configured commands that can invoke a launcher during a read. */
export function hasDynamicProviderLauncherName([command, ...args]: readonly string[]): boolean {
  return !!command && (blockedLauncher(command) || blockedArguments(command, args));
}

/** File-only classification for legacy commands, which may still run on explicit session start. */
export async function isDynamicProviderLauncher(
  [command, ...args]: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  if (!command) return true;
  if (hasDynamicProviderLauncherName([command, ...args])) return true;
  // Some Windows adapters search their launch directory before PATH. A bare
  // command checked here could name a different file when the adapter runs it.
  if (process.platform === "win32" && !path.isAbsolute(command)) return true;
  // Read requests can select different working directories, so relative entries
  // cannot establish that every lookup reaches the same executable.
  const searchPath = getEnv(env, "PATH") ?? "";
  if (
    (!path.isAbsolute(command) && /[/\\\\]/u.test(command)) ||
    (!path.isAbsolute(command) &&
      searchPath.split(path.delimiter).length !==
        absolutePathList(env).split(path.delimiter).length)
  ) {
    return true;
  }
  try {
    const cwd = homedir();
    const executable = await resolveExecutable(command, args, cwd, env);
    await rejectKnownDownloadWrappers(executable, cwd, env, { requireResolved: true });
    return false;
  } catch {
    return true;
  }
}

function getEnv(env: NodeJS.ProcessEnv, key: string): string | undefined {
  if (process.platform !== "win32") return env[key];
  const match = Object.keys(env)
    .sort()
    .find((entry) => entry.toUpperCase() === key);
  return match === undefined ? undefined : env[match];
}

function absolutePathList(env: NodeJS.ProcessEnv): string {
  const searchPath = getEnv(env, "PATH") ?? "";
  return searchPath
    .split(path.delimiter)
    .map((entry) => (process.platform === "win32" ? entry.replace(/^"(.*)"$/u, "$1") : entry))
    .filter((entry) => path.isAbsolute(entry))
    .join(path.delimiter);
}

async function locate(
  draft: ProviderDraft,
  cwd: string,
  adapterArgs: string[] = [],
): Promise<Executable> {
  const argv = draft.command ?? [defaultCommand(draft.adapter)];
  if (!validCommand(argv)) throw new RejectedOperation("invalid");
  const [command, ...args] = argv;
  const storeFallback = draft.adapter === "codex" && draft.command === undefined;
  const executable = await resolveExecutable(command, [...args, ...adapterArgs], cwd, draft.env, {
    storeFallback,
    searchWindowsLaunchDirectory: draft.adapter === "acp" || draft.adapter === "copilot",
  });
  await rejectKnownDownloadWrappers(executable, cwd, draft.env);
  return executable;
}

async function resolveExecutable(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  lookup: { storeFallback?: boolean; searchWindowsLaunchDirectory?: boolean } = {},
): Promise<Executable> {
  if (blockedLauncher(command) || blockedArguments(command, args)) {
    throw new RejectedOperation("blocked");
  }
  const searchPath = absolutePathList(env);
  const options = {
    cwd,
    env,
    path: searchPath,
    searchWindowsLaunchDirectory: lookup.searchWindowsLaunchDirectory,
  };
  let file: string | null;
  if (lookup.storeFallback) {
    file = await findCodexLaunchFile(command, options, true);
  } else {
    if (
      !path.isAbsolute(command) &&
      !searchPath &&
      !(process.platform === "win32" && lookup.searchWindowsLaunchDirectory)
    ) {
      throw new RejectedOperation("unavailable");
    }
    file = await findInstallationLaunchPath(command, options);
  }
  if (!file) throw new RejectedOperation("unavailable");
  const real = await checkedRealPath(file, args);
  if (!real) throw new RejectedOperation("unavailable");
  return { file, real, args };
}

async function checkedRealPath(
  file: string,
  args: string[],
  options: { allowShell?: boolean } = {},
): Promise<string | null> {
  const real = await realpath(file).catch(() => null);
  if (!real) return null;
  const systemBusyBoxShell =
    options.allowShell && file === "/bin/sh" && SYSTEM_BUSYBOX_PATHS.has(real);
  const check = (candidate: string) => {
    const allowedShell =
      (options.allowShell && SHELL_LAUNCHERS.has(launcherName(candidate))) ||
      (systemBusyBoxShell && SYSTEM_BUSYBOX_PATHS.has(candidate));
    if ((blockedLauncher(candidate) && !allowedShell) || blockedArguments(candidate, args)) {
      throw new RejectedOperation("blocked");
    }
  };
  // realpath alone loses intermediate names, including package runner shims.
  let link = file;
  for (let hops = 0; hops < 40; hops += 1) {
    check(link);
    const target = await readlink(link).catch(() => null);
    if (target === null) break;
    link = path.resolve(path.dirname(link), target);
  }
  check(real);
  return real;
}

async function executableHeader(file: string): Promise<Buffer> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    if (!(await handle.stat()).isFile()) return Buffer.alloc(0);
    const buffer = Buffer.alloc(256);
    const { bytesRead } = await handle.read(buffer);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function shebang(header: Buffer): string[] {
  if (header[0] !== 0x23 || header[1] !== 0x21) return [];
  const newline = header.indexOf(0x0a);
  if (newline < 0) return [];
  return header.toString("utf8", 2, newline).trim().split(/\s+/u);
}

async function rejectKnownDownloadWrappers(
  executable: Executable,
  cwd: string,
  env: NodeJS.ProcessEnv,
  options: { requireResolved?: boolean } = {},
): Promise<void> {
  if (isScriptInterpreter(executable.real)) {
    // Legacy probes require a direct script argument. An interpreter option
    // can consume the next argument and leave the actual script unresolved.
    const script = options.requireResolved
      ? executable.args[0]
      : executable.args.find((arg) => !arg.startsWith("-"));
    const resolved = script && path.isAbsolute(script) ? await checkedRealPath(script, []) : null;
    if (options.requireResolved && (!resolved || !(await stat(resolved)).isFile())) {
      throw new RejectedOperation("unavailable");
    }
  }

  if (options.requireResolved) {
    return checkLegacyShebang(await executableHeader(executable.real));
  }
  const header = await executableHeader(executable.real).catch(() => Buffer.alloc(0));
  const [interpreter, ...args] = shebang(header);
  if (!interpreter) return;
  if (launcherName(interpreter) === "env") {
    return checkEnvShebang(args, cwd, env);
  }
  // Presence is useful even for shell shims, which the launch check rejects separately.
  if (path.isAbsolute(interpreter) && !SHELL_LAUNCHERS.has(launcherName(interpreter))) {
    await checkedRealPath(interpreter, args);
  }
}

async function checkLegacyShebang(header: Buffer): Promise<void> {
  if (header[0] !== 0x23 || header[1] !== 0x21) return;
  const newline = header.indexOf(0x0a);
  if (newline < 0) throw new RejectedOperation("unavailable");
  const [interpreter, ...args] = header
    .toString("utf8", 2, newline)
    .replace(/^[ \t]+|[ \t]+$/gu, "")
    .split(/[ \t]+/u);
  if (!path.isAbsolute(interpreter)) throw new RejectedOperation("unavailable");

  const real = await realpath(interpreter);
  const systemEnv = await realpath("/usr/bin/env").catch(() => null);
  // With BusyBox, different applets share a real path. Only the system env
  // entry establishes that this interpreter runs the env applet.
  const isSystemEnv =
    real === systemEnv && (launcherName(real) !== "busybox" || interpreter === "/usr/bin/env");
  let target = interpreter;
  if (isSystemEnv) {
    const [command, ...extra] = args[0] === "-S" ? args.slice(1) : args;
    // Require a literal absolute target. A runtime PATH search can skip a
    // file that our filesystem checks would select.
    if (!command || !/^\/[\w./+-]+$/u.test(command) || extra.length) {
      throw new RejectedOperation("unavailable");
    }
    target = command;
  } else if (args.length) {
    throw new RejectedOperation("unavailable");
  }
  const resolved = await checkedRealPath(target, [], { allowShell: true });
  if (!resolved) throw new RejectedOperation("unavailable");
  // An interpreter that is itself a script can introduce another set of arguments.
  const targetHeader = await executableHeader(resolved);
  if (targetHeader.length < 4 || !NativeExecutableMagic.has(targetHeader.readUInt32BE())) {
    throw new RejectedOperation("unavailable");
  }
}

async function checkEnvShebang(args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
  const wrapped = args[0] === "-S" || args[0] === "--split-string" ? args.slice(1) : args;
  const [command, ...commandArgs] = wrapped;
  if (!command || command.startsWith("-")) return;
  if (SHELL_LAUNCHERS.has(launcherName(command))) return;
  try {
    await resolveExecutable(command, commandArgs, cwd, env);
  } catch (error) {
    if (!(error instanceof RejectedOperation) || error.status !== "unavailable") {
      throw error;
    }
  }
}

const NativeExecutableMagic = new Set([
  0x7f454c46, // ELF
  0xfeedface,
  0xcefaedfe,
  0xfeedfacf,
  0xcffaedfe, // Mach-O
  0xcafebabe,
  0xbebafeca,
  0xcafebabf,
  0xbfbafeca, // Universal Mach-O
]);

async function canSpawnWithoutShell(
  executable: Executable,
  cwd: string,
  env: NodeJS.ProcessEnv,
  files: LaunchFileIdentity[],
  depth = 0,
): Promise<boolean> {
  if (depth > 3) return false;
  const identity = captureLaunchFile(executable.file);
  if (identity.real !== executable.real) return false;
  files.push(identity);
  if (depth === 0 && isScriptInterpreter(executable.real)) {
    // Keep an explicit local interpreter script bound too. Options before the script
    // can consume argv, so a discovery entry must name its script directly.
    const script = executable.args[0];
    if (script !== undefined) {
      if (!path.isAbsolute(script) || !(await checkedRealPath(script, []))) return false;
      files.push(captureLaunchFile(script));
    }
  }
  const header = await executableHeader(executable.real);
  if (process.platform === "win32") {
    return /\.exe$/iu.test(executable.file) && header[0] === 0x4d && header[1] === 0x5a;
  }
  if (header.length >= 4 && NativeExecutableMagic.has(header.readUInt32BE())) return true;
  const [interpreter, ...args] = shebang(header);
  if (!interpreter || !path.isAbsolute(interpreter)) return false;
  // The kernel invokes a shebang directly. Refuse shell scripts and indirect runner shims.
  if (launcherName(interpreter) === "env") {
    if ((await realpath(interpreter)) !== (await realpath("/usr/bin/env"))) return false;
    const [arg] = args;
    if (args.length !== 1 || arg.startsWith("-")) return false;
    const next = await resolveExecutable(arg, [], cwd, env);
    files.push(captureLaunchFile(interpreter));
    return await canSpawnWithoutShell(next, cwd, env, files, depth + 1);
  }
  const next = await resolveExecutable(interpreter, args, cwd, env);
  return await canSpawnWithoutShell(next, cwd, env, files, depth + 1);
}

async function launchable(
  draft: ProviderDraft,
  cwd: string,
  adapterArgs?: string[],
): Promise<
  Executable & {
    files: LaunchFileIdentity[];
    entrypoint: string;
    entrypointArgs: string[];
  }
> {
  const executable = await locate(draft, cwd, adapterArgs);
  const searchPath = getEnv(draft.env, "PATH") ?? "";
  // A relative PATH can select one installation during validation and another in a workspace.
  if (
    searchPath &&
    searchPath.split(path.delimiter).length !==
      absolutePathList(draft.env).split(path.delimiter).length
  ) {
    throw new RejectedOperation("blocked");
  }
  if (searchPath && !absolutePathList(draft.env)) throw new RejectedOperation("blocked");
  for (const key of Object.keys(draft.env)) {
    if (
      /^(?:NODE_OPTIONS|LD_PRELOAD|LD_AUDIT|DYLD_INSERT_LIBRARIES)$/iu.test(key) &&
      draft.env[key]
    ) {
      throw new RejectedOperation("blocked");
    }
  }
  const files: LaunchFileIdentity[] = [];
  if (!(await canSpawnWithoutShell(executable, cwd, draft.env, files)))
    throw new RejectedOperation("blocked");
  // Bind a PATH-selected shebang interpreter as an absolute executable too.
  const [interpreter, argument] = shebang(await executableHeader(executable.real));
  let entrypoint = executable.file;
  let entrypointArgs: string[] = [];
  if (interpreter && launcherName(interpreter) === "env") {
    const target = await resolveExecutable(argument, [], cwd, draft.env);
    const header = await executableHeader(target.real);
    if (
      header.length < 4 ||
      !NativeExecutableMagic.has(header.readUInt32BE()) ||
      !files.some((candidate) => candidate.file === target.file && candidate.real === target.real)
    ) {
      throw new RejectedOperation("blocked");
    }
    entrypoint = target.file;
    entrypointArgs = [executable.file];
  }
  assertLaunchFiles(files);
  return { ...executable, files, entrypoint, entrypointArgs };
}

function handshakeEnvironment(
  cwd: string,
  env: NodeJS.ProcessEnv,
  adapter: string,
): NodeJS.ProcessEnv {
  const probeEnv: NodeJS.ProcessEnv = {
    PATH: absolutePathList(env),
    HOME: cwd,
    XDG_CONFIG_HOME: cwd,
    XDG_DATA_HOME: cwd,
    XDG_CACHE_HOME: cwd,
    XDG_STATE_HOME: cwd,
    TMPDIR: cwd,
    TMP: cwd,
    TEMP: cwd,
  };
  if (process.platform === "win32") {
    probeEnv.SystemRoot = process.env.SystemRoot;
    probeEnv.USERPROFILE = cwd;
    probeEnv.APPDATA = cwd;
    probeEnv.LOCALAPPDATA = cwd;
  }
  if (adapter === "copilot") probeEnv.COPILOT_AUTO_UPDATE = "false";
  return probeEnv;
}

function waitForInitialize(child: HandshakeProcess, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => observeInitialize(child, signal, resolve));
}

function observeInitialize(
  child: HandshakeProcess,
  signal: AbortSignal | undefined,
  settle: (ok: boolean) => void,
): void {
  const chunks: Buffer[] = [];
  let received = 0;
  let finished = false;
  const timeout = setTimeout(() => finish(false), PROBE_TIMEOUT_MS);

  function fail(): void {
    finish(false);
  }

  function receive(chunk: Buffer): void {
    const newline = chunk.indexOf(0x0a);
    const part = newline < 0 ? chunk : chunk.subarray(0, newline);
    received += part.length;
    if (received > MAX_REPLY_BYTES) {
      fail();
      return;
    }
    chunks.push(part);
    if (newline < 0) return;
    try {
      const reply: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      finish(InitializeReply.safeParse(reply).success);
    } catch {
      fail();
    }
  }

  function finish(ok: boolean): void {
    if (finished) return;
    finished = true;
    clearTimeout(timeout);
    signal?.removeEventListener("abort", fail);
    child.stdout.off("data", receive);
    child.stdout.off("end", fail);
    child.off("close", fail);
    settle(ok);
  }

  // Retain stream error handlers through teardown.
  child.on("error", fail);
  child.stdin.on("error", fail);
  child.stdout.on("error", fail);
  child.stdout.on("data", receive);
  child.stdout.once("end", fail);
  child.once("close", fail);
  if (signal?.aborted) {
    fail();
    return;
  }
  signal?.addEventListener("abort", fail, { once: true });
  child.stdin.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} },
    }) + "\n",
  );
}

async function runHandshake(
  draft: ProviderDraft,
  providerId: string,
  executable: Awaited<ReturnType<typeof launchable>>,
  cwd: string,
  signal?: AbortSignal,
): Promise<Result> {
  const adapter = draft.adapter;
  const keys = await readInstallationActivityKeys(executable.file);
  const opaque = draft.command !== undefined || adapter === "acp" || keys.length === 0;
  signal?.throwIfAborted();
  let release: () => void;
  try {
    release = installationActivity.acquireAgent({
      family: adapter === "acp" ? providerId : adapter,
      keys,
      opaque,
    });
  } catch {
    return { status: "blocked" };
  }

  let child: HandshakeProcess;
  try {
    assertLaunchFiles(executable.files);
    const args = [...executable.args];
    if (adapter === "copilot") {
      if (!args.includes("--acp")) args.push("--acp");
      if (!args.includes("--no-auto-update")) args.push("--no-auto-update");
    }
    child = spawn(executable.entrypoint, [...executable.entrypointArgs, ...args], {
      cwd,
      env: handshakeEnvironment(cwd, draft.env, adapter),
      shell: false,
      detached: true,
      stdio: ["pipe", "pipe", "ignore"],
    });
  } catch (error) {
    release();
    throw error;
  }

  let initialized: boolean;
  let stopped: boolean;
  const tree = child.pid === undefined ? undefined : watchScopedProviderProcess(child.pid);
  try {
    initialized = await waitForInitialize(child, signal);
  } finally {
    stopped = tree ? await tree.stop(release) : true;
    child.stdin.destroy();
    child.stdout.destroy();
    // A direct child can close all its pipes before a descendant exits.
    if (!tree) release();
    if (!stopped) child.unref();
  }
  if (!initialized || !stopped || signal?.aborted) return { status: "failed" };
  return { status: "ok", path: executable.file };
}

function requireCurrentTarget(
  draft: CustomProviderCliDraft,
  current: MutableDaemonConfig,
  persisted: ProviderOverrides | undefined,
): void {
  const live = overrideFor(current.providers, draft.providerId);
  const disk = overrideFor(persisted, draft.providerId);
  const diskIdentityChanged = draft.mode === "edit" && live?.extends !== disk?.extends;
  const diskCommandChanged = !isDeepStrictEqual(live?.command, disk?.command);
  const diskEnvChanged = !isDeepStrictEqual(live?.env ?? {}, disk?.env ?? {});
  if (diskIdentityChanged || diskCommandChanged || diskEnvChanged) {
    throw new RejectedOperation("blocked", "reload_required");
  }
}

function requireCurrentProviderIdentity(
  providerId: string,
  current: MutableDaemonConfig,
  persisted: ProviderOverrides | undefined,
): void {
  if (
    overrideFor(current.providers, providerId)?.extends !==
    overrideFor(persisted, providerId)?.extends
  ) {
    throw new RejectedOperation("blocked", "reload_required");
  }
}

function requireCurrentBase(
  draft: CustomProviderCliDraft,
  adapter: string,
  current: MutableDaemonConfig,
  persisted: ProviderOverrides | undefined,
): void {
  if (adapter === "acp" || adapter === draft.providerId) return;
  const liveBase = overrideFor(current.providers, adapter);
  const diskBase = overrideFor(persisted, adapter);
  if (
    liveBase?.extends !== diskBase?.extends ||
    !isDeepStrictEqual(liveBase?.command, diskBase?.command) ||
    !isDeepStrictEqual(liveBase?.env ?? {}, diskBase?.env ?? {})
  ) {
    throw new RejectedOperation("blocked", "reload_required");
  }
}

async function save(draft: CustomProviderCliDraft, deps: Dependencies): Promise<Result> {
  await deps.configStore.patchCustomProviderCli(
    async (current, persisted): Promise<MutableDaemonConfigPatch> => {
      const launchEdit =
        draft.mode === "create" ||
        draft.command !== undefined ||
        Object.keys(draft.env ?? {}).length > 0;
      if (launchEdit) requireCurrentTarget(draft, current, persisted);
      else requireCurrentProviderIdentity(draft.providerId, current, persisted);
      const prepared = prepareDraft(draft, deps, current, persisted);
      if (launchEdit) requireCurrentBase(draft, prepared.adapter, current, persisted);
      if (prepared.validateForSave) {
        try {
          await launchable(prepared, tmpdir());
        } catch (error) {
          // An inherited default can be installed later. Discovery will validate it before use.
          if (
            prepared.command ||
            !(error instanceof RejectedOperation) ||
            error.status !== "unavailable"
          ) {
            throw error;
          }
        }
      }
      deps.signal?.throwIfAborted();
      return { providers: { [draft.providerId]: prepared.patch } };
    },
  );
  return { status: "ok" };
}

type FailureResult = Omit<Result, "status"> & { status: FailureStatus };

function failureResult(error: unknown): FailureResult {
  // Never serialize process errors, argv, environment, or child output.
  if (!(error instanceof RejectedOperation)) return { status: "failed" };
  if (error.reason) return { status: error.status, reason: error.reason };
  return { status: error.status };
}

/** Checks whether discovery can safely start the selected file. Never starts it. */
export async function checkCustomProviderCliLaunch(
  draft: CustomProviderCliDraft,
  deps: Dependencies,
): Promise<Result> {
  try {
    deps.signal?.throwIfAborted();
    validateDraft(draft);
    const prepared = prepareDraft(draft, deps, deps.configStore.get());
    const executable = await launchable(prepared, tmpdir());
    deps.signal?.throwIfAborted();
    return { status: "ok", path: executable.file };
  } catch (error) {
    return failureResult(error);
  }
}

interface Discovery {
  status: "ok";
  run<T>(operation: () => Promise<T>): Promise<T>;
}

function catalogArgv(prepared: ProviderDraft, cwd: string): string[] {
  const command: [string, ...string[]] = [defaultCommand(prepared.adapter)];
  const runtimeSettings = prepared.command
    ? { command: { mode: "replace" as const, argv: prepared.command } }
    : undefined;
  const argv = prepared.command ?? command;
  switch (prepared.adapter) {
    case "codex":
      return [...argv, "app-server"];
    case "copilot":
      return [...argv, "--acp"];
    case "pi":
      return buildPiLaunch({
        command,
        runtimeSettings,
        session: { cwd, protocolMode: "rpc", noSession: true },
      }).argv;
    case "omp":
      return buildOmpLaunch({
        command,
        runtimeSettings,
        session: { cwd, protocolMode: "rpc-ui", noSession: true },
      }).argv;
    case "opencode":
      return [...argv, "--version"];
    default:
      return argv;
  }
}

async function bindCatalogLaunch(
  prepared: ProviderDraft,
  providerId: string,
  directory: string,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const { adapter } = prepared;
  const directoryIdentity = captureLaunchDirectory(directory);
  const argv = catalogArgv(prepared, directory);
  const configuredArgv = prepared.command ?? [defaultCommand(adapter)];
  const suffix = argv.slice(configuredArgv.length);
  const useRealDirectory =
    adapter === "acp" || adapter === "copilot" || adapter === "pi" || adapter === "omp";
  const executable = await launchable(
    prepared,
    useRealDirectory ? directoryIdentity.real : directory,
    suffix,
  );
  const binding = bindCustomProviderLaunch(
    {
      adapter,
      providerId,
      cwd: directory,
      argv,
      ...(adapter === "opencode"
        ? {
            operations: {
              "opencode.version": { argv },
              "opencode.serve.v1": {
                argv: [...configuredArgv, "serve", "--port"],
                appendPort: true,
              },
              "opencode.serve.v2": {
                argv: [...configuredArgv, "serve", "--hostname", "127.0.0.1", "--port", "0"],
              },
            },
          }
        : {}),
      env: prepared.env,
      file: executable.file,
      entrypoint: executable.entrypoint,
      entrypointArgs: executable.entrypointArgs,
      files: executable.files,
      signal,
    },
    directoryIdentity,
  );
  binding.assertCurrent();
  return binding;
}

/** Binds an explicit discovery load to one directory and the adapter's final argv. */
export async function prepareCustomProviderCliDiscovery(
  draft: CustomProviderCliDraft,
  deps: Dependencies,
  cwd?: string | null,
): Promise<Discovery | FailureResult> {
  try {
    deps.signal?.throwIfAborted();
    validateDraft(draft);
    const prepared = prepareDraft(draft, deps, deps.configStore.get());
    const adapter = prepared.adapter;
    if (
      !DISCOVERY_ADAPTERS.has(adapter) ||
      (adapter === "acp" && SPECIALIZED_ACP_PROVIDER_IDS.includes(draft.providerId))
    ) {
      return { status: "unsupported" };
    }
    if (adapter === "opencode") {
      const directory = path.resolve(resolveOpenCodeHomeDir());
      const run = bindOpenCodeDiscovery(async (ownedCwd) => {
        if (path.resolve(ownedCwd) !== directory) {
          throw new Error("OpenCode launch directory did not match discovery authorization");
        }
        deps.signal?.throwIfAborted();
        await mkdir(directory, { recursive: true });
        return bindCatalogLaunch(prepared, draft.providerId, directory, deps.signal);
      });
      return { status: "ok", run };
    }
    if (adapter !== "claude" && !supportsScopedProviderProcess()) return { status: "unsupported" };
    const binding = await bindCatalogLaunch(
      prepared,
      draft.providerId,
      path.resolve(cwd || homedir()),
      deps.signal,
    );
    return { status: "ok", run: binding.run };
  } catch (error) {
    return failureResult(error);
  }
}

export async function runCustomProviderCliOperation(
  operation: Operation,
  draft: CustomProviderCliDraft,
  deps: Dependencies,
): Promise<Result> {
  try {
    deps.signal?.throwIfAborted();
    validateDraft(draft);
    if (operation === "save") return await save(draft, deps);

    const prepared = prepareDraft(draft, deps, deps.configStore.get());
    if (operation === "locate") {
      const executable = await locate(prepared, tmpdir());
      return { status: "ok", path: executable.file };
    }

    const standardAcp =
      prepared.adapter === "copilot" ||
      (prepared.adapter === "acp" && !SPECIALIZED_ACP_PROVIDER_IDS.includes(draft.providerId));
    if (!standardAcp) return { status: "unsupported" };
    // Without a job object, Windows cannot contain descendants of an exited parent.
    if (!supportsScopedProviderProcess()) return { status: "unsupported" };
    const cwd = await mkdtemp(path.join(tmpdir(), "paseo-cli-test-"));
    try {
      const executable = await launchable(prepared, cwd);
      return await runHandshake(prepared, draft.providerId, executable, cwd, deps.signal);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  } catch (error) {
    return failureResult(error);
  }
}
