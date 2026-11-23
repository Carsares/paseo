import {
  RESIDENT_ROLE_MAX_LENGTH,
  RESIDENT_ROLE_SLUG_PATTERN,
} from "@getpaseo/protocol/agent-labels";
import type { AgentProfile } from "@getpaseo/protocol/messages";
import type { ResidentAction } from "./resident-actions";

type Preset = Pick<
  AgentProfile,
  "id" | "name" | "roleSlug" | "residentUrgentReport" | "residentKeepAlive"
>;

export function openResidentForm(action: ResidentAction) {
  let preset: Preset | null = null;
  let role = "";
  let roleSlug = "";
  let urgentReport: boolean | undefined;
  let keepAlive: boolean | undefined;
  let interrupt = false;
  let clearVisibleTimeline = false;
  let phase: "idle" | "pending" | "complete" = "idle";
  let error: string | null = null;
  const listeners = new Set<() => void>();

  function snapshot() {
    const roleInvalid = role.trim().length > RESIDENT_ROLE_MAX_LENGTH;
    const roleSlugInvalid =
      Boolean(roleSlug.trim()) && !RESIDENT_ROLE_SLUG_PATTERN.test(roleSlug.trim());
    return {
      preset,
      role,
      roleSlug,
      roleInvalid,
      roleSlugInvalid,
      urgentReport: urgentReport ?? preset?.residentUrgentReport ?? false,
      keepAlive: keepAlive ?? preset?.residentKeepAlive ?? false,
      interrupt,
      clearVisibleTimeline,
      phase,
      error,
      canSubmit:
        phase === "idle" &&
        !roleInvalid &&
        !roleSlugInvalid &&
        (action !== "create" || preset !== null),
    };
  }

  let state = snapshot();
  function publish() {
    state = snapshot();
    for (const listener of listeners) listener();
  }
  function edit<T>(update: (value: T) => void) {
    return (value: T) => {
      if (phase !== "idle") return;
      update(value);
      error = null;
      publish();
    };
  }

  return {
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    selectPreset: edit((value: Preset) => {
      preset = value;
    }),
    setRole: edit((value: string) => {
      role = value;
    }),
    setRoleSlug: edit((value: string) => {
      roleSlug = value;
    }),
    setUrgentReport: edit((value: boolean) => {
      urgentReport = value;
    }),
    setKeepAlive: edit((value: boolean) => {
      keepAlive = value;
    }),
    setInterrupt: edit((value: boolean) => {
      interrupt = value;
    }),
    setClearVisibleTimeline: edit((value: boolean) => {
      clearVisibleTimeline = value;
    }),
    async submit(
      run: (input: {
        profileId?: string;
        overrides: {
          role?: string;
          roleSlug?: string;
          urgentReport?: boolean;
          keepAlive?: boolean;
        };
        reset: { interrupt: boolean; clearVisibleTimeline: boolean };
      }) => Promise<void>,
    ) {
      if (!state.canSubmit) return false;
      phase = "pending";
      error = null;
      publish();
      try {
        await run({
          profileId: preset?.id,
          overrides: {
            role: role.trim() || undefined,
            roleSlug: roleSlug.trim() || undefined,
            urgentReport,
            keepAlive,
          },
          reset: { interrupt, clearVisibleTimeline },
        });
        phase = "complete";
        publish();
        return true;
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause);
        phase = "idle";
        publish();
        return false;
      }
    },
  };
}
