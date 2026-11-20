import { readFileSync } from "node:fs";
import { readFile, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { app, ipcMain, powerMonitor } from "electron";
import log from "electron-log/main";
import {
  resolvePaseoHome,
  startDaemonInstance,
  DaemonInstanceError,
  stopDaemonInstance,
  readDaemonInstance,
  waitForDaemonReady,
  isSameDaemonInstance,
  readLocalCredentialForTarget,
  type DaemonInstance,
} from "@getpaseo/server/daemon-control";
import {
  copyAttachmentFileToManagedStorage,
  deleteManagedAttachmentFile,
  garbageCollectManagedAttachmentFiles,
  readManagedFileBase64,
  writeAttachmentBase64,
  writeAttachmentBytes,
} from "../features/attachments.js";
import {
  checkForAppUpdate,
  confirmOfficialUpdateWithoutAgentResume,
  downloadAndInstallUpdate,
  type AppUpdateCheckIntent,
  type AppReleaseChannel,
} from "../features/auto-updater.js";
import type { AppUpdateShutdown } from "../features/app-update-service.js";
import {
  getBundledCliShimPath,
  getCliInstallStatus,
  installCli,
  uninstallCli,
} from "../integrations/cli-install/index.js";
import {
  openLocalTransportSession,
  sendLocalTransportMessage,
  closeLocalTransportSession,
} from "./local-transport.js";
import { createNodeEntrypointInvocation, resolveDaemonRunnerEntrypoint } from "./runtime-paths.js";
import {
  ExternalCliCommandError,
  runExternalCliJsonCommand,
  runExternalCliTextCommand,
} from "./cli/external.js";
import {
  createDesktopSettingsCommandHandlers,
  type DesktopCommandHandler,
} from "../settings/desktop-settings-commands.js";
import type { DesktopSettings } from "../settings/desktop-settings.js";
import { getDesktopSettingsStore } from "../settings/desktop-settings-electron.js";
import { isRunningUnderARM64Translation } from "../system/arm64-translation.js";
import { describeSandbox } from "../diagnostics/sandbox.js";
import { getDesktopAppLogs } from "../diagnostics/app-logs.js";
import { getDesktopUpdaterDiagnostics } from "../diagnostics/updater.js";
import {
  deleteLegacySkillSelection,
  readLegacySkillSelection,
} from "../integrations/legacy-skill-selection.js";
import { tailFile } from "../diagnostics/tail-file.js";

const DAEMON_LOG_FILENAME = "daemon.log";
let ownedLaunch: { home: string; instance: DaemonInstance } | null = null;
let manualUpdateHandoffInProgress = false;
const daemonUpdateStops = new Set<string>();
let daemonLaunchesInProgress = 0;

export function isManualUpdateHandoffInProgress(): boolean {
  return manualUpdateHandoffInProgress;
}

type DesktopDaemonState = "starting" | "running" | "stopped" | "errored";
const DESKTOP_DAEMON_STOP_REASON_VALUES = [
  "manual_ipc",
  "settings",
  "host_remove",
  "quit",
  "quit_preserve_work",
  "app_update",
  "version_mismatch",
  "restart",
] as const;
export type DesktopDaemonStopReason = (typeof DESKTOP_DAEMON_STOP_REASON_VALUES)[number];

const DESKTOP_DAEMON_STOP_REASONS = new Set<string>(DESKTOP_DAEMON_STOP_REASON_VALUES);
const DEFAULT_DESKTOP_DAEMON_STOP_REASON: DesktopDaemonStopReason = "manual_ipc";

export interface DesktopDaemonStatus {
  serverId: string;
  status: DesktopDaemonState;
  listen: string | null;
  hostname: string | null;
  pid: number | null;
  home: string;
  version: string | null;
  desktopManaged: boolean;
  ownedByDesktop: boolean;
  startedAt: string | null;
  error: string | null;
}

interface DesktopDaemonLogs {
  logPath: string;
  contents: string;
}

function parseReleaseChannel(
  args: Record<string, unknown> | undefined,
): AppReleaseChannel | undefined {
  if (args?.releaseChannel === "beta") {
    return "beta";
  }
  if (args?.releaseChannel === "stable") {
    return "stable";
  }
  return undefined;
}

function parseAppUpdateCheckIntent(
  args: Record<string, unknown> | undefined,
): AppUpdateCheckIntent {
  return args?.intent === "manual" ? "manual" : "automatic";
}

function parseDesktopDaemonStopReason(
  args: Record<string, unknown> | undefined,
): DesktopDaemonStopReason {
  const reason = args?.reason;
  if (typeof reason === "string" && DESKTOP_DAEMON_STOP_REASONS.has(reason)) {
    return reason as DesktopDaemonStopReason;
  }
  return DEFAULT_DESKTOP_DAEMON_STOP_REASON;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function getPaseoHome(): string {
  return resolvePaseoHome(process.env);
}

function logFilePath(): string {
  return path.join(getPaseoHome(), DAEMON_LOG_FILENAME);
}

export function isDesktopManagedDaemonRunningSync(): boolean {
  const home = getPaseoHome();
  if (!ownedLaunch || ownedLaunch.home !== home) return false;
  try {
    const lock = JSON.parse(readFileSync(path.join(home, "paseo.pid"), "utf8"));
    return isSameDaemonInstance(lock, ownedLaunch.instance) && isProcessRunning(lock.pid);
  } catch {
    return false;
  }
}

export function isDesktopManagedDaemonPresentSync(): boolean {
  if (isDesktopManagedDaemonRunningSync()) return true;
  try {
    const lock = JSON.parse(readFileSync(path.join(getPaseoHome(), "paseo.pid"), "utf8"));
    return (
      lock?.desktopManaged === true && typeof lock.pid === "number" && isProcessRunning(lock.pid)
    );
  } catch {
    return false;
  }
}

export async function stopDesktopDaemonViaCli(
  reason: DesktopDaemonStopReason = DEFAULT_DESKTOP_DAEMON_STOP_REASON,
  options?: { includePreviousLaunch?: boolean },
): Promise<void> {
  await stopDesktopDaemon(reason, undefined, options);
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (typeof err === "object" && err !== null && "code" in err && err.code === "EPERM") {
      return true;
    }
    return false;
  }
}

function logDesktopDaemonLifecycle(message: string, details?: Record<string, unknown>): void {
  log.info("[desktop daemon]", message, {
    pid: process.pid,
    ...details,
  });
}

function statusFromDaemonProbe(
  payload: Record<string, unknown>,
  home: string,
): DesktopDaemonStatus {
  const local = typeof payload.localDaemon === "string" ? payload.localDaemon : "stopped";
  const processAlive = local === "running" || local === "not_ready";
  let status: DesktopDaemonState = "stopped";
  if (local === "not_ready") status = "starting";
  if (local === "running") status = "running";
  return {
    serverId: typeof payload.serverId === "string" ? payload.serverId : "",
    status,
    listen: typeof payload.listen === "string" ? payload.listen : null,
    hostname:
      status === "running" && typeof payload.hostname === "string" ? payload.hostname : null,
    pid: processAlive && typeof payload.pid === "number" ? payload.pid : null,
    home,
    version: typeof payload.daemonVersion === "string" ? payload.daemonVersion : null,
    desktopManaged: payload.desktopManaged === true,
    startedAt: typeof payload.startedAt === "string" ? payload.startedAt : null,
    ownedByDesktop: Boolean(
      ownedLaunch &&
      ownedLaunch.home === home &&
      payload.pid === ownedLaunch.instance.pid &&
      payload.startedAt === ownedLaunch.instance.startedAt,
    ),
    error: null,
  };
}

function resolveDesktopAppVersion(): string {
  if (app.isPackaged) {
    return app.getVersion();
  }

  try {
    const packageJsonPath = path.join(__dirname, "..", "..", "package.json");
    const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as {
      version?: unknown;
    };
    if (typeof pkg.version === "string" && pkg.version.trim().length > 0) {
      return pkg.version.trim();
    }
  } catch {
    // Fall back to Electron's default version if the package metadata is unavailable.
  }

  return app.getVersion();
}

// ---------------------------------------------------------------------------
// Daemon lifecycle
// ---------------------------------------------------------------------------

export async function resolveDesktopDaemonStatus(): Promise<DesktopDaemonStatus> {
  const home = getPaseoHome();

  try {
    // The app polls this while no local daemon runs. Answer that case in-process,
    // since launching the CLI once per poll keeps spawning processes while idle.
    if (!(await readDaemonInstance(home))) {
      return statusFromDaemonProbe({ localDaemon: "stopped" }, home);
    }

    const payload = (await runExternalCliJsonCommand([
      "daemon",
      "status",
      "--home",
      home,
      "--json",
    ])) as Record<string, unknown>;
    return statusFromDaemonProbe(payload, home);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logDesktopDaemonLifecycle("resolveStatus failed", { error: errorMessage });
    return {
      serverId: "",
      status: "errored",
      listen: null,
      hostname: null,
      pid: null,
      home,
      version: null,
      desktopManaged: false,
      ownedByDesktop: false,
      startedAt: null,
      error: errorMessage,
    };
  }
}

function normalizeVersion(version: string | null): string | null {
  const trimmed = version?.trim();
  if (!trimmed) return null;
  return trimmed.replace(/^v/i, "");
}

function shouldRestartForVersion(current: DesktopDaemonStatus): boolean {
  if (!current.desktopManaged) return false;
  const appVersion = normalizeVersion(resolveDesktopAppVersion());
  const daemonVersion = normalizeVersion(current.version);
  return Boolean(appVersion && daemonVersion && appVersion !== daemonVersion);
}

function assertBuiltInDaemonManagementEnabled(settings: DesktopSettings): void {
  if (!settings.daemon.manageBuiltInDaemon) {
    throw new Error("Built-in daemon management is disabled.");
  }
}

async function runDaemonLaunch(
  launch: () => Promise<DesktopDaemonStatus>,
): Promise<DesktopDaemonStatus> {
  if (daemonUpdateStops.has(getPaseoHome())) {
    throw new Error("The built-in daemon is stopped for an app update.");
  }
  daemonLaunchesInProgress++;
  try {
    return await launch();
  } finally {
    daemonLaunchesInProgress--;
  }
}

async function startDaemon(): Promise<DesktopDaemonStatus> {
  assertBuiltInDaemonManagementEnabled(await getDesktopSettingsStore().get());

  const current = await resolveDesktopDaemonStatus();
  logDesktopDaemonLifecycle("initial status check before start", {
    status: current.status,
    pid: current.pid,
    listen: current.listen,
    serverId: current.serverId || null,
    error: current.error,
    desktopManaged: current.desktopManaged,
  });
  if (current.status === "running" || current.status === "starting") {
    if (shouldRestartForVersion(current)) {
      logDesktopDaemonLifecycle("daemon version mismatch, restarting", {
        appVersion: normalizeVersion(resolveDesktopAppVersion()),
        daemonVersion: normalizeVersion(current.version),
      });
      await stopDesktopDaemon("version_mismatch");
    } else {
      return current;
    }
  }

  try {
    await launchBuiltInDaemon(getPaseoHome());
  } catch (error) {
    if (!(error instanceof DaemonInstanceError && error.code === "DAEMON_NOT_READY")) throw error;
  }
  return resolveDesktopDaemonStatus();
}

async function launchBuiltInDaemon(home: string): Promise<void> {
  const invocation = createNodeEntrypointInvocation({
    entrypoint: resolveDaemonRunnerEntrypoint(),
    argvMode: "node-script",
    args: [],
    baseEnv: process.env,
  });
  await startDaemonInstance({
    home,
    timeoutMs: 30_000,
    ...invocation,
    env: { ...invocation.env, PASEO_CLI: getBundledCliShimPath() },
    mode: "managed",
    desktopManaged: true,
    onAcquired: (instance) => {
      ownedLaunch = { home, instance };
    },
  });
}

async function readRecoveryMarkerIdentity(markerPath: string): Promise<string | null> {
  try {
    const { dev, ino } = await stat(markerPath, { bigint: true });
    return `${dev}:${ino}`;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

export function prepareBuiltInDaemonForUpdate(): Promise<AppUpdateShutdown>;
export function prepareBuiltInDaemonForUpdate(
  policy: "stop" | "keep" | "defer",
): Promise<AppUpdateShutdown | false>;
export async function prepareBuiltInDaemonForUpdate(
  policy: "stop" | "keep" | "defer" = "stop",
): Promise<AppUpdateShutdown | false> {
  const home = getPaseoHome();
  return withDaemonUpdateLock(home, async () => {
    const instance = await readDaemonInstance(home);
    if (instance?.desktopManaged) {
      if (policy === "defer") return false;
      if (policy === "keep") return holdDaemonLaunchForUpdate(home, instance);
      const shutdown = await captureDaemonUpdateShutdown(home, instance);
      if (shutdown) return shutdown;
    }
    return holdDaemonLaunchForUpdate(home);
  });
}

function holdDaemonLaunchForUpdate(home: string, retained?: DaemonInstance): AppUpdateShutdown {
  return {
    async beforeHandoff() {
      const current = await readDaemonInstance(home);
      if (current?.desktopManaged && (!retained || !isSameDaemonInstance(retained, current))) {
        throw new Error("A daemon restarted before the update.");
      }
    },
    async restore() {
      daemonUpdateStops.delete(home);
    },
  };
}

async function withDaemonUpdateLock<T extends AppUpdateShutdown | false>(
  home: string,
  prepare: () => Promise<T>,
): Promise<T> {
  if (daemonUpdateStops.has(home) || daemonLaunchesInProgress > 0) {
    throw new Error("The built-in daemon is busy. Retry the update in a moment.");
  }
  daemonUpdateStops.add(home);
  let shutdown: T | undefined;
  try {
    shutdown = await prepare();
    return shutdown;
  } finally {
    if (!shutdown) daemonUpdateStops.delete(home);
  }
}

async function captureDaemonUpdateShutdown(
  home: string,
  instance: DaemonInstance,
): Promise<AppUpdateShutdown | undefined> {
  const markerPath = path.join(home, "restart-recovery-once.json");
  // A forced stop replaces the canonical marker. An update must not consume
  // recovery already requested by another operation.
  if (await readRecoveryMarkerIdentity(markerPath)) {
    throw new Error("An agent recovery record is pending. Retry the update after recovery.");
  }
  const stopped = await stopCapturedDaemon({
    home,
    instance,
    reason: "app_update",
    keepTerminals: keepsTerminalsOnStop("app_update", process.platform),
    resumeAgents: true,
  });
  if (stopped.action !== "stopped") return undefined;
  if (ownedLaunch?.home === home && isSameDaemonInstance(ownedLaunch.instance, instance)) {
    ownedLaunch = null;
  }
  const markerAfterStop = await (
    stopped.requestedAgentResume ? readRecoveryMarkerIdentity(markerPath) : Promise.resolve(null)
  ).then(
    (identity) => ({ identity, error: null }),
    (error: unknown) => ({
      identity: null,
      error: new Error("Could not read update recovery record.", { cause: error }),
    }),
  );
  let rollbackMarker: Buffer | undefined;
  async function preserveForNextLaunch(): Promise<void> {
    if (!rollbackMarker) return;
    // Another shutdown may have recorded newer intent. Never overwrite it.
    try {
      await writeFile(markerPath, rollbackMarker, { flag: "wx" });
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
  }
  return {
    preserveForNextLaunch,
    async beforeHandoff() {
      if (markerAfterStop.error) throw markerAfterStop.error;
      if (await readDaemonInstance(home)) throw new Error("A daemon restarted before the update.");
      const marker = markerAfterStop.identity;
      if (!marker) {
        if (stopped.requestedAgentResume) throw new Error("Daemon recovery record is missing.");
        return;
      }
      const contents = await readFile(markerPath);
      if (
        (await readRecoveryMarkerIdentity(markerPath)) !== marker ||
        (await readDaemonInstance(home))
      ) {
        throw new Error("Daemon recovery changed before the update.");
      }
      // Only the old version may consume the one-shot record for this stop.
      await unlink(markerPath);
      rollbackMarker = contents;
    },
    async restore() {
      try {
        const running = await readDaemonInstance(home);
        if (running && !running.desktopManaged) throw new Error("A different daemon is running.");
        if (!running) {
          await preserveForNextLaunch();
          await launchBuiltInDaemon(home);
        }
        const current = await waitForDaemonReady(home, {
          timeoutMs: 30_000,
          instance: running ?? undefined,
        });
        if (!current.desktopManaged || isSameDaemonInstance(instance, current)) {
          throw new Error("Replacement built-in daemon was not started.");
        }
      } finally {
        daemonUpdateStops.delete(home);
      }
    },
  };
}

function canStopPreviouslyManagedDaemon(
  reason: DesktopDaemonStopReason,
  includePreviousLaunch?: boolean,
): boolean {
  return (
    resumesAgentsOnStop(reason) ||
    reason === "app_update" ||
    (reason === "quit" && includePreviousLaunch === true)
  );
}

export async function stopDesktopDaemon(
  reason: DesktopDaemonStopReason = DEFAULT_DESKTOP_DAEMON_STOP_REASON,
  confirmedInstance?: { pid: number; startedAt: string },
  options?: { includePreviousLaunch?: boolean },
): Promise<DesktopDaemonStatus> {
  const home = getPaseoHome();
  const instance = await readDaemonInstance(home);
  const owned = Boolean(
    instance &&
    ownedLaunch &&
    ownedLaunch.home === home &&
    isSameDaemonInstance(instance, ownedLaunch.instance),
  );
  const explicit =
    reason === "manual_ipc" &&
    confirmedInstance &&
    instance &&
    instance.pid === confirmedInstance.pid &&
    instance.startedAt === confirmedInstance.startedAt;
  if (confirmedInstance && !explicit)
    throw new Error(
      "Daemon changed since confirmation; inspect its current home and PID before stopping it.",
    );
  const resumeAgents = resumesAgentsOnStop(reason);
  const canStopPreviouslyManaged = canStopPreviouslyManagedDaemon(
    reason,
    options?.includePreviousLaunch,
  );
  if (
    !instance ||
    (!owned && !explicit && !(instance.desktopManaged && canStopPreviouslyManaged))
  ) {
    return resolveDesktopDaemonStatus();
  }
  const keepTerminals = keepsTerminalsOnStop(reason, process.platform);
  logDesktopDaemonLifecycle("stopping captured supervisor", {
    reason,
    pid: instance.pid,
    owned,
    keepTerminals,
    resumeAgents,
  });
  await stopCapturedDaemon({ home, instance, reason, keepTerminals, resumeAgents });
  if (owned) ownedLaunch = null;
  return resolveDesktopDaemonStatus();
}

export interface StopCapturedDaemonInput {
  home: string;
  instance: DaemonInstance;
  reason: DesktopDaemonStopReason;
  keepTerminals: boolean;
  resumeAgents?: boolean;
  stopInstance?: typeof stopDaemonInstance;
  runCliJson?: typeof runExternalCliJsonCommand;
  log?: typeof logDesktopDaemonLifecycle;
}

/** Stops the captured supervisor with the requested preservation options it supports. */
export async function stopCapturedDaemon(input: StopCapturedDaemonInput) {
  const stopInstance = input.stopInstance ?? stopDaemonInstance;
  const runCliJson = input.runCliJson ?? runExternalCliJsonCommand;
  const logLifecycle = input.log ?? logDesktopDaemonLifecycle;
  const stop = (keep: boolean, resume: boolean) =>
    stopInstance(input.home, {
      instance: input.instance,
      timeoutMs: 15_000,
      keepTerminals: keep,
      ...(resume ? { resumeAgents: true } : {}),
      requestShutdown: async (ready) => {
        await runCliJson([
          "daemon",
          "stop",
          "--host",
          ready.listen,
          ...(keep ? ["--keep-terminals"] : []),
          ...(resume ? ["--resume-agents"] : []),
          "--json",
        ]);
      },
    });
  let keep = input.keepTerminals;
  let resume = input.resumeAgents ?? false;
  // The CLI rejects unsupported options before sending a shutdown request.
  // Each retry drops one option, so there can be at most two retries.
  while (true) {
    try {
      const result = await stop(keep, resume);
      return { ...result, requestedAgentResume: resume && result.usedLifecycleRpc };
    } catch (error) {
      if (!(error instanceof ExternalCliCommandError)) throw error;
      const version = typeof error.error?.version === "string" ? error.error.version : "unknown";
      const details = { reason: input.reason, pid: input.instance.pid };
      // COMPAT(resumeAgentsOnStop): added after v0.16.0, remove after 2027-05-19.
      if (resume && error.code === "AGENT_RESUME_ON_STOP_UNSUPPORTED") {
        if (input.reason === "quit_preserve_work") throw error;
        logLifecycle(
          `daemon v${version} cannot resume agents on stop; stopping without agent resume`,
          details,
        );
        resume = false;
        continue;
      }
      if (keep && error.code === "TERMINALS_KEEP_UNSUPPORTED") {
        logLifecycle(
          `daemon v${version} cannot keep terminals; stopping it and closing them`,
          details,
        );
        keep = false;
        continue;
      }
      throw error;
    }
  }
}

/**
 * Whether a desktop stop keeps the daemon's terminals running for the daemon that replaces it.
 * Only when one comes straight back (an app update, a version-mismatch restart), and never on
 * Windows: a surviving terminal worker runs Paseo.exe and would lock the install folder the
 * update replaces. Quit, Settings, host removal and manual stops close terminals.
 */
export function keepsTerminalsOnStop(
  reason: DesktopDaemonStopReason,
  platform: NodeJS.Platform,
): boolean {
  if (platform === "win32") return false;
  return reason === "app_update" || reason === "version_mismatch";
}

export function resumesAgentsOnStop(reason: DesktopDaemonStopReason): boolean {
  return reason === "version_mismatch" || reason === "quit_preserve_work";
}

async function restartDaemon(): Promise<DesktopDaemonStatus> {
  await runExternalCliJsonCommand(["daemon", "restart", "--home", getPaseoHome(), "--json"]);
  return resolveDesktopDaemonStatus();
}

function getDaemonLogs(): DesktopDaemonLogs {
  const logPath = logFilePath();
  return {
    logPath,
    contents: tailFile(logPath, 100),
  };
}

async function getCliDaemonStatus(): Promise<string> {
  return await runExternalCliTextCommand(["daemon", "status", "--home", getPaseoHome()]);
}

async function getLocalDaemonVersion(): Promise<{ version: string | null; error: string | null }> {
  const status = await resolveDesktopDaemonStatus();
  if (status.status !== "running") {
    return { version: null, error: "Daemon is not running." };
  }
  return {
    version: status.version,
    error: status.version ? null : "Running daemon did not report a version.",
  };
}

async function resolveRequestedReleaseChannel(
  args: Record<string, unknown> | undefined,
): Promise<AppReleaseChannel> {
  return parseReleaseChannel(args) ?? (await getDesktopSettingsStore().get()).releaseChannel;
}

// ---------------------------------------------------------------------------
// IPC registration
// ---------------------------------------------------------------------------

export function createDaemonCommandHandlers(
  onSettingsChanged?: (settings: DesktopSettings) => void,
  isQuitting: () => boolean = () => false,
): Record<string, DesktopCommandHandler> {
  return {
    ...createDesktopSettingsCommandHandlers({
      settingsStore: getDesktopSettingsStore(),
      onSettingsChanged,
    }),
    desktop_get_runtime_info: () => ({
      appVersion: resolveDesktopAppVersion(),
      runningUnderARM64Translation: isRunningUnderARM64Translation(),
    }),
    desktop_daemon_status: () => resolveDesktopDaemonStatus(),
    desktop_local_credential: async (args) => {
      const instance = await readDaemonInstance(getPaseoHome());
      if (!instance?.desktopManaged || typeof args?.listen !== "string") return null;
      return readLocalCredentialForTarget(getPaseoHome(), args.listen);
    },
    start_desktop_daemon: () => runDaemonLaunch(startDaemon),
    stop_desktop_daemon: (args) =>
      stopDesktopDaemon(
        parseDesktopDaemonStopReason(args),
        typeof args?.pid === "number" && typeof args.startedAt === "string"
          ? { pid: args.pid, startedAt: args.startedAt }
          : undefined,
      ),
    restart_desktop_daemon: () => runDaemonLaunch(restartDaemon),
    desktop_daemon_logs: () => getDaemonLogs(),
    desktop_sandbox_diagnostics: () =>
      describeSandbox({
        disabled: app.commandLine.hasSwitch("no-sandbox"),
        launcherReason: process.env.PASEO_DESKTOP_SANDBOX_REASON,
      }),
    desktop_app_logs: () => getDesktopAppLogs(),
    desktop_update_diagnostics: () => getDesktopUpdaterDiagnostics(),
    desktop_get_system_idle_time: () => powerMonitor.getSystemIdleTime() * 1000,
    cli_daemon_status: () => getCliDaemonStatus(),
    write_attachment_base64: (args) => writeAttachmentBase64(args ?? {}),
    write_attachment_bytes: (args) => writeAttachmentBytes(args ?? {}),
    copy_attachment_file: (args) => copyAttachmentFileToManagedStorage(args ?? {}),
    read_file_base64: (args) => readManagedFileBase64(args ?? {}),
    delete_attachment_file: (args) => deleteManagedAttachmentFile(args ?? {}),
    garbage_collect_attachment_files: (args) => garbageCollectManagedAttachmentFiles(args ?? {}),
    open_local_daemon_transport: async (args) => await openLocalTransportSession(args),
    send_local_daemon_transport_message: async (args) => {
      await sendLocalTransportMessage(
        args as { sessionId: string; text?: string; binaryBase64?: string },
      );
    },
    close_local_daemon_transport: (args) => {
      const sessionId =
        typeof args === "object" && args !== null && "sessionId" in args
          ? (args as { sessionId: string }).sessionId
          : "";
      if (sessionId) closeLocalTransportSession(sessionId);
    },
    check_app_update: async (args) => {
      const currentVersion = resolveDesktopAppVersion();
      return checkForAppUpdate({
        currentVersion,
        releaseChannel: await resolveRequestedReleaseChannel(args),
        intent: parseAppUpdateCheckIntent(args),
      });
    },
    install_app_update: async (args) => {
      const currentVersion = resolveDesktopAppVersion();
      let ownsHandoff = false;
      try {
        return await downloadAndInstallUpdate(
          { currentVersion, releaseChannel: await resolveRequestedReleaseChannel(args) },
          async (target) => {
            if (isQuitting()) return false;
            const home = getPaseoHome();
            const instance = await readDaemonInstance(home);
            if (instance?.desktopManaged) {
              if (!(await confirmOfficialUpdateWithoutAgentResume(target, "Cancel"))) return false;
              if (!(await getDesktopSettingsStore().get()).officialUpdatesEnabled) return false;
            }
            if (isQuitting()) return false;
            ownsHandoff = true;
            manualUpdateHandoffInProgress = true;
            return withDaemonUpdateLock(home, async () => {
              const shutdown = instance?.desktopManaged
                ? await captureDaemonUpdateShutdown(home, instance)
                : undefined;
              return shutdown ?? holdDaemonLaunchForUpdate(home);
            });
          },
        );
      } finally {
        if (ownsHandoff) manualUpdateHandoffInProgress = false;
      }
    },
    get_local_daemon_version: () => getLocalDaemonVersion(),
    install_cli: () => installCli(),
    uninstall_cli: () => uninstallCli(),
    get_cli_install_status: () => getCliInstallStatus(),
    read_legacy_skill_selection: () => readLegacySkillSelection(),
    delete_legacy_skill_selection: () => deleteLegacySkillSelection(),
  };
}

export function registerDaemonManager(
  onSettingsChanged?: (settings: DesktopSettings) => void,
  isQuitting?: () => boolean,
): void {
  const handlers = createDaemonCommandHandlers(onSettingsChanged, isQuitting);

  ipcMain.handle(
    "paseo:invoke",
    async (_event, command: string, args?: Record<string, unknown>) => {
      const handler = handlers[command];
      if (!handler) {
        throw new Error(`Unknown desktop command: ${command}`);
      }
      return await handler(args);
    },
  );
}
