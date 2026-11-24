import {
  SIDE_CHAT_LABEL,
  SIDE_OF_AGENT_ID_LABEL,
  WORKSPACE_ROLE_LABEL,
} from "@getpaseo/protocol/agent-labels";
import { expect, test } from "vitest";
import {
  buildHierarchyAppendSystemPrompt,
  computeAgentDepth,
  computeMaxSubtreeDepth,
  validateCanSpawnChild,
  validateSetAgentParent,
  type HierarchyAgent,
} from "./hierarchy-policy.js";

test("a side chat does not become a hierarchy member or attach to one", () => {
  const main = { id: "main", labels: { [WORKSPACE_ROLE_LABEL]: "main" } };
  const side = {
    id: "side",
    labels: { [SIDE_CHAT_LABEL]: "true", [SIDE_OF_AGENT_ID_LABEL]: main.id },
  };
  const agents = new Map<string, HierarchyAgent>([
    [main.id, main],
    [side.id, side],
  ]);
  const readAgent = (id: string) => agents.get(id);
  const listActiveAgents = () => agents.values();
  expect(computeAgentDepth(side.id, readAgent)).toBe(0);
  expect(computeMaxSubtreeDepth(main.id, listActiveAgents)).toBe(0);
  expect(buildHierarchyAppendSystemPrompt({ agent: side, readAgent, listActiveAgents })).toBe("");
  expect(() => validateCanSpawnChild(side, readAgent)).toThrow("cannot spawn subagents");
  expect(() =>
    validateSetAgentParent({ agent: side, parentAgent: main, readAgent, listActiveAgents }),
  ).toThrow("cannot join the agent hierarchy");
  expect(() =>
    validateSetAgentParent({ agent: main, parentAgent: side, readAgent, listActiveAgents }),
  ).toThrow("cannot join the agent hierarchy");
});
