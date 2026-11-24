import { RESIDENT_AGENT_LABEL, SIDE_CHAT_LABEL } from "@getpaseo/protocol/agent-labels";
import { describe, expect, it, vi } from "vitest";
import { discardSideChatIfEmpty, resolveCloseAgentTabPolicy } from "./close-tab-policy";

describe("resolveCloseAgentTabPolicy", () => {
  it("archives root agents when their tab closes", () => {
    expect(resolveCloseAgentTabPolicy({ parentAgentId: null })).toEqual({
      kind: "archive-on-close",
    });
  });

  it("keeps subagent tab close layout-only", () => {
    expect(resolveCloseAgentTabPolicy({ parentAgentId: "parent-agent" })).toEqual({
      kind: "layout-only",
    });
  });

  it("keeps a parentless specialist alive when its tab closes", () => {
    expect(
      resolveCloseAgentTabPolicy({
        parentAgentId: null,
        labels: { [RESIDENT_AGENT_LABEL]: "true" },
      }),
    ).toEqual({ kind: "layout-only" });
  });

  it("preserves the existing archive fallback when the agent is missing", () => {
    expect(resolveCloseAgentTabPolicy(null)).toEqual({ kind: "archive-on-close" });
    expect(resolveCloseAgentTabPolicy(undefined)).toEqual({ kind: "archive-on-close" });
  });
});

it("closes a side-chat tab without archiving and only asks the daemon to discard apparent empties", async () => {
  expect(
    resolveCloseAgentTabPolicy({ parentAgentId: null, labels: { [SIDE_CHAT_LABEL]: "true" } }),
  ).toEqual({ kind: "side-chat" });
  const deleteAgent = vi.fn().mockRejectedValue(
    Object.assign(new Error("First question won"), {
      code: "side_chat_not_empty",
    }),
  );
  const options = { client: { deleteAgent }, supportsSideChat: true };
  await discardSideChatIfEmpty({
    ...options,
    agent: { id: "side", lastUserMessageAt: new Date() },
  });
  expect(deleteAgent).not.toHaveBeenCalled();
  await expect(
    discardSideChatIfEmpty({ ...options, agent: { id: "side", lastUserMessageAt: null } }),
  ).resolves.toBeUndefined();
  expect(deleteAgent).toHaveBeenCalledExactlyOnceWith("side", { onlyIfEmptySideChat: true });
});
