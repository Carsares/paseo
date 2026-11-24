import {
  execFile,
  spawn,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

import {
  collectDescendants,
  createTerminalWorkerProcessInspector,
  type ProcessTableEntry,
} from "../../terminal/terminal-worker-processes.js";
import type { ManagedProcessCommandRunner } from "../managed-processes/managed-processes.js";
import { installationActivity } from "./provider-installation/installation-activity.js";

const CLEANUP_TIMEOUT_MS = 1_000;
const execFileAsync = promisify(execFile);

interface ScopedProviderProcess {
  /** A false result leaves the installation occupied until background cleanup confirms exit. */
  stop(release: () => void): Promise<boolean>;
}

export function supportsScopedProviderProcess(): boolean {
  return process.platform === "darwin" || process.platform === "linux";
}

interface ProcessObservation {
  platform: NodeJS.Platform;
  commandRunner: ManagedProcessCommandRunner;
  kill: (pid: number, signal: NodeJS.Signals | 0) => void;
}

const systemProcessObservation: ProcessObservation = {
  platform: process.platform,
  commandRunner: {
    exec: (command, args) => {
      if (command !== "ps") throw new Error("Unexpected process table command");
      return execFileAsync("/bin/ps", args, {
        env: { LC_ALL: "C" },
        timeout: 250,
        maxBuffer: 8 * 1024 * 1024,
      });
    },
  },
  kill: (pid, signal) => process.kill(pid, signal),
};

function groupIsGone(
  pid: number,
  signal: NodeJS.Signals | 0,
  kill: ProcessObservation["kill"],
): boolean {
  try {
    kill(-pid, signal);
    return false;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ESRCH";
  }
}

interface ObservedProcess extends ProcessTableEntry {
  groupId?: number;
  exited?: boolean;
}

async function listLinuxProcesses(runner: ManagedProcessCommandRunner): Promise<ObservedProcess[]> {
  // A thread-group leader may be defunct while other threads still execute.
  const { stdout } = await runner.exec("ps", [
    "-A",
    "-L",
    "-ww",
    "-o",
    "pid=",
    "-o",
    "lwp=",
    "-o",
    "ppid=",
    "-o",
    "sid=",
    "-o",
    "pgid=",
    "-o",
    "state=",
    "-o",
    "lstart=",
  ]);
  const leaders = new Map<number, ObservedProcess>();
  const seen = new Set<number>();
  const live = new Set<number>();
  for (const line of stdout.trim().split("\n")) {
    const row = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+([a-zA-Z])\s+(\S.{22}\S)\s*$/u.exec(
      line,
    );
    if (!row) throw new Error("Could not read Linux process state");
    const [, pid, threadId, ppid, sessionId, groupId, state, startedAt] = row;
    const id = Number(pid);
    seen.add(id);
    if (!["Z", "X", "x"].includes(state)) live.add(id);
    if (pid === threadId) {
      if (leaders.has(id)) throw new Error("Linux process table repeats a thread leader");
      leaders.set(id, {
        pid: id,
        ppid: Number(ppid),
        sessionId: Number(sessionId),
        groupId: Number(groupId),
        startedAt,
      });
    }
  }
  if (leaders.size !== seen.size) throw new Error("Linux process table omits a thread leader");
  for (const entry of leaders.values()) entry.exited = !live.has(entry.pid);
  return Array.from(leaders.values());
}

function groupHasOnlyExitedMembers(table: ObservedProcess[], groupId: number): boolean {
  const members = table.filter((entry) => entry.groupId === groupId);
  return (
    members.length > 0 && members.every((entry) => entry.sessionId === groupId && entry.exited)
  );
}

/** Observe immediately after spawning with detached: true to retain descendant identities. */
export function watchScopedProviderProcess(
  pid: number,
  observation: ProcessObservation = systemProcessObservation,
): ScopedProviderProcess {
  const linux = observation.platform === "linux";
  if ((!linux && observation.platform !== "darwin") || !Number.isSafeInteger(pid) || pid <= 1) {
    throw new Error("Managed provider discovery is unsupported");
  }
  const { kill, commandRunner } = observation;
  const inspector = createTerminalWorkerProcessInspector({
    platform: observation.platform,
    commandRunner,
  });
  const known = new Map<number, ProcessTableEntry>();
  let rootStartedAt: string | undefined;
  let snapshot: Promise<{ groupOnlyExited: boolean } | undefined> | undefined;
  let groupGone = false;

  const discover = () => {
    snapshot ??= (async () => {
      try {
        const table: ObservedProcess[] = linux
          ? await listLinuxProcesses(commandRunner)
          : await inspector.listProcesses();
        const byPid = new Map(table.map((entry) => [entry.pid, entry]));
        const root = byPid.get(pid);
        rootStartedAt ??= root?.startedAt;
        const sameRoot = !root || root.startedAt === rootStartedAt;
        if (!groupGone && sameRoot) {
          for (const entry of collectDescendants(table, pid)) known.set(entry.pid, entry);
        }
        for (const entry of known.values()) {
          if (byPid.get(entry.pid)?.startedAt !== entry.startedAt) continue;
          for (const child of collectDescendants(table, entry.pid)) known.set(child.pid, child);
        }
        for (const entry of known.values()) {
          const current = byPid.get(entry.pid);
          if (current?.startedAt !== entry.startedAt || current.exited) known.delete(entry.pid);
        }
        return { groupOnlyExited: linux && sameRoot && groupHasOnlyExitedMembers(table, pid) };
      } catch {
        return undefined;
      }
    })().finally(() => {
      snapshot = undefined;
    });
    return snapshot;
  };
  const watch = setInterval(() => void discover(), 40);
  watch.unref();
  void discover();

  async function reap(): Promise<boolean> {
    const inspected = await discover();
    if (!inspected) return false;
    // kill(0) sees unreaped entries. A complete Linux snapshot can establish
    // that the remaining entries in this session's original group have exited.
    groupGone ||= groupIsGone(pid, 0, kill) || inspected.groupOnlyExited;
    for (const entry of known.values()) {
      const state = await inspector.inspect(entry.pid);
      if (
        state.status === "not-found" ||
        (state.status === "alive" && state.snapshot.startedAt !== entry.startedAt)
      ) {
        known.delete(entry.pid);
      } else if (state.status === "alive") {
        try {
          kill(entry.pid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") known.delete(entry.pid);
        }
      }
    }
    return groupGone && known.size === 0;
  }

  let stopping: Promise<boolean> | undefined;
  return {
    stop: (release) => (stopping ??= stop(release)),
  };

  async function stop(release: () => void): Promise<boolean> {
    clearInterval(watch);
    // Take a final live tree snapshot before killing the group and losing parent links.
    // A snapshot started before the initialize reply may predate a late child.
    await snapshot;
    await discover();
    groupGone ||= groupIsGone(pid, "SIGKILL", kill);
    const deadline = performance.now() + CLEANUP_TIMEOUT_MS;
    do {
      if (await reap()) {
        release();
        return true;
      }
      await delay(25);
    } while (performance.now() < deadline);

    // The RPC can finish before the kernel reaps the children. Keep the installation
    // occupied until the group and all identified descendants are confirmed gone.
    const retry = async (): Promise<void> => {
      if (await reap()) release();
      else setTimeout(() => void retry(), 250).unref();
    };
    setTimeout(() => void retry(), 250).unref();
    return false;
  }
}

const managed = new WeakMap<ChildProcess, () => Promise<boolean>>();

export function spawnScopedProviderProcess(options: {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  activity: Parameters<typeof installationActivity.acquireAgent>[0];
}): ChildProcessWithoutNullStreams {
  if (!supportsScopedProviderProcess())
    throw new Error("Managed provider discovery is unsupported");
  const release = installationActivity.acquireAgent(options.activity);
  try {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      shell: false,
      stdio: "pipe",
    });
    const tree = child.pid === undefined ? undefined : watchScopedProviderProcess(child.pid);
    const stop = () => {
      if (tree) return tree.stop(release);
      release();
      return Promise.resolve(true);
    };
    managed.set(child, stop);
    // Start cleanup even if startup failed or the child exited while a descendant holds its pipes.
    child.once("exit", () => void stop());
    child.once("error", () => void stop());
    return child;
  } catch {
    release();
    throw new Error("Managed provider discovery could not start");
  }
}

export function isScopedProviderProcess(child: ChildProcess): boolean {
  return managed.has(child);
}

export function stopScopedProviderProcess(child: ChildProcess): Promise<void> | undefined {
  const stop = managed.get(child);
  if (!stop) return undefined;
  return finishScopedProviderProcess(child, stop);
}

async function finishScopedProviderProcess(
  child: ChildProcess,
  stop: () => Promise<boolean>,
): Promise<void> {
  const stopped = await stop();
  child.stdin?.destroy();
  child.stdout?.destroy();
  child.stderr?.destroy();
  if (!stopped) {
    child.unref();
    throw new Error("Provider discovery process cleanup did not finish");
  }
}
