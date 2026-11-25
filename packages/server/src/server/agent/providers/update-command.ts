import { spawn, type ChildProcess } from "node:child_process";
import { isAbsolute } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { AgentClientUpdateContext, InstallationUpdateResult } from "../agent-sdk-types.js";
import { createUpdateOutput } from "../provider-installation/update-output.js";

interface UpdateCommand {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd?: string;
  deadlineMs?: number;
  verifyBeforeSpawn?(): Promise<void>;
  requireForegroundExit?: boolean;
}

type CommandResult =
  | { status: "exited"; code: number | null; signal: NodeJS.Signals | null }
  | { status: "failed"; message: string; stopped: boolean };

const UPDATE_DEADLINE_MS = 5 * 60_000;
const UPDATE_STARTED = "Running the verified native updater.\n";

/** Kept for the built-in installation declarations that have no controlled updater yet. */
export function updatedForNewAgents(name: string): string {
  return `${name} update command completed.`;
}

function signalGroup(pid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    return true;
  }
}

async function stopGroup(pid: number | undefined): Promise<boolean> {
  if (pid === undefined || !signalGroup(pid, "SIGTERM")) return true;
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    if (signal === "SIGKILL" && !signalGroup(pid, signal)) return true;
    for (let count = 0; count < 10; count += 1) {
      if (!signalGroup(pid, 0)) return true;
      await delay(50);
    }
  }
  return !signalGroup(pid, 0);
}

async function runNativeCommand(
  {
    command,
    args,
    env,
    cwd = "/",
    deadlineMs = UPDATE_DEADLINE_MS,
    verifyBeforeSpawn,
    requireForegroundExit = false,
  }: UpdateCommand,
  parent: AbortSignal,
  assertCurrent: AgentClientUpdateContext["assertCurrent"],
  onOutput?: (stream: "stdout" | "stderr", text: string) => void,
): Promise<CommandResult> {
  if (!isAbsolute(command) || !["darwin", "linux"].includes(process.platform)) {
    return {
      status: "failed",
      message: "This platform or executable is unsupported for native updates.",
      stopped: true,
    };
  }
  if (parent.aborted) return { status: "failed", message: "Update canceled.", stopped: true };
  if (verifyBeforeSpawn) {
    await verifyBeforeSpawn();
    if (parent.aborted) return { status: "failed", message: "Update canceled.", stopped: true };
  }
  const deadline = AbortSignal.timeout(deadlineMs);
  const signal = AbortSignal.any([parent, deadline]);
  assertCurrent?.();
  let child: ChildProcess;
  try {
    child = spawn(command, args, {
      shell: false,
      cwd,
      env,
      detached: true,
      stdio: onOutput ? ["ignore", "pipe", "pipe"] : "ignore",
    });
  } catch {
    return { status: "failed", message: "Could not start the verified executable.", stopped: true };
  }
  if (onOutput) {
    child.stdout?.setEncoding("utf8").on("data", (text: string) => onOutput("stdout", text));
    child.stderr?.setEncoding("utf8").on("data", (text: string) => onOutput("stderr", text));
  }
  let onAbort: (() => void) | undefined;
  const result = await new Promise<CommandResult>((resolve) => {
    onAbort = () =>
      resolve({
        status: "failed",
        message: parent.aborted ? "Update canceled." : "The native command timed out.",
        stopped: false,
      });
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    child.once("error", () =>
      resolve({
        status: "failed",
        message: "Could not start the verified executable.",
        stopped: true,
      }),
    );
    child.once("close", (code, exitSignal) =>
      resolve({ status: "exited", code, signal: exitSignal }),
    );
  });
  if (onAbort) signal.removeEventListener("abort", onAbort);
  return finishNativeCommand(child, result, requireForegroundExit);
}

async function finishNativeCommand(
  child: ChildProcess,
  result: CommandResult,
  requireForegroundExit: boolean,
): Promise<CommandResult> {
  // The child can exit before descendants close inherited pipes, or a descendant can close them
  // and carry on. Check the group even after a successful exit.
  const foregroundExitConfirmed =
    !requireForegroundExit || confirmedForegroundExit(result, child.pid);
  const stopped = await stopGroup(child.pid);
  child.stdout?.destroy();
  child.stderr?.destroy();
  if (!stopped) {
    return {
      status: "failed",
      message: "Could not confirm the updater process tree stopped.",
      stopped: false,
    };
  }
  if (!foregroundExitConfirmed) {
    return {
      status: "failed",
      message: "Could not confirm the approved updater finished. Check it on the host.",
      stopped: false,
    };
  }
  if (result.status === "failed") return { ...result, stopped: true };
  return result;
}

function confirmedForegroundExit(result: CommandResult, pid: number | undefined): boolean {
  if (result.status === "failed") return result.stopped;
  return result.signal === null && pid !== undefined && !signalGroup(pid, 0);
}

type UpdaterResult =
  | Extract<InstallationUpdateResult, { status: "failed" }>
  | { status: "succeeded"; outcome: "unverified"; reportedCurrentVersion?: string };

export async function runUpdateCommand(
  update: UpdateCommand,
  context: AgentClientUpdateContext,
): Promise<UpdaterResult> {
  context.report({ type: "message", text: UPDATE_STARTED });
  const stdout = createUpdateOutput(context.report);
  const stderr = createUpdateOutput(context.report);
  const result = await runNativeCommand(
    update,
    context.signal,
    context.assertCurrent,
    (stream, text) => {
      (stream === "stdout" ? stdout : stderr).write(text);
    },
  );
  stdout.end();
  stderr.end();
  if (result.status === "failed") {
    if (!result.stopped) context.quarantineActivity?.();
    return { status: "failed", message: result.message };
  }
  if (result.code !== 0) {
    return {
      status: "failed",
      message:
        result.code === null
          ? `The native updater stopped (${result.signal ?? "unknown signal"}).`
          : `The native updater exited with code ${result.code}.`,
    };
  }
  const reportedCurrentVersion = stdout.currentVersion ?? stderr.currentVersion;
  return reportedCurrentVersion === undefined
    ? { status: "succeeded", outcome: "unverified" }
    : { status: "succeeded", outcome: "unverified", reportedCurrentVersion };
}

export async function runApprovedUpdateCommand(
  update: UpdateCommand,
  context: AgentClientUpdateContext,
): Promise<InstallationUpdateResult> {
  context.report({ type: "message", text: UPDATE_STARTED });
  // Approved commands can print arbitrary local values. Discard both streams at spawn.
  const result = await runNativeCommand(
    { ...update, requireForegroundExit: true },
    context.signal,
    context.assertCurrent,
  );
  if (result.status === "failed") {
    if (!result.stopped) context.quarantineActivity?.();
    return { status: "failed", message: result.message };
  }
  return result.code === 0
    ? { status: "succeeded", outcome: "unverified" }
    : { status: "failed", message: "The updater failed." };
}
