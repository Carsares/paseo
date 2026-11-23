import { createHash } from "node:crypto";
import {
  AGENT_PROFILE_ID_LABEL,
  AGENT_PROFILE_ID_MAX_LENGTH,
  EXPLICIT_PARENT_REPORTING,
  getResidentRoleFromLabels,
  getResidentRoleSlugFromLabels,
  PARENT_REPORTING_LABEL,
  RESIDENT_AGENT_LABEL,
  RESIDENT_INBOX_BYPASS_LABEL,
  RESIDENT_KEEPALIVE_LABEL,
  RESIDENT_ROLE_LABEL,
  RESIDENT_ROLE_MAX_LENGTH,
  RESIDENT_ROLE_SLUG_PATTERN,
  RESIDENT_SLUG_LABEL,
} from "@getpaseo/protocol/agent-labels";
import type { AgentProfile } from "@getpaseo/protocol/agent-profile";

export interface ResidentOptions {
  profileId?: string;
  role?: string;
  roleSlug?: string;
  urgentReport?: boolean;
  keepAlive?: boolean;
}

type ResidentLabelPatch = Record<string, string | null>;

export const clearResidentLabels: ResidentLabelPatch = {
  [RESIDENT_AGENT_LABEL]: null,
  [RESIDENT_ROLE_LABEL]: null,
  [RESIDENT_SLUG_LABEL]: null,
  [AGENT_PROFILE_ID_LABEL]: null,
  [RESIDENT_INBOX_BYPASS_LABEL]: null,
  [RESIDENT_KEEPALIVE_LABEL]: null,
};

function slugFromRole(role: string): string {
  const slug = role
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (RESIDENT_ROLE_SLUG_PATTERN.test(slug)) return slug;
  return `role-${createHash("sha256").update(role).digest("hex").slice(0, 16)}`;
}

function residentSlug(
  options: ResidentOptions,
  profile: AgentProfile | undefined,
  previous: Record<string, string> | undefined,
  role: string,
): string {
  const explicitSlug = options.roleSlug ?? profile?.roleSlug;
  if (explicitSlug !== undefined) return explicitSlug;
  if (options.role !== undefined || profile)
    return slugFromRole(options.role ?? profile?.id ?? role);
  return getResidentRoleSlugFromLabels(previous) ?? slugFromRole(role);
}

function booleanLabel(value: boolean | undefined, previous: string | undefined): string | null {
  if (value === undefined) return previous ?? null;
  return value ? "true" : null;
}

export function residentLabelPatch(
  options: ResidentOptions,
  profile: AgentProfile | undefined,
  previous: Record<string, string> | undefined,
  fallbackRole: string,
): ResidentLabelPatch {
  const role = (
    options.role ??
    profile?.name ??
    getResidentRoleFromLabels(previous) ??
    fallbackRole
  ).trim();
  if (!role || role.length > RESIDENT_ROLE_MAX_LENGTH) throw new Error("Invalid resident role.");
  const profileId = options.profileId ?? previous?.[AGENT_PROFILE_ID_LABEL];
  if (
    profileId !== undefined &&
    (!profileId.trim() || profileId.length > AGENT_PROFILE_ID_MAX_LENGTH)
  ) {
    throw new Error("Invalid agent profile ID.");
  }
  const slug = residentSlug(options, profile, previous, role);
  if (!RESIDENT_ROLE_SLUG_PATTERN.test(slug)) throw new Error("Invalid resident role slug.");
  const urgent = options.urgentReport ?? profile?.residentUrgentReport;
  const keepAlive = options.keepAlive ?? profile?.residentKeepAlive;
  return {
    [RESIDENT_AGENT_LABEL]: "true",
    [PARENT_REPORTING_LABEL]: EXPLICIT_PARENT_REPORTING,
    [RESIDENT_ROLE_LABEL]: role,
    [RESIDENT_SLUG_LABEL]: slug,
    [AGENT_PROFILE_ID_LABEL]: profileId ?? null,
    [RESIDENT_INBOX_BYPASS_LABEL]: booleanLabel(urgent, previous?.[RESIDENT_INBOX_BYPASS_LABEL]),
    [RESIDENT_KEEPALIVE_LABEL]: booleanLabel(keepAlive, previous?.[RESIDENT_KEEPALIVE_LABEL]),
  };
}

export interface ResidentSpecialist {
  agentId: string;
  role: string;
  roleSlug: string;
}

export function buildResidentSpecialistsPrompt(specialists: readonly ResidentSpecialist[]): string {
  const ordered = specialists.toSorted((a, b) => {
    if (a.roleSlug === b.roleSlug) return 0;
    return a.roleSlug < b.roleSlug ? -1 : 1;
  });
  // Keep every value on the JSON line, even if a role contains Unicode line separators.
  const text = JSON.stringify(ordered).replace(
    /[\u0085\u2028\u2029]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  return `[Workspace Resident Specialists]\n${text}\n[/Workspace Resident Specialists]\n\n`;
}
