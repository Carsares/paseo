import type {
  PluginText,
  PluginButton,
  PluginButtonContext,
  PluginButtonRegistration,
  PluginHeaderButtonContribution,
  PluginComposerPillContribution,
  PluginSelectionButton,
  PluginSelectionButtonContribution,
  PluginSelectionButtonRegistration,
  PluginTimelineSelection,
} from "@getpaseo/plugin/client";
import type { InstalledPlugin } from "../types";
import {
  requireButtonId,
  validateButton,
  validateSelectionButton,
  type ButtonValidation,
  type ResolvedPluginButton,
  type ResolvedPluginButtonBehavior,
} from "./validation";

export type ButtonPlacement = "header" | "composer" | "selection";

export interface RegisteredPluginButton {
  key: number;
  id: string;
  installation: InstalledPlugin;
  placement: ButtonPlacement;
  context: PluginButtonContext;
  button: ResolvedPluginButton;
  pending: boolean;
  open: boolean;
}

function resolveAction(
  behavior: ResolvedPluginButtonBehavior,
  path: readonly string[],
): Extract<ResolvedPluginButtonBehavior, { kind: "action" }> | null {
  if (path.length === 0) return behavior.kind === "action" ? behavior : null;
  if (behavior.kind !== "menu") return null;
  const item = behavior.items.find((entry) => entry.id === path[0]);
  if (!item || item.kind !== "item" || item.visible === false || item.disabled) return null;
  return resolveAction(item.behavior, path.slice(1));
}

export class PluginButtonStore {
  private entries: readonly RegisteredPluginButton[] = [];
  private nextKey = 0;
  private listeners = new Set<() => void>();

  constructor(private validation: ButtonValidation) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): readonly RegisteredPluginButton[] => this.entries;

  addHeaderButton(
    installation: InstalledPlugin,
    input: PluginHeaderButtonContribution<PluginText>,
  ): PluginButtonRegistration<PluginText> {
    return this.add(
      installation,
      input,
      "header",
      { context: "workspace", workspaceId: input.workspaceId.trim() },
      validateButton,
    );
  }

  addComposerPill(
    installation: InstalledPlugin,
    input: PluginComposerPillContribution<PluginText>,
  ): PluginButtonRegistration<PluginText> {
    if (!input.agentId.trim()) throw new Error("Plugin composer pill needs an agent");
    return this.add(
      installation,
      input,
      "composer",
      { context: "agent", workspaceId: input.workspaceId.trim(), agentId: input.agentId.trim() },
      validateButton,
    );
  }

  addSelectionButton(
    installation: InstalledPlugin,
    input: PluginSelectionButtonContribution<PluginText>,
  ): PluginSelectionButtonRegistration<PluginText> {
    const workspaceId = input.workspaceId.trim();
    const agentId = input.agentId === undefined ? undefined : input.agentId.trim();
    if (agentId === "") throw new Error("Plugin selection button needs a non-empty agent");
    return this.add(
      installation,
      input,
      "selection",
      agentId === undefined
        ? { context: "workspace", workspaceId }
        : { context: "agent", workspaceId, agentId },
      validateSelectionButton,
    );
  }

  private add<Button extends PluginButton<PluginText> | PluginSelectionButton<PluginText>>(
    installation: InstalledPlugin,
    input: { id: string; button: Button },
    placement: ButtonPlacement,
    context: PluginButtonContext,
    validate: (
      button: Button,
      validation: ButtonValidation,
      resolve: (text: PluginText) => string,
    ) => ResolvedPluginButton,
  ): { update(patch: Partial<Button>): void; remove(): void } {
    const { signal } = installation.lifetime;
    if (signal.aborted) throw new Error("Plugin has stopped");
    const id = requireButtonId(input.id);
    if (!context.workspaceId.trim()) throw new Error("Plugin button needs a workspace");
    const duplicate = this.entries.some(
      (entry) =>
        entry.installation === installation &&
        entry.placement === placement &&
        entry.id === id &&
        entry.context.workspaceId === context.workspaceId &&
        (entry.context.context === "workspace"
          ? context.context === "workspace"
          : context.context === "agent" && entry.context.agentId === context.agentId),
    );
    if (duplicate) throw new Error(`Duplicate plugin button: ${id}`);
    const key = this.nextKey++;
    let sourceButton = input.button;
    const initialButton = validate(sourceButton, this.validation, installation.i18n.resolve);
    const unsubscribe = installation.i18n.subscribe(() => {
      this.replace(key, {
        button: validate(sourceButton, this.validation, installation.i18n.resolve),
      });
    });
    let active = true;
    const remove = () => {
      if (!active) return;
      active = false;
      signal.removeEventListener("abort", remove);
      unsubscribe();
      const next = this.entries.filter((entry) => entry.key !== key);
      if (next.length !== this.entries.length) this.publish(next);
    };
    signal.addEventListener("abort", remove, { once: true });
    this.publish([
      ...this.entries,
      {
        key,
        id,
        installation,
        placement,
        context,
        button: initialButton,
        pending: false,
        open: false,
      },
    ]);
    return {
      update: (patch) => {
        const entry = this.entries.find((candidate) => candidate.key === key);
        if (!entry) return;
        const nextSource = { ...sourceButton, ...patch };
        const button = validate(nextSource, this.validation, installation.i18n.resolve);
        sourceButton = nextSource;
        const close = !button.visible || button.disabled || patch.behavior !== undefined;
        this.replace(key, { button, open: close ? false : entry.open });
      },
      remove,
    };
  }

  setOpen(key: number, open: boolean): void {
    const entry = this.entries.find((candidate) => candidate.key === key);
    if (!entry) return;
    if (open && (!entry.button.visible || entry.button.disabled || entry.pending)) return;
    this.replace(key, { open });
  }

  async run(
    key: number,
    path: readonly string[] = [],
    selection?: PluginTimelineSelection,
  ): Promise<void> {
    const entry = this.entries.find((candidate) => candidate.key === key);
    if (!entry || !entry.button.visible || entry.button.disabled || entry.pending) return;
    const action = resolveAction(entry.button.behavior, path);
    if (!action) return;
    const invoke = selectAction(action, entry, selection);
    if (!invoke) return;
    this.replace(key, { pending: true });
    try {
      if (!entry.installation.lifetime.signal.aborted) await invoke();
    } finally {
      this.replace(key, { pending: false });
    }
  }

  private replace(
    key: number,
    patch: Partial<Pick<RegisteredPluginButton, "button" | "open" | "pending">>,
  ): void {
    if (!this.entries.some((entry) => entry.key === key)) return;
    this.publish(this.entries.map((entry) => (entry.key === key ? { ...entry, ...patch } : entry)));
  }

  private publish(entries: readonly RegisteredPluginButton[]): void {
    this.entries = entries;
    for (const listener of this.listeners) listener();
  }
}

function selectAction(
  action: Extract<ResolvedPluginButtonBehavior, { kind: "action" }>,
  entry: RegisteredPluginButton,
  selection: PluginTimelineSelection | undefined,
): (() => void | Promise<void>) | null {
  const { withSelection, onPress } = action;
  if (!withSelection) return onPress;
  if (
    !selection ||
    !selectionButtonMatches(
      entry,
      entry.installation.serverId,
      selection.workspaceId,
      selection.agentId,
    )
  )
    return null;
  return () => onPress(selection);
}

export function buttonMatches(
  entry: RegisteredPluginButton,
  serverId: string,
  workspaceId: string,
  agentId: string | null,
): boolean {
  if (
    entry.installation.serverId !== serverId ||
    entry.context.workspaceId !== workspaceId ||
    !entry.button.visible
  )
    return false;
  if (agentId === null) return entry.placement === "header";
  return (
    entry.placement === "composer" &&
    entry.context.context === "agent" &&
    entry.context.agentId === agentId
  );
}

export function selectionButtonMatches(
  entry: RegisteredPluginButton,
  serverId: string,
  workspaceId: string,
  agentId: string,
): boolean {
  return (
    entry.placement === "selection" &&
    entry.installation.serverId === serverId &&
    entry.context.workspaceId === workspaceId &&
    entry.button.visible &&
    (entry.context.context === "workspace" || entry.context.agentId === agentId)
  );
}
