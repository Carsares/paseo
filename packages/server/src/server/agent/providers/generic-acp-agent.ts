import type { Logger } from "pino";

import { spawnProcess } from "../../../utils/spawn.js";
import { acquireInstallationProcess } from "../provider-installation/installation-activity.js";
import { currentCustomProviderLaunch } from "../scoped-custom-provider-launch.js";
import {
  ACPAgentClient,
  type ACPCatalogModelResolver,
  type ACPClientCapabilityMeta,
  type ACPConfigFeatureOption,
  DEFAULT_ACP_CAPABILITIES,
  type ACPExtensionCommandsParser,
} from "./acp-agent.js";
import {
  formatProviderDiagnostic,
  type DiagnosticEntry,
  toDiagnosticErrorMessage,
  truncateForDiagnostic,
} from "./diagnostic-utils.js";

interface GenericACPAgentClientOptions {
  logger: Logger;
  command: [string, ...string[]];
  env?: Record<string, string>;
  providerId?: string;
  label?: string;
  usageProvider?: string;
  waitForInitialCommands?: boolean;
  initialCommandsWaitTimeoutMs?: number;
  diagnosticPhaseTimeoutMs?: number;
  clientCapabilityMeta?: ACPClientCapabilityMeta;
  configFeatureOptions?: ACPConfigFeatureOption[];
  extensionCommandsParser?: ACPExtensionCommandsParser;
  catalogModelResolver?: ACPCatalogModelResolver;
  now?: () => number;
}

export class GenericACPAgentClient extends ACPAgentClient {
  private readonly command: [string, ...string[]];
  private readonly providerId?: string;
  private readonly label?: string;
  private readonly diagnosticPhaseTimeoutMs?: number;

  constructor(options: GenericACPAgentClientOptions) {
    super({
      provider: "acp",
      configuredProviderId: options.providerId,
      usageProvider: options.usageProvider,
      logger: options.logger,
      runtimeSettings: {
        env: options.env,
      },
      defaultCommand: options.command,
      capabilities: DEFAULT_ACP_CAPABILITIES,
      // ACP agents advertise slash commands with available_commands_update after
      // session/new, so the first listCommands() waits for that batch.
      waitForInitialCommands: options.waitForInitialCommands ?? true,
      initialCommandsWaitTimeoutMs: options.initialCommandsWaitTimeoutMs,
      clientCapabilityMeta: options.clientCapabilityMeta,
      configFeatureOptions: options.configFeatureOptions,
      extensionCommandsParser: options.extensionCommandsParser,
      catalogModelResolver: options.catalogModelResolver,
      now: options.now,
    });

    this.command = options.command;
    this.providerId = options.providerId;
    this.label = options.label;
    this.diagnosticPhaseTimeoutMs = options.diagnosticPhaseTimeoutMs;
  }

  async getDiagnostic(): Promise<{ diagnostic: string }> {
    if (currentCustomProviderLaunch())
      throw new Error("Custom CLI diagnostics require a separate request");
    const providerName = formatProviderName(this.label, this.providerId);
    const entries: DiagnosticEntry[] = [
      { label: "Provider ID", value: this.providerId ?? "unknown" },
      { label: "Configured command", value: this.command.join(" ") },
    ];
    const versionProbe = buildVersionProbeCommand(this.command);

    try {
      const { executable, env } = await this.resolveLauncher();
      let version = "unknown";
      if (executable) {
        try {
          version = (await readLauncherVersion(executable, versionProbe.args, env)) || "unknown";
        } catch (error) {
          version = `error: ${toDiagnosticErrorMessage(error)}`;
        }
      }
      entries.push(
        { label: "Launcher binary", value: versionProbe.command },
        { label: "Resolved path", value: executable ?? "not found" },
        { label: "Version", value: version },
      );
    } catch (error) {
      entries.push({
        label: "Launcher binary",
        value: `error: ${toDiagnosticErrorMessage(error)}`,
      });
    }

    entries.push(
      {
        label: "Version command",
        value: formatCommand(versionProbe.command, versionProbe.args),
      },
      ...(await this.getACPProbeRowsForDiagnostic()),
    );

    return {
      diagnostic: formatProviderDiagnostic(providerName, entries),
    };
  }

  private async getACPProbeRowsForDiagnostic() {
    try {
      return await this.buildACPProbeDiagnosticRows({
        phaseTimeoutMs: this.diagnosticPhaseTimeoutMs,
      });
    } catch (error) {
      return [
        {
          label: "ACP probe",
          value: `error: ${toDiagnosticErrorMessage(error)}`,
        },
      ];
    }
  }
}

function readLauncherVersion(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const cwd = process.cwd();
  const signal = AbortSignal.timeout(5_000);
  const child = acquireInstallationProcess({ family: "acp", keys: [], opaque: true }, () =>
    spawnProcess(command, args, {
      cwd,
      env,
      signal,
      killSignal: "SIGKILL",
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
  return new Promise((resolve, reject) => {
    const collect = (stream: NodeJS.ReadableStream | null) => {
      const chunks: Buffer[] = [];
      let size = 0;
      stream?.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size <= 1024 * 1024) chunks.push(chunk);
        else if (size - chunk.length <= 1024 * 1024) {
          child.kill("SIGKILL");
          reject(new Error("ACP version output exceeded its limit"));
        }
      });
      return () => Buffer.concat(chunks).toString("utf8").trim();
    };
    const stdout = collect(child.stdout);
    const stderr = collect(child.stderr);
    child.once("error", reject);
    child.once("close", (code, exitSignal) => {
      if (code === 0) resolve(stdout() || stderr());
      else {
        reject(
          Object.assign(new Error("ACP version command failed"), {
            code,
            signal: exitSignal,
            stdout: truncateForDiagnostic(stdout()),
            stderr: truncateForDiagnostic(stderr()),
          }),
        );
      }
    });
  });
}

export interface CommandInvocation {
  command: string;
  args: string[];
}

function formatProviderName(label: string | undefined, providerId: string | undefined): string {
  if (label) {
    return `${label} (ACP)`;
  }
  if (providerId) {
    return `${providerId} (ACP)`;
  }
  return "Custom ACP";
}

function formatCommand(command: string, args: string[]): string {
  return [command, ...args].join(" ");
}

export function buildVersionProbeCommand(command: [string, ...string[]]): CommandInvocation {
  const [launcher, ...args] = command;
  if (isPackageRunner(launcher)) {
    return {
      command: launcher,
      args: [...takePackageRunnerPrefix(args), "--version"],
    };
  }

  return {
    command: launcher,
    args: ["--version"],
  };
}

function isPackageRunner(command: string): boolean {
  return ["npx", "bunx", "pnpm", "uvx"].includes(command);
}

function takePackageRunnerPrefix(args: string[]): string[] {
  if (args.length === 0) {
    return [];
  }
  if (args[0] === "dlx") {
    return ["dlx", ...takePackageSpecPrefix(args.slice(1))];
  }
  return takePackageSpecPrefix(args);
}

function takePackageSpecPrefix(args: string[]): string[] {
  const prefix: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    prefix.push(arg);
    if (arg === "--package" || arg === "-p") {
      if (args[index + 1]) {
        prefix.push(args[index + 1]);
        index += 1;
      }
      continue;
    }
    if (!arg.startsWith("-")) {
      break;
    }
  }
  return prefix;
}
