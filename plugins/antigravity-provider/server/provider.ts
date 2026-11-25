import { execCommand } from "@getpaseo/plugin/server";
import { runAcpProvider, type AcpTransformer } from "@getpaseo/plugin/server/acp";
import {
  PROVIDER_PROTOCOL_VERSION,
  type ProviderInstallationLaunch,
  type ProviderRegistration,
} from "@getpaseo/plugin/server/provider";
import { z } from "zod";
import { readHistory } from "./internal/history.js";
import { mapToolCall } from "./tool-calls.js";

const legacySession = z.object({
  version: z.literal(1),
  data: z.object({ conversationId: z.string().min(1) }),
});
const systemPromptCapability = z.object({
  antigravity: z.object({ systemPrompt: z.object({ append: z.literal(true) }) }),
});

const command = ["agy", "acp", "--disable-telemetry"] as const;
const disableAutoUpdate = { AGY_CLI_DISABLE_AUTO_UPDATE: "true" };

// agy 1.5.13 advertises these built-in commands and its invocable skills in one ACP list.
const builtInCommands = new Set([
  "goal",
  "compact",
  "schedule",
  "browser",
  "plan",
  "grill-me",
  "teamwork",
  "learn",
  "boost",
]);

function isOrchestrator(model: string | undefined): boolean {
  return model !== undefined && /^gemini-pro-orchestrator(?:-|$)/.test(model);
}

const antigravity: AcpTransformer = {
  command(entry) {
    return { ...entry, kind: builtInCommands.has(entry.name) ? "command" : "skill" };
  },
  discover(catalog) {
    return {
      ...catalog,
      models: catalog.models.map((model) =>
        isOrchestrator(model.id)
          ? { ...model, thinkingOptions: [], defaultThinkingOptionId: undefined }
          : model,
      ),
    };
  },
  toolCall: mapToolCall,
  sessionOpen({ persistence, systemPrompt, agentMetadata }) {
    // COMPAT(antigravityStreamJson): added in v0.16.2, remove after 2027-11-19.
    const saved = legacySession.safeParse(persistence);
    return {
      sessionId: saved.success ? saved.data.data.conversationId : undefined,
      metadata:
        systemPrompt && systemPromptCapability.safeParse(agentMetadata).success
          ? { antigravity: { systemPrompt: { append: systemPrompt } } }
          : undefined,
    };
  },
  loadHistoryFallback({ nativeSessionId, launch, config }) {
    return readHistory({ conversationId: nativeSessionId, launch, config });
  },
  async configure(change, { apply, catalog, config }) {
    if (change.target === "thinking") {
      const current = catalog();
      // A saved tier can follow a model switch even after agy removes its selector.
      if (
        isOrchestrator(current.defaultModel) &&
        !current.thinkingOptions?.length &&
        !Object.hasOwn(await config.read(), "thought_level")
      ) {
        return "handled";
      }
      return "pass";
    }
    // COMPAT(antigravityLegacyTieredModelId): added in v0.17.0, remove after 2027-06-01.
    if (change.target !== "model" || !change.value) return "pass";
    const requestedModel = change.value;
    const legacyModel = /^(.+)-(minimal|low|medium|high|xhigh)$/.exec(requestedModel);
    if (!legacyModel) return "pass";

    const current = catalog();
    if (
      current.models.some(
        (model) => model.id === requestedModel || model.aliases?.includes(requestedModel),
      )
    ) {
      return "pass";
    }
    const [, baseId, effort] = legacyModel;
    const model =
      current.models.find((candidate) => candidate.id === baseId) ??
      current.models.find((candidate) => candidate.aliases?.includes(baseId));
    if (!model) return "pass";

    // ACP exposes the thinking options for the current model. Switching models
    // can change that list, so check the tier only after the base model is active.
    if (current.defaultModel !== model.id) {
      await apply({ target: "model", value: model.id });
    }
    if (!catalog().thinkingOptions?.some((option) => option.id === effort)) return "pass";
    await apply({ target: "thinking", value: effort });
    return "handled";
  },
};

/** The release `agy --version` reports, or its first line when it names no release. */
async function readAgyVersion(
  launch: ProviderInstallationLaunch,
  signal: AbortSignal,
): Promise<string | undefined> {
  // The launch ends with the `acp` subcommand and its flags; the version comes from the CLI itself.
  const acp = launch.args.indexOf("acp");
  const prefix = acp === -1 ? launch.args : launch.args.slice(0, acp);
  const { stdout } = await execCommand(launch.command, [...prefix, "--version"], {
    env: { ...launch.env, ...disableAutoUpdate },
    timeout: 5000,
    maxBuffer: 8192,
    signal,
  });
  const firstLine = stdout.trim().split("\n")[0]?.trim();
  return /\b\d+\.\d+\.\d+\S*/.exec(stdout)?.[0] ?? (firstLine || undefined);
}

// agy 1.5.14 reads its sign-in from a token file when any of these is set, and from the OS keyring
// otherwise. https://github.com/google-antigravity/antigravity-cli/issues/1336
const sshSessionVariables = ["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY"];

/**
 * Report rows that say whether agy runs in an SSH session, because that decides which sign-in it
 * uses. The report does not wrap, so each row stays short enough to read without scrolling.
 */
function describeSignIn(env: Readonly<Record<string, string>>): string {
  const variable = sshSessionVariables.find((name) => env[name]);
  return variable
    ? `SSH session: yes (${variable})\nSign-in: can differ from agy outside SSH`
    : "SSH session: no\nSign-in: can differ from agy over SSH";
}

export function createAntigravityProvider(): ProviderRegistration {
  const provider = runAcpProvider({
    id: "antigravity",
    label: "Antigravity",
    description: "Antigravity CLI on your host",
    icon: "icon.svg",
    command,
    acpOptions: {
      // agy 1.5.14 lists thinking options for the selected model only, and none for Orchestrator.
      perModelThinkingOptions: true,
      waitForInitialCommands: true,
      loadReplayQuietPeriodMs: 200,
      scopeAnonymousReplayMessageIds: true,
      // COMPAT(antigravityAcpV1DeferredTurn): added in v0.18.0, remove once Antigravity CLI supports ACP v2 state_update.
      deferTurnOnRunningTools: {
        keepsTurnOpen(toolCall) {
          const input = toolCall.input;
          if (typeof input !== "object" || input === null || Array.isArray(input)) return true;
          if (input.IsDaemon === true) return false;

          // agy leaves recurring schedules in progress after registering them.
          const recurringSchedule =
            toolCall.name === "schedule" &&
            typeof input.CronExpression === "string" &&
            input.CronExpression.trim().length > 0;
          return !recurringSchedule;
        },
      },
      autoAcceptMode: {
        mode: {
          id: "full-access",
          label: "Full access",
          description: "Approve tool requests without asking.",
          icon: "ShieldOff",
          colorTier: "dangerous",
        },
        nativeMode: "default",
        default: true,
      },
    },
    transformers: [antigravity],
  });
  const connect: ProviderRegistration["connect"] = async (request) => {
    const [executable, ...args] = command;
    const launch = request.launch ?? {
      command: executable,
      args,
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      ),
    };
    // Connecting probes capabilities, and catalog requests launch another CLI from this same config.
    const connection = await provider.connect({
      ...request,
      launch: { ...launch, env: { ...launch.env, ...disableAutoUpdate } },
    });
    return {
      ...connection,
      send(input) {
        if (input.type !== "session.open") return connection.send(input);
        // The ACP launcher applies session environment after the connection environment.
        return connection.send({
          ...input,
          config: { ...input.config, env: { ...input.config.env, ...disableAutoUpdate } },
        });
      },
    };
  };
  return {
    ...provider,
    connect,
    docsUrl: "https://paseo.sh/docs/supported-providers/antigravity#troubleshooting",
    installation: {
      installUrl: "https://antigravity.google/docs/getting-started?tab=cli",
      updateUrl:
        "https://antigravity.google/docs/cli/troubleshooting#resolve-self-updater-locks-and-failures",
      maintenance: {
        kind: "automatic",
        message:
          "Run Antigravity CLI directly on the host to let it update itself, or follow the updater guide. Paseo disables automatic updates in its CLI connections.",
      },
      async inspect({ launch, signal }) {
        if (!launch?.resolved) return { status: "not_installed" };
        const version = await readAgyVersion(launch, signal);
        return version ? { status: "installed", version } : { status: "installed" };
      },
    },
    async status({ launch }) {
      if (!launch) return { available: false, diagnostic: "Install Antigravity 1.5.0 or later." };
      // A sign-in problem can stop ACP from starting, so the report says which sign-in either way.
      const signIn = describeSignIn(launch.env);
      try {
        const connection = await connect({
          launch,
          versions: [PROVIDER_PROTOCOL_VERSION],
          capabilities: [],
        });
        await connection.close();
        return { available: true, diagnostic: signIn };
      } catch {
        return {
          available: false,
          diagnostic: `Antigravity ACP did not start. Install Antigravity 1.5.0 or later. If you override the command, include the acp subcommand.\n${signIn}`,
        };
      }
    },
  };
}
