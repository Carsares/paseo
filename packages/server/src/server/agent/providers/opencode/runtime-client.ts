import type { Logger } from "pino";
import type {
  AgentClient,
  AgentClientInstallation,
  AgentSessionConfig,
  AgentLaunchContext,
  AgentCreateSessionOptions,
  AgentResumeSessionOptions,
  AgentPersistenceHandle,
  FetchCatalogOptions,
  ProviderRefreshContext,
  ListImportableSessionsOptions,
  ImportProviderSessionInput,
  ImportProviderSessionContext,
} from "../../agent-sdk-types.js";
import {
  createProviderEnvSpec,
  resolveProviderLaunch,
  type ProviderRuntimeSettings,
} from "../../provider-launch-config.js";
import { execCommand } from "../../../../utils/spawn.js";
import { OpenCodeAgentClient } from "../opencode-agent.js";
import type { OpenCodeV2AgentClient } from "./v2/agent.js";
import { resolveExternalOpenCodeServer } from "./v2/external-server.js";
import { withOpenCodeRuntimeNotice } from "./runtime-notice.js";
import { selectOpenCodeService, type OpenCodeServiceSelection } from "./v2/service-selection.js";
import { createCliInstallation } from "../cli-installation.js";

const OPENCODE_INSTALL_URL = "https://opencode.ai/docs/";
const OPENCODE_EXTERNAL_MAINTENANCE = {
  kind: "external",
  message: "Update OpenCode on the host that manages the connected server.",
} as const;
// Agents share a long-lived OpenCode server, and this client keeps the protocol it chose for the
// version it found. Neither changes until the daemon restarts.
const OPENCODE_UPDATED =
  "OpenCode is updated. Restart the Paseo daemon to use the new version; agents keep the running OpenCode server until then.";

// Keep the minimum aligned with the SDK and binary exercised by CI.
const MINIMUM_V2: readonly [number, number] = [0, 10];
const VERSION_PATTERN = /^(?:opencode\s+)?v?(\d+)\.(\d+)\.(\d+)(?:[-+][\w.-]+)?$/i;

export function openCodeMajorVersion(output: string): 1 | 2 {
  const version = output.trim().match(VERSION_PATTERN);
  if (!version) return 1;
  if (version[1] === "1") return 1;
  if (version[1] === "2") {
    const [minimumMinor, minimumPatch] = MINIMUM_V2;
    const minor = Number(version[2]);
    const patch = Number(version[3]);
    if (minor < minimumMinor || (minor === minimumMinor && patch < minimumPatch))
      throw new Error(
        `OpenCode ${version[1]}.${version[2]}.${version[3]} is too old for this Paseo integration. Update OpenCode to 2.${minimumMinor}.${minimumPatch} or newer, then refresh the provider in Paseo.`,
      );
    return 2;
  }
  throw new Error(
    `Unsupported OpenCode major version ${version[1]}; supported versions are 1 and 2`,
  );
}

export type OpenCodeRuntimeClientOptions = NonNullable<
  ConstructorParameters<typeof OpenCodeAgentClient>[2]
>;

// Selection belongs to the configured client, which provider reload replaces.
export class OpenCodeRuntimeClient implements AgentClient {
  readonly provider = "opencode";
  readonly capabilities;
  readonly resolveCreateConfig;
  readonly isCreateConfigUnattended;
  private selected: Promise<OpenCodeAgentClient | OpenCodeV2AgentClient> | null = null;
  private runtimeService?: OpenCodeServiceSelection;
  private legacySelected = false;
  private readonly legacy: OpenCodeAgentClient;
  readonly installation: AgentClientInstallation;
  constructor(
    private readonly logger: Logger,
    private readonly settings?: ProviderRuntimeSettings,
    private readonly options: OpenCodeRuntimeClientOptions = {},
  ) {
    this.legacy = new OpenCodeAgentClient(logger, settings, options);
    this.capabilities = this.legacy.capabilities;
    this.resolveCreateConfig = this.legacy.resolveCreateConfig;
    this.isCreateConfigUnattended = this.legacy.isCreateConfigUnattended;
    // OpenCode's update source depends on its channel and install method, which only the binary
    // knows, so it has no update check here.
    const local = createCliInstallation({
      name: "OpenCode",
      defaultBinary: "opencode",
      runtimeSettings: settings,
      installUrl: OPENCODE_INSTALL_URL,
      versionLabel: (output) =>
        output
          .split("\n")[0]
          ?.trim()
          .replace(/^opencode\s+/i, "") || undefined,
      update: { args: ["upgrade"], successMessage: OPENCODE_UPDATED },
    });
    const inspectionSnapshot: NonNullable<AgentClientInstallation["inspectionSnapshot"]> = {
      cacheKey: () => this.runtimeService?.kind ?? "unselected",
      read: async (context) => {
        if (await this.hasExternalInstallation(context.signal)) {
          return {
            inspection: { status: "installed" },
            maintenance: OPENCODE_EXTERNAL_MAINTENANCE,
          };
        }
        // Keep this choice even if the runtime is selected while the local version is read.
        const [inspection, maintenance] = await Promise.all([
          local.inspect!(context),
          local.getMaintenance?.(context),
        ]);
        return { inspection, maintenance };
      },
    };
    this.installation = {
      ...local,
      updateUrl: OPENCODE_INSTALL_URL,
      getMaintenance: async (context) =>
        (await this.hasExternalInstallation(context.signal))
          ? OPENCODE_EXTERNAL_MAINTENANCE
          : local.getMaintenance?.(context),
      inspect: async (context) => (await inspectionSnapshot.read(context)).inspection,
      inspectionSnapshot,
      update: async (context) => {
        if (await this.hasExternalInstallation(context.signal)) {
          return { status: "failed", message: OPENCODE_EXTERNAL_MAINTENANCE.message };
        }
        return local.update!(context);
      },
    };
  }
  private async hasExternalInstallation(signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted();
    // Installation responses never include server URLs or authentication details.
    const selection = await this.effectiveService().catch(() => {
      throw new Error("Could not determine which OpenCode server manages this installation.");
    });
    signal.throwIfAborted();
    return selection.kind !== "owned";
  }
  private selectService() {
    return selectOpenCodeService({
      explicit: resolveExternalOpenCodeServer({ ...globalThis.process.env, ...this.settings?.env }),
      env: this.settings?.env,
    });
  }
  private async effectiveService(): Promise<OpenCodeServiceSelection> {
    if (this.runtimeService) return this.runtimeService;
    const discovered = await this.selectService();
    return this.runtimeService ?? discovered;
  }
  private client(): Promise<OpenCodeAgentClient | OpenCodeV2AgentClient> {
    this.selected ??= (async () => {
      const selection = await this.effectiveService();
      if (selection.kind !== "owned") {
        const { OpenCodeV2AgentClient } = await import("./v2/agent.js");
        const client = new OpenCodeV2AgentClient({
          logger: this.logger,
          settings: this.settings,
          managedProcesses: this.options.managedProcesses,
          bridge: this.options.bridge,
          selection,
        });
        this.runtimeService = selection;
        return client;
      }
      let output: string;
      try {
        const launch = await resolveProviderLaunch({
          commandConfig: this.settings?.command,
          defaultBinary: "opencode",
        });
        const result = await execCommand(launch.command, [...launch.args, "--version"], {
          ...createProviderEnvSpec({ runtimeSettings: this.settings }),
          timeout: 5_000,
        });
        output = result.stdout;
      } catch {
        // Version discovery is additive: legacy wrappers need not support --version.
        this.selected = null;
        this.runtimeService = selection;
        this.legacySelected = true;
        return this.legacy;
      }
      if (!VERSION_PATTERN.test(output.trim())) this.selected = null;
      if (openCodeMajorVersion(output) === 1) {
        this.runtimeService = selection;
        this.legacySelected = true;
        return this.legacy;
      }
      const { OpenCodeV2AgentClient } = await import("./v2/agent.js");
      const client = new OpenCodeV2AgentClient({
        logger: this.logger,
        settings: this.settings,
        managedProcesses: this.options.managedProcesses,
        bridge: this.options.bridge,
        selection,
      });
      this.runtimeService = selection;
      return client;
    })().catch((error: unknown) => {
      // A failed probe must not poison refresh after the user updates the binary.
      this.selected = null;
      throw error;
    });
    return this.selected;
  }
  async isAvailable() {
    const selection = await this.effectiveService();
    if (selection.kind !== "owned") return true;
    return this.legacy.isAvailable();
  }
  async getDiagnostic() {
    const selection = await this.effectiveService();
    if (selection.kind !== "owned")
      return { diagnostic: `OpenCode server: ${selection.server.url}` };
    return this.legacy.getDiagnostic();
  }
  async createSession(
    config: AgentSessionConfig,
    launch?: AgentLaunchContext,
    options?: AgentCreateSessionOptions,
  ) {
    const client = await this.client();
    const session = await client.createSession(config, launch, options);
    return client === this.legacy ? session : withOpenCodeRuntimeNotice(session, 2);
  }
  async resumeSession(
    handle: AgentPersistenceHandle,
    config?: Partial<AgentSessionConfig>,
    launch?: AgentLaunchContext,
    options?: AgentResumeSessionOptions,
  ) {
    const client = await this.client();
    const session = await client.resumeSession(handle, config, launch, options);
    return client === this.legacy ? session : withOpenCodeRuntimeNotice(session, 2, handle);
  }
  async fetchCatalog(options: FetchCatalogOptions, context?: ProviderRefreshContext) {
    if (options.force) await this.reprobeLegacySelection();
    return (await this.client()).fetchCatalog(options, context);
  }
  // Updating the binary does not change provider config, so the client survives it. A forced
  // refresh re-probes a v1 pick so a 1.x to 2.x update takes effect without a daemon restart.
  // A v2 pick owns live sessions and stays.
  private async reprobeLegacySelection() {
    const current = this.selected;
    if (!current) return;
    const client = await current.catch(() => null);
    if (client === this.legacy && this.selected === current) this.selected = null;
  }
  async listCommands(config: AgentSessionConfig) {
    return (await this.client()).listCommands(config);
  }
  async listControls(config: AgentSessionConfig) {
    return (await this.client()).listControls(config);
  }
  async listImportableSessions(options?: ListImportableSessionsOptions) {
    return (await this.client()).listImportableSessions(options);
  }
  async importSession(input: ImportProviderSessionInput, context: ImportProviderSessionContext) {
    const client = await this.client();
    const imported = await client.importSession(input, context);
    return client === this.legacy
      ? imported
      : { ...imported, session: withOpenCodeRuntimeNotice(imported.session, 2) };
  }
  async archiveNativeSession(handle: AgentPersistenceHandle) {
    const client = await this.client();
    if (client instanceof OpenCodeAgentClient) await client.archiveNativeSession(handle);
  }
  async unarchiveNativeSession(handle: AgentPersistenceHandle) {
    const client = await this.client();
    if (client instanceof OpenCodeAgentClient) await client.unarchiveNativeSession(handle);
  }
  async shutdown() {
    const selected = await this.selected?.catch(() => null);
    if (this.legacySelected) await this.legacy.shutdown();
    if (selected && selected !== this.legacy) await selected.shutdown();
  }
}
