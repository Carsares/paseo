export const PRIMARY_LAUNCH_ORDER = [
  "agent",
  "terminal",
  "changes",
  "diff",
  "files",
  "browser",
  "pullRequest",
] as const;

export const SUPPORTING_LAUNCH_ORDER = [
  "changes",
  "terminal",
  "diff",
  "files",
  "agent",
  "browser",
  "pullRequest",
] as const;

export type BuiltInLaunchItemId = (typeof PRIMARY_LAUNCH_ORDER)[number] | "standalone-agent";

export function getBuiltInLaunchOrder(
  purpose: "primary" | "supporting",
  showStandaloneAgent = false,
): readonly BuiltInLaunchItemId[] {
  const order = purpose === "supporting" ? SUPPORTING_LAUNCH_ORDER : PRIMARY_LAUNCH_ORDER;
  if (!showStandaloneAgent) return order;
  return order.flatMap((id) => (id === "agent" ? [id, "standalone-agent"] : [id]));
}
