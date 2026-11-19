import type {
  AgentHistorySearchScope,
  AgentSnapshotPayload,
  ProjectPlacementPayload,
} from "@getpaseo/protocol/messages";
import { scoreTextFields } from "@getpaseo/protocol/search/text-match";

export interface AgentHistorySearchCandidate {
  agent: AgentSnapshotPayload;
  project: ProjectPlacementPayload;
}

/** Search the names people recall, never an incomplete subset of transcripts. */
export function matchesAgentHistoryQuery(
  query: string,
  { agent, project }: AgentHistorySearchCandidate,
  scope: AgentHistorySearchScope = "all",
): boolean {
  const title = agent.title ?? "";
  if (scope === "agent") {
    return scoreTextFields(query, [title], { typoTolerant: true }) !== null;
  }

  const checkoutPath = project.checkout.worktreeRoot || project.checkout.cwd || "";
  const dirBasename = checkoutPath.split(/[\\/]/).findLast(Boolean) ?? "";
  const workspaceFields = [
    project.workspaceName ?? "",
    project.checkout.currentBranch ?? "",
    dirBasename,
  ];
  const fields =
    scope === "workspace" ? workspaceFields : [...workspaceFields, title, project.projectName];
  return scoreTextFields(query, fields, { typoTolerant: true }) !== null;
}
