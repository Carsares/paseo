import { existsSync, readFileSync } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { isRealpathInsideRoot } from "../../../utils/path.js";
import { PASEO_CLI_PACKAGE, type NpmGlobalPaseoInstall } from "./npm-global-cli.js";

const PackageNameSchema = z.object({ name: z.string().optional() });
const ServerPackageJsonSchema = PackageNameSchema.extend({
  version: z.string().optional(),
  paseoAgentResumeOnRestart: z.boolean().optional(),
});

export interface InstalledServerTarget {
  identity: string;
  agentResumeSupported: boolean;
}

export async function readInstalledServerTarget(
  install: NpmGlobalPaseoInstall,
  currentServerRoot: string | null,
): Promise<InstalledServerTarget | null> {
  if (install.isLinked || !currentServerRoot) return null;
  try {
    // Resolve from the installed CLI, the same package resolution used to launch its daemon.
    const daemonLauncher = path.join(
      install.packagePath,
      "dist",
      "commands",
      "daemon",
      "local-daemon.js",
    );
    await access(daemonLauncher);
    const require = createRequire(daemonLauncher);
    const root = resolvePackageRootFrom(require.resolve("@getpaseo/server"), "@getpaseo/server");
    if (!root || !isCurrentServerUnderNpmInstall(root, install)) return null;
    // The live supervisor restarts its original worker entrypoint. If npm moved
    // the package, the newly resolved CLI alone cannot attest to that worker.
    const [resolvedRoot, resolvedCurrentRoot] = await Promise.all([
      realpath(root),
      realpath(currentServerRoot),
    ]);
    if (resolvedRoot !== resolvedCurrentRoot) return null;
    const worker = await realpath(path.join(root, "dist", "server", "server", "daemon-worker.js"));
    if (!isRealpathInsideRoot(resolvedRoot, worker)) return null;
    const packageJson = ServerPackageJsonSchema.parse(
      JSON.parse(await readFile(path.join(root, "package.json"), "utf8")),
    );
    if (packageJson.version !== install.version) return null;
    // A subsequent npm install can replace the package at the same version and path.
    const [cli, entry] = await Promise.all(
      [install.packagePath, worker].map((file) => stat(file, { bigint: true })),
    );
    if (!cli?.isDirectory() || !entry?.isFile()) return null;
    return {
      identity: [
        resolvedRoot,
        worker,
        cli.dev,
        cli.ino,
        cli.ctimeNs,
        entry.dev,
        entry.ino,
        entry.ctimeNs,
      ].join("\0"),
      agentResumeSupported: packageJson.paseoAgentResumeOnRestart === true,
    };
  } catch {
    return null;
  }
}

export interface DaemonInstallOriginRuntime {
  resolveCurrentServerPackageRoot(): string | null;
}

export const daemonInstallOriginRuntime: DaemonInstallOriginRuntime = {
  resolveCurrentServerPackageRoot,
};

export function resolveNpmGlobalPrefix(serverPackageRoot: string | null): string | undefined {
  if (!serverPackageRoot) return undefined;
  let directory = serverPackageRoot;
  let prefix: string | undefined;
  while (path.dirname(directory) !== directory) {
    if (path.basename(directory) === "node_modules") {
      const root = path.dirname(directory);
      if (process.platform === "win32") prefix = root;
      else if (path.basename(root) === "lib") prefix = path.dirname(root);
    }
    directory = path.dirname(directory);
  }
  return prefix;
}

export function validateDaemonInstallOrigin(
  install: NpmGlobalPaseoInstall,
  daemonVersion: string | null,
  runtime: DaemonInstallOriginRuntime = daemonInstallOriginRuntime,
): string | null {
  if (install.isLinked) {
    return `The global ${PASEO_CLI_PACKAGE} install is linked; self-update only supports normal npm global installs.`;
  }

  if (daemonVersion && install.version !== daemonVersion) {
    return `This daemon is not running from the npm global ${PASEO_CLI_PACKAGE} install (global npm has ${install.version}, daemon is ${daemonVersion}).`;
  }

  const currentServerPackageRoot = runtime.resolveCurrentServerPackageRoot();
  if (!currentServerPackageRoot) {
    return "Unable to verify that this daemon is running from an npm global install.";
  }

  if (!isCurrentServerUnderNpmInstall(currentServerPackageRoot, install)) {
    return `This daemon is not running from the npm global ${PASEO_CLI_PACKAGE} install.`;
  }

  return null;
}

function isCurrentServerUnderNpmInstall(
  currentServerPackageRoot: string,
  install: NpmGlobalPaseoInstall,
): boolean {
  const roots = install.globalRootPath
    ? [install.packagePath, globalNodeModulesPath(install.globalRootPath)]
    : [install.packagePath];

  return roots.some((root) => isRealpathInsideRoot(root, currentServerPackageRoot));
}

function globalNodeModulesPath(globalRootPath: string): string {
  const normalized = path.normalize(globalRootPath);
  return path.basename(normalized) === "node_modules"
    ? normalized
    : path.join(normalized, "node_modules");
}

function resolveCurrentServerPackageRoot(): string | null {
  return resolvePackageRootFrom(fileURLToPath(import.meta.url), "@getpaseo/server");
}

function resolvePackageRootFrom(startPath: string, packageName: string): string | null {
  let currentDir = path.dirname(startPath);

  while (true) {
    const packageJsonPath = path.join(currentDir, "package.json");
    if (existsSync(packageJsonPath)) {
      try {
        const packageJson = PackageNameSchema.parse(
          JSON.parse(readFileSync(packageJsonPath, "utf8")),
        );
        if (packageJson.name === packageName) {
          return currentDir;
        }
      } catch {
        return null;
      }
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }
    currentDir = parentDir;
  }
}
