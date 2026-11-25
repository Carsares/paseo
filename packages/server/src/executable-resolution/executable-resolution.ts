import { constants, existsSync } from "node:fs";
import { access, open, realpath, stat } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, resolve } from "node:path";
import type { ProcessEnvRecord } from "../server/paseo-env.js";
import { execCommand } from "../utils/spawn.js";
import which from "which";
import { windowsExecutableResolution } from "./windows.js";

const PROBE_TIMEOUT_MS = 2000;

function hasPathSeparator(value: string): boolean {
  return value.includes("/") || value.includes("\\");
}

function stripWindowsPathQuotes(entry: string): string {
  return process.platform === "win32" &&
    entry.length >= 2 &&
    entry.startsWith('"') &&
    entry.endsWith('"')
    ? entry.slice(1, -1)
    : entry;
}

function normalizeDirectory(dir: string): string {
  const resolved = resolve(dir);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function extractAbsolutePathDirs(rawPath: string | undefined): string[] {
  if (!rawPath) {
    return [];
  }
  return rawPath
    .split(delimiter)
    .map(stripWindowsPathQuotes)
    .filter((entry) => entry.length > 0 && isAbsolute(entry));
}

async function enumerateCandidates(name: string, env?: ProcessEnvRecord): Promise<string[]> {
  const rawPath = env?.PATH !== undefined ? env.PATH : process.env.PATH;
  const absolutePathDirs = extractAbsolutePathDirs(rawPath);
  if (absolutePathDirs.length === 0) {
    return [];
  }
  const filteredEnv: ProcessEnvRecord = {
    ...(env ?? process.env),
    PATH: absolutePathDirs.join(delimiter),
  };
  const allowedDirs = new Set(absolutePathDirs.map(normalizeDirectory));
  const candidates =
    process.platform !== "win32" && existsSync("/usr/bin/which")
      ? await enumerateCandidatesViaSystemWhich(name, filteredEnv)
      : await enumerateCandidatesViaLibrary(name, filteredEnv);
  return candidates.filter((candidate) => allowedDirs.has(normalizeDirectory(dirname(candidate))));
}

async function enumerateCandidatesViaSystemWhich(
  name: string,
  env?: ProcessEnvRecord,
): Promise<string[]> {
  try {
    const { stdout } = await execCommand("/usr/bin/which", ["-a", name], {
      baseEnv: env,
      timeout: 3000,
      killSignal: "SIGKILL",
    });
    return Array.from(new Set(stdout.trim().split("\n").filter(Boolean)));
  } catch (error) {
    // which exits 1 for a missing command. A failed lookup is not evidence of absence.
    if (error instanceof Error && "code" in error && error.code === 1) return [];
    throw error;
  }
}

async function enumerateCandidatesViaLibrary(
  name: string,
  env?: ProcessEnvRecord,
): Promise<string[]> {
  let candidates: string[];
  try {
    candidates = await which(name, { all: true, path: env?.PATH, pathExt: env?.PATHEXT });
  } catch (error) {
    // `which` throws ENOENT when the command is absent from PATH.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    if (seen.has(candidate)) {
      return false;
    }
    seen.add(candidate);
    return true;
  });
}

export async function probeExecutable(
  executablePath: string,
  options: number | ExecutableResolutionOptions = PROBE_TIMEOUT_MS,
): Promise<boolean> {
  const { probeTimeoutMs: timeoutMs = PROBE_TIMEOUT_MS, env } =
    typeof options === "number" ? { probeTimeoutMs: options } : options;
  try {
    await execCommand(executablePath, ["--version"], {
      baseEnv: env,
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      maxBuffer: 64 * 1024,
    });
    return true;
  } catch (error) {
    return classifyProbeError(error);
  }
}

function classifyProbeError(error: unknown): boolean {
  const err = error as NodeJS.ErrnoException & {
    killed?: boolean;
  };
  if (err.killed) {
    return true;
  }
  if (typeof err.code === "number") {
    return true;
  }
  if (
    err.code === "ENOENT" ||
    err.code === "EACCES" ||
    err.code === "ENOEXEC" ||
    err.code === "UNKNOWN"
  ) {
    return false;
  }
  return false;
}

/**
 * Check a literal executable path. PATH search is handled by findExecutable().
 */
export function executableExists(
  executablePath: string,
  exists: typeof existsSync = existsSync,
): string | null {
  if (process.platform === "win32") {
    return windowsExecutableResolution.exists(executablePath, { exists });
  }
  return exists(executablePath) ? executablePath : null;
}

export interface ExecutableFileLookupOptions {
  cwd: string;
  path?: string;
  env?: ProcessEnvRecord;
  platform?: NodeJS.Platform;
  winGetFallback?: boolean;
  /** Preserve the working-directory search for callers that previously used cmd.exe. */
  searchWindowsLaunchDirectory?: boolean;
  /** Skip a POSIX script if its declared absolute interpreter cannot execute. */
  skipMissingInterpreter?: boolean;
}

// Windows child processes receive the first spelling after sorting environment keys.
function readWindowsEnv(env: ProcessEnvRecord, name: string): string | undefined {
  const key = Object.keys(env)
    .sort()
    .find((entry) => entry.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

async function isPosixExecutableFile(candidate: string): Promise<boolean> {
  try {
    await access(candidate, constants.X_OK);
    return (await stat(candidate)).isFile();
  } catch {
    return false;
  }
}

async function missingPosixInterpreter(candidate: string): Promise<boolean> {
  const file = await open(candidate, constants.O_RDONLY | constants.O_NONBLOCK).catch(() => null);
  if (!file) return false;
  try {
    if (!(await file.stat()).isFile()) return false;
    const bytes = Buffer.alloc(256);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    const line = bytes.indexOf(0x0a);
    if (line < 0 || line >= bytesRead) return false;
    const interpreter = /^#![ \t]*(\/[^ \t\n]+)/u.exec(bytes.toString("utf8", 0, line))?.[1];
    return interpreter !== undefined && !(await isPosixExecutableFile(interpreter));
  } catch {
    return false;
  } finally {
    await file.close();
  }
}

async function findPosixExecutableFile(
  name: string,
  cwd: string,
  searchPath: string,
  skipMissingInterpreter: boolean,
) {
  const isCandidate = async (candidate: string) =>
    (await isPosixExecutableFile(candidate)) &&
    (!skipMissingInterpreter || !(await missingPosixInterpreter(candidate)));
  if (name.includes("/")) {
    // The filesystem must traverse symlinks before interpreting a later `..`.
    const command = isAbsolute(name) ? name : `${cwd}/${name}`;
    if (!(await isCandidate(command))) return null;
    const normalized = resolve(command);
    if (command === normalized) return command;
    const [actual, regular] = await Promise.all([
      realpath(command).catch(() => null),
      realpath(normalized).catch(() => null),
    ]);
    return actual !== null && actual === regular ? normalized : command;
  }
  for (const entry of searchPath.split(delimiter)) {
    let directory = entry || cwd;
    if (entry && !isAbsolute(entry)) directory = `${cwd}/${entry}`;
    const candidate = `${directory}${directory.endsWith("/") ? "" : "/"}${name}`;
    if (await isCandidate(candidate)) return candidate;
  }
  return null;
}

// PATH lookup that never runs the candidate, unlike findExecutable which probes
// each one with `--version`. A terminal spawn path cannot afford that probe: it
// would execute the profile command once before the terminal even opens.
// `path` overrides the PATH to search, so a caller can resolve against the
// environment its child process will actually get rather than the daemon's own.
export async function findExecutableWithoutProbing(
  name: string,
  options: ExecutableFileLookupOptions,
): Promise<string | null> {
  if (!name) {
    return null;
  }
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  if (platform === "win32") {
    return windowsExecutableResolution.findWithoutProbing(name, {
      cwd: options.cwd,
      path: options.path ?? readWindowsEnv(env, "PATH") ?? process.env.PATH,
      pathExt: readWindowsEnv(env, "PATHEXT"),
      wingetLocalAppData: options.winGetFallback ? readWindowsEnv(env, "LOCALAPPDATA") : undefined,
      searchLaunchDirectory:
        options.searchWindowsLaunchDirectory === true &&
        readWindowsEnv(env, "NODEFAULTCURRENTDIRECTORYINEXEPATH") === undefined,
    });
  }
  const searchPath = options.path ?? env.PATH ?? process.env.PATH ?? "";
  return findPosixExecutableFile(
    name,
    options.cwd,
    searchPath,
    options.skipMissingInterpreter === true,
  );
}

export interface ExecutableResolutionOptions {
  probeTimeoutMs?: number;
  env?: ProcessEnvRecord;
}

export async function findExecutable(
  name: string,
  options: number | ExecutableResolutionOptions = PROBE_TIMEOUT_MS,
): Promise<string | null> {
  const { probeTimeoutMs = PROBE_TIMEOUT_MS, env } =
    typeof options === "number" ? { probeTimeoutMs: options } : options;
  const trimmed = name.trim();
  if (!trimmed) {
    return null;
  }

  if (process.platform === "win32") {
    return windowsExecutableResolution.find(trimmed, {
      enumeratePathCandidates: (command) => enumerateCandidates(command, env),
      probeExecutable: (command, timeout) =>
        probeExecutable(command, { probeTimeoutMs: timeout, env }),
      exists: existsSync,
      probeTimeoutMs,
    });
  }

  if (hasPathSeparator(trimmed)) {
    return (await probeExecutable(trimmed, { probeTimeoutMs, env })) ? trimmed : null;
  }

  const candidates = await enumerateCandidates(trimmed, env);
  for (const candidate of candidates) {
    if (await probeExecutable(candidate, { probeTimeoutMs, env })) {
      return candidate;
    }
  }
  return null;
}

export async function isCommandAvailable(command: string): Promise<boolean> {
  return (await findExecutable(command)) !== null;
}
