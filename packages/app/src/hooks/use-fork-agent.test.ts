import { describe, expect, it } from "vitest";
import { WORKSPACE_MAIN_ROLE, WORKSPACE_ROLE_LABEL } from "@getpaseo/protocol/agent-labels";
import { normalizeWorkspaceDraftTabSetup } from "@/workspace-tabs/identity";
import { buildNewAgentTabTarget } from "@/workspace-tabs/new-tab";
import { buildMainSubagentTabDraftSetup, buildSubagentDraftSetup } from "./use-fork-agent";

describe("drafts from Main Control", () => {
  const mainAgent = {
    provider: "custom-provider",
    cwd: "/workspace/project",
    currentModeId: "read-only",
    model: "coordinator-model",
    thinkingOptionId: "high",
    options: { customPermissionPolicy: "deny" },
    labels: { [WORKSPACE_ROLE_LABEL]: WORKSPACE_MAIN_ROLE },
  };

  it.each(["pi", undefined])(
    "keeps the parent and leaves coding defaults to the composer (%s)",
    (preferredProvider) => {
      const setup = buildSubagentDraftSetup(mainAgent, "main-1", preferredProvider);

      expect(normalizeWorkspaceDraftTabSetup(setup)).toMatchObject({
        parentAgentId: "main-1",
        provider: preferredProvider ?? mainAgent.provider,
        cwd: mainAgent.cwd,
        modeId: null,
        model: null,
        thinkingOptionId: null,
        providerOptions: {},
      });
    },
  );

  it("gives the button and keyboard shortcut the same parent, while standalone opens a root draft", () => {
    const resolveSubagentSetup = () =>
      buildMainSubagentTabDraftSetup({ mainAgent, mainAgentId: "main-1", preferredProvider: "pi" });
    const draftId = "draft-1";
    const shortcut = buildNewAgentTabTarget({ draftId, resolveSubagentSetup });
    const button = buildNewAgentTabTarget({
      draftId,
      selection: { kind: "agent" },
      resolveSubagentSetup,
    });
    const standalone = buildNewAgentTabTarget({
      draftId,
      selection: { kind: "agent", relationship: "standalone" },
      resolveSubagentSetup,
    });

    expect(shortcut.setup).toMatchObject({ parentAgentId: "main-1", provider: "pi" });
    expect(button).toEqual(shortcut);
    expect(standalone).toEqual({ kind: "draft", draftId });
  });
});
