import {
  findInstallationLaunchPath,
  readInstallationActivityKeys,
} from "../provider-installation/installation-target.js";
import type { ProviderUpdateCheck } from "@getpaseo/plugin/server/provider";
import { isAbsolute } from "node:path";
import type { AgentClientInstallation } from "../agent-sdk-types.js";
import {
  checkProviderLaunchAvailable,
  createProviderEnv,
  resolveProviderLaunch,
  type ProviderRuntimeSettings,
} from "../provider-launch-config.js";
import { readCommandVersionOutput } from "./diagnostic-utils.js";

/** The provider's CLI as configured, found on the provider's PATH. */
export interface InstalledCli {
  /** The resolved executable. */
  command: string;
  /** Arguments the configuration puts before any subcommand. */
  args: string[];
  env: Record<string, string> | undefined;
}

export interface CliInstallationOptions {
  /** The product name used in messages, such as "Copilot". */
  name: string;
  defaultBinary: string;
  runtimeSettings: ProviderRuntimeSettings | undefined;
  installUrl: string;
  updateUrl?: string;
  /** Allows host approval for an absolute configured command with no arguments. */
  allowApprovedUpdate?: boolean;
  /** For CLIs that need a filesystem lookup and a guarded version invocation. */
  versionProbe?: { args: readonly string[]; env: Record<string, string> };
  /** The version shown for the CLI's `--version` output. Defaults to its first line. */
  versionLabel?(output: string): string | undefined;
  /** Asks the source the CLI's own updater asks. Left out when that source is not known. */
  checkForUpdates?(input: {
    cli: InstalledCli;
    /** The version `inspect` reported. */
    installedVersion: string | undefined;
    signal: AbortSignal;
  }): Promise<ProviderUpdateCheck>;
  /** Legacy declaration used to give a reason until an updater for this source is available. */
  update?: { args: string[]; successMessage: string };
}

function firstLine(output: string): string | undefined {
  return output.split("\n")[0]?.trim() || undefined;
}

/**
 * The installation contract for a provider whose CLI reports its version with `--version` and,
 * where it can, updates itself with a subcommand.
 */
export function createCliInstallation(options: CliInstallationOptions): AgentClientInstallation {
  const { name, runtimeSettings } = options;
  const versionLabel = options.versionLabel ?? firstLine;
  const versionProbe = options.versionProbe;

  async function resolveCli(): Promise<InstalledCli | null> {
    const launch = await resolveProviderLaunch({
      commandConfig: runtimeSettings?.command,
      defaultBinary: options.defaultBinary,
    });
    // Agents spawn the bare command with the provider's environment, so look on its PATH. The
    // OpenCode 1.x legacy server is the exception: it resolves on the daemon's PATH.
    const env = createProviderEnv({ runtimeSettings, overlays: [versionProbe?.env] });
    const command = versionProbe
      ? await findInstallationLaunchPath(launch.command, { cwd: process.cwd(), env })
      : (await checkProviderLaunchAvailable({ ...launch, env })).resolvedPath;
    if (!command) return null;
    return {
      command,
      args: [...launch.args],
      env: versionProbe ? { ...runtimeSettings?.env, ...versionProbe.env } : runtimeSettings?.env,
    };
  }

  async function readVersion(cli: InstalledCli, signal: AbortSignal): Promise<string | undefined> {
    const output = await readCommandVersionOutput({
      command: cli.command,
      args: [...cli.args, ...(versionProbe?.args ?? ["--version"])],
      env: cli.env,
      signal,
    });
    return versionLabel(output);
  }

  const installation: AgentClientInstallation = {
    installUrl: options.installUrl,
    async getActivityKeys(launch) {
      const configured = await resolveProviderLaunch({
        commandConfig: runtimeSettings?.command,
        defaultBinary: options.defaultBinary,
      });
      const env = createProviderEnv({ runtimeSettings, overlays: [launch?.env] });
      const command = await findInstallationLaunchPath(configured.command, {
        env,
        cwd: launch?.cwd ?? process.cwd(),
      });
      const keys = command ? await readInstallationActivityKeys(command) : [];
      return configured.source === "override" ? [...keys, "opaque"] : keys;
    },
    async inspect({ signal }) {
      const cli = await resolveCli();
      if (!cli) return { status: "not_installed" };
      const version = await readVersion(cli, signal);
      return version ? { status: "installed", version } : { status: "installed" };
    },
  };
  if (options.updateUrl) installation.updateUrl = options.updateUrl;
  if (options.allowApprovedUpdate) {
    installation.resolveApprovedUpdateLaunch = async ({ signal }) => {
      signal.throwIfAborted();
      const launch = await resolveProviderLaunch({
        commandConfig: runtimeSettings?.command,
        defaultBinary: options.defaultBinary,
      });
      if (!isAbsolute(launch.command) || launch.args.length > 0) return null;
      const env = createProviderEnv({ runtimeSettings });
      const command = await findInstallationLaunchPath(launch.command, { cwd: process.cwd(), env });
      signal.throwIfAborted();
      return command;
    };
  }

  const checkForUpdates = options.checkForUpdates;
  if (checkForUpdates) {
    installation.checkForUpdates = async ({ installedVersion, signal }) => {
      const cli = await resolveCli();
      if (!cli) return { status: "unknown", message: `${name} is not installed` };
      return checkForUpdates({ cli, installedVersion, signal });
    };
  }

  const update = options.update;
  if (update) {
    const message = `Update ${name} with the installer or package manager that installed it.`;
    installation.getMaintenance = async () => ({ kind: "manual", message });
    installation.update = async () => ({ status: "failed", message });
  }
  return installation;
}
