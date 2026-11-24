import { readdirSync } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join, resolve, win32 } from "node:path";

interface WindowsFindExecutableOptions {
  enumeratePathCandidates: (name: string) => Promise<string[]>;
  probeExecutable: (executablePath: string, timeoutMs: number) => Promise<boolean>;
  exists: (path: string) => boolean;
  localAppData?: string;
  probeTimeoutMs: number;
}

interface WindowsExecutableExistsOptions {
  exists: (path: string) => boolean;
}

function hasPathSeparator(value: string): boolean {
  return value.includes("/") || value.includes("\\");
}

function enumerateLiteralPathCandidates(executablePath: string): string[] {
  if (extname(executablePath)) {
    return [executablePath];
  }
  return [executablePath, `${executablePath}.exe`, `${executablePath}.cmd`];
}

function enumerateWingetPackageCandidates(
  name: string,
  localAppData: string | undefined,
): string[] {
  if (!localAppData) {
    return [];
  }

  const wingetPackages = join(localAppData, "Microsoft", "WinGet", "Packages");
  let packageDirs: string[];
  try {
    packageDirs = readdirSync(wingetPackages, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }

  const exeName = `${name}.exe`;
  return packageDirs.map((packageDir) => join(wingetPackages, packageDir, exeName));
}

async function find(input: string, options: WindowsFindExecutableOptions): Promise<string | null> {
  if (hasPathSeparator(input)) {
    return findFirstProbeable(enumerateLiteralPathCandidates(input), options);
  }

  const pathCandidates = await options.enumeratePathCandidates(input);
  const wingetCandidates = enumerateWingetPackageCandidates(
    input,
    options.localAppData ?? process.env.LOCALAPPDATA,
  );

  return findFirstProbeable([...pathCandidates, ...wingetCandidates], options);
}

interface WindowsFileLookupOptions {
  cwd: string;
  path?: string;
  pathExt?: string;
  wingetLocalAppData?: string;
  searchLaunchDirectory: boolean;
}

async function firstFile(candidates: Iterable<string>): Promise<string | null> {
  for (const candidate of candidates) {
    const info = await stat(candidate).catch(() => null);
    if (info?.isFile()) return candidate;
  }
  return null;
}

function* pathFileCandidates(input: string, options: WindowsFileLookupOptions) {
  const extensions = (options.pathExt || ".EXE;.CMD;.BAT;.COM")
    .split(";")
    .map((extension) => extension.trim())
    .filter(Boolean);
  const suffix = win32.extname(input);
  const literalPath = hasPathSeparator(input);
  if (literalPath && suffix) {
    yield resolve(options.cwd, input);
    return;
  }
  const matchingSuffixes = suffix ? ["", ...extensions] : extensions;
  const bases = literalPath
    ? [resolve(options.cwd, input)]
    : [
        ...(options.searchLaunchDirectory ? [join(options.cwd, input)] : []),
        ...(options.path
          ?.split(";")
          .map((entry) => resolve(options.cwd, entry.replace(/^"(.*)"$/u, "$1"), input)) ?? []),
      ];
  for (const base of bases) {
    for (const extension of matchingSuffixes) yield base + extension;
  }
}

async function findWithoutProbing(input: string, options: WindowsFileLookupOptions) {
  const found = await firstFile(pathFileCandidates(input, options));
  if (found || hasPathSeparator(input) || !options.wingetLocalAppData) return found;
  return firstFile(enumerateWingetPackageCandidates(input, options.wingetLocalAppData));
}

async function findFirstProbeable(
  candidates: string[],
  options: WindowsFindExecutableOptions,
): Promise<string | null> {
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    if (!options.exists(candidate)) {
      continue;
    }
    if (await options.probeExecutable(candidate, options.probeTimeoutMs)) {
      return candidate;
    }
  }
  return null;
}

function exists(executablePath: string, options: WindowsExecutableExistsOptions): string | null {
  for (const candidate of enumerateLiteralPathCandidates(executablePath)) {
    if (options.exists(candidate)) {
      return candidate;
    }
  }
  return null;
}

export const windowsExecutableResolution = {
  exists,
  find,
  findWithoutProbing,
};
