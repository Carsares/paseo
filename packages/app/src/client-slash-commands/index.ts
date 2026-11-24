import type { Agent } from "@/stores/session-store";
import type { WorkspaceDraftTabSetup } from "@/workspace-tabs/model";

export type ClientSlashCommandKind = "archive-agent" | "replace-agent-with-draft" | "side-chat";
export type ClientSlashCommandExecution = "immediate" | "insert";

export interface ClientSlashCommand {
  name: string;
  aliases: readonly string[];
  description: string;
  descriptionKey:
    | "composer.clientCommands.archiveAgent"
    | "composer.clientCommands.freshDraft"
    | "composer.clientCommands.sideChat";
  argumentHint: string;
  kind: ClientSlashCommandKind;
  execution: ClientSlashCommandExecution;
  argumentText?: string;
}

export const CLIENT_SLASH_COMMANDS: readonly ClientSlashCommand[] = [
  {
    name: "exit",
    aliases: ["quit", "q"],
    description: "Archive the current agent",
    descriptionKey: "composer.clientCommands.archiveAgent",
    argumentHint: "",
    kind: "archive-agent",
    execution: "immediate",
  },
  {
    name: "clear",
    aliases: ["new"],
    description: "Archive this agent and start a fresh draft",
    descriptionKey: "composer.clientCommands.freshDraft",
    argumentHint: "",
    kind: "replace-agent-with-draft",
    execution: "immediate",
  },
  {
    name: "side",
    aliases: ["btw"],
    description: "Start a side chat",
    descriptionKey: "composer.clientCommands.sideChat",
    argumentHint: "",
    kind: "side-chat",
    execution: "immediate",
  },
];

export function availableClientSlashCommands(input: {
  allowSideChat?: boolean;
  providerCommands?: readonly { name: string; aliases?: readonly string[] }[];
  pluginCommands?: readonly { name: string }[];
}): readonly ClientSlashCommand[] {
  const claimed = new Set((input.pluginCommands ?? []).map(({ name }) => name));
  for (const { name, aliases } of input.providerCommands ?? []) {
    claimed.add(name);
    for (const alias of aliases ?? []) claimed.add(alias);
  }
  return CLIENT_SLASH_COMMANDS.flatMap((command) => {
    if (command.kind !== "side-chat") return [command];
    if (!input.allowSideChat) return [];
    const tokens = [command.name, ...command.aliases];
    const name = tokens.find((token) => !claimed.has(token));
    if (!name) return [];
    return [
      {
        ...command,
        name,
        aliases: tokens.filter((token) => token !== name && !claimed.has(token)),
      },
    ];
  });
}

export function resolveClientSlashCommand(
  input: Parameters<typeof availableClientSlashCommands>[0] & {
    text: string;
    hasAttachments: boolean;
  },
): ClientSlashCommand | null {
  if (input.hasAttachments) {
    return null;
  }

  const match = /^\/([^\s]+)(?:(?:\r\n|\s)([\s\S]*))?$/.exec(input.text.trimStart());
  if (!match) return null;
  const [, token, argumentText = ""] = match;
  if (!token) return null;
  const command = availableClientSlashCommands(input).find(
    ({ name, aliases }) => name === token || aliases.includes(token),
  );
  if (!command) return null;
  if (command.kind === "side-chat") return { ...command, argumentText };
  return argumentText.trim() ? null : command;
}

export function buildDraftAgentSetup(agent: Agent): WorkspaceDraftTabSetup {
  return {
    provider: agent.provider,
    cwd: agent.cwd,
    modeId: agent.currentModeId ?? agent.runtimeInfo?.modeId ?? null,
    model: agent.model ?? agent.runtimeInfo?.model ?? null,
    thinkingOptionId: agent.thinkingOptionId ?? agent.runtimeInfo?.thinkingOptionId ?? null,
    providerOptions: { ...agent.options },
  };
}
