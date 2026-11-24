import type { CheckoutGitRebaseStep } from "@getpaseo/protocol/messages";

export const REBASE_ACTIONS = ["pick", "reword", "squash", "fixup", "drop"] as const;
export type PlanAction = (typeof REBASE_ACTIONS)[number];

export interface PlanRow {
  sha: string;
  subject: string;
  type: PlanAction;
  message: string;
}

export function createPlanRows(entries: readonly Pick<PlanRow, "sha" | "subject">[]): PlanRow[] {
  return entries.map((entry) => ({ ...entry, type: "pick", message: "" }));
}

export type PlanIssue = "emptyPlan" | "invalidCommit" | "missingMessage" | "missingParent";

export function compilePlan(
  rows: readonly PlanRow[],
): { steps: CheckoutGitRebaseStep[]; issue?: never } | { steps?: never; issue: PlanIssue } {
  if (!rows.length) return { issue: "emptyPlan" };
  const steps: CheckoutGitRebaseStep[] = [];
  const seen = new Set<string>();
  let canFold = false;
  for (const row of rows) {
    const { sha, type } = row;
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sha) || seen.has(sha)) {
      return { issue: "invalidCommit" };
    }
    seen.add(sha);
    if ((type === "squash" || type === "fixup") && !canFold) return { issue: "missingParent" };
    if (type === "reword") {
      const message = row.message.trim();
      if (!message) return { issue: "missingMessage" };
      steps.push({ type, sha, message });
    } else {
      steps.push({ type, sha });
    }
    canFold ||= type !== "drop";
  }
  return { steps };
}
