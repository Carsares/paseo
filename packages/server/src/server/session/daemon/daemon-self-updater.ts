import { getErrorMessage } from "@getpaseo/protocol/error-utils";
import {
  daemonInstallOriginRuntime,
  readInstalledServerTarget,
  resolveNpmGlobalPrefix,
  validateDaemonInstallOrigin,
  type DaemonInstallOriginRuntime,
  type InstalledServerTarget,
} from "./install-origin.js";
import {
  npmGlobalPaseoCli,
  type NpmGlobalPaseoCli,
  type NpmGlobalPaseoInstall,
} from "./npm-global-cli.js";

export type DaemonSelfUpdatePhase = "starting" | "downloading" | "installing" | "complete";

export interface DaemonSelfUpdateResult {
  success: boolean;
  error: string | null;
  newVersion: string | null;
  agentResumeSupported?: true;
}

export interface DaemonSelfUpdateInput {
  daemonVersion: string | null;
  desktopManaged: boolean;
  onProgress: (phase: DaemonSelfUpdatePhase) => void;
  logger: DaemonSelfUpdateLogger;
}

export interface DaemonSelfUpdateLogger {
  error(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
}

export interface DaemonSelfUpdateRuntime {
  npm: NpmGlobalPaseoCli;
  installOrigin: DaemonInstallOriginRuntime;
}

export class DaemonSelfUpdateInProgressError extends Error {
  constructor() {
    super("An update is already in progress");
    this.name = "DaemonSelfUpdateInProgressError";
  }
}

const defaultRuntime: DaemonSelfUpdateRuntime = {
  npm: npmGlobalPaseoCli,
  installOrigin: daemonInstallOriginRuntime,
};

const DESKTOP_MANAGED_UPDATE_ERROR =
  "This daemon is managed by Paseo Desktop. Update Paseo Desktop on the host.";

export class DaemonSelfUpdater {
  private inProgress = false;
  // Kept by the process-wide updater so a retry can also come from a new connection.
  private installedForRestart?: {
    daemonVersion: string | null;
    serverRoot: string;
    install: NpmGlobalPaseoInstall;
    target: InstalledServerTarget;
  };

  constructor(private readonly runtime: DaemonSelfUpdateRuntime = defaultRuntime) {}

  private async readReusableInstallTarget(input: {
    daemonVersion: string | null;
    serverRoot: string | null;
    install: NpmGlobalPaseoInstall;
  }): Promise<InstalledServerTarget | null> {
    const pending = this.installedForRestart;
    if (!pending) return null;

    const { install, serverRoot } = input;
    const matchesOrigin =
      pending.daemonVersion === input.daemonVersion &&
      pending.serverRoot === serverRoot &&
      pending.install.version === install.version &&
      pending.install.packagePath === install.packagePath &&
      pending.install.globalRootPath === install.globalRootPath &&
      !validateDaemonInstallOrigin(install, pending.install.version, this.runtime.installOrigin);
    const target = matchesOrigin ? await readInstalledServerTarget(install, serverRoot) : null;
    if (
      !target ||
      target.identity !== pending.target.identity ||
      target.agentResumeSupported !== pending.target.agentResumeSupported
    ) {
      this.installedForRestart = undefined;
      return null;
    }
    return target;
  }

  async update(input: DaemonSelfUpdateInput): Promise<DaemonSelfUpdateResult> {
    if (input.desktopManaged) {
      return { success: false, error: DESKTOP_MANAGED_UPDATE_ERROR, newVersion: null };
    }

    if (this.inProgress) {
      throw new DaemonSelfUpdateInProgressError();
    }

    this.inProgress = true;
    try {
      input.onProgress("starting");
      const currentServerRoot = this.runtime.installOrigin.resolveCurrentServerPackageRoot();
      const npmOptions = {
        prefix: resolveNpmGlobalPrefix(currentServerRoot),
      };
      const install = await this.runtime.npm.inspect(npmOptions);
      const reusableTarget = await this.readReusableInstallTarget({
        daemonVersion: input.daemonVersion,
        serverRoot: currentServerRoot,
        install,
      });
      if (reusableTarget) {
        input.onProgress("complete");
        return {
          success: true,
          error: null,
          newVersion: install.version,
          ...(reusableTarget.agentResumeSupported ? { agentResumeSupported: true } : {}),
        };
      }
      const unsupportedReason = validateDaemonInstallOrigin(
        install,
        input.daemonVersion,
        this.runtime.installOrigin,
      );
      if (unsupportedReason) {
        return { success: false, error: unsupportedReason, newVersion: null };
      }

      input.onProgress("downloading");
      input.onProgress("installing");

      const result = await this.runtime.npm.installLatest(npmOptions);
      if (result.exitCode !== 0) {
        const error =
          result.stderr.trim() || result.stdout.trim() || `npm exited with code ${result.exitCode}`;
        input.logger.error(
          { exitCode: result.exitCode, stderr: result.stderr },
          "Daemon self-update failed",
        );
        return { success: false, error, newVersion: null };
      }

      const updatedInstall = await this.runtime.npm.inspect(npmOptions).catch((error: unknown) => {
        input.logger.warn({ err: error }, "Unable to read updated npm package version");
        return null;
      });

      const target =
        updatedInstall && (await readInstalledServerTarget(updatedInstall, currentServerRoot));
      if (
        target &&
        currentServerRoot &&
        updatedInstall.packagePath === install.packagePath &&
        updatedInstall.globalRootPath === install.globalRootPath
      ) {
        this.installedForRestart = {
          daemonVersion: input.daemonVersion,
          serverRoot: currentServerRoot,
          install: updatedInstall,
          target,
        };
      }
      input.onProgress("complete");
      return {
        success: true,
        error: null,
        newVersion: updatedInstall?.version ?? null,
        ...(target?.agentResumeSupported ? { agentResumeSupported: true } : {}),
      };
    } catch (error) {
      input.logger.error({ err: error }, "Daemon self-update failed with exception");
      return { success: false, error: getErrorMessage(error), newVersion: null };
    } finally {
      this.inProgress = false;
    }
  }
}

export const daemonSelfUpdater = new DaemonSelfUpdater();
