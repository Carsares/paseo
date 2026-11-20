import { generateMessageId } from "@/types/stream";
import type {
  WorkspaceDraftTabSetup,
  WorkspaceTab,
  WorkspaceTabTarget,
} from "@/workspace-tabs/model";
import type { TerminalProfile } from "@getpaseo/protocol/messages";

export type NewTabSelection =
  | { kind: "target"; target: WorkspaceTab["target"] }
  | { kind: "agent"; relationship?: "standalone" }
  | { kind: "terminal"; profile?: TerminalProfile }
  | { kind: "browser" };

export function buildNewAgentTabTarget(input: {
  draftId: string;
  selection?: Extract<NewTabSelection, { kind: "agent" }>;
  resolveSubagentSetup: () => WorkspaceDraftTabSetup | undefined;
}): Extract<WorkspaceTabTarget, { kind: "draft" }> {
  const { draftId, selection, resolveSubagentSetup } = input;
  const setup = selection?.relationship === "standalone" ? undefined : resolveSubagentSetup();
  return setup ? { kind: "draft", draftId, setup } : { kind: "draft", draftId };
}

export function createNewWorkspaceTab(): WorkspaceTab {
  return {
    tabId: `tab_${generateMessageId()}`,
    target: { kind: "new_tab" },
    createdAt: Date.now(),
  };
}
