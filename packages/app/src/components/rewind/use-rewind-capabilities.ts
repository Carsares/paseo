import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { AgentCapabilityFlags } from "@getpaseo/protocol/agent-types";

export type RewindMode = "conversation" | "files" | "both";

export interface RewindMenuItem {
  mode: RewindMode;
  label: string;
  testID: string;
}

export interface RewindMenuLabels {
  conversation: string;
  files: string;
  both: string;
}

export interface RewindCheckpointActions {
  canRewindFiles?: boolean;
  canRewindBoth?: boolean;
}

const DEFAULT_REWIND_MENU_LABELS: RewindMenuLabels = {
  conversation: "Rewind conversation",
  files: "Rewind files",
  both: "Rewind conversation and files",
};

export function isRewindableMessage(messageId: string | undefined, text: string): boolean {
  return Boolean(messageId) && text.trim().length > 0;
}

export function resolveRewindMenuItems(
  capabilities:
    | Pick<
        AgentCapabilityFlags,
        "supportsRewindConversation" | "supportsRewindFiles" | "supportsRewindBoth"
      >
    | null
    | undefined,
  checkpoint?: RewindCheckpointActions,
  labelsInput?: Partial<RewindMenuLabels>,
): RewindMenuItem[] {
  const labels = { ...DEFAULT_REWIND_MENU_LABELS, ...labelsInput };
  const items: RewindMenuItem[] = [];
  if (capabilities?.supportsRewindConversation) {
    items.push({
      mode: "conversation",
      label: labels.conversation,
      testID: "rewind-menu-conversation",
    });
  }
  if (checkpoint?.canRewindFiles) {
    items.push({
      mode: "files",
      label: labels.files,
      testID: "rewind-menu-files",
    });
  }
  if (checkpoint?.canRewindBoth && capabilities?.supportsRewindConversation) {
    items.push({
      mode: "both",
      label: labels.both,
      testID: "rewind-menu-both",
    });
  }
  return items;
}

export function useRewindMenuItems(
  capabilities: Parameters<typeof resolveRewindMenuItems>[0],
  checkpoint?: RewindCheckpointActions,
): RewindMenuItem[] {
  const { t } = useTranslation();
  return useMemo(
    () =>
      resolveRewindMenuItems(capabilities, checkpoint, {
        conversation: t("rewind.actions.conversation"),
        files: t("rewind.actions.files"),
        both: t("rewind.actions.both"),
      }),
    [capabilities, checkpoint, t],
  );
}
