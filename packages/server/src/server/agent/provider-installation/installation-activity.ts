import type { ChildProcess } from "node:child_process";
import {
  acquireProviderAgentFileTicket,
  supportsHostApprovedProviderUpdates,
} from "./installation-target.js";

interface ActivityScope {
  family: string;
  keys: readonly string[];
  opaque?: boolean;
}

interface ActivityLease {
  release(): void;
  /** Pin the installation if updater termination could not be established. */
  quarantine(): void;
}

function conflicts(left: ActivityScope, right: ActivityScope): boolean {
  if (left.opaque || right.opaque) return true;
  if (left.family === right.family && (!left.keys.length || !right.keys.length)) return true;
  return left.keys.some((key) => right.keys.includes(key));
}

/** Admission is synchronous once a scope is known, so neither side can pass the other. */
export class InstallationActivity {
  private readonly agents = new Set<{ scope: ActivityScope }>();
  private readonly updates = new Set<{ scope: ActivityScope }>();

  constructor(private readonly acquireAgentFileTicket?: () => (() => void) | undefined) {}

  acquireUpdate(scope: ActivityScope): ActivityLease {
    if ([...this.agents].some((agent) => conflicts(agent.scope, scope))) {
      throw new Error(
        "This installation is in use by a Paseo agent. Close its runtime before updating.",
      );
    }
    if ([...this.updates].some((update) => conflicts(update.scope, scope))) {
      throw new Error("An update is already in progress for this installation.");
    }
    const update = { scope };
    this.updates.add(update);
    let quarantined = false;
    return {
      release: () => {
        if (!quarantined) this.updates.delete(update);
      },
      quarantine: () => {
        quarantined = true;
      },
    };
  }

  acquireAgent(scope: ActivityScope): () => void {
    if ([...this.updates].some((update) => conflicts(update.scope, scope))) {
      throw new Error(
        "This installation is being updated. Try opening the agent again after the update.",
      );
    }
    const releaseFileTicket = this.acquireAgentFileTicket?.();
    const agent = { scope };
    this.agents.add(agent);
    return () => {
      if (this.agents.delete(agent)) releaseFileTicket?.();
    };
  }
}

/** One coordinator for all provider clients and their runtime processes in this daemon. */
export const installationActivity = new InstallationActivity(() =>
  supportsHostApprovedProviderUpdates() ? acquireProviderAgentFileTicket() : undefined,
);

/** Transfer a synchronous admission check to the lifetime of the actual child. */
export function acquireInstallationProcess<T extends ChildProcess>(
  scope: ActivityScope,
  spawn: () => T,
): T {
  const release = installationActivity.acquireAgent(scope);
  try {
    const child = spawn();
    child.once("close", release);
    return child;
  } catch (error) {
    release();
    throw error;
  }
}
