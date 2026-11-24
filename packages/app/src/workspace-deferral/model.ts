export interface WorkspaceDeferralFields {
  snoozedUntil?: string;
  parkedAt?: string;
}

export type WorkspaceDeferralKind = "snoozed" | "parked";

export function workspaceDeferralKind(
  workspace: WorkspaceDeferralFields,
): WorkspaceDeferralKind | null {
  if (workspace.parkedAt) return "parked";
  return workspace.snoozedUntil ? "snoozed" : null;
}

export function isWorkspaceDeferred(workspace: WorkspaceDeferralFields): boolean {
  // The host publishes the clearing update, including when a snooze expires offline.
  return workspaceDeferralKind(workspace) !== null;
}

export function formatDeferralTime(time: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(time),
  );
}
