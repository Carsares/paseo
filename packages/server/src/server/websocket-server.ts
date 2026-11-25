import { rewindDirectoriesOverlap } from "./agent-rewind-scope.js";
import { handleHostProxyRequest, isHostProxyRequest } from "./network/host-proxy-rpc.js";
import { isProtectedProxyIngress } from "./network/host-proxy-ingress.js";
import type { HostProxyRuntime } from "./network/proxy-runtime.js";
import { readConfirmedLanPeers, type ConfirmedLanPeers } from "./network/host-proxy-trust.js";
import {
  ChunkedTransport,
  ChunkedTransportProtocolError,
} from "@getpaseo/protocol/chunked-transport";
import { type WorkspaceRuntimeStore } from "./workspace-runtime-store/index.js";
import { createAgentMessageDelivery } from "./agent/agent-messages/index.js";
import {
  createPeerPromptHandoff,
  sendPreparedPromptToAgent,
  waitForAgentRunStartWithTimeout,
} from "./agent/agent-prompt.js";
import {
  assertDirectParent,
  createToolHosts,
  DIRECT_PARENT_ROUTE_ACK,
  readDirectParentRoute,
} from "./agent/host-operations/index.js";
import {
  isAutomaticLocalParentSubscription,
  ParentReportRecipientUnavailableError,
  type FinishRegistration,
  type FinishSubscription,
  type FinishSubscriptions,
} from "./agent/finish-subscriptions/index.js";
import { decodeParentReportIdentity } from "./agent/finish-subscriptions/report-identity.js";
import { resolveReportTitle } from "./agent/report-title.js";
import {
  getParentAddressFromLabels,
  hasResidentInboxBypass,
  isExplicitParentReportingLabels,
  isMainControlAgentLabels,
  isResidentAgentLabels,
} from "@getpaseo/protocol/agent-labels";
import { registerParentFinishSubscription } from "./agent/create-agent/create.js";
import { HOST_ROUTE_OPCODE } from "@getpaseo/protocol/binary-frames/index";
import { DaemonLinkEndpoint, VirtualHostSocket } from "./connected-hosts/index.js";
import { ConnectedHosts } from "./connected-hosts/index.js";
import { stat } from "node:fs/promises";
import {
  createWorkspaceBaseBranchService,
  type WorkspaceBaseBranchService,
} from "./session/workspace-base-branch/service.js";
import type { AgentFinishReport, CreationSnapshot } from "@getpaseo/protocol/messages";
import { CreationService } from "./creation/index.js";
import { openDurableItemStore } from "./durable-items/requests.js";
import type { DurableItemStore } from "./durable-items/store.js";
import { MessageReceipts } from "./message-receipts/index.js";
import { WebSocket, WebSocketServer } from "ws";
import type { IncomingMessage, Server as HTTPServer } from "http";
import { join } from "path";
import { getCachedHostMachineKind } from "./host-machine-kind.js";
import { getHostName } from "./host-name.js";
import { createHash, randomUUID } from "node:crypto";
import { monitorEventLoopDelay } from "node:perf_hooks";
import {
  AgentRunCancellationError,
  type AgentManager,
  type AgentMetricsSnapshot,
} from "./agent/agent-manager.js";
import { supportsHostApprovedProviderUpdates } from "./agent/provider-installation/installation-target.js";
import type { AgentStorage } from "./agent/agent-storage.js";
import type { DownloadTokenStore } from "./file-download/token-store.js";
import type { TerminalManager } from "../terminal/terminal-manager.js";
import type pino from "pino";
import type { ProjectRegistry, WorkspaceRegistry } from "./workspace-registry.js";
import type { ProjectUpdate } from "./workspace-reconciliation-service.js";
import type { ScheduleService } from "./schedule/service.js";
import type { CheckoutDiffManager, CheckoutDiffMetrics } from "./checkout-diff-manager.js";
import {
  toWireDaemonConfig,
  type DaemonConfigStore,
  type MutableDaemonConfig,
} from "./daemon-config-store.js";
import {
  type ServerInfoStatusPayload,
  type ScriptStatusUpdateMessage,
  type SessionInboundMessage,
  type SessionOutboundMessage,
  type WSHelloMessage,
  type WSInboundMessage,
  WSInboundMessageSchema,
  type ServerCapabilityState,
  type ServerCapabilities,
  type WSOutboundMessage,
  wrapSessionMessage,
} from "./messages.js";
import { asUint8Array, decodeBinaryFrame } from "@getpaseo/protocol/binary-frames/index";
import type { TerminalActivity } from "@getpaseo/protocol/terminal-activity";
import { MAX_WEBSOCKET_MESSAGE_BYTES } from "@getpaseo/protocol/websocket-message-limit";
import type { HostnamesConfig } from "./hostnames.js";
import { isHostnameAllowed } from "./hostnames.js";
import {
  enqueueRecoverableAgentMessage,
  retainQueuedAgentMessage,
  Session,
  SourceDeliveryClosedError,
  isWorkspaceArchivePending,
  type SessionLifecycleIntent,
  type SessionOptions,
  type SessionRuntimeMetrics,
} from "./session.js";
import type { HubRelationshipManagement } from "./hub/relationship-controller.js";
import { WorkspaceSetupObservation } from "./workspace-setup-observation.js";
import { WorkspaceSetupRuntime } from "./workspace-setup-runtime.js";
import { WorkspaceArchiveOperations } from "./workspace-archive-operations.js";

function resolveWorkspaceArchiveOperations(
  operations: WorkspaceArchiveOperations | undefined,
): WorkspaceArchiveOperations {
  return operations ?? new WorkspaceArchiveOperations();
}
import type { HubExecutionAgents } from "./hub/daemon-executions.js";
import type { AgentProvider } from "./agent/agent-sdk-types.js";
import { ProviderSnapshotManager } from "./agent/provider-snapshot-manager.js";
import { attachMutableProviderConfigOwner } from "./agent/mutable-provider-config-owner.js";
import type {
  WorkspaceGitRuntimeSnapshot,
  WorkspaceGitService,
  WorkspaceGitServiceMetrics,
} from "./workspace-git-service.js";
import type { GitCommandRuntimeMetricsSnapshot } from "../utils/git-command-runtime-metrics.js";
import { snapshotGitCommandRuntimeMetrics } from "../utils/run-git-command.js";
import { createPluginClientId, isPluginClientId } from "./plugins/plugin-session-identity.js";
import type { WorkspaceAutoName } from "./workspace-auto-name.js";
import { deriveProjectSlug } from "./workspace-git-metadata.js";
import {
  createPushNotifications,
  type PushNotifications,
  type PushNotificationSender,
} from "./push/index.js";
import type { ScriptHealthState } from "./script-health-monitor.js";
import type { ServiceProxySubsystem } from "./service-proxy.js";
import type { WorkspaceScriptRuntimeStore } from "./workspace-script-runtime-store.js";
import type { SpeechReadinessSnapshot, SpeechService } from "./speech/speech-runtime.js";
import type { VoiceCallerContext, VoiceSpeakHandler } from "./voice-types.js";
import {
  computeNotificationPlan,
  isPushEligibleAttentionReason,
  type ClientPresenceState,
  type NotificationPlan,
} from "./agent-attention-policy.js";
import {
  buildAgentAttentionNotificationPayload,
  findLatestPermissionRequest,
} from "@getpaseo/protocol/agent-attention-notification";
import { createGitHubService } from "../services/github-service.js";
import type { ForgeService } from "../services/forge-service.js";
import {
  extractHttpBearerToken,
  extractWsBearerProtocol,
  extractWsBearerToken,
  isBearerTokenValidAsync,
  type DaemonAuthConfig,
} from "./auth.js";
import { resolveSessionAdmission } from "./session-admission-auth.js";
import {
  WebSocketRuntimeMetricsWindow,
  type WebSocketRuntimeCounters,
  type WebSocketRuntimeDiagnosticSnapshot,
} from "./websocket/runtime-metrics.js";
import { getProcessMemoryDiagnostics, getProcessUptimeSeconds } from "./process-diagnostics.js";
import {
  CLIENT_SHUTDOWN_RPC_REASON,
  normalizeClientRestartRpcReason,
} from "./lifecycle-reasons.js";
import { CLIENT_CAPS } from "@getpaseo/protocol/client-capabilities";

import type { SecurityMode } from "@getpaseo/relay/e2ee";
import type { BrowserToolsBroker } from "./browser-tools/broker.js";
import type { DaemonRuntimeConfig } from "./session/daemon/daemon-session.js";
import { DirectorySyncService } from "./directory-sync/index.js";
import { OWNER_PERMISSIONS, type DaemonPermission } from "./authorization/index.js";
import type { WorkspaceLabelService } from "./workspace-labels/index.js";
import {
  APPLICATION_SOCKET_LEASE_CHECK_INTERVAL_MS,
  ApplicationSocketLease,
  MAX_PHYSICAL_SOCKET_BUFFERED_BYTES,
  outboundFrameByteLength,
  physicalSocketHasCapacity,
  sendBoundedPhysicalFrameAndWait,
} from "./websocket/physical-socket.js";

const WS_CLOSE_DAEMON_AUTH_FAILED = 4401;
// Give clients intermediate messages that count as progress during large transfers.
const DIRECT_WEBSOCKET_FRAME_BYTES = 512 * 1024;

export interface ExternalSocketMetadata {
  transport: "relay" | "hub";
  externalSessionKey?: string;
  relayConnectionId?: string;
  /** Negotiated endpoint security for relay-carried sockets. */
  securityMode?: SecurityMode;
  hubDaemonId?: string;
}

export interface SessionAdmission {
  principalId: string;
  permissions: readonly DaemonPermission[];
  hubExecutionAgents?: HubExecutionAgents;
}

interface PendingConnection {
  connectionLogger: pino.Logger;
  helloTimeout: ReturnType<typeof setTimeout> | null;
  identity: WebSocketConnectionIdentity;
  admission: SessionAdmission | null;
  authenticating: boolean;
}

interface WebSocketConnectionIdentity {
  connectionId: string;
  transport: "direct" | "relay" | "hub";
  peer: "loopback" | "local_ipc" | "external";
  browserOrigin: boolean;
  host?: string;
  origin?: string;
  userAgent?: string;
  remoteAddress?: string;
  relayConnectionId?: string;
  securityMode?: SecurityMode;
  hubDaemonId?: string;
  clientId?: string;
  sessionId?: string;
  appVersion?: string;
}

export interface ServerFeatureOverrides {
  daemonStatusRpc?: boolean;
  relayConfig?: boolean;
  topicWorkbenchV1?: boolean;
  topicPromptRetryV1?: boolean;
  workspaceDurableItemsV1?: boolean;
  checkoutGitStagingV1?: boolean;
  checkoutGitGraphV1?: boolean;
  checkoutGitRebaseV1?: boolean;
  checkoutGitMultiRepoV1?: boolean;
  checkoutGitP2V1?: boolean;
}

interface WebSocketServerConfig extends Pick<
  ServerFeatureOverrides,
  "daemonStatusRpc" | "relayConfig"
> {
  allowedOrigins?: Set<string>;
  hostnames?: HostnamesConfig;
  getAllowedOrigins?: () => Set<string>;
  getHostnames?: () => HostnamesConfig | undefined;
  serverFeatureOverrides?: ServerFeatureOverrides;
  startPaused?: boolean;
  messageReceipts?: MessageReceipts;
  hostProxy?: HostProxyRuntime;
}

function resolveServerFeatureOverrides(wsConfig: WebSocketServerConfig): ServerFeatureOverrides {
  const overrides = wsConfig.serverFeatureOverrides;
  return {
    ...overrides,
    daemonStatusRpc: overrides?.daemonStatusRpc ?? wsConfig.daemonStatusRpc,
    relayConfig: overrides?.relayConfig ?? wsConfig.relayConfig,
  };
}

function resolveAgentMessageReceiptStores(paseoHome: string, messages?: MessageReceipts) {
  return {
    messages: messages ?? new MessageReceipts(join(paseoHome, "agent-requests")),
    parentReports: new MessageReceipts(join(paseoHome, "parent-report-receipts")),
  };
}

type WebSocketRuntimeMetrics = SessionRuntimeMetrics & CheckoutDiffMetrics;
interface GitRuntimeMetrics {
  commands: GitCommandRuntimeMetricsSnapshot;
  workspaceService: WorkspaceGitServiceMetrics;
}
type WebSocketRuntimeDiagnosticPayload = WebSocketRuntimeDiagnosticSnapshot<
  WebSocketRuntimeMetrics,
  AgentMetricsSnapshot,
  GitRuntimeMetrics
>;
type WebSocketRuntimeMetricsLogPayload = Omit<WebSocketRuntimeDiagnosticPayload, "collectedAt">;

type TerminalAttentionReason = "finished" | "needs_input";

function resolveTerminalAttentionReason(input: {
  attentionReason?: TerminalActivity["attentionReason"];
  previousState: "working" | "idle" | "attention" | null;
  state: "working" | "idle" | "attention" | null;
}): TerminalAttentionReason | null {
  if (input.attentionReason === "finished") return "finished";
  if (input.attentionReason === "needs_input") return "needs_input";
  if (input.state === "attention") return "needs_input";
  if (input.previousState === "working" && input.state === "idle") return "finished";
  return null;
}

function terminalAttentionTitle(reason: TerminalAttentionReason): string {
  return reason === "needs_input" ? "Terminal needs input" : "Terminal finished";
}

function createFallbackWorkspaceGitSnapshot(cwd: string): WorkspaceGitRuntimeSnapshot {
  return {
    cwd,
    git: {
      isGit: false,
      repoRoot: null,
      mainRepoRoot: null,
      currentBranch: null,
      remoteUrl: null,
      isPaseoOwnedWorktree: false,
      isDirty: null,
      baseRef: null,
      aheadBehind: null,
      upstreamRef: null,
      aheadOfOrigin: null,
      behindOfOrigin: null,
      upstreamState: "none",
      hasRemote: false,
      pullRemote: null,
      pushRemote: null,
      firstPushRemote: null,
      diffStat: null,
    },
    forge: {
      featuresEnabled: false,
      authState: "no_remote",
      pullRequest: null,
      error: null,
    },
  };
}

function createFallbackWorkspaceGitService(): WorkspaceGitService {
  return {
    registerWorkspace: () => ({
      unsubscribe: () => {},
    }),
    onSnapshotUpdated: () => ({
      unsubscribe: () => {},
    }),
    getCheckout: async (cwd: string) => ({
      cwd,
      isGit: false,
      currentBranch: null,
      remoteUrl: null,
      worktreeRoot: null,
      isPaseoOwnedWorktree: false,
      mainRepoRoot: null,
    }),
    getSnapshot: async (cwd: string) => createFallbackWorkspaceGitSnapshot(cwd),
    resolveForge: async () => null,
    getCheckoutDiff: async () => ({ diff: "" }),
    validateBranchRef: async () => ({ kind: "not-found" }),
    hasLocalBranch: async () => false,
    suggestBranchesForCwd: async () => [],
    listStashes: async () => [],
    listWorktrees: async () => [],
    invalidateWorktrees: () => {},
    getProjectSlug: async (cwd: string) => {
      const snapshot = createFallbackWorkspaceGitSnapshot(cwd);
      return deriveProjectSlug(cwd, snapshot.git.isGit ? snapshot.git.remoteUrl : null);
    },
    resolveRepoRoot: async (cwd: string) => cwd,
    resolveDefaultBranch: async () => "main",
    resolveRepoRemoteUrl: async () => null,
    refresh: async () => {},
    requestWorkingTreeWatch: async () => ({
      repoRoot: null,
      unsubscribe: () => {},
    }),
    scheduleRefreshForCwd: () => {},
    onWorkspaceStateMayHaveChanged: () => {},
    invalidateForge: () => {},
    getMetrics: () => ({
      workspaceTargetCount: 0,
      workspaceListenerCount: 0,
      repositoryTargetCount: 0,
      repositoryWorkspaceLinkCount: 0,
      workingTreeWatchTargetCount: 0,
      workingTreeWatchListenerCount: 0,
      workspaceObservationSetupInFlightCount: 0,
      workingTreeWatchSetupInFlightCount: 0,
      workspaceRefreshInFlightCount: 0,
      workspaceRefreshQueuedCount: 0,
      workspaceRefreshAdmissionActiveCount: 0,
      workspaceRefreshAdmissionPendingCount: 0,
      workspaceObservationSetupAdmissionActiveCount: 0,
      workspaceObservationSetupAdmissionPendingCount: 0,
      fetchInFlightCount: 0,
      snapshotUpdatedListenerCount: 0,
      watcherErrorCallbackCount: 0,
      fileObserver: {
        activeObservationCount: 0,
        nativeHandleCount: 0,
        nativeTrackedFileCount: 0,
        pendingEventCount: 0,
        pendingReconciliationWorkCount: 0,
        pendingClassificationCount: 0,
        reconciliationInFlightCount: 0,
        reconciliationCount: 0,
        scopedReconciliationCount: 0,
        fullReconciliationCount: 0,
        reconciliationFailureCount: 0,
        observerFailureCount: 0,
        directoryLimitFailureCount: 0,
        nativeEventCount: 0,
        nativeChangeEventCount: 0,
        nativeRenameEventCount: 0,
        nativePathlessEventCount: 0,
        nativeClassificationCount: 0,
        nativeShallowScanCount: 0,
        lastReconciliationDurationMs: 0,
        maxReconciliationDurationMs: 0,
      },
    }),
    dispose: async () => {},
  };
}

function createNoopProjectRegistry(): ProjectRegistry {
  return {
    initialize: async () => {},
    existsOnDisk: async () => true,
    list: async () => [],
    get: async () => null,
    getOrCreateActiveByRoot: async (input) => ({
      projectId: "prj_noop",
      rootPath: input.rootPath,
      kind: input.kind,
      displayName: input.displayName,
      projectKey: input.projectKey ?? null,
      customName: null,
      customIconRevision: null,
      createdAt: input.timestamp,
      updatedAt: input.timestamp,
      archivedAt: null,
    }),
    upsert: async () => {},
    update: async () => null,
    archive: async () => {},
    remove: async () => {},
  };
}

function createNoopWorkspaceRegistry(): WorkspaceRegistry {
  return {
    initialize: async () => {},
    existsOnDisk: async () => true,
    listAll: async () => [],
    listActive: async () => [],
    get: async () => null,
    update: async () => null,
    upsert: async () => {},
    archive: async () => false,
    remove: async () => {},
  };
}

function toServerCapabilityState(params: {
  state: SpeechReadinessSnapshot["dictation"];
  reason: string;
}): ServerCapabilityState {
  const { state, reason } = params;
  return {
    enabled: state.enabled,
    reason,
  };
}

function resolveCapabilityReason(params: {
  state: SpeechReadinessSnapshot["dictation"];
  readiness: SpeechReadinessSnapshot;
}): string {
  const { state, readiness } = params;
  if (state.available) {
    return "";
  }

  if (readiness.voiceFeature.reasonCode === "model_download_in_progress") {
    const baseMessage = readiness.voiceFeature.message.trim();
    if (baseMessage.includes("Try again in a few minutes")) {
      return baseMessage;
    }
    return `${baseMessage} Try again in a few minutes.`;
  }

  return state.message;
}

function buildServerCapabilities(params: {
  readiness: SpeechReadinessSnapshot | null;
}): ServerCapabilities | undefined {
  const readiness = params.readiness;
  if (!readiness) {
    return undefined;
  }
  return {
    voice: {
      dictation: toServerCapabilityState({
        state: readiness.dictation,
        reason: resolveCapabilityReason({
          state: readiness.dictation,
          readiness,
        }),
      }),
      voice: toServerCapabilityState({
        state: readiness.realtimeVoice,
        reason: resolveCapabilityReason({
          state: readiness.realtimeVoice,
          readiness,
        }),
      }),
    },
  };
}

function areServerCapabilitiesEqual(
  current: ServerCapabilities | undefined,
  next: ServerCapabilities | undefined,
): boolean {
  return JSON.stringify(current ?? null) === JSON.stringify(next ?? null);
}

function bufferFromWsData(data: Buffer | ArrayBuffer | Buffer[] | string): Buffer {
  if (typeof data === "string") return Buffer.from(data, "utf8");
  if (Array.isArray(data)) {
    return Buffer.concat(
      data.map((item) => (Buffer.isBuffer(item) ? item : Buffer.from(item as ArrayBuffer))),
    );
  }
  if (Buffer.isBuffer(data)) return data;
  return Buffer.from(data);
}

export interface WebSocketLike {
  maxFrameBytes?: number;
  supportsConcurrentWrites?: boolean;
  readyState: number;
  bufferedAmount?: number;
  send: (
    data: string | Uint8Array | ArrayBuffer,
    callback?: (error?: Error) => void,
  ) => void | Promise<void>;
  close: (code?: number, reason?: string) => void;
  terminate?: () => void;
  on: (event: "message" | "close" | "error", listener: (...args: unknown[]) => void) => void;
  once: (event: "close" | "error", listener: (...args: unknown[]) => void) => void;
}

interface SessionConnectionBase {
  hubExecutionAgents?: HubExecutionAgents;
  readonly permissionCeiling?: readonly DaemonPermission[];
  session: Session;
  principalId: string;
  sessionKey: string;
  clientId: string;
  appVersion: string | null;
  clientCapabilities: Record<string, unknown> | null;
  connectionLogger: pino.Logger;
  sockets: Set<WebSocketLike>;
}

interface ReconnectableSessionConnection extends SessionConnectionBase {
  lifecycle: "reconnectable";
  externalDisconnectCleanupTimeout: ReturnType<typeof setTimeout> | null;
}

interface PluginSessionConnection extends SessionConnectionBase {
  lifecycle: "ephemeral-plugin";
  pluginId: string;
}

type AgentFinishReportPushRequest = Extract<
  SessionInboundMessage,
  { type: "agent.finish_reports.push.request" }
>;
type AgentFinishReportConfirmRequest = Extract<
  SessionOutboundMessage,
  { type: "agent.finish_reports.confirm.request" }
>;
type AgentFinishReportConfirmResponse = Extract<
  SessionInboundMessage,
  { type: "agent.finish_reports.confirm.response" }
>;
type AgentFinishReportConfirmResult = Pick<
  AgentFinishReportConfirmResponse["payload"],
  "accepted" | "error" | "confirmedReport"
>;

type ConfirmedAgentFinishReport = NonNullable<AgentFinishReportConfirmResult["confirmedReport"]>;

function parentReportFingerprint(report: AgentFinishReport): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        report.id,
        report.parentReportStatus,
        report.title,
        report.prompt,
        report.event,
      ]),
    )
    .digest("hex");
}

interface PendingAgentFinishReportConfirmation {
  childAgentId: string;
  parentAgentId: string;
  reportId: string;
  resolve: (response: AgentFinishReportConfirmResponse) => void;
  reject: (error: unknown) => void;
}

type SessionConnection = ReconnectableSessionConnection | PluginSessionConnection;

interface SocketSessionOptions {
  sourceId?: string;
  clientId: string;
  appVersion: string | null;
  clientCapabilities: Record<string, unknown> | null;
  permissions: readonly DaemonPermission[];
  connectionLogger: pino.Logger;
  onMessage: (message: SessionOutboundMessage) => void;
  onMessageToSource?: (source: object, message: SessionOutboundMessage) => void | Promise<void>;
  onBinaryMessage?: (frame: Uint8Array) => void;
  onBinaryMessageToSource?: (source: object, frame: Uint8Array) => Promise<void>;
  getTransportBufferedAmount?: (source?: object) => number | null;
  onLifecycleIntent?: (intent: SessionLifecycleIntent) => void;
  prepareLifecycleIntent?: (intent: SessionLifecycleIntent) => Promise<void>;
  hubExecutionAgents?: HubExecutionAgents;
  hubRelationships?: HubRelationshipManagement;
}

interface ClosePhysicalSocketParams {
  ws: WebSocketLike;
  logMessage: string;
  logFields?: Record<string, unknown>;
  reportWhileClosing?: boolean;
}

const SLOW_REQUEST_THRESHOLD_MS = 500;
const EXTERNAL_SESSION_DISCONNECT_GRACE_MS = 90_000;
const HELLO_TIMEOUT_MS = 15_000;
const WS_CLOSE_HELLO_TIMEOUT = 4001;
const WS_CLOSE_INVALID_HELLO = 4002;
const WS_CLOSE_INCOMPATIBLE_PROTOCOL = 4003;
const WS_CLOSE_SERVER_SHUTDOWN = 1001;
const WS_PROTOCOL_VERSION = 1;
const WS_RUNTIME_METRICS_FLUSH_MS = 30_000;
const PARENT_REPORT_CONFIRMATION_TIMEOUT_MS = 5_000;
class ParentReportConfirmationUnavailableError extends Error {
  constructor(cause?: unknown) {
    super("Parent report confirmation is unavailable", { cause });
    this.name = "ParentReportConfirmationUnavailableError";
  }
}
const OWNER_SESSION_ADMISSION: SessionAdmission = {
  principalId: "owner",
  permissions: OWNER_PERMISSIONS,
};

export class MissingDaemonVersionError extends Error {
  constructor() {
    super("VoiceAssistantWebSocketServer requires a non-empty daemonVersion.");
    this.name = "MissingDaemonVersionError";
  }
}

interface RequiredWebSocketServices {
  scheduleService: ScheduleService;
  checkoutDiffManager: CheckoutDiffManager;
}

function requireWebSocketServices(params: {
  scheduleService?: ScheduleService;
  checkoutDiffManager?: CheckoutDiffManager;
}): RequiredWebSocketServices {
  const { scheduleService, checkoutDiffManager } = params;
  if (!scheduleService) {
    throw new Error("VoiceAssistantWebSocketServer requires a schedule service.");
  }
  if (!checkoutDiffManager) {
    throw new Error("VoiceAssistantWebSocketServer requires a checkout diff manager.");
  }
  return { scheduleService, checkoutDiffManager };
}

/**
 * WebSocket server that only accepts sockets + parses/forwards messages to the session layer.
 */
export class VoiceAssistantWebSocketServer {
  private readonly hostProxy?: HostProxyRuntime;
  private readonly protectedProxySources = new WeakSet<WebSocketLike>();
  private trustedProxyOrigins: readonly string[] = [];
  private unsubscribeProxyTrust?: () => void;

  getTrustedProxyOrigins(): readonly string[] {
    return this.trustedProxyOrigins;
  }

  observeProxyTrust(): void {
    let generation = 0;
    let confirmed: ConfirmedLanPeers = new Map();
    const refresh = async () => {
      const current = ++generation;
      this.trustedProxyOrigins = [];
      try {
        const directory = await this.connectedHosts.list();
        const next = await readConfirmedLanPeers(this.paseoHome, directory, confirmed);
        if (generation !== current) return;
        confirmed = next;
        this.trustedProxyOrigins = [...next.values()].map((peer) => peer.origin);
      } catch {
        // An unreadable registration grants no bypass.
      }
    };
    const unsubscribe = this.connectedHosts.observe(() => void refresh());
    this.unsubscribeProxyTrust = () => {
      generation++;
      unsubscribe();
      this.trustedProxyOrigins = [];
    };
    void refresh();
  }

  private hostProxyFeatures(): { outboundProxy?: true } {
    // COMPAT(outboundProxy): added in v0.18.0, remove gate after 2027-06-01.
    return this.hostProxy?.available ? { outboundProxy: true } : {};
  }

  private readonly logger: pino.Logger;
  private readonly wss: WebSocketServer;
  private readonly hostLinks = new Map<WebSocketLike, DaemonLinkEndpoint>();
  private readonly pendingConnections: Map<WebSocketLike, PendingConnection> = new Map();
  private readonly sessions: Map<WebSocketLike, SessionConnection> = new Map();
  private readonly pendingAgentFinishReportConfirmations = new WeakMap<
    WebSocketLike,
    Map<string, PendingAgentFinishReportConfirmation>
  >();
  private readonly socketIdentities: Map<WebSocketLike, WebSocketConnectionIdentity> = new Map();
  private readonly externalSessionsByKey: Map<string, ReconnectableSessionConnection> = new Map();
  private readonly pluginSocketIds = new WeakMap<WebSocketLike, string>();
  private readonly pluginSocketCleanup = new WeakMap<WebSocketLike, () => void>();
  private readonly serverId: string;
  private readonly daemonVersion: string;
  private readonly daemonRuntimeConfig: DaemonRuntimeConfig | undefined;
  private readonly agentManager: AgentManager;
  private readonly agentStorage: AgentStorage;
  private readonly messageReceipts: MessageReceipts;
  private readonly parentReportReceipts: MessageReceipts;
  readonly agentMessages: ReturnType<typeof createAgentMessageDelivery>;
  private readonly remoteInboxChildren = new Map<string, Set<string>>();
  private readonly remoteFinishedSupersessions = new Set<string>();
  private readonly parentReportSockets = new Map<string, VirtualHostSocket>();
  private readonly creationService: CreationService;
  private readonly projectRegistry: ProjectRegistry;
  private readonly workspaceRegistry: WorkspaceRegistry;
  private readonly durableItems: DurableItemStore;
  private readonly workspaceBaseBranch: WorkspaceBaseBranchService;
  private readonly workspaceLabelService: WorkspaceLabelService | null;
  private readonly scheduleService: ScheduleService;
  private readonly checkoutDiffManager: CheckoutDiffManager;
  private readonly github: ForgeService;
  private readonly workspaceGitService: WorkspaceGitService;
  private readonly workspaceAutoName: WorkspaceAutoName;
  private readonly downloadTokenStore: DownloadTokenStore;
  private readonly paseoHome: string;
  private readonly connectedHosts: ConnectedHosts;

  toolHosts() {
    return createToolHosts(this.connectedHosts);
  }
  private readonly passwordHash: string | undefined;
  private readonly credentialSource: DaemonAuthConfig | undefined;
  private readonly worktreesRoot: string | undefined;
  private readonly daemonConfigStore: DaemonConfigStore;
  private readonly pushNotifications: PushNotifications;
  private readonly pushNotificationSender: PushNotificationSender;
  // Per agent, the unread finish (by its attention timestamp) that a notification was delivered for.
  private readonly notifiedUnreadFinishAt = new Map<string, number>();
  private readonly mcpBaseUrl: string | null;
  private speech!: SpeechService | null;
  private terminalManager!: TerminalManager | null;
  private serviceProxy!: ServiceProxySubsystem | null;
  private scriptRuntimeStore!: WorkspaceScriptRuntimeStore | null;
  private getDaemonTcpPort!: (() => number | null) | null;
  private getDaemonTcpHost!: (() => string | null) | null;
  private serviceProxyPublicBaseUrl!: string | null;
  private resolveScriptHealth!: ((hostname: string) => ScriptHealthState | null) | null;
  private dictation!: {
    finalTimeoutMs?: number;
  } | null;
  private readonly voiceSpeakHandlers = new Map<string, VoiceSpeakHandler>();
  private readonly voiceCallerContexts = new Map<string, VoiceCallerContext>();
  private readonly workspaceSetupObservation = new WorkspaceSetupObservation();
  private readonly workspaceSetupRuntime: WorkspaceSetupRuntime;
  // One lane per workspace and per checkout across the daemon, so archive, undo, and restore
  // from any client or background caller coordinate through one boundary.
  private readonly workspaceArchiveOperations: WorkspaceArchiveOperations;
  private readonly providerSnapshotManager: ProviderSnapshotManager;
  private onLifecycleIntent!: ((intent: SessionLifecycleIntent) => void) | null;
  private prepareLifecycleIntent!: ((intent: SessionLifecycleIntent) => Promise<void>) | null;
  private onBranchChanged!:
    | ((workspaceId: string, oldBranch: string | null, newBranch: string | null) => void)
    | null;
  private serverCapabilities: ServerCapabilities | undefined;
  private readonly runtimeMetrics = new WebSocketRuntimeMetricsWindow();
  private lastRuntimeMetricsSnapshot: WebSocketRuntimeDiagnosticPayload | null = null;
  private runtimeMetricsInterval: ReturnType<typeof setInterval> | null = null;
  private applicationSocketLeaseInterval: ReturnType<typeof setInterval> | null = null;
  private readonly applicationSocketLease = new ApplicationSocketLease<WebSocketLike>();
  private eventLoopDelayMonitor: ReturnType<typeof monitorEventLoopDelay> | null = null;
  private unsubscribeSpeechReadiness: (() => void) | null = null;
  private unsubscribeDaemonConfigChange: (() => void) | null = null;
  private unsubscribeTerminalActivity: (() => void) | null = null;
  private readonly browserToolsBroker: BrowserToolsBroker | null;
  private readonly hubRelationships: HubRelationshipManagement | null;
  private connectionLifecycle: "starting" | "accepting" | "stopping" = "accepting";
  private readonly featureOverrides: ServerFeatureOverrides;
  private readonly directorySync = new DirectorySyncService();
  private readonly pluginRuntime: SessionOptions["pluginRuntime"];
  private readonly orchestrationSkills: SessionOptions["orchestrationSkills"];

  private async validateCompletedCreation(snapshot: CreationSnapshot): Promise<void> {
    if (snapshot.workspace && snapshot.kind === "workspace") {
      const workspace = await this.workspaceRegistry.get(snapshot.workspace.id);
      if (!workspace) throw new Error("Previously created workspace no longer exists");
      const directory = await stat(workspace.cwd).catch(() => null);
      if (!directory?.isDirectory())
        throw Object.assign(new Error(`Directory not found: ${workspace.cwd}`), {
          code: "directory_not_found",
        });
    }
    for (const id of [snapshot.agentId, snapshot.mainAgent?.id]) {
      if (id && !this.agentManager.getAgent(id) && !(await this.agentStorage.get(id))) {
        throw new Error("Previously created agent no longer exists");
      }
    }
  }

  constructor(
    server: HTTPServer,
    logger: pino.Logger,
    serverId: string,
    agentManager: AgentManager,
    agentStorage: AgentStorage,
    downloadTokenStore: DownloadTokenStore,
    paseoHome: string,
    daemonConfigStore: DaemonConfigStore,
    mcpBaseUrl: string | null,
    wsConfig: WebSocketServerConfig,
    workspaceAutoName: WorkspaceAutoName,
    private readonly workspaceRuntimeStore: WorkspaceRuntimeStore,
    auth?: DaemonAuthConfig,
    speech?: SpeechService | null,
    terminalManager?: TerminalManager | null,
    dictation?: {
      finalTimeoutMs?: number;
    },
    daemonVersion?: string,
    onLifecycleIntent?: (intent: SessionLifecycleIntent) => void,
    prepareLifecycleIntent?: (intent: SessionLifecycleIntent) => Promise<void>,
    projectRegistry?: ProjectRegistry,
    workspaceRegistry?: WorkspaceRegistry,
    scheduleService?: ScheduleService,
    checkoutDiffManager?: CheckoutDiffManager,
    serviceProxy?: ServiceProxySubsystem | null,
    scriptRuntimeStore?: WorkspaceScriptRuntimeStore | null,
    onBranchChanged?: (
      workspaceId: string,
      oldBranch: string | null,
      newBranch: string | null,
    ) => void,
    getDaemonTcpPort?: () => number | null,
    getDaemonTcpHost?: () => string | null,
    resolveScriptHealth?: (hostname: string) => ScriptHealthState | null,
    workspaceGitService?: WorkspaceGitService,
    github?: ForgeService,
    pushNotificationSender?: PushNotificationSender,
    providerSnapshotManager?: ProviderSnapshotManager,
    daemonRuntimeConfig?: DaemonRuntimeConfig,
    serviceProxyPublicBaseUrl?: string | null,
    browserToolsBroker?: BrowserToolsBroker | null,
    hubRelationships?: HubRelationshipManagement | null,
    workspaceSetupRuntime: WorkspaceSetupRuntime = new WorkspaceSetupRuntime(),
    pluginRuntime?: SessionOptions["pluginRuntime"],
    orchestrationSkills?: SessionOptions["orchestrationSkills"],
    workspaceLabelService?: WorkspaceLabelService,
    private readonly finishSubscriptions?: FinishSubscriptions,
    workspaceArchiveOperations?: WorkspaceArchiveOperations,
  ) {
    this.logger = logger.child({ module: "websocket-server" });
    this.workspaceSetupRuntime = workspaceSetupRuntime;
    this.workspaceArchiveOperations = resolveWorkspaceArchiveOperations(workspaceArchiveOperations);
    this.featureOverrides = resolveServerFeatureOverrides(wsConfig);
    this.connectionLifecycle = wsConfig.startPaused === true ? "starting" : "accepting";
    this.serverId = serverId;
    if (typeof daemonVersion !== "string" || daemonVersion.trim().length === 0) {
      throw new MissingDaemonVersionError();
    }
    this.daemonVersion = daemonVersion.trim();
    this.credentialSource = auth;
    this.daemonRuntimeConfig = daemonRuntimeConfig;
    this.browserToolsBroker = browserToolsBroker ?? null;
    this.hubRelationships = hubRelationships ?? null;
    this.pluginRuntime = pluginRuntime;
    this.orchestrationSkills = orchestrationSkills;
    this.agentManager = agentManager;
    this.agentStorage = agentStorage;
    this.agentMessages = createAgentMessageDelivery({
      shouldHoldInbox: (parentId, source) => {
        const live = agentManager.getAgent(parentId);
        if (live && !isMainControlAgentLabels(live.labels)) return false;
        for (const child of agentManager.listAgents()) {
          if (source?.agentId === child.id && (source.serverId ?? serverId) === serverId) continue;
          if (isResidentAgentLabels(child.labels) && hasResidentInboxBypass(child.labels)) continue;
          if (child.lifecycle !== "initializing" && !agentManager.hasInFlightRun(child.id))
            continue;
          const parent = getParentAddressFromLabels(child.labels, serverId);
          if (parent?.agentId === parentId && parent.serverId === serverId) return true;
        }
        return [...(this.remoteInboxChildren.get(parentId) ?? [])].some(
          (id) => id !== JSON.stringify([source?.serverId ?? serverId, source?.agentId]),
        );
      },
      onInboxChange: (agentId) => {
        void agentManager.notifyAgentInboxChanged(agentId).catch((err) => {
          this.logger.warn({ err, agentId }, "Failed to publish subagent inbox update");
        });
      },
      classifyInbox: (parentId, source) => this.classifySubagentInbox(parentId, source),
      tryRunOutOfBand: (request, onAccepted, commandDispatch) =>
        agentManager.tryRunOutOfBand(
          request.recipientId,
          request.prompt,
          { clientMessageId: request.messageIds[0] },
          onAccepted,
          commandDispatch,
        ),
      isRunning: (agentId) => agentManager.hasInFlightRun(agentId),
      canSteer: (agentId) => agentManager.canSteer(agentId),
      hasPendingPermission: (agentId) => agentManager.hasPendingPermissions(agentId),
      validateParentOwnership: (address) => this.validateFinishSubscriptionParent(address),
      unavailableHeldRecipient: async (agentId) => {
        const stored = await agentStorage.get(agentId);
        if (stored?.archivedAt) return "Queued peer recipient is archived.";
        if (
          !stored &&
          (await agentStorage.hasDeletedAgent(agentId)) &&
          !agentManager.getAgent(agentId)
        )
          return "Queued peer recipient was deleted.";
      },
      subscribe: (notify) =>
        agentManager.subscribe(
          (event) => {
            if (event.type === "agent_state")
              notify(event.agent.id, !isMainControlAgentLabels(event.agent.labels));
            if (event.type === "agent_removed") notify(event.agentId, true);
          },
          { replayState: false },
        ),
      onStop: (notify) => agentManager.onStop(notify),
      dispatch: async (batch) => {
        let registration: FinishRegistration | undefined;
        let dispatched = false;
        let prepared = false;
        const peerHandoff = batch.turnAuthorization
          ? createPeerPromptHandoff(batch.handoff)
          : undefined;
        const { disposition } = await sendPreparedPromptToAgent({
          agentManager,
          agentStorage,
          agentId: batch.recipientId,
          prompt: batch.prompt,
          activeTurnBehavior: batch.activeTurnBehavior,
          idleOnly: batch.idleOnly,
          canSteerDuringDrain: batch.canSteerDuringDrain,
          handoff: peerHandoff?.handoff ?? batch.handoff,
          assertDispatchAllowed: peerHandoff?.assertAllowed,
          validateDispatch: batch.validateDispatch,
          admit: batch.admit,
          sessionMode: batch.validateDispatch ? undefined : batch.sessionMode,
          clearPendingPermissions: batch.clearPendingPermissions,
          unarchive: batch.unarchive,
          waitForCommandOutcome: batch.waitForProviderOutcome,
          runOptions: {
            clientMessageId: batch.messageIds[0],
            turnAuthorization: batch.turnAuthorization,
            ...(peerHandoff
              ? {
                  waitForProviderPrompt: true,
                  onPeerPromptSubmitting: peerHandoff.onSubmitting,
                  onPeerPromptAccepted: peerHandoff.onAccepted,
                }
              : {}),
          },
          beforeDispatch: async () => {
            if (batch.shouldReportUpward) {
              try {
                registration = await registerParentFinishSubscription({
                  agentId: batch.recipientId,
                  serverId,
                  agentManager,
                  agentStorage,
                  finishSubscriptions,
                  logger: this.logger,
                });
              } catch (error) {
                this.logger.warn(
                  { err: error, agentId: batch.recipientId },
                  "Failed to register parent finish subscription",
                );
              }
            }
            if (batch.validateDispatch) {
              await batch.validateDispatch();
              if (batch.sessionMode && !batch.turnAuthorization)
                await agentManager.setAgentMode(batch.recipientId, batch.sessionMode);
            }
            // Run queue preparation before reserving a turn so it can be deferred at shutdown.
            await batch.beforeProviderDispatch();
            await batch.validateDispatch?.();
            prepared = true;
          },
          logger: this.logger,
        })
          .then(async (result) => {
            if (!prepared) throw new Error("Recipient was archived before message dispatch");
            if (result.disposition === "turn_started" && peerHandoff) {
              await peerHandoff.wait(result.started, agentManager, batch.recipientId);
            } else if (result.disposition === "turn_started") {
              await waitForAgentRunStartWithTimeout(
                agentManager,
                batch.recipientId,
                result.started,
              );
            }
            if (result.disposition !== "out_of_band") {
              dispatched = true;
              registration?.accept();
            }
            return result;
          })
          .finally(async () => {
            if (!dispatched) {
              await registration?.reject().catch((error) => {
                this.logger.warn(
                  { err: error, agentId: batch.recipientId },
                  "Failed to reject parent finish subscription",
                );
              });
            }
          });
        return disposition;
      },
      awaitStart: (agentId, started) =>
        waitForAgentRunStartWithTimeout(agentManager, agentId, started),
      onError: (err, batch) =>
        this.logger.error(
          { err, agentId: batch.recipientId, messageIds: batch.messageIds },
          "Agent message batch dispatch failed",
        ),
    });
    this.agentMessages.observeRemoteChild = (parentId, childServerId, childId, active) => {
      const children = this.remoteInboxChildren.get(parentId) ?? new Set<string>();
      const key = JSON.stringify([childServerId, childId]);
      if (active) {
        children.add(key);
        this.remoteInboxChildren.set(parentId, children);
      } else {
        children.delete(key);
        if (!children.size) this.remoteInboxChildren.delete(parentId);
      }
      this.agentMessages.refreshInbox?.();
    };
    this.agentMessages.isRemoteFinishSuperseded = (address, messageId) =>
      this.isRemoteFinishedSuperseded(address, messageId);
    const receiptStores = resolveAgentMessageReceiptStores(paseoHome, wsConfig.messageReceipts);
    this.messageReceipts = receiptStores.messages;
    this.parentReportReceipts = receiptStores.parentReports;
    this.creationService = new CreationService(
      join(paseoHome, "creations"),
      this.logger.child({ module: "creation" }),
      (snapshot) => this.validateCompletedCreation(snapshot),
      join(paseoHome, "agent-requests"),
    );
    this.projectRegistry = projectRegistry ?? createNoopProjectRegistry();
    this.workspaceRegistry = workspaceRegistry ?? createNoopWorkspaceRegistry();
    this.durableItems = openDurableItemStore({
      paseoHome,
      serverId,
      workspaceRegistry: this.workspaceRegistry,
      agentStorage: this.agentStorage,
    });
    this.workspaceLabelService = workspaceLabelService ?? null;
    const requiredServices = requireWebSocketServices({
      scheduleService,
      checkoutDiffManager,
    });
    this.scheduleService = requiredServices.scheduleService;
    this.checkoutDiffManager = requiredServices.checkoutDiffManager;
    this.github = github ?? createGitHubService();
    this.workspaceGitService = workspaceGitService ?? createFallbackWorkspaceGitService();
    this.worktreesRoot = daemonRuntimeConfig?.worktreesRoot;
    this.configureRewindCheckpoints(paseoHome);
    this.workspaceBaseBranch = createWorkspaceBaseBranchService({
      paseoHome,
      worktreesRoot: this.worktreesRoot,
      workspaceRegistry: this.workspaceRegistry,
      workspaceGitService: this.workspaceGitService,
    });
    this.workspaceAutoName = workspaceAutoName;
    this.downloadTokenStore = downloadTokenStore;
    this.paseoHome = paseoHome;
    this.connectedHosts = new ConnectedHosts(
      paseoHome,
      { serverId, label: getHostName() },
      { onFinishReportConfirm: (request) => this.confirmParentReport(request) },
    );
    this.hostProxy = wsConfig.hostProxy;
    this.passwordHash = auth?.password;
    this.daemonConfigStore = daemonConfigStore;
    this.mcpBaseUrl = mcpBaseUrl;
    this.assignOptionalServices({
      speech,
      terminalManager,
      dictation,
      onLifecycleIntent,
      prepareLifecycleIntent,
      serviceProxy,
      scriptRuntimeStore,
      onBranchChanged,
      getDaemonTcpPort,
      getDaemonTcpHost,
      serviceProxyPublicBaseUrl,
      resolveScriptHealth,
    });
    if (!providerSnapshotManager) {
      throw new Error("providerSnapshotManager is required");
    }
    this.providerSnapshotManager = providerSnapshotManager;
    this.serverCapabilities = buildServerCapabilities({
      readiness: this.speech?.getReadiness() ?? null,
    });
    this.unsubscribeSpeechReadiness =
      this.speech?.onReadinessChange((snapshot) => {
        this.publishSpeechReadiness(snapshot);
      }) ?? null;
    const unsubscribeProviderConfig = attachMutableProviderConfigOwner({
      store: this.daemonConfigStore,
      providerSnapshotManager: this.providerSnapshotManager,
      updateProviderRegistry: (state) => this.agentManager.updateProviderRegistry(state),
    });
    const unsubscribeChange = this.daemonConfigStore.onChange((config) => {
      this.broadcastDaemonConfigChanged(config);
    });
    this.unsubscribeDaemonConfigChange = () => {
      unsubscribeProviderConfig();
      unsubscribeChange();
    };

    const pushLogger = this.logger.child({ module: "push" });
    this.pushNotifications = createPushNotifications({
      logger: pushLogger,
      filePath: join(paseoHome, "push-tokens.json"),
    });
    this.pushNotificationSender = pushNotificationSender ?? this.pushNotifications;

    this.agentManager.setAgentAttentionCallback((params) => {
      void this.broadcastAgentAttention(params).catch((err) => {
        this.logger.warn({ err, agentId: params.agentId }, "Failed to broadcast agent attention");
      });
    });

    this.wss = this.createWebSocketServer(server, wsConfig, auth);
    this.startRuntimeMetricsInterval();
    this.startApplicationSocketLeaseInterval();

    this.logger.info("WebSocket server initialized on /ws");
  }

  private configureRewindCheckpoints(paseoHome: string): void {
    this.agentManager.configureRewindCheckpoints?.({
      paseoHome,
      worktreesRoot: this.worktreesRoot,
      projects: this.projectRegistry,
      workspaces: this.workspaceRegistry,
      isWorkspaceArchiving: (workspaceId) =>
        isWorkspaceArchivePending(this.workspaceRegistry, workspaceId),
      hasActiveTerminal: async (cwd) => {
        const manager = this.terminalManager;
        if (!manager) return false;
        if (manager.getUnavailableError?.()) return true;
        const directories = new Set([
          cwd,
          ...manager
            .listDirectories()
            .filter((directory) => rewindDirectoriesOverlap(cwd, directory)),
        ]);
        const groups = await Promise.all(
          [...directories].map((directory) => manager.getTerminals(directory)),
        );
        return groups.some((terminals) =>
          terminals.some((terminal) => rewindDirectoriesOverlap(cwd, terminal.cwd)),
        );
      },
    });
  }

  private assignOptionalServices(params: {
    speech: SpeechService | null | undefined;
    terminalManager: TerminalManager | null | undefined;
    dictation: { finalTimeoutMs?: number } | undefined;
    onLifecycleIntent: ((intent: SessionLifecycleIntent) => void) | undefined;
    prepareLifecycleIntent: ((intent: SessionLifecycleIntent) => Promise<void>) | undefined;
    serviceProxy: ServiceProxySubsystem | null | undefined;
    scriptRuntimeStore: WorkspaceScriptRuntimeStore | null | undefined;
    onBranchChanged:
      | ((workspaceId: string, oldBranch: string | null, newBranch: string | null) => void)
      | undefined;
    getDaemonTcpPort: (() => number | null) | undefined;
    getDaemonTcpHost: (() => string | null) | undefined;
    serviceProxyPublicBaseUrl: string | null | undefined;
    resolveScriptHealth: ((hostname: string) => ScriptHealthState | null) | undefined;
  }): void {
    this.speech = params.speech ?? null;
    this.terminalManager = params.terminalManager ?? null;
    if (this.terminalManager) {
      this.unsubscribeTerminalActivity = this.terminalManager.subscribeTerminalActivity((event) => {
        const reason = resolveTerminalAttentionReason({
          attentionReason: event.activity?.attentionReason,
          previousState: event.previous?.state ?? null,
          state: event.activity?.state ?? null,
        });
        if (!reason) {
          return;
        }
        void this.broadcastTerminalAttention({
          terminalId: event.terminalId,
          cwd: event.cwd,
          ...(event.workspaceId ? { workspaceId: event.workspaceId } : {}),
          terminalName: event.name,
          reason,
        }).catch((err) => {
          this.logger.warn(
            { err, terminalId: event.terminalId },
            "Failed to broadcast terminal attention",
          );
        });
      });
    }
    this.dictation = params.dictation ?? null;
    this.onLifecycleIntent = params.onLifecycleIntent ?? null;
    this.prepareLifecycleIntent = params.prepareLifecycleIntent ?? null;
    this.serviceProxy = params.serviceProxy ?? null;
    this.scriptRuntimeStore = params.scriptRuntimeStore ?? null;
    this.onBranchChanged = params.onBranchChanged ?? null;
    this.getDaemonTcpPort = params.getDaemonTcpPort ?? null;
    this.getDaemonTcpHost = params.getDaemonTcpHost ?? null;
    this.serviceProxyPublicBaseUrl = params.serviceProxyPublicBaseUrl ?? null;
    this.resolveScriptHealth = params.resolveScriptHealth ?? null;
  }

  private createWebSocketServer(
    server: HTTPServer,
    wsConfig: WebSocketServerConfig,
    auth: DaemonAuthConfig | undefined,
  ): WebSocketServer {
    const password = auth?.password;
    const wss = new WebSocketServer({
      server,
      path: "/ws",
      maxPayload: MAX_WEBSOCKET_MESSAGE_BYTES,
      handleProtocols: (protocols) => selectWebSocketProtocol(protocols, password),
      verifyClient: ({ req }, callback) => {
        this.verifyWsUpgrade(
          req,
          wsConfig.getAllowedOrigins?.() ?? wsConfig.allowedOrigins ?? new Set(),
          wsConfig.getHostnames?.() ?? wsConfig.hostnames,
          callback,
        );
      },
    });
    wss.on("connection", (ws, request) => {
      const socket = Object.assign(ws, { maxFrameBytes: DIRECT_WEBSOCKET_FRAME_BYTES });
      if (isProtectedProxyIngress(server.address(), request.socket)) {
        this.protectedProxySources.add(socket);
      }
      void this.attachAuthenticatedSocket(socket, request, password);
    });
    return wss;
  }

  private startRuntimeMetricsInterval(): void {
    this.eventLoopDelayMonitor = monitorEventLoopDelay({ resolution: 10 });
    this.eventLoopDelayMonitor.enable();
    const runtimeMetricsInterval = setInterval(() => {
      this.flushRuntimeMetrics();
    }, WS_RUNTIME_METRICS_FLUSH_MS);
    this.runtimeMetricsInterval = runtimeMetricsInterval;
    (runtimeMetricsInterval as unknown as { unref?: () => void }).unref?.();
  }

  private startApplicationSocketLeaseInterval(): void {
    const interval = setInterval(() => {
      for (const ws of this.applicationSocketLease.listExpired()) {
        this.closePhysicalSocket({
          ws,
          logMessage: "Closing physical WebSocket with expired application lease",
        });
      }
    }, APPLICATION_SOCKET_LEASE_CHECK_INTERVAL_MS);
    this.applicationSocketLeaseInterval = interval;
    (interval as unknown as { unref?: () => void }).unref?.();
  }

  // Main-loop stall visibility: terminal frames and agent traffic share one event
  // loop, so delay percentiles here are the ground truth for "the daemon is busy".
  private snapshotEventLoopDelay(): { p50Ms: number; p99Ms: number; maxMs: number } | null {
    const monitor = this.eventLoopDelayMonitor;
    if (!monitor) {
      return null;
    }
    const toMs = (nanoseconds: number): number => Math.round(nanoseconds / 1e5) / 10;
    const snapshot = {
      p50Ms: toMs(monitor.percentile(50)),
      p99Ms: toMs(monitor.percentile(99)),
      maxMs: toMs(monitor.max),
    };
    monitor.reset();
    return snapshot;
  }

  private verifyWsUpgrade(
    req: IncomingMessage,
    allowedOrigins: Set<string>,
    hostnames: HostnamesConfig | undefined,
    callback: (res: boolean, code?: number, message?: string) => void,
  ): void {
    if (this.connectionLifecycle !== "accepting") {
      callback(false, 503, "Server not ready");
      return;
    }

    const requestMetadata = extractSocketRequestMetadata(req);
    const origin = requestMetadata.origin;
    const requestHost = requestMetadata.host ?? null;
    if (requestHost && !isHostnameAllowed(requestHost, hostnames)) {
      this.incrementRuntimeCounter("hostRejected");
      this.logger.warn(
        { ...requestMetadata, host: requestHost },
        "Rejected connection from disallowed host",
      );
      callback(false, 403, "Host not allowed");
      return;
    }
    if (!origin || isDaemonOriginAllowed(origin, requestHost, allowedOrigins)) {
      callback(true);
    } else {
      this.incrementRuntimeCounter("originRejected");
      this.logger.warn({ ...requestMetadata, origin }, "Rejected connection from origin");
      callback(false, 403, "Origin not allowed");
    }
  }

  private async attachAuthenticatedSocket(
    ws: WebSocket,
    request: IncomingMessage,
    password: string | undefined,
  ): Promise<void> {
    // Header validation is asynchronous. Buffer frames until the socket has a
    // pending hello handler so an eager client cannot lose its first message.
    ws.pause();
    try {
      // COMPAT(headerAuth): added in v0.9.1, remove after 2027-03-24.
      const protocol = extractWsBearerProtocol(request.headers["sec-websocket-protocol"]);
      const token =
        extractHttpBearerToken(request.headers.authorization) ?? extractWsBearerToken(protocol);
      const hasHeaderCredential = token !== null;
      if (password && hasHeaderCredential) {
        const requestMetadata = extractSocketRequestMetadata(request);
        const isAuthorized = await isBearerTokenValidAsync({ password, token });
        if (!isAuthorized) {
          const reason = "Incorrect password";
          this.logger.warn(
            { ...requestMetadata, hasToken: true },
            "Rejected WebSocket connection with invalid daemon password",
          );
          ws.close(WS_CLOSE_DAEMON_AUTH_FAILED, reason);
          return;
        }
      }

      await this.attachSocket(
        ws,
        request,
        undefined,
        false,
        hasHeaderCredential ? OWNER_SESSION_ADMISSION : null,
      );
    } finally {
      ws.resume();
    }
  }

  public broadcast(message: WSOutboundMessage): void {
    // External setup producers (MCP and schedules) publish once, including when no
    // clients are connected. Session-owned observers perform the source routing.
    if (message.type === "session" && message.message.type === "workspace_setup_progress") {
      const { workspaceId, subscriptionId: _subscriptionId, ...snapshot } = message.message.payload;
      this.workspaceSetupObservation.publish(workspaceId, snapshot);
      return;
    }
    if (message.type === "session") {
      for (const connection of new Set(this.sessions.values())) {
        connection.session.publish(message.message);
      }
      return;
    }
    this.sendMessageToSockets(this.sessions.keys(), message);
  }

  public listSessions(): Session[] {
    return Array.from(
      new Set(
        [...this.sessions.values(), ...this.externalSessionsByKey.values()].map(
          (connection) => connection.session,
        ),
      ),
    );
  }

  public async publishWorkspaceUpdates(workspaceIds: Iterable<string>): Promise<void> {
    const ids = Array.from(workspaceIds);
    await Promise.all(
      this.listSessions().map(async (session) => {
        try {
          await session.emitWorkspaceUpdatesForExternalWorkspaceIds(ids);
        } catch (error) {
          this.logger.warn({ err: error }, "Failed to publish workspace updates");
        }
      }),
    );
  }

  public publishProjectUpdate(update: ProjectUpdate): void {
    for (const session of this.listSessions()) {
      void session
        .emitProjectUpdate(update)
        .catch((error) => this.logger.warn({ err: error }, "Failed to publish project update"));
    }
  }

  public publishScriptStatusUpdate(message: ScriptStatusUpdateMessage): void {
    for (const session of this.listSessions()) {
      session.emitServerMessage(message);
    }
  }

  public publishSpeechReadiness(readiness: SpeechReadinessSnapshot | null): void {
    this.updateServerCapabilities(buildServerCapabilities({ readiness }));
  }

  public updateServerCapabilities(capabilities: ServerCapabilities | null | undefined): void {
    const next = capabilities ?? undefined;
    if (areServerCapabilitiesEqual(this.serverCapabilities, next)) {
      return;
    }
    this.serverCapabilities = next;
    this.broadcastCapabilitiesUpdate();
  }

  public async attachExternalSocket(
    ws: WebSocketLike,
    metadata?: ExternalSocketMetadata,
    admission: SessionAdmission | null = null,
    initialHello?: WSHelloMessage,
  ): Promise<void> {
    if (metadata?.transport === "relay") {
      this.incrementRuntimeCounter("relayExternalSocketAttached");
      if (metadata.securityMode === "protected") this.protectedProxySources.add(ws);
    }
    await this.attachSocket(ws, undefined, metadata, false, admission, initialHello);
  }

  public async attachPluginSocket(
    pluginId: string,
    ws: WebSocketLike,
  ): Promise<{ closed: Promise<void> }> {
    if (this.connectionLifecycle === "stopping") {
      throw new Error(`Cannot attach plugin session while shutting down: ${pluginId}`);
    }
    let resolve: () => void = () => undefined;
    const closed = new Promise<void>((finish) => {
      resolve = finish;
    });
    this.pluginSocketIds.set(ws, pluginId);
    this.pluginSocketCleanup.set(ws, resolve);
    try {
      await this.attachSocket(ws, undefined, undefined, true, OWNER_SESSION_ADMISSION);
    } catch (error) {
      this.pluginSocketIds.delete(ws);
      this.finishPluginSocketCleanup(ws);
      throw error;
    }
    return { closed };
  }

  public updatePrincipalPermissions(
    principalId: string,
    permissions: readonly DaemonPermission[],
  ): void {
    for (const [socket, link] of this.hostLinks) {
      if (this.sessions.get(socket)?.principalId === principalId) {
        link.close("permission_denied");
        this.hostLinks.delete(socket);
      }
    }
    for (const pending of this.pendingConnections.values()) {
      if (pending.admission?.principalId === principalId) {
        pending.admission = { ...pending.admission, permissions };
      }
    }
    for (const connection of new Set(this.externalSessionsByKey.values())) {
      if (connection.principalId === principalId) {
        connection.session.setPermissions(
          connection.permissionCeiling
            ? permissions.filter((permission) => connection.permissionCeiling!.includes(permission))
            : permissions,
        );
      }
    }
  }

  public prepareForShutdown(): void {
    this.connectionLifecycle = "stopping";
  }

  public beginAcceptingConnections(): void {
    if (this.connectionLifecycle === "starting") {
      this.connectionLifecycle = "accepting";
    }
  }

  public async close(options?: { waitForAgentMessages?: boolean }): Promise<void> {
    this.prepareForShutdown();
    this.unsubscribeProxyTrust?.();
    if (options?.waitForAgentMessages !== false) await this.agentMessages.close();
    await this.connectedHosts.close();
    this.unsubscribeSpeechReadiness?.();
    this.unsubscribeSpeechReadiness = null;
    this.unsubscribeDaemonConfigChange?.();
    this.unsubscribeDaemonConfigChange = null;
    this.unsubscribeTerminalActivity?.();
    this.unsubscribeTerminalActivity = null;
    if (this.runtimeMetricsInterval) {
      clearInterval(this.runtimeMetricsInterval);
      this.runtimeMetricsInterval = null;
    }
    if (this.applicationSocketLeaseInterval) {
      clearInterval(this.applicationSocketLeaseInterval);
      this.applicationSocketLeaseInterval = null;
    }
    this.applicationSocketLease.clear();
    this.flushRuntimeMetrics({ final: true });
    this.eventLoopDelayMonitor?.disable();
    this.eventLoopDelayMonitor = null;

    const uniqueConnections = new Set<SessionConnection>([
      ...this.sessions.values(),
      ...this.externalSessionsByKey.values(),
    ]);

    const pendingSockets = new Set<WebSocketLike>(this.pendingConnections.keys());
    for (const pending of this.pendingConnections.values()) {
      if (pending.helloTimeout) {
        clearTimeout(pending.helloTimeout);
        pending.helloTimeout = null;
      }
    }

    const cleanupPromises: Promise<void>[] = [];
    for (const connection of uniqueConnections) {
      if (connection.lifecycle === "reconnectable" && connection.externalDisconnectCleanupTimeout) {
        clearTimeout(connection.externalDisconnectCleanupTimeout);
        connection.externalDisconnectCleanupTimeout = null;
      }

      cleanupPromises.push(Promise.resolve(connection.session.cleanup()));
      for (const ws of connection.sockets) {
        cleanupPromises.push(
          new Promise<void>((resolve) => {
            // WebSocket.CLOSED = 3
            if (ws.readyState === 3) {
              resolve();
              return;
            }
            ws.once("close", () => resolve());
            ws.close();
          }),
        );
      }
    }

    for (const ws of pendingSockets) {
      cleanupPromises.push(
        new Promise<void>((resolve) => {
          if (ws.readyState === 3) {
            resolve();
            return;
          }
          ws.once("close", () => resolve());
          ws.close();
        }),
      );
    }

    await Promise.all(cleanupPromises);
    this.providerSnapshotManager.destroy();
    await this.checkoutDiffManager.dispose();
    await this.workspaceGitService.dispose();
    this.pendingConnections.clear();
    this.sessions.clear();
    this.socketIdentities.clear();
    this.externalSessionsByKey.clear();
    this.wss.close();
  }

  private sendToClient(ws: WebSocketLike, message: WSOutboundMessage): void {
    this.sendMessageToSockets([ws], message, true);
  }

  private sendMessageToSockets(
    sockets: Iterable<WebSocketLike>,
    message: WSOutboundMessage,
    reportRejection = false,
  ): void {
    const prepared = this.prepareJsonDelivery(sockets, message, reportRejection);
    if (!prepared) return;
    for (const ws of prepared.sockets) {
      this.sendFrameToClient(ws, prepared.payload, prepared.bytes, () => {
        this.runtimeMetrics.recordOutboundMessage(message, ws.bufferedAmount);
      });
    }
  }

  private prepareJsonDelivery(
    sockets: Iterable<WebSocketLike>,
    message: WSOutboundMessage,
    reportRejection: boolean,
  ): { sockets: WebSocketLike[]; payload: string; bytes: number } | null {
    const writableSockets = [...sockets].filter((ws) => {
      if (!this.canSendSocketFrame(ws)) return false;
      if (
        message.type === "session" &&
        this.sessions.get(ws)?.session.delivery.permits(ws, message.message) !== true
      ) {
        this.incrementRuntimeCounter("applicationJsonRejected");
        // Legacy broadcasts intentionally exclude modern sockets. Targeted failures are bugs.
        if (reportRejection)
          this.logger.warn(
            {
              messageType: message.message.type,
              status:
                message.message.type === "status" ? message.message.payload.status : undefined,
            },
            "ws_application_delivery_denied",
          );
        return false;
      }
      return this.ensureOutboundCapacity(ws, 0);
    });
    if (writableSockets.length === 0) {
      return null;
    }

    let payload: string;
    try {
      payload = JSON.stringify(message);
    } catch (err) {
      this.logger.warn({ err }, "ws_serialize_failed");
      return null;
    }

    return { sockets: writableSockets, payload, bytes: outboundFrameByteLength(payload) };
  }

  private sendHelloResponse(ws: WebSocketLike, session: Session, hello: WSHelloMessage): void {
    // The peer learns our support from this ordinary response before receiving chunks.
    this.sendToClient(ws, this.createServerInfoMessage(session));
    this.chunkedSocket(ws).enabled = hello.capabilities?.[CLIENT_CAPS.binaryChunkingV1] === true;
  }

  private readonly chunkedSockets = new WeakMap<WebSocketLike, ChunkedTransport>();
  private readonly closedSocketDelivery = new WeakSet<WebSocketLike>();
  private readonly socketDrainCancellations = new WeakMap<WebSocketLike, Set<() => void>>();

  private chunkedSocket(ws: WebSocketLike): ChunkedTransport {
    let transport = this.chunkedSockets.get(ws);
    if (!transport) {
      const onWriteFailure = (err: unknown) => {
        if (err instanceof SourceDeliveryClosedError) return;
        this.closePhysicalSocket({
          ws,
          logMessage: "Closing physical WebSocket after outbound framing failure",
          logFields: { err },
          // A transport can start closing before the failed write's callback runs.
          reportWhileClosing: true,
        });
      };
      const onWrite = (err?: Error) => {
        if (err) onWriteFailure(err);
      };
      transport = new ChunkedTransport({
        frameBytes: ws.maxFrameBytes ?? 32 * 1024 * 1024,
        supportsConcurrentWrites: ws.supportsConcurrentWrites,
        onFailure: onWriteFailure,
        send: (frame, waitForDrain) => {
          if (!this.canSendSocketFrame(ws)) throw new SourceDeliveryClosedError();
          if (waitForDrain) return this.sendPhysicalFrameAndWait(ws, frame);
          if (!physicalSocketHasCapacity(ws, outboundFrameByteLength(frame))) {
            this.closeAtOutboundHighWater(ws);
            throw new SourceDeliveryClosedError();
          }
          try {
            // Observe physical failures without making these frames wait for drain.
            const sent = ws.send(frame, onWrite);
            void sent?.catch(onWriteFailure);
            if (!this.canSendSocketFrame(ws)) throw new SourceDeliveryClosedError();
          } catch (err) {
            onWriteFailure(err);
            throw err;
          }
        },
        deliver: (frame) =>
          this.handleRawMessage(ws, typeof frame === "string" ? frame : Buffer.from(frame)),
      });
      this.chunkedSockets.set(ws, transport);
    }
    return transport;
  }

  private socketBufferedAmount(ws: WebSocketLike): number | null {
    const queued = this.chunkedSockets.get(ws)?.queuedByteLength ?? 0;
    if (typeof ws.bufferedAmount === "number") return ws.bufferedAmount + queued;
    return queued > 0 ? queued : null;
  }

  private canSendSocketFrame(ws: WebSocketLike): boolean {
    return ws.readyState === 1 && !this.closedSocketDelivery.has(ws);
  }

  private sendPhysicalFrameAndWait(ws: WebSocketLike, frame: string | Uint8Array): Promise<void> {
    const waiters = this.socketDrainCancellations.get(ws) ?? new Set<() => void>();
    this.socketDrainCancellations.set(ws, waiters);
    return new Promise<void>((resolve, reject) => {
      const fail = (error: unknown) => {
        waiters.delete(cancel);
        reject(error);
      };
      const cancel = () => fail(new SourceDeliveryClosedError());
      // Closing the socket must release the framing queue even if a write
      // callback never runs. Remove settled waiters so idle sockets retain none.
      waiters.add(cancel);
      void sendBoundedPhysicalFrameAndWait({
        socket: ws,
        frame,
        onHighWater: () => this.closeAtOutboundHighWater(ws),
      }).then((sent) => {
        waiters.delete(cancel);
        if (sent) resolve();
        else cancel();
        return undefined;
      }, fail);
    });
  }

  private async sendSocketFrame(
    ws: WebSocketLike,
    frame: string | Uint8Array,
    bytes: number,
    waitForDrain = false,
  ): Promise<void> {
    if (!this.canSendSocketFrame(ws)) throw new SourceDeliveryClosedError();
    const transport = this.chunkedSocket(ws);
    const admittedBytes = transport.isWriting
      ? bytes
      : Math.min(bytes, ws.maxFrameBytes ?? 32 * 1024 * 1024);
    if (!this.ensureOutboundCapacity(ws, admittedBytes)) throw new SourceDeliveryClosedError();
    try {
      await transport.send(frame, { waitForDrain, byteLength: bytes });
    } catch (err) {
      if (err instanceof SourceDeliveryClosedError) throw err;
      if (!this.canSendSocketFrame(ws)) throw new SourceDeliveryClosedError(err);
      this.logger.warn({ err }, "ws_send_failed");
      throw err;
    }
  }

  private async sendMessageToClientAndWait(
    ws: WebSocketLike,
    message: WSOutboundMessage,
  ): Promise<void> {
    if (!this.canSendSocketFrame(ws)) throw new SourceDeliveryClosedError();
    const prepared = this.prepareJsonDelivery([ws], message, true);
    if (!prepared) {
      if (!this.canSendSocketFrame(ws)) throw new SourceDeliveryClosedError();
      throw new Error("Source message delivery unavailable");
    }
    await this.sendSocketFrame(ws, prepared.payload, prepared.bytes, true);
    this.runtimeMetrics.recordOutboundMessage(message, ws.bufferedAmount);
  }

  private sendBinaryToClient(ws: WebSocketLike, frame: Uint8Array, reportRejection = true): void {
    if (!this.canSendSocketFrame(ws)) return;
    if (!this.sessions.get(ws)?.session.delivery.permitsBinary(ws, frame)) {
      this.incrementRuntimeCounter("applicationBinaryRejected");
      if (reportRejection)
        this.logger.warn({ bytes: frame.byteLength }, "ws_application_binary_delivery_denied");
      return;
    }
    this.sendFrameToClient(ws, frame, outboundFrameByteLength(frame), () => {
      this.runtimeMetrics.recordOutboundBinaryFrame(ws.bufferedAmount);
    });
  }

  private async sendBinaryToClientAndWait(ws: WebSocketLike, frame: Uint8Array): Promise<void> {
    if (!this.canSendSocketFrame(ws)) throw new SourceDeliveryClosedError();
    if (!this.sessions.get(ws)?.session.delivery.permitsBinary(ws, frame)) {
      this.incrementRuntimeCounter("applicationBinaryRejected");
      this.logger.warn({ bytes: frame.byteLength }, "ws_application_binary_delivery_denied");
      throw new Error("Source binary delivery denied");
    }
    await this.sendSocketFrame(ws, frame, frame.byteLength, true);
    this.runtimeMetrics.recordOutboundBinaryFrame(ws.bufferedAmount);
  }

  private sendFrameToClient(
    ws: WebSocketLike,
    frame: string | Uint8Array,
    frameBytes: number,
    recordSent: () => void,
  ): void {
    void this.sendSocketFrame(ws, frame, frameBytes).then(recordSent, () => {});
  }

  private ensureOutboundCapacity(ws: WebSocketLike, frameBytes: number): boolean {
    if (!this.canSendSocketFrame(ws)) return false;
    if (
      physicalSocketHasCapacity(
        { bufferedAmount: this.socketBufferedAmount(ws) ?? undefined },
        frameBytes,
      )
    )
      return true;

    this.closeAtOutboundHighWater(ws);
    return false;
  }

  private closeAtOutboundHighWater(ws: WebSocketLike): void {
    this.closePhysicalSocket({
      ws,
      logMessage: "Closing physical WebSocket at outbound high-water mark",
      logFields: {
        bufferedAmount: ws.bufferedAmount,
        maxBufferedBytes: MAX_PHYSICAL_SOCKET_BUFFERED_BYTES,
      },
    });
  }

  private stopSocketDelivery(ws: WebSocketLike): void {
    this.closedSocketDelivery.add(ws);
    this.chunkedSockets.get(ws)?.close();
    const waiters = this.socketDrainCancellations.get(ws);
    this.socketDrainCancellations.delete(ws);
    for (const cancel of waiters ?? []) cancel();
    this.applicationSocketLease.release(ws);
  }

  private closePhysicalSocket(params: ClosePhysicalSocketParams): void {
    const { ws, logMessage, logFields, reportWhileClosing } = params;
    if (this.closedSocketDelivery.has(ws)) return;
    const isOpen = ws.readyState === 1;
    this.stopSocketDelivery(ws);
    if (!isOpen && !reportWhileClosing) return;
    const identity = this.socketIdentities.get(ws);
    this.logger.warn(
      {
        ...(identity ? toConnectionLogFields(identity) : {}),
        ...logFields,
      },
      logMessage,
    );
    if (!isOpen) return;
    try {
      // A close frame queues behind application data, so it cannot enforce a
      // hard memory cutoff. Production transports expose terminate().
      if (ws.terminate) {
        ws.terminate();
      } else {
        ws.close();
      }
    } catch (err) {
      this.logger.warn(
        { err, ...(identity ? toConnectionLogFields(identity) : {}) },
        "ws_close_failed",
      );
    }
  }

  private sendToConnection(connection: SessionConnection, message: WSOutboundMessage): void {
    this.sendMessageToSockets(connection.sockets, message);
  }

  private sendBinaryToConnection(connection: SessionConnection, frame: Uint8Array): void {
    for (const ws of connection.sockets) {
      this.sendBinaryToClient(ws, frame, false);
    }
  }

  private async attachSocket(
    ws: WebSocketLike,
    request?: unknown,
    metadata?: ExternalSocketMetadata,
    allowDuringStartup = false,
    admission: SessionAdmission | null = null,
    initialHello?: WSHelloMessage,
  ): Promise<void> {
    if (
      this.connectionLifecycle === "stopping" ||
      (this.connectionLifecycle === "starting" && !allowDuringStartup)
    ) {
      try {
        ws.close(WS_CLOSE_SERVER_SHUTDOWN, "Server shutting down");
      } catch {
        // ignore close errors
      }
      return;
    }

    const requestMetadata = extractSocketRequestMetadata(request);
    const identity = createWebSocketConnectionIdentity(requestMetadata, metadata);
    this.socketIdentities.set(ws, identity);
    const connectionLogger = this.logger.child(toConnectionLogFields(identity));

    const pending: PendingConnection = {
      connectionLogger,
      helloTimeout: null,
      identity,
      admission,
      authenticating: false,
    };
    const timeout = setTimeout(() => {
      if (this.pendingConnections.get(ws) !== pending) {
        return;
      }
      pending.helloTimeout = null;
      this.pendingConnections.delete(ws);
      pending.connectionLogger.warn(
        { ...toConnectionLogFields(identity), timeoutMs: HELLO_TIMEOUT_MS },
        "Closing connection due to missing hello",
      );
      try {
        ws.close(WS_CLOSE_HELLO_TIMEOUT, "Hello timeout");
      } catch {
        // ignore close errors
      }
    }, HELLO_TIMEOUT_MS);
    pending.helloTimeout = timeout;
    (timeout as unknown as { unref?: () => void }).unref?.();

    this.pendingConnections.set(ws, pending);
    this.incrementRuntimeCounter("connectedAwaitingHello");
    this.bindSocketHandlers(ws);

    pending.connectionLogger.info(
      {
        ...toConnectionLogFields(identity),
        totalPendingConnections: this.pendingConnections.size,
      },
      "Client connected; awaiting hello",
    );
    if (initialHello) await this.handleHelloSafely({ ws, message: initialHello, pending });
  }

  private createSessionConnection(params: {
    ws: WebSocketLike;
    clientId: string;
    appVersion: string | null;
    clientCapabilities: Record<string, unknown> | null;
    connectionLogger: pino.Logger;
    lifecycle: { kind: "reconnectable" } | { kind: "ephemeral-plugin"; pluginId: string };
    admission: SessionAdmission;
    permissionCeiling?: readonly DaemonPermission[];
    sessionKey: string;
  }): SessionConnection {
    const { ws, clientId, appVersion, clientCapabilities, connectionLogger, lifecycle, admission } =
      params;
    let connection: SessionConnection | null = null;

    const session = this.createSocketSession({
      clientId,
      appVersion,
      clientCapabilities,
      permissions: admission.permissions,
      sourceId:
        lifecycle.kind === "ephemeral-plugin"
          ? `plugin:${lifecycle.pluginId}`
          : admission.principalId,
      connectionLogger,
      onMessage: (msg) => {
        if (!connection) {
          return;
        }
        this.sendToConnection(connection, wrapSessionMessage(msg));
      },
      onMessageToSource: async (source, msg) => {
        if (!connection || !connection.sockets.has(source as WebSocketLike)) {
          throw new SourceDeliveryClosedError();
        }
        await this.sendMessageToClientAndWait(source as WebSocketLike, wrapSessionMessage(msg));
      },
      onBinaryMessage: (frame) => {
        if (!connection) {
          return;
        }
        this.sendBinaryToConnection(connection, frame);
      },
      onBinaryMessageToSource: async (source, frame) => {
        if (!connection || !connection.sockets.has(source as WebSocketLike)) {
          throw new SourceDeliveryClosedError();
        }
        await this.sendBinaryToClientAndWait(source as WebSocketLike, frame);
      },
      getTransportBufferedAmount: (source) => {
        if (!connection) {
          return null;
        }
        if (source) return this.socketBufferedAmount(source as WebSocketLike);
        // Relay-attached sockets are a WebSocketLike that doesn't expose
        // bufferedAmount. Return null when no socket gives a signal so the
        // terminal fallback can't mistake "no signal" for "client keeping up";
        // a direct ws reports its real buffered bytes (0 when drained).
        let maxBuffered: number | null = null;
        for (const socket of connection.sockets) {
          const buffered = this.socketBufferedAmount(socket);
          if (buffered !== null) maxBuffered = Math.max(maxBuffered ?? 0, buffered);
        }
        return maxBuffered;
      },
      onLifecycleIntent: (intent) => {
        this.onLifecycleIntent?.(intent);
      },
      prepareLifecycleIntent: async (intent) => {
        await this.prepareLifecycleIntent?.(intent);
      },
      hubExecutionAgents: admission.hubExecutionAgents,
      hubRelationships: this.hubRelationships ?? undefined,
    });

    const base: SessionConnectionBase = {
      session,
      principalId: admission.principalId,
      hubExecutionAgents: admission.hubExecutionAgents,
      sessionKey: params.sessionKey,
      permissionCeiling: params.permissionCeiling,
      clientId,
      appVersion,
      clientCapabilities,
      connectionLogger,
      sockets: new Set([ws]),
    };
    connection =
      lifecycle.kind === "ephemeral-plugin"
        ? { ...base, lifecycle: "ephemeral-plugin", pluginId: lifecycle.pluginId }
        : { ...base, lifecycle: "reconnectable", externalDisconnectCleanupTimeout: null };
    session.updateClientCapabilities(clientCapabilities, ws, appVersion);
    return connection;
  }

  private createSocketSession(options: SocketSessionOptions): Session {
    let session!: Session;
    session = new Session({
      connectedHosts: this.connectedHosts,
      getConnectedHostBufferedAmount: () => {
        let total = 0;
        for (const socket of this.sessions.keys()) {
          if (socket instanceof VirtualHostSocket) continue;
          const buffered = this.socketBufferedAmount(socket);
          if (buffered === null) return null;
          total += buffered;
        }
        return total;
      },
      sourceId: options.sourceId,
      authenticateAgentNotificationEvent: (sourceAgentServerId) =>
        session.delivery.currentSource instanceof VirtualHostSocket &&
        this.canAcceptAgentNotificationEvent(session, sourceAgentServerId),
      browserToolsBroker: this.browserToolsBroker,
      clientId: options.clientId,
      appVersion: options.appVersion,
      clientCapabilities: options.clientCapabilities,
      permissions: options.permissions,
      onMessage: options.onMessage,
      onMessageToSource: options.onMessageToSource,
      onBinaryMessage: options.onBinaryMessage,
      onBinaryMessageToSource: options.onBinaryMessageToSource,
      getTransportBufferedAmount: options.getTransportBufferedAmount,
      onLifecycleIntent: options.onLifecycleIntent,
      prepareLifecycleIntent: options.prepareLifecycleIntent,
      logger: options.connectionLogger.child({ module: "session" }),
      publishWorkspaceArchiveUpdates: (workspaceIds) => this.publishWorkspaceUpdates(workspaceIds),
      onWorkspaceRecovered: async (workspace) => {
        await Promise.all(
          this.listSessions().map((activeSession) =>
            activeSession.refreshRecoveredWorkspaceForExternalMutation(workspace),
          ),
        );
      },
      publishScriptStatusUpdate: (message) => this.publishScriptStatusUpdate(message),
      downloadTokenStore: this.downloadTokenStore,
      pushNotifications: this.pushNotifications,
      paseoHome: this.paseoHome,
      worktreesRoot: this.worktreesRoot,
      agentManager: this.agentManager,
      agentStorage: this.agentStorage,
      messageReceipts: this.messageReceipts,
      agentMessages: this.agentMessages,
      finishSubscriptions: this.finishSubscriptions,
      creationService: this.creationService,
      projectRegistry: this.projectRegistry,
      workspaceRegistry: this.workspaceRegistry,
      durableItems: this.durableItems,
      workspaceBaseBranch: this.workspaceBaseBranch,
      workspaceLabelService: this.workspaceLabelService ?? undefined,
      directorySync: this.directorySync,
      scheduleService: this.scheduleService,
      checkoutDiffManager: this.checkoutDiffManager,
      github: this.github,
      workspaceGitService: this.workspaceGitService,
      workspaceRuntimeStore: this.workspaceRuntimeStore,
      workspaceAutoName: this.workspaceAutoName,
      daemonConfigStore: this.daemonConfigStore,
      pluginRuntime: this.pluginRuntime,
      orchestrationSkills: this.orchestrationSkills,
      mcpBaseUrl: this.mcpBaseUrl,
      stt: () => this.speech?.resolveStt() ?? null,
      sttLanguage: this.speech?.resolveSttLanguage() ?? "en",
      tts: () => this.speech?.resolveTts() ?? null,
      speechModels: this.speech,
      terminalManager: this.terminalManager,
      providerSnapshotManager: this.providerSnapshotManager,
      hubExecutionAgents: options.hubExecutionAgents,
      hubRelationships: options.hubRelationships,
      serviceProxy: this.serviceProxy ?? undefined,
      scriptRuntimeStore: this.scriptRuntimeStore ?? undefined,
      workspaceSetupObservation: this.workspaceSetupObservation,
      workspaceSetupRuntime: this.workspaceSetupRuntime,
      workspaceArchiveOperations: this.workspaceArchiveOperations,
      onBranchChanged: this.onBranchChanged ?? undefined,
      getDaemonTcpPort: this.getDaemonTcpPort ?? undefined,
      getDaemonTcpHost: this.getDaemonTcpHost ?? undefined,
      serviceProxyPublicBaseUrl: this.serviceProxyPublicBaseUrl,
      resolveScriptHealth: this.resolveScriptHealth ?? undefined,
      voice: {
        turnDetection: () => this.speech?.resolveTurnDetection() ?? null,
      },
      voiceBridge: {
        registerVoiceSpeakHandler: (agentId, handler) => {
          if (this.voiceSpeakHandlers.has(agentId))
            throw new Error("Voice mode is already active for this agent");
          this.voiceSpeakHandlers.set(agentId, handler);
        },
        unregisterVoiceSpeakHandler: (agentId) => {
          this.voiceSpeakHandlers.delete(agentId);
        },
        registerVoiceCallerContext: (agentId, context) => {
          this.voiceCallerContexts.set(agentId, context);
        },
        unregisterVoiceCallerContext: (agentId) => {
          this.voiceCallerContexts.delete(agentId);
        },
      },
      dictation:
        this.dictation || this.speech
          ? {
              finalTimeoutMs: this.dictation?.finalTimeoutMs,
              stt: () => this.speech?.resolveDictationStt() ?? null,
              sttLanguage: this.speech?.resolveDictationSttLanguage() ?? "en",
              getSpeechReadiness: () => this.speech!.getReadiness(),
            }
          : undefined,
      serverId: this.serverId,
      daemonVersion: this.daemonVersion,
      daemonRuntimeConfig: this.daemonRuntimeConfig,
      getWebSocketRuntimeMetrics: () => this.lastRuntimeMetricsSnapshot,
    });
    return session;
  }

  private clearPendingConnection(ws: WebSocketLike): PendingConnection | null {
    const pending = this.pendingConnections.get(ws);
    if (!pending) {
      return null;
    }
    if (pending.helloTimeout) {
      clearTimeout(pending.helloTimeout);
      pending.helloTimeout = null;
    }
    this.pendingConnections.delete(ws);
    return pending;
  }

  private async handleHello(params: {
    ws: WebSocketLike;
    message: WSHelloMessage;
    pending: PendingConnection;
  }): Promise<void> {
    const { ws, message, pending } = params;

    if (message.protocolVersion < 1) {
      this.clearPendingConnection(ws);
      pending.connectionLogger.warn(
        {
          receivedProtocolVersion: message.protocolVersion,
          expectedProtocolVersion: WS_PROTOCOL_VERSION,
        },
        "Rejected hello due to protocol version mismatch",
      );
      await this.rejectHello(ws, message, "incompatible_protocol");
      return;
    }

    pending.authenticating = true;
    if (!pending.admission && !(await this.admitPendingHello(ws, message, pending))) return;

    const clientId = message.clientId.trim();
    if (clientId.length === 0) {
      this.clearPendingConnection(ws);
      pending.connectionLogger.warn("Rejected hello with empty clientId");
      try {
        ws.close(WS_CLOSE_INVALID_HELLO, "Invalid hello");
      } catch {
        // ignore close errors
      }
      return;
    }

    const pluginId = this.pluginSocketIds.get(ws);
    const expectedPluginClientId = pluginId ? createPluginClientId(pluginId) : null;
    if (
      (expectedPluginClientId !== null && clientId !== expectedPluginClientId) ||
      (expectedPluginClientId === null && isPluginClientId(clientId))
    ) {
      this.clearPendingConnection(ws);
      pending.connectionLogger.warn({ clientId }, "Rejected reserved plugin clientId");
      ws.close(WS_CLOSE_INVALID_HELLO, "Invalid plugin clientId");
      return;
    }

    this.clearPendingConnection(ws);
    let admitted = pending.admission;
    if (!admitted) throw new Error("Admitted hello has no session admission");
    if (message.sessionPermissions)
      admitted = {
        ...admitted,
        permissions: admitted.permissions.filter((permission) =>
          message.sessionPermissions!.includes(permission),
        ),
      };
    pending.admission = admitted;
    pending.identity.clientId = clientId;
    if (message.appVersion) {
      pending.identity.appVersion = message.appVersion;
    }
    const permissionCeiling = message.sessionPermissions;
    const sessionKey = sessionConnectionKey(admitted.principalId, clientId, permissionCeiling);
    const existing = pluginId ? undefined : this.externalSessionsByKey.get(sessionKey);
    if (existing) {
      this.resumeSession({ ws, message, pending, existing, admission: admitted });
      return;
    }

    const connectionLogger = pending.connectionLogger.child({ clientId });
    this.incrementRuntimeCounter("helloNew");
    const connection = this.createSessionConnection({
      ws,
      clientId,
      appVersion: message.appVersion ?? null,
      clientCapabilities: message.capabilities ?? null,
      connectionLogger,
      lifecycle: pluginId ? { kind: "ephemeral-plugin", pluginId } : { kind: "reconnectable" },
      admission: admitted,
      permissionCeiling,
      sessionKey,
    });
    connection.session.setRouted(message.routed === true);
    this.assignHostSource(connection, message, admitted.principalId, pluginId);
    this.sessions.set(ws, connection);
    if (connection.lifecycle === "reconnectable") {
      this.externalSessionsByKey.set(sessionKey, connection);
    }
    pending.identity.sessionId = connection.session.getSessionId();
    this.sendHelloResponse(ws, connection.session, message);
    connection.connectionLogger.info(
      {
        ...toConnectionLogFields(pending.identity),
        resumed: false,
        totalSessions: this.sessions.size,
      },
      "Client connected via hello",
    );
  }

  private handleHelloSafely(params: {
    ws: WebSocketLike;
    message: WSHelloMessage;
    pending: PendingConnection;
  }): Promise<void> {
    return this.handleHello(params).catch((error: unknown) => {
      try {
        this.handleRawMessageError({
          ws: params.ws,
          data: "",
          error,
          log: params.pending.connectionLogger,
        });
      } catch {
        // The error reporter must not turn a connection failure into a process failure.
      } finally {
        try {
          params.ws.close(WS_CLOSE_INVALID_HELLO, "Invalid hello");
        } catch {
          // The transport may already be closed.
        }
      }
    });
  }

  private async admitPendingHello(
    ws: WebSocketLike,
    message: WSHelloMessage,
    pending: PendingConnection,
  ): Promise<boolean> {
    if (pending.admission) return true;
    try {
      const resolved = await resolveSessionAdmission({
        credential: message.auth,
        passwordHash: this.passwordHash,
        localCredential: this.credentialSource?.localCredential?.() ?? null,
      });
      if (this.pendingConnections.get(ws) !== pending) return false;
      if ("rejection" in resolved) {
        this.clearPendingConnection(ws);
        await this.rejectHello(ws, message, resolved.rejection);
        return false;
      }
      pending.admission = resolved.admission;
      return true;
    } catch (error) {
      pending.connectionLogger.error({ err: error }, "Failed to resolve hello credential");
      if (this.pendingConnections.get(ws) === pending) {
        this.clearPendingConnection(ws);
        await this.rejectHello(ws, message, "incorrect_password");
      }
      return false;
    }
  }

  private async rejectHello(
    ws: WebSocketLike,
    hello: WSHelloMessage,
    reason: "password_required" | "incorrect_password" | "incompatible_protocol",
  ): Promise<void> {
    // Older clients discard unknown frames, then use the close code and reason.
    // They never send hello.auth, so avoid sending an unknown envelope to them.
    if (hello.auth || hello.capabilities?.[CLIENT_CAPS.helloRejection] === true) {
      try {
        await ws.send(JSON.stringify({ type: "hello.rejected", reason, accepts: ["password"] }));
      } catch {
        // The close reason remains the compatibility signal.
      }
    }
    const closeReason = {
      password_required: "Password required",
      incorrect_password: "Incorrect password",
      incompatible_protocol: "Incompatible protocol version",
    }[reason];
    try {
      ws.close(
        reason === "incompatible_protocol"
          ? WS_CLOSE_INCOMPATIBLE_PROTOCOL
          : WS_CLOSE_DAEMON_AUTH_FAILED,
        closeReason,
      );
    } catch {
      // Ignore a transport that closed while the rejection was sent.
    }
  }

  private resumeSession(params: {
    ws: WebSocketLike;
    message: WSHelloMessage;
    pending: PendingConnection;
    existing: ReconnectableSessionConnection;
    admission: SessionAdmission;
  }): void {
    const { ws, message, pending, existing, admission } = params;
    const currentPermissions = existing.session.getPermissions();
    if (
      existing.sockets.size > 0 &&
      (currentPermissions.length !== new Set(admission.permissions).size ||
        !currentPermissions.every((permission) => admission.permissions.includes(permission)))
    ) {
      ws.close(WS_CLOSE_INVALID_HELLO, "Session permissions changed");
      return;
    }
    this.incrementRuntimeCounter("helloResumed");
    if (existing.externalDisconnectCleanupTimeout) {
      clearTimeout(existing.externalDisconnectCleanupTimeout);
      existing.externalDisconnectCleanupTimeout = null;
    }
    for (const socket of existing.sockets) {
      this.hostLinks.get(socket)?.close("permission_denied");
      this.hostLinks.delete(socket);
    }
    if (existing.sockets.size === 0) {
      existing.session.setPermissions(admission.permissions);
    }
    existing.session.setRouted(message.routed === true);
    this.assignHostSource(existing, message, admission.principalId);
    const newAppVersion = message.appVersion ?? null;
    if (newAppVersion && newAppVersion !== existing.appVersion) {
      existing.appVersion = newAppVersion;
      existing.session.updateAppVersion(newAppVersion);
    }
    const newClientCapabilities = message.capabilities ?? null;
    // COMPAT(selectiveAgentTimeline): added in v0.1.106. Every capable resumed
    // hello resets membership before server_info so stale retained-session
    // state cannot leak. Remove after 2027-01-12.
    existing.session.updateClientCapabilities(newClientCapabilities, ws, newAppVersion);
    if (
      JSON.stringify(existing.clientCapabilities ?? null) !==
      JSON.stringify(newClientCapabilities ?? null)
    ) {
      existing.clientCapabilities = newClientCapabilities;
    }
    existing.sockets.add(ws);
    this.sessions.set(ws, existing);
    pending.identity.sessionId = existing.session.getSessionId();
    this.sendHelloResponse(ws, existing.session, message);
    pending.connectionLogger.info(
      {
        ...toConnectionLogFields(pending.identity),
        resumed: true,
        totalSessions: this.sessions.size,
      },
      "Client connected via hello",
    );
  }

  private assignHostSource(
    connection: SessionConnection,
    hello: WSHelloMessage,
    principalId: string,
    pluginId?: string,
  ): void {
    if (pluginId) return;
    const producer = hello.producer;
    const sourceId =
      hello.routed && producer
        ? `route:${[principalId, producer.serverId, producer.sourceId].map(encodeURIComponent).join(":")}`
        : principalId;
    connection.session.setHostSource(sourceId);
  }

  private buildServerInfoStatusPayload(session: Session): ServerInfoStatusPayload {
    const machineKind = getCachedHostMachineKind();
    return {
      status: "server_info",
      protocolVersion: WS_PROTOCOL_VERSION,
      serverId: this.serverId,
      hostname: getHostName(),
      version: this.daemonVersion,
      ...(machineKind ? { machineKind } : {}),
      sourceId:
        session.isRouted() && readDirectParentRoute(session.getHostSourceId())
          ? session.getHostSourceId() + DIRECT_PARENT_ROUTE_ACK
          : session.getHostSourceId(),
      permissions: session.getPermissions(),
      // COMPAT(desktopManaged): added in v0.1.X, remove optional parsing after 2027-01-16.
      desktopManaged: this.daemonRuntimeConfig?.desktopManaged === true,
      ...(this.serverCapabilities ? { capabilities: this.serverCapabilities } : {}),
      features: {
        ...this.hostProxyFeatures(),
        connectedHosts: true,
        hostMultiplexing: true,
        // COMPAT(relayProtectedSecurity): added in v0.13.0, remove gate after 2027-04-21.
        relayProtectedSecurity: true,
        usageSetting: true,
        usageSources: true,
        providerInstallation: true,
        providerCustomCli: true,
        providerCatalogPinUpdates: true,
        providerApprovedUpdates: supportsHostApprovedProviderUpdates(),
        ownedSubscriptions: true,
        // COMPAT(agentHierarchyControl): added in v0.16.0, remove gate after 2027-05-19.
        agentHierarchyControl: true,
        mainControlAppendSystemPrompt: true,
        // COMPAT(agentResidentSpecialists): added in v0.18.0, remove gate after 2027-06-01.
        agentResidentSpecialists: true,
        // COMPAT(agentSessionReset): added in v0.18.0, remove gate after 2027-06-01.
        agentSessionReset: true,
        // COMPAT(agentProviderSwitchBlankContext): added in v0.18.0, remove after 2027-06-01.
        agentProviderSwitchBlankContext: true,
        // COMPAT(agentIdleArchiveV1): added in v0.18.0, remove gate after 2027-06-01.
        agentIdleArchiveV1: true,
        workspaceMainAgentDefault: true,
        agentCreateAsMain: true,
        // COMPAT(topicWorkbenchV1): added in v0.18.0, remove after 2027-06-01.
        ...(this.featureOverrides.topicWorkbenchV1 !== false ? { topicWorkbenchV1: true } : {}),
        teamConclusionAttention: true,
        ...(this.featureOverrides.topicWorkbenchV1 !== false &&
        this.featureOverrides.topicPromptRetryV1 !== false
          ? { topicPromptRetryV1: true }
          : {}),
        // COMPAT(workspaceDurableItemsV1): added in v0.18.0, remove after 2027-06-01.
        ...(this.featureOverrides.workspaceDurableItemsV1 !== false
          ? { workspaceDurableItemsV1: true }
          : {}),
        ...(this.featureOverrides.checkoutGitStagingV1 !== false
          ? { checkoutGitStagingV1: true }
          : {}),
        // COMPAT(checkoutGitGraphV1): added in v0.18.0, remove gate after 2027-06-01.
        ...(this.featureOverrides.checkoutGitGraphV1 !== false ? { checkoutGitGraphV1: true } : {}),
        // COMPAT(checkoutGitRebaseV1): added in v0.18.0, remove gate after 2027-06-01.
        ...(this.featureOverrides.checkoutGitRebaseV1 !== false
          ? { checkoutGitRebaseV1: true }
          : {}),
        // COMPAT(checkoutGitMultiRepoV1): added in v0.18.0, remove gate after 2027-06-01.
        ...(this.featureOverrides.checkoutGitMultiRepoV1 !== false
          ? { checkoutGitMultiRepoV1: true }
          : {}),
        // COMPAT(checkoutGitP2V1): added in v0.18.0, remove gate after 2027-06-01.
        ...(this.featureOverrides.checkoutGitP2V1 !== false ? { checkoutGitP2V1: true } : {}),
        agentSideChat: true,
        workspaceAgentsSummary: true,
        agentHistoryWorkspaceFilter: true,
        // COMPAT(agentInitialPromptOrigin): added in v0.16.0, remove gate after 2027-05-19.
        agentInitialPromptOrigin: true,
        providerOptionControls: true,
        entityMetadata: true,
        diffSubscription: true,
        binaryChunkingV1: true,
        agentRequestReceipts: true,
        workspaceRequestReceipts: true,
        creationLifecycle: true,
        hubAgentRpc: true,
        backgroundWorkspaces: true,
        // COMPAT(backgroundAgents): added in v0.15.0; remove gate after 2027-05-03.
        backgroundAgents: true,
        // COMPAT(agentHistoryArchiveScope): added in v0.16.0, remove gate after 2027-05-19.
        agentHistoryArchiveScope: true,
        // COMPAT(agentHistoryQueryControls): added in v0.16.0, remove gate after 2027-05-19.
        agentHistoryQueryControls: true,
        workspaceBaseBranch: true,
        // COMPAT(checkoutWorktreeList): added after v0.16.2, remove gate after 2027-11-19.
        checkoutWorktreeList: true,
        // COMPAT(worktreeRefActions): added after v0.16.2, remove gate after 2027-11-19.
        worktreeRefActions: true,
        // COMPAT(directorySync): added in v0.3.x, remove gate after 2027-02-12.
        directorySync: true,
        // COMPAT(workspaceLabels): added in v0.5.0, remove after 2027-08-14.
        ...(this.workspaceLabelService ? { workspaceLabels: true } : {}),
        ...(session.supportsWorkspaceDeferral() ? { workspaceDeferral: true } : {}),
        terminalCollection: true,
        // COMPAT(workspaceSetupRun): added in v0.7.3, remove gate after 2027-09-02.
        workspaceSetupRun: true,
        workspaceSetupObservation: true,
        workspaceTaskLedger: true,
        workspaceFixedStartPoint: true,
        workspaceSortTimes: true,
        // COMPAT(providersSnapshot): keep optional until all clients rely on snapshot flow.
        providersSnapshot: true,
        // COMPAT(providersSnapshotCwd): added in v0.3.2, remove gate after 2027-02-10.
        providersSnapshotCwd: true,
        // COMPAT(checkoutForgeSetAutoMerge): added in v0.2.0-beta.1. Remove the
        // feature gate and legacy fallback after 2027-01-17 once the supported
        // daemon floor is >= v0.2.0.
        checkoutForgeSetAutoMerge: true,
        // COMPAT(checkoutGithubSetAutoMerge): added in v0.1.75 and retained as
        // the fallback for checkoutForgeSetAutoMerge. Stop advertising it after
        // 2027-01-17 once supported floors are >= v0.2.0.
        checkoutGithubSetAutoMerge: true,
        // COMPAT(githubCheckDetails): added in v0.1.92 and retained as the
        // fallback for forgeCheckDetails. Stop advertising it after 2027-01-17
        // once supported floors are >= v0.2.0.
        githubCheckDetails: true,
        // COMPAT(forgeCheckDetails): added in v0.2.0-beta.1. Remove the feature
        // gate and legacy fallback after 2027-01-17 once the supported daemon
        // floor is >= v0.2.0.
        forgeReviewGuide: true,
        forgeCheckDetails: true,
        // COMPAT(forgeSearch): added in v0.2.0-beta.1. Remove the feature gate
        // and legacy fallback after 2027-01-17 once the supported daemon floor
        // is >= v0.2.0.
        forgeSearch: true,
        // COMPAT(daemonStatusRpc): added in v0.1.76, remove gate after 2026-11-18.
        ...(this.featureOverrides.daemonStatusRpc !== false ? { daemonStatusRpc: true } : {}),
        // COMPAT(daemonConfigReload): added in v0.4.0, remove gate after 2027-02-14.
        daemonConfigReload: true,
        // COMPAT(speechSettings): added in v0.12.0, remove gate after 2027-04-18.
        speechSettings: true,
        // COMPAT(relayConfig): added in v0.2.6, remove gate after 2027-01-31.
        ...(this.featureOverrides.relayConfig !== false ? { relayConfig: true } : {}),
        // COMPAT(pushTokenRevocation): added in v0.3.2, remove gate after 2027-02-10.
        pushTokenRevocation: true,
        // COMPAT(plugins): added in v0.3.0, remove gate after 2027-08-07.
        plugins: true,
        pluginManagement: true,
        pluginGitManagement: true,
        pluginSourceInstallation: true,
        pluginSourceUpdates: true,
        // COMPAT(pluginRegistry): added in v0.16.0, remove gate after 2027-05-15.
        pluginRegistry: true,
        pluginLogs: true,
        // COMPAT(pluginThemes): added in v0.5.0, remove gate after 2027-08-20.
        pluginThemes: true,
        pluginSettings: true,
        pluginTimelineItems: true,
        // COMPAT(pluginSubscriptions): added in v0.15.0, remove gate after 2027-05-02.
        pluginSubscriptions: true,
        // COMPAT(skillManagement): added in v0.4.0, remove gate after 2027-08-16.
        skillManagement: true,
        // COMPAT(idleRuntimeCleanupSetting): added in v0.13.0, remove gate after 2027-04-26.
        idleRuntimeCleanupSetting: true,
        resumeOnStartupSetting: true,
        // COMPAT(terminalRestoreModes): added in v0.1.81, remove gate after 2026-11-23.
        "terminal-restore-modes": true,
        // COMPAT(terminalInputModeReplay): added in v0.2.6, remove gate after 2027-02-02.
        "terminal-input-mode-replay": true,
        // COMPAT(terminalSizeOwnership): added in v0.2.6, remove gate after 2027-02-02.
        "terminal-size-ownership": true,
        // COMPAT(terminalGraphemeWidths): added in v0.15.0, remove gate after 2027-05-01.
        "terminal-grapheme-widths": true,
        workspaceTerminals: true,
        // COMPAT(rewind): added in v0.1.X, drop the gate when floor >= v0.1.X.
        rewind: true,
        // COMPAT(rewindCheckpoints): added in v0.17.0, remove the gate after 2027-05-24.
        rewindCheckpoints: typeof this.agentManager.configureRewindCheckpoints === "function",
        rewindPendingFiles: typeof this.agentManager.getPendingRewindFiles === "function",
        // COMPAT(agentTimelinePromptIndex): added in v0.2.X, drop the gate when floor >= v0.2.X.
        agentTimelinePromptIndex: true,
        // COMPAT(agentHistorySearch): added in v0.3.0, remove gate after 2027-02-07.
        agentHistorySearch: true,
        // COMPAT(checkoutRefresh): added in v0.1.86, remove gate after 2026-11-29.
        checkoutRefresh: true,
        // COMPAT(workspaceMultiplicity): added in v0.1.97, drop the gate when floor >= v0.1.97
        workspaceMultiplicity: true,
        // COMPAT(projectRemove): added in v0.1.97, drop the gate when floor >= v0.1.97.
        projectRemove: true,
        // COMPAT(projectAdd): added in v0.1.97, drop the gate when floor >= v0.1.97.
        projectAdd: true,
        // COMPAT(projectList): added in v0.2.4, drop the gate when floor >= v0.2.4.
        projectList: true,
        // COMPAT(projectSuggestions): added in v0.14.1, remove gate after 2027-05-01.
        projectSuggestions: true,
        // COMPAT(worktreeRestore): keep through 2027-01-11 for clients older than v0.1.105.
        worktreeRestore: true,
        // COMPAT(workspaceRecovery): added in v0.1.105, remove after 2027-01-11 once daemon floor >= v0.1.105.
        workspaceRecovery: true,
        // COMPAT(workspaceArchiveUndo): added in v0.15.3, remove gate after 2027-05-06.
        workspaceArchiveUndo: true,
        // COMPAT(workspaceFileEditing): added in v0.2.0, remove after 2027-01-18 once daemon floor >= v0.2.0.
        workspaceFileEditing: true,
        // COMPAT(fileByteWrites): added in v0.13.0, remove gate after 2027-04-20.
        fileByteWrites: true,
        // COMPAT(providerUsageList): added in v0.1.98, drop the gate when daemon floor >= v0.1.98.
        providerUsageList: true,
        // COMPAT(agentDetach): added in v0.1.98, remove gate after 2026-12-19 once daemon floor >= v0.1.98.
        agentDetach: true,
        // COMPAT(agentMoveToWorkspace): added in v0.16.0, remove gate after 2027-05-19.
        agentMoveToWorkspace: true,
        // COMPAT(agentThinkingUpdate): added in v0.2.4, remove gate after 2027-01-28.
        agentThinkingUpdate: true,
        // COMPAT(daemonDiagnostics): added in v0.1.100, remove gate after 2026-12-25 once daemon floor >= v0.1.100.
        daemonDiagnostics: true,
        // COMPAT(daemonSelfUpdate): added in v0.1.93, remove gate after 2026-12-13.
        daemonSelfUpdate: this.daemonRuntimeConfig?.desktopManaged !== true,
        // COMPAT(terminalsSurviveRestart): added in v0.12.0, remove gate after 2027-04-21.
        terminalsSurviveRestart: true,
        // COMPAT(resumeAgentsOnStop): added after v0.16.0, remove gate after 2027-05-19.
        resumeAgentsOnStop: true,
        // COMPAT(agentForkContext): added in v0.1.102, remove gate after 2026-12-28.
        agentForkContext: true,
        // COMPAT(agentForkContextCursor): added in v0.1.108, remove gate after 2027-01-14.
        agentForkContextCursor: true,
        // COMPAT(agentSeamlessContextSwitch): added in v0.16.0, remove gate after 2027-05-21.
        agentSeamlessContextSwitch: true,
        // COMPAT(providerSubagents): added in v0.1.107, remove gate after 2027-01-12.
        providerSubagents: true,
        // COMPAT(agentBackgroundWork): added after v0.11.0-beta.5, remove gate after 2027-04-06.
        agentBackgroundWork: true,
        // COMPAT(agentBackgroundWorkStop): added after v0.15.0, remove after 2027-05-03.
        agentBackgroundWorkStop: true,
        // COMPAT(projectedSubagentTimeline): added after v0.8.0, remove gates after 2027-03-14; retain advertisement.
        projectedSubagentTimeline: true,
        wholeTurnTimeline: true,
        // COMPAT(providerSubagentNesting): added in v0.7, remove gate after 2027-03-04.
        providerSubagentNesting: true,
        // COMPAT(workspacePinning): added in v0.1.107, remove gate after 2027-01-12.
        workspacePinning: true,
        // COMPAT(workspaceMarkUnread): added in v0.5.0, remove after 2027-08-20.
        workspaceMarkUnread: true,
        // COMPAT(hubRelationship): added in v0.1.X, drop the gate when floor >= v0.1.X.
        hubRelationship: true,
        // COMPAT(projectGithubClone): added in v0.1.108, remove gate after 2027-01-15.
        projectGithubClone: true,
        // COMPAT(workspaceGithubRepositorySearch): added in v0.1.108, remove gate after 2027-01-15.
        workspaceGithubRepositorySearch: true,
        // COMPAT(projectCreateDirectory): added in v0.1.108, remove gate after 2027-01-15.
        projectCreateDirectory: true,
        // COMPAT(commitsList): added in v0.1.110, remove gate after 2027-01-16.
        commitsList: true,
        // COMPAT(commitBaseClassification): added in v0.2.0, remove gate after 2027-01-23.
        commitBaseClassification: true,
        // COMPAT(providerRemoval): added in v0.1.105, drop the gate when floor >= v0.1.105.
        providerRemoval: true,
        hopliteProvider: this.providerSnapshotManager.supportsConfigRequiredProvider("hoplite"),
        // COMPAT(fxProvider): added after v0.15.3, remove after 2027-05-09 once host floor includes the bundled adapter.
        fxProvider: this.providerSnapshotManager.supportsConfigRequiredProvider("fx"),
        // COMPAT(gooseProvider): added in v0.17.0, remove after 2027-05-20 once host floor includes the bundled adapter.
        gooseProvider: this.providerSnapshotManager.supportsConfigRequiredProvider("goose"),
        // COMPAT(hermesProvider): added in v0.17.4, remove after 2027-05-23 once host floor includes the bundled adapter.
        hermesProvider: this.providerSnapshotManager.supportsConfigRequiredProvider("hermes"),
        // COMPAT(importSessionWorkspaceTarget): added in v0.1.110, remove gate after 2027-01-16.
        importSessionWorkspaceTarget: true,
        // COMPAT(importSessionSearch): added in v0.7.3, remove gate after 2027-03-02.
        importSessionSearch: true,
        // COMPAT(forgeProviders): added in v0.2.0-beta.1. Drop the gate after
        // 2027-01-17 once the supported daemon floor is >= v0.2.0.
        forgeProviders: true,
        // COMPAT(selectiveAgentTimeline): added in v0.1.106, remove after 2027-01-12.
        selectiveAgentTimeline: true,
        // COMPAT(timelineFreshnessCheck): added after v0.15.3, remove after 2027-05-09.
        timelineFreshnessCheck: true,
        explicitEventSubscriptions: true,
        // COMPAT(canonicalSubmittedPrompts): added in v0.2.6, remove gate after 2027-01-30.
        canonicalSubmittedPrompts: true,
        agentMessageProvenance: true,
        agentMessageBatching: true,
        subagentInbox: this.finishSubscriptions !== undefined,
        agentMessageDispatchConfirmation: true,
        // COMPAT(agentNotificationEvents): added in v0.16.0, remove after 2027-05-19.
        agentNotificationEvents: true,
        agentFinishReportPull: this.finishSubscriptions !== undefined,
        agentExplicitParentReports: this.finishSubscriptions !== undefined,
        agentTrackRemoteParentReports: this.finishSubscriptions !== undefined,
        agentDirectParentQueuedDelivery: true,
        // COMPAT(agentActiveTurnBehaviors): added in v0.17.2, remove gate after 2027-05-22.
        agentActiveTurnBehaviors: true,
        // COMPAT(stableProjectIdentity): added in v0.1.109, remove gate after 2027-01-15.
        stableProjectIdentity: true,
        // COMPAT(workspaceScriptManagement): added in v0.1.105, remove gate after 2027-01-10.
        workspaceScriptManagement: true,
        // COMPAT(projectCustomIcon): added in v0.2.0, remove after 2027-01-20.
        projectCustomIcon: true,
        // COMPAT(fsEntryOps): added in v0.3.0, remove gate after 2027-02-08.
        fsEntryOps: true,
        // COMPAT(fsEntryDuplicate): added in v0.3.0, remove gate after 2027-02-09.
        fsEntryDuplicate: true,
        // COMPAT(checkoutDiscardChanges): added in v0.3.0, remove gate after 2027-02-08.
        checkoutDiscardChanges: true,
        checkoutDiffAll: true,
        // COMPAT(agentProfiles): added in v0.3.2, remove gate after 2027-02-11.
        agentProfiles: true,
        // COMPAT(agentConfigApply): added in v0.3.2, remove gate after 2027-02-11.
        agentConfigApply: true,
      },
    };
  }

  private createServerInfoMessage(session: Session): WSOutboundMessage {
    return {
      type: "session",
      message: {
        type: "status",
        payload: this.buildServerInfoStatusPayload(session),
      },
    };
  }

  private createDaemonConfigChangedMessage(config: MutableDaemonConfig): WSOutboundMessage {
    return wrapSessionMessage({
      type: "status",
      payload: {
        status: "daemon_config_changed",
        config: toWireDaemonConfig(config),
      },
    });
  }

  private broadcastCapabilitiesUpdate(): void {
    for (const connection of new Set(this.sessions.values())) {
      if (
        ![...connection.sockets].some((socket) =>
          connection.session.wantsSourceEvent(socket, "status.server_info"),
        )
      )
        continue;
      connection.session.publish({
        type: "status",
        payload: this.buildServerInfoStatusPayload(connection.session),
      });
    }
  }

  private broadcastDaemonConfigChanged(config: MutableDaemonConfig): void {
    this.broadcast(this.createDaemonConfigChangedMessage(config));
  }

  private bindSocketHandlers(ws: WebSocketLike): void {
    ws.on("message", (...args: unknown[]) => {
      if (!this.canSendSocketFrame(ws)) return;
      const data = args[0] as Buffer | ArrayBuffer | Buffer[] | string;
      try {
        this.chunkedSocket(ws).receive(typeof data === "string" ? data : bufferFromWsData(data));
      } catch (error) {
        if (!(error instanceof ChunkedTransportProtocolError)) throw error;
        this.stopSocketDelivery(ws);
        ws.close(1002, "Invalid chunked transport");
      }
    });

    ws.on("close", async (...args: unknown[]) => {
      const code = args[0];
      const reason = args[1];
      await this.detachSocket(ws, {
        code: typeof code === "number" ? code : undefined,
        reason,
      });
    });

    ws.on("error", async (...args: unknown[]) => {
      const error = args[0];
      const err = error instanceof Error ? error : new Error(String(error));
      const active = this.sessions.get(ws);
      const pending = this.pendingConnections.get(ws);
      const log = active?.connectionLogger ?? pending?.connectionLogger ?? this.logger;
      log.error({ err }, "Client error");
      await this.detachSocket(ws, { error: err });
    });
  }

  public resolveVoiceSpeakHandler(callerAgentId: string): VoiceSpeakHandler | null {
    return this.voiceSpeakHandlers.get(callerAgentId) ?? null;
  }

  public resolveVoiceCallerContext(callerAgentId: string): VoiceCallerContext | null {
    return this.voiceCallerContexts.get(callerAgentId) ?? null;
  }

  private async detachSocket(
    ws: WebSocketLike,
    details: {
      code?: number;
      reason?: unknown;
      error?: Error;
    },
  ): Promise<void> {
    this.stopSocketDelivery(ws);
    this.hostLinks.get(ws)?.close();
    this.hostLinks.delete(ws);

    const identity = this.socketIdentities.get(ws);
    const identityFields = identity ? toConnectionLogFields(identity) : {};
    const pending = this.clearPendingConnection(ws);
    if (pending) {
      this.incrementRuntimeCounter("pendingDisconnected");
      pending.connectionLogger.info(
        {
          ...identityFields,
          code: details.code,
          reason: stringifyCloseReason(details.reason),
        },
        "Pending client disconnected",
      );
      this.socketIdentities.delete(ws);
      this.finishPluginSocketCleanup(ws);
      return;
    }

    const connection = this.sessions.get(ws);
    if (!connection) {
      if (identity) {
        this.logger.info(
          {
            ...identityFields,
            code: details.code,
            reason: stringifyCloseReason(details.reason),
          },
          "Client socket closed without active session",
        );
        this.socketIdentities.delete(ws);
      }
      this.finishPluginSocketCleanup(ws);
      return;
    }

    this.sessions.delete(ws);
    connection.sockets.delete(ws);
    connection.session.clearAgentTimelineSubscription(ws);
    this.socketIdentities.delete(ws);

    if (connection.sockets.size === 0) {
      if (connection.lifecycle === "ephemeral-plugin") {
        this.pluginSocketIds.delete(ws);
        await this.cleanupConnection(connection, "Plugin session disconnected");
        this.finishPluginSocketCleanup(ws);
        return;
      }
      if (connection.session.isRouted()) {
        await this.cleanupConnection(connection, "Routed session disconnected");
        return;
      }
      this.incrementRuntimeCounter("sessionDisconnectedWaitingReconnect");
      if (connection.externalDisconnectCleanupTimeout) {
        clearTimeout(connection.externalDisconnectCleanupTimeout);
      }
      const timeout = setTimeout(() => {
        if (connection.externalDisconnectCleanupTimeout !== timeout) {
          return;
        }
        connection.externalDisconnectCleanupTimeout = null;
        void this.cleanupConnection(connection, "Client disconnected (grace timeout)");
      }, EXTERNAL_SESSION_DISCONNECT_GRACE_MS);
      connection.externalDisconnectCleanupTimeout = timeout;

      connection.connectionLogger.info(
        {
          ...identityFields,
          code: details.code,
          reason: stringifyCloseReason(details.reason),
          reconnectGraceMs: EXTERNAL_SESSION_DISCONNECT_GRACE_MS,
        },
        "Client disconnected; waiting for reconnect",
      );
      return;
    }

    if (connection.sockets.size > 0) {
      this.incrementRuntimeCounter("sessionSocketDisconnectedAttached");
      connection.connectionLogger.info(
        {
          ...identityFields,
          remainingSockets: connection.sockets.size,
          code: details.code,
          reason: stringifyCloseReason(details.reason),
        },
        "Client socket disconnected; session remains attached",
      );
      return;
    }

    await this.cleanupConnection(connection, "Client disconnected");
    this.finishPluginSocketCleanup(ws);
  }

  private finishPluginSocketCleanup(ws: WebSocketLike): void {
    const resolve = this.pluginSocketCleanup.get(ws);
    if (!resolve) return;
    this.pluginSocketCleanup.delete(ws);
    resolve();
  }

  private async cleanupConnection(
    connection: SessionConnection,
    logMessage: string,
  ): Promise<void> {
    this.incrementRuntimeCounter("sessionCleanup");
    if (connection.lifecycle === "reconnectable" && connection.externalDisconnectCleanupTimeout) {
      clearTimeout(connection.externalDisconnectCleanupTimeout);
      connection.externalDisconnectCleanupTimeout = null;
    }

    for (const socket of connection.sockets) {
      this.sessions.delete(socket);
      this.socketIdentities.delete(socket);
    }
    connection.sockets.clear();
    if (connection.lifecycle === "reconnectable") {
      const existing = this.externalSessionsByKey.get(connection.sessionKey);
      if (existing === connection) {
        this.externalSessionsByKey.delete(connection.sessionKey);
      }
    }

    connection.connectionLogger.trace(
      { clientId: connection.clientId, totalSessions: this.sessions.size },
      logMessage,
    );
    await connection.session.cleanup();
  }

  private handleInvalidInboundMessage(args: {
    ws: WebSocketLike;
    parsed: unknown;
    parsedMessage: { success: false; error: { message: string } } & Record<string, unknown>;
    pendingConnection: PendingConnection | undefined;
    activeConnection: SessionConnection | undefined;
    log: pino.Logger;
  }): void {
    const { ws, parsed, parsedMessage, pendingConnection, activeConnection, log } = args;
    this.incrementRuntimeCounter("validationFailed");
    if (pendingConnection) {
      pendingConnection.connectionLogger.warn("Rejected invalid pending message before hello");
      this.clearPendingConnection(ws);
      try {
        ws.close(WS_CLOSE_INVALID_HELLO, "Invalid hello");
      } catch {
        // ignore close errors
      }
      return;
    }

    const requestInfo = extractRequestInfoFromUnknownWsInbound(parsed);
    const requestType = getSessionRequestTypeFromUnknownWsInbound(parsed);
    const validationError =
      requestType === "set_daemon_config_request" ||
      requestType?.startsWith("provider.custom_cli.") ||
      requestType?.startsWith("daemon.network.")
        ? "Invalid configuration request"
        : parsedMessage.error.message;
    const isUnknownSchema =
      requestInfo?.requestId != null &&
      typeof parsed === "object" &&
      parsed != null &&
      "type" in parsed &&
      (parsed as { type?: unknown }).type === "session";

    log.warn(
      {
        clientId: activeConnection?.clientId,
        requestId: requestInfo?.requestId,
        requestType: requestInfo?.requestType,
        error: validationError,
      },
      "WS inbound message validation failed",
    );

    activeConnection?.session.delivery.protocolFailure(ws, {
      ...requestInfo,
      error: isUnknownSchema
        ? `Unknown request, try upgrading the daemon (currently v${this.daemonVersion})`
        : `Invalid message: ${validationError}`,
      code: isUnknownSchema ? "unknown_schema" : "invalid_message",
    });
  }

  private maybeHandleBinaryFrame(params: {
    ws: WebSocketLike;
    buffer: Buffer;
    activeConnection: SessionConnection | undefined;
    log: pino.Logger;
  }): boolean {
    const { ws, buffer, activeConnection, log } = params;
    const asBytes = asUint8Array(buffer);
    if (!asBytes) {
      return false;
    }
    const decodedFrame = decodeBinaryFrame(asBytes);
    if (asBytes[0] === HOST_ROUTE_OPCODE && !decodedFrame) {
      ws.close(1008, "Invalid host routing frame");
      return true;
    }
    if (decodedFrame?.kind === "host_route" && this.hostLinks.get(ws)?.binary(decodedFrame.frame))
      return true;
    if (!decodedFrame) {
      return false;
    }
    if (!activeConnection) {
      this.incrementRuntimeCounter("binaryBeforeHelloRejected");
      log.warn("Rejected binary frame before hello");
      this.clearPendingConnection(ws);
      try {
        ws.close(WS_CLOSE_INVALID_HELLO, "Session message before hello");
      } catch {
        // ignore close errors
      }
      return true;
    }
    void Promise.resolve(activeConnection.session.handleBinaryFrame(decodedFrame, ws)).catch(
      (error: unknown) => {
        this.handleRawMessageError({
          ws,
          data: buffer,
          error,
          log: activeConnection.connectionLogger,
        });
      },
    );
    return true;
  }

  private handlePendingConnectionMessage(params: {
    ws: WebSocketLike;
    message: WSInboundMessage;
    pendingConnection: PendingConnection;
  }): void {
    const { ws, message, pendingConnection } = params;
    if (message.type === "hello" && !pendingConnection.authenticating) {
      void this.handleHelloSafely({
        ws,
        message,
        pending: pendingConnection,
      });
      return;
    }

    pendingConnection.connectionLogger.warn(
      {
        messageType: message.type,
      },
      "Rejected pending message before hello",
    );
    this.incrementRuntimeCounter("pendingMessageRejectedBeforeHello");
    this.clearPendingConnection(ws);
    try {
      ws.close(WS_CLOSE_INVALID_HELLO, "Session message before hello");
    } catch {
      // ignore close errors
    }
  }

  private handleRawMessage(
    ws: WebSocketLike,
    data: Buffer | ArrayBuffer | Buffer[] | string,
  ): void {
    if (
      this.connectionLifecycle === "stopping" ||
      (this.connectionLifecycle === "starting" && !this.pluginSocketIds.has(ws))
    ) {
      return;
    }

    this.applicationSocketLease.renew(ws);

    const activeConnection = this.sessions.get(ws);
    const pendingConnection = this.pendingConnections.get(ws);
    const log =
      activeConnection?.connectionLogger ?? pendingConnection?.connectionLogger ?? this.logger;

    try {
      const buffer = bufferFromWsData(data);
      const binaryHandled = this.maybeHandleBinaryFrame({
        ws,
        buffer,
        activeConnection,
        log,
      });
      if (binaryHandled) {
        return;
      }

      const parsed = JSON.parse(buffer.toString());
      const parsedMessage = WSInboundMessageSchema.safeParse(parsed);
      if (!parsedMessage.success) {
        this.handleInvalidInboundMessage({
          ws,
          parsed,
          parsedMessage,
          pendingConnection,
          activeConnection,
          log,
        });
        return;
      }

      const message = parsedMessage.data;
      this.recordInboundMessageType(message.type);

      if (message.type === "ping" && activeConnection) {
        // A plugin socket is IPC to a child this daemon already supervises, not
        // an abandonable application socket.
        if (!this.pluginSocketIds.has(ws)) {
          this.applicationSocketLease.claim(ws);
        }
        this.sendToClient(ws, { type: "pong" });
        return;
      }

      if (pendingConnection) {
        this.handlePendingConnectionMessage({
          ws,
          message,
          pendingConnection,
        });
        return;
      }

      if (message.type === "recording_state") {
        return;
      }

      if (!activeConnection) {
        this.incrementRuntimeCounter("missingConnectionForMessage");
        this.logger.error("No connection found for websocket");
        return;
      }

      if (message.type === "hello") {
        this.incrementRuntimeCounter("unexpectedHelloOnActiveConnection");
        activeConnection.connectionLogger.warn("Received hello on active connection");
        try {
          ws.close(WS_CLOSE_INVALID_HELLO, "Unexpected hello");
        } catch {
          // ignore close errors
        }
        return;
      }

      if (message.type === "session") {
        void this.dispatchSessionMessage(ws, activeConnection, message).catch((error: unknown) => {
          this.handleRawMessageError({ ws, data, error, log: activeConnection.connectionLogger });
        });
      }
    } catch (error) {
      this.handleRawMessageError({ ws, data, error, log });
    }
  }

  private hostLink(ws: WebSocketLike, connection: SessionConnection): DaemonLinkEndpoint {
    let link = this.hostLinks.get(ws);
    if (!link) {
      link = new DaemonLinkEndpoint({
        identity: JSON.stringify([connection.principalId, connection.clientId]),
        permissions: () => connection.session.getPermissions(),
        routed: () => connection.session.isRouted(),
        bufferedAmount: () => this.socketBufferedAmount(ws),
        delivery: connection.session.delivery,
        admit: (socket, permissions) =>
          this.attachSocket(socket, undefined, undefined, false, {
            principalId: connection.principalId,
            permissions,
          }),
      });
      this.hostLinks.set(ws, link);
    }
    return link;
  }

  async restoreQueuedAgentMessages(): Promise<void> {
    let unreadable = 0;
    const records = await this.messageReceipts.queuedMessages(() => unreadable++);
    if (unreadable) this.logger.warn({ unreadable }, "Skipped unreadable agent message receipts");
    for (const receipt of records) {
      let markAdmitted!: () => void;
      const admitted = new Promise<void>((resolve) => {
        markAdmitted = resolve;
      });
      const settled = this.messageReceipts.resumeQueued(receipt, {
        enqueue: (handoff) =>
          enqueueRecoverableAgentMessage(
            {
              agentManager: this.agentManager,
              agentStorage: this.agentStorage,
              agentMessages: this.agentMessages,
              finishSubscriptions: this.finishSubscriptions,
              logger: this.logger,
              serverId: this.serverId,
            },
            receipt.agentId,
            receipt.queued.message,
            handoff,
            true,
          ),
        retainOnError: retainQueuedAgentMessage,
        onQueued: markAdmitted,
      });
      const observed = settled.catch((err) => {
        this.logger.warn({ err, agentId: receipt.agentId }, "Queued agent message recovery failed");
      });
      await Promise.race([admitted, observed]);
    }
  }

  private async confirmParentReport(
    request: AgentFinishReportConfirmRequest,
  ): Promise<AgentFinishReportConfirmResult> {
    const confirmedReport = await this.finishSubscriptions?.readConfirmedParentReport(
      {
        childAgentId: request.childAgentId,
        callerAgentId: request.parentAgentId,
        callerServerId: request.parentServerId,
      },
      request.reportId,
    );
    if (!confirmedReport)
      return { accepted: false, error: "The parent report is no longer registered." };
    // Report lookup can wait for storage. Read the relationship after that wait.
    const child =
      this.agentManager.getAgent(request.childAgentId) ??
      (await this.agentStorage.get(request.childAgentId));
    const parent = getParentAddressFromLabels(child?.labels, this.serverId);
    if (parent?.agentId !== request.parentAgentId || parent.serverId !== request.parentServerId) {
      return { accepted: false, error: "The child is no longer assigned to this parent." };
    }
    return {
      accepted: true,
      error: null,
      confirmedReport: {
        fingerprint: parentReportFingerprint(confirmedReport),
        reportedAt: confirmedReport.reportedAt,
      },
    };
  }

  private async requestParentReportConfirmation(
    ws: VirtualHostSocket,
    request: AgentFinishReportConfirmRequest,
  ): Promise<ConfirmedAgentFinishReport | undefined> {
    const pending = this.pendingAgentFinishReportConfirmations.get(ws) ?? new Map();
    this.pendingAgentFinishReportConfirmations.set(ws, pending);
    const response = await new Promise<AgentFinishReportConfirmResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(request.requestId);
        if (pending.size === 0) this.pendingAgentFinishReportConfirmations.delete(ws);
        reject(new ParentReportConfirmationUnavailableError());
      }, PARENT_REPORT_CONFIRMATION_TIMEOUT_MS);
      pending.set(request.requestId, {
        childAgentId: request.childAgentId,
        parentAgentId: request.parentAgentId,
        reportId: request.reportId,
        resolve: (result: AgentFinishReportConfirmResponse) => {
          clearTimeout(timer);
          pending.delete(request.requestId);
          if (pending.size === 0) this.pendingAgentFinishReportConfirmations.delete(ws);
          resolve(result);
        },
        reject: (error: unknown) => {
          clearTimeout(timer);
          pending.delete(request.requestId);
          if (pending.size === 0) this.pendingAgentFinishReportConfirmations.delete(ws);
          reject(error);
        },
      });
      try {
        void Promise.resolve(ws.send(JSON.stringify(wrapSessionMessage(request)))).catch(
          (error) => {
            pending
              .get(request.requestId)
              ?.reject(new ParentReportConfirmationUnavailableError(error));
          },
        );
      } catch (error) {
        pending.get(request.requestId)?.reject(new ParentReportConfirmationUnavailableError(error));
      }
    });
    if (!response.payload.accepted) {
      throw new ParentReportRecipientUnavailableError(
        response.payload.error ?? "The parent report was rejected.",
      );
    }
    return response.payload.confirmedReport;
  }

  private allowsDirectParentReportPush(
    ws: WebSocketLike,
    session: Session,
    request: AgentFinishReportPushRequest,
    directParent: NonNullable<ReturnType<typeof readDirectParentRoute>>,
  ): boolean {
    return (
      ws instanceof VirtualHostSocket &&
      session.isRouted() &&
      this.hasFinishReportWorkspacePermissions(session) &&
      session.allowsInbound(request) &&
      request.childAgentId === directParent.agentId
    );
  }

  private async assertParentReportRecipientAvailable(parentAgentId: string): Promise<void> {
    const storedParent = await this.agentStorage.get(parentAgentId);
    if (storedParent?.archivedAt || (!storedParent && !this.agentManager.getAgent(parentAgentId))) {
      throw new ParentReportRecipientUnavailableError(
        `Parent agent ${parentAgentId} is unavailable`,
      );
    }
  }

  private async classifySubagentInbox(
    parentId: string,
    source: Parameters<
      NonNullable<VoiceAssistantWebSocketServer["agentMessages"]["classifyInbox"]>
    >[1],
  ): Promise<"ordinary" | "urgent" | undefined> {
    const stored = await this.agentStorage.get(parentId);
    const live = this.agentManager.getAgent(parentId);
    if (stored?.archivedAt || !isMainControlAgentLabels(live?.labels ?? stored?.labels))
      return undefined;
    if (source.kind === "agent-message") {
      if (source.reportStatus === "blocked") return "urgent";
      if (
        source.reportStatus &&
        (source.serverId ?? this.serverId) === this.serverId &&
        (await this.isUrgentResidentReport(parentId, source.agentId))
      )
        return "urgent";
      return "ordinary";
    }
    if (source.event === "permission-required" || source.event === "errored") return "urgent";
    return source.event === "finished" ? "ordinary" : undefined;
  }

  private async isUrgentResidentReport(parentId: string, childId: string): Promise<boolean> {
    const child = this.agentManager.getAgent(childId) ?? (await this.agentStorage.get(childId));
    const parent = getParentAddressFromLabels(child?.labels, this.serverId);
    return (
      parent?.serverId === this.serverId &&
      parent.agentId === parentId &&
      isResidentAgentLabels(child?.labels) &&
      hasResidentInboxBypass(child?.labels)
    );
  }

  private async assertCurrentReportParent(
    record: Pick<FinishSubscription, "callerAgentId" | "childAgentId" | "serverId">,
  ): Promise<void> {
    const child = record.serverId
      ? await this.toolHosts().use(
          record.serverId,
          async (client) => (await client.fetchAgent(record.childAgentId))?.agent,
        )
      : (this.agentManager.getAgent(record.childAgentId) ??
        (await this.agentStorage.get(record.childAgentId)));
    const parent = getParentAddressFromLabels(child?.labels, record.serverId ?? this.serverId);
    if (parent?.agentId !== record.callerAgentId || parent.serverId !== this.serverId) {
      throw new ParentReportRecipientUnavailableError("You can only manage your direct subagents.");
    }
    await this.assertParentReportRecipientAvailable(record.callerAgentId);
  }

  private async validateFinishSubscriptionParent(
    record: Pick<FinishSubscription, "callerAgentId" | "childAgentId" | "serverId"> &
      Partial<Pick<FinishSubscription, "id" | "requireParentOwnership" | "callerServerId">> & {
        hasFinalSnapshot?: boolean;
      },
  ): Promise<void> {
    if (record.serverId && record.id && this.isRemoteFinishedSuperseded(record, record.id))
      throw new ParentReportRecipientUnavailableError("Child already reported this result.");
    if (record.id && isAutomaticLocalParentSubscription({ ...record, id: record.id })) {
      const migratedParent = await this.agentManager.convergeLegacyParentReporting(
        record.childAgentId,
      );
      const child =
        this.agentManager.getAgent(record.childAgentId) ??
        (await this.agentStorage.get(record.childAgentId));
      const parent = getParentAddressFromLabels(child?.labels, this.serverId);
      if (
        child &&
        (parent?.agentId !== record.callerAgentId || parent.serverId !== this.serverId)
      ) {
        throw new ParentReportRecipientUnavailableError(
          "You can only manage your direct subagents.",
        );
      }
      if (
        migratedParent === record.callerAgentId ||
        isExplicitParentReportingLabels(child?.labels)
      ) {
        await this.finishSubscriptions
          ?.cancelAutomaticParent(record.childAgentId, record.callerAgentId)
          .catch((error) => {
            this.logger.warn(
              { err: error, subscription: record.id },
              "Failed to retire parent finish subscription",
            );
          });
        throw new ParentReportRecipientUnavailableError("Child uses explicit parent reporting.");
      }
      await this.assertParentReportRecipientAvailable(record.callerAgentId);
      return;
    }
    if (record.hasFinalSnapshot !== false) await this.assertCurrentReportParent(record);
  }

  private isRemoteFinishedSuperseded(
    record: Pick<FinishSubscription, "callerAgentId" | "childAgentId" | "serverId">,
    reportId: string,
  ): boolean {
    return this.remoteFinishedSupersessions.has(
      JSON.stringify([record.callerAgentId, record.serverId, record.childAgentId, reportId]),
    );
  }

  private async applyRemoteReportSupersession(
    record: FinishSubscription,
    reportId: string,
  ): Promise<void> {
    if (!record.serverId) return;
    const { turnId, finishedIds } = decodeParentReportIdentity(reportId);
    if (turnId) await this.finishSubscriptions?.suppressRemoteFinished?.(record, turnId);
    for (const id of finishedIds) {
      this.remoteFinishedSupersessions.add(
        JSON.stringify([record.callerAgentId, record.serverId, record.childAgentId, id]),
      );
      this.agentMessages.withdrawInboxReport?.(record.callerAgentId, id, {
        kind: "agent-notification",
        agentId: record.childAgentId,
        serverId: record.serverId,
        event: "finished",
      });
    }
    while (this.remoteFinishedSupersessions.size > 4096)
      this.remoteFinishedSupersessions.delete(
        this.remoteFinishedSupersessions.values().next().value!,
      );
  }

  async dispatchFinishReport(
    record: FinishSubscription,
    report: AgentFinishReport,
    options: {
      childServerId?: string;
      confirmBeforeDispatch?: () => Promise<ConfirmedAgentFinishReport | undefined>;
    } = {},
  ): Promise<void> {
    const explicit = report.parentReportStatus !== undefined;
    // An older attempt may still have an inconclusive receipt after the parent is archived.
    if (explicit) await this.assertParentReportRecipientAvailable(record.callerAgentId);
    const childServerId = options.childServerId ?? record.serverId ?? this.serverId;
    const messageId = explicit
      ? JSON.stringify([childServerId, record.childAgentId, report.id])
      : report.id;
    const assertNotSuperseded = () => {
      if (
        !explicit &&
        report.event === "finished" &&
        (this.finishSubscriptions?.isFinishedSuppressed?.(record.id) ||
          (record.serverId && this.isRemoteFinishedSuperseded(record, report.id)))
      )
        throw new ParentReportRecipientUnavailableError("Child already reported this result.");
    };
    const validateDispatch =
      explicit || record.requireParentOwnership
        ? async () => {
            if (options.confirmBeforeDispatch)
              await this.assertParentReportRecipientAvailable(record.callerAgentId);
            else if (!explicit && isAutomaticLocalParentSubscription(record))
              await this.validateFinishSubscriptionParent(record);
            else await this.assertCurrentReportParent(record);
            assertNotSuperseded();
          }
        : undefined;
    const receipts = explicit ? this.parentReportReceipts : this.messageReceipts;
    const title = resolveReportTitle(record.childAgentId, report.title);
    const source = explicit
      ? ({
          kind: "agent-message",
          agentId: record.childAgentId,
          serverId: childServerId,
          ...(title ? { title } : {}),
          reportStatus: report.parentReportStatus,
        } as const)
      : ({
          kind: "agent-notification",
          agentId: record.childAgentId,
          serverId: record.serverId,
          ...(title ? { title } : {}),
          event: report.event,
        } as const);
    await receipts.send({
      agentId: record.callerAgentId,
      messageId,
      retryIfUnsent: (error) =>
        error instanceof AgentRunCancellationError ||
        error instanceof ParentReportRecipientUnavailableError ||
        error instanceof ParentReportConfirmationUnavailableError ||
        retainQueuedAgentMessage(error),
      // Use the same receipt if a reverse route tried to dispatch before the observer enrolled.
      request: {
        prompt: report.prompt,
        ...(explicit ? { parentReportStatus: report.parentReportStatus, title: report.title } : {}),
        sourceAgentId: record.childAgentId,
        sourceAgentServerId: record.serverId,
        // Legacy reverse routes fingerprinted their default queue mode as steer.
        activeTurnBehavior: "steer",
      },
      send: async (beforeProviderDispatch, declined, onProviderOutcome) => {
        await validateDispatch?.();
        const confirmed = await options.confirmBeforeDispatch?.();
        if (confirmed && confirmed.fingerprint !== parentReportFingerprint(report)) {
          throw new ParentReportRecipientUnavailableError(
            "The push does not match the stored parent report.",
          );
        }
        const reportedAt = options.confirmBeforeDispatch
          ? confirmed?.reportedAt
          : report.reportedAt;
        if (explicit && record.serverId)
          await this.applyRemoteReportSupersession(record, report.id);
        const subagentInbox =
          explicit ||
          (record.requireParentOwnership &&
            (report.event !== "finished" || !report.id.startsWith("requested-parent:")))
            ? await this.classifySubagentInbox(record.callerAgentId, source)
            : undefined;
        assertNotSuperseded();
        // The explicit report is persisted by the child and its ownership was confirmed above.
        if (report.parentReportStatus === "blocked" && reportedAt) {
          await this.agentManager.notifyPersistedBlockedSubagentReport(
            record.callerAgentId,
            JSON.stringify([
              childServerId,
              record.childAgentId,
              decodeParentReportIdentity(report.id).id,
            ]),
            reportedAt,
          );
        }
        const receipt = this.agentMessages.enqueue({
          recipientId: record.callerAgentId,
          messageId,
          prompt: report.prompt,
          childReported: explicit,
          source,
          subagentInbox,
          validateDispatch,
          activeTurnBehavior: "queue",
          unarchive: false,
          waitForProviderOutcome: true,
          handoff: {
            begin: async () => {
              await beforeProviderDispatch();
              await options.confirmBeforeDispatch?.();
            },
            declined,
            onProviderOutcome,
          },
        });
        await receipt.dispatched;
      },
    });
  }

  private resolveParentReportConfirmation(
    ws: WebSocketLike,
    response: AgentFinishReportConfirmResponse,
  ): boolean {
    const pending = this.pendingAgentFinishReportConfirmations
      .get(ws)
      ?.get(response.payload.requestId);
    if (!pending) return false;
    if (
      pending.childAgentId !== response.payload.childAgentId ||
      pending.parentAgentId !== response.payload.parentAgentId ||
      pending.reportId !== response.payload.reportId
    ) {
      pending.reject(
        new ParentReportConfirmationUnavailableError("Mismatched report confirmation"),
      );
      return true;
    }
    pending.resolve(response);
    return true;
  }

  private async pushFinishReport(
    session: Session,
    ws: WebSocketLike,
    request: AgentFinishReportPushRequest,
  ): Promise<void> {
    const directParent = readDirectParentRoute(session.getHostSourceId());
    if (!(ws instanceof VirtualHostSocket) || !directParent) {
      throw new Error("Explicit parent reports require an authenticated direct-parent route.");
    }
    const record: FinishSubscription = {
      id: request.report.id,
      childAgentId: request.childAgentId,
      callerAgentId: request.parentAgentId,
      serverId: directParent.serverId,
      requireParentOwnership: true,
    };
    const routeKey = JSON.stringify([
      record.callerAgentId,
      directParent.serverId,
      record.childAgentId,
      request.report.id,
    ]);
    this.parentReportSockets.set(routeKey, ws);
    try {
      await this.dispatchFinishReport(record, request.report, {
        childServerId: directParent.serverId,
        confirmBeforeDispatch: async () => {
          const socket = this.parentReportSockets.get(routeKey);
          if (!socket) throw new ParentReportConfirmationUnavailableError();
          return this.requestParentReportConfirmation(socket, {
            type: "agent.finish_reports.confirm.request",
            requestId: randomUUID(),
            childAgentId: request.childAgentId,
            parentAgentId: request.parentAgentId,
            parentServerId: this.serverId,
            reportId: request.report.id,
          });
        },
      });
    } catch (error) {
      if (!(error instanceof ParentReportRecipientUnavailableError)) throw error;
      session.delivery.reply({
        type: "agent.finish_reports.push.response",
        payload: {
          requestId: request.requestId,
          accepted: false,
          error: error.message,
        },
      });
      return;
    } finally {
      if (this.parentReportSockets.get(routeKey) === ws) this.parentReportSockets.delete(routeKey);
    }
    session.delivery.reply({
      type: "agent.finish_reports.push.response",
      payload: { requestId: request.requestId, accepted: true, error: null },
    });
  }

  private canAcceptAgentNotificationEvent(session: Session, sourceAgentServerId: string): boolean {
    const source = session.getHostSourceId().split(":");
    if (!this.canPullFinishReports(session, true, source)) return false;
    try {
      return decodeURIComponent(source[2]!) === sourceAgentServerId;
    } catch {
      return false;
    }
  }

  private canPullFinishReports(session: Session, routedSource: boolean, source: string[]): boolean {
    return (
      routedSource &&
      session.isRouted() &&
      source.length === 4 &&
      source[0] === "route" &&
      source[3] === "mcp" &&
      this.hasFinishReportWorkspacePermissions(session)
    );
  }

  private hasFinishReportWorkspacePermissions(session: Session): boolean {
    const permissions = session.getPermissions();
    return permissions.includes("workspace.write") && permissions.includes("workspace.read");
  }

  private async trackFinishReports(
    session: Session,
    request: Extract<SessionInboundMessage, { type: "agent.finish_reports.track.request" }>,
  ): Promise<void> {
    const { childServerId, childAgentId, parentAgentId, requestId } = request;
    const subscriptions = this.finishSubscriptions;
    let error: string | null = null;
    try {
      if (
        !subscriptions ||
        session.isRouted() ||
        !session.allowsInbound(request) ||
        !this.hasFinishReportWorkspacePermissions(session) ||
        childServerId === this.serverId
      )
        throw new Error("Permission denied for remote parent report registration.");
      await this.assertParentReportRecipientAvailable(parentAgentId);
      // A recovered creation can return after the child has archived. The source
      // pull closes an archived child's watch once its persisted reports are drained.
      await this.toolHosts().use(
        childServerId,
        async (client) => {
          const info = client.getLastServerInfoMessage();
          const child = (await client.fetchAgent(childAgentId))?.agent;
          const parent = getParentAddressFromLabels(child?.labels, childServerId);
          if (
            info?.features?.agentExplicitParentReports !== true ||
            info.features.agentFinishReportPull !== true ||
            !info.permissions?.includes("workspace.read") ||
            !info.permissions.includes("workspace.write") ||
            !child ||
            !isExplicitParentReportingLabels(child.labels) ||
            parent?.agentId !== parentAgentId ||
            parent.serverId !== this.serverId
          )
            throw new Error("Could not verify an explicit-reporting child on the destination.");
        },
        session.delivery.requestSignal,
      );
      await this.assertParentReportRecipientAvailable(parentAgentId);
      await subscriptions.trackRemoteChild({
        callerAgentId: parentAgentId,
        childAgentId,
        serverId: childServerId,
      });
    } catch (failure) {
      error =
        failure instanceof Error ? failure.message : "Failed to register remote parent reports.";
    }
    session.delivery.reply({
      type: "agent.finish_reports.track.response",
      payload: { requestId, error },
    });
  }

  private async pullFinishReports(
    session: Session,
    request: Extract<
      Extract<WSInboundMessage, { type: "session" }>["message"],
      { type: "agent.finish_reports.pull.request" }
    >,
    routedSource: boolean,
  ): Promise<void> {
    const subscriptions = this.finishSubscriptions;
    const sourceId = session.getHostSourceId();
    const source = sourceId.split(":");
    let ownsChild = false;
    let reports: AgentFinishReport[] = [];
    let error: string | null = null;
    if (!subscriptions || !this.canPullFinishReports(session, routedSource, source)) {
      error = "Permission denied for delegated completion reports.";
    } else {
      try {
        const callerServerId = decodeURIComponent(source[2]!);
        const stored = await this.agentStorage.get(request.childAgentId);
        const labels = this.agentManager.getAgent(request.childAgentId)?.labels ?? stored?.labels;
        const parent = getParentAddressFromLabels(labels, this.serverId);
        const archivedOrActive = stored?.archivedAt ? "archived" : "active";
        const related =
          parent?.agentId === request.parentAgentId && parent.serverId === callerServerId;
        const result = await subscriptions.pullReports(
          {
            childAgentId: request.childAgentId,
            callerAgentId: request.parentAgentId,
            callerServerId,
            sourceId,
          },
          request.acknowledged,
          request.observe === true,
          related ? archivedOrActive : "unrelated",
          request.includeParentReports === true,
        );
        reports = result.reports;
        ownsChild = result.ownsBinding;
      } catch (failure) {
        this.logger.warn({ err: failure }, "Failed to read delegated finish reports");
        error = "Failed to read delegated completion reports.";
      }
    }
    session.delivery.reply({
      type: "agent.finish_reports.pull.response",
      payload: { requestId: request.requestId, ownsChild, reports, error },
    });
  }

  private allowsDirectParentRequest(
    ws: WebSocketLike,
    session: Session,
    request: SessionInboundMessage,
  ): boolean | Promise<boolean> {
    const directParent = readDirectParentRoute(session.getHostSourceId());
    if (!directParent) return true;
    if (request.type === "send_agent_message_request") {
      if (
        !(ws instanceof VirtualHostSocket) ||
        !session.isRouted() ||
        request.sourceAgentId !== directParent.agentId ||
        request.sourceAgentServerId !== directParent.serverId ||
        request.sourceAgentEvent
      ) {
        ws.close(1008, "Invalid direct-parent message");
        return false;
      }
    }
    if (request.type === "agent.finish_reports.push.request") {
      if (!this.allowsDirectParentReportPush(ws, session, request, directParent)) {
        ws.close(1008, "Invalid direct-parent report route");
        return false;
      }
    }
    if (request.type === "agent_permission_response") {
      return this.allowsDirectParentPermissionResponse(ws, session, request, directParent);
    }
    return true;
  }

  private async allowsDirectParentPermissionResponse(
    ws: WebSocketLike,
    session: Session,
    request: Extract<SessionInboundMessage, { type: "agent_permission_response" }>,
    directParent: NonNullable<ReturnType<typeof readDirectParentRoute>>,
  ): Promise<boolean> {
    try {
      if (
        !(ws instanceof VirtualHostSocket) ||
        !session.isRouted() ||
        !session.allowsInbound(request)
      ) {
        throw new Error("Permission denied for direct-parent operations.");
      }
      const stored = await this.agentStorage.get(request.agentId);
      const child = this.agentManager.getAgent(request.agentId);
      assertDirectParent(child?.labels, this.serverId, directParent);
      if (stored?.archivedAt || !child?.pendingPermissions.has(request.requestId)) {
        throw new Error("Permission request is no longer pending.");
      }
    } catch (error) {
      if (!this.canSendSocketFrame(ws)) return false;
      await session.delivery.request(ws, request, async () => {
        session.delivery.reply({
          type: "rpc_error",
          payload: {
            requestId: request.requestId,
            requestType: request.type,
            error: error instanceof Error ? error.message : "Permission response denied",
            code: "access_denied",
          },
        });
      });
      return false;
    }
    return true;
  }

  private async dispatchSessionMessage(
    ws: WebSocketLike,
    activeConnection: SessionConnection,
    message: Extract<WSInboundMessage, { type: "session" }>,
  ): Promise<void> {
    if (message.message.type === "agent.finish_reports.confirm.response") {
      if (
        !(ws instanceof VirtualHostSocket) ||
        !activeConnection.session.isRouted() ||
        !this.hasFinishReportWorkspacePermissions(activeConnection.session) ||
        !activeConnection.session.allowsInbound(message.message) ||
        !this.resolveParentReportConfirmation(ws, message.message)
      ) {
        ws.close(1008, "Unexpected parent report confirmation");
      }
      return;
    }
    // Upload requests must register before the next binary frame is dispatched.
    const allowed = this.allowsDirectParentRequest(ws, activeConnection.session, message.message);
    if (!allowed) return;
    if (typeof allowed !== "boolean" && (!(await allowed) || !this.canSendSocketFrame(ws))) return;
    const link = this.hostLink(ws, activeConnection);
    if (link.handles(message.message)) {
      await activeConnection.session.delivery.request(ws, message.message, () =>
        link.dispatch(message.message),
      );
      return;
    }
    if (message.message.type === "agent.finish_reports.track.request") {
      const request = message.message;
      await activeConnection.session.delivery.request(ws, request, () =>
        this.trackFinishReports(activeConnection.session, request),
      );
      return;
    }
    if (message.message.type === "agent.finish_reports.pull.request") {
      const request = message.message;
      await activeConnection.session.delivery.request(ws, request, () =>
        this.pullFinishReports(activeConnection.session, request, ws instanceof VirtualHostSocket),
      );
      return;
    }
    if (message.message.type === "agent.finish_reports.push.request") {
      const request = message.message;
      await activeConnection.session.delivery.request(ws, request, () =>
        this.pushFinishReport(activeConnection.session, ws, request),
      );
      return;
    }
    if (isHostProxyRequest(message.message)) {
      const request = message.message;
      const session = activeConnection.session;
      await session.delivery.request(ws, request, async () => {
        const canManage = () => session.allowsPermission("daemon.manage");
        const authorized =
          request.type === "daemon.network.get_proxy.request"
            ? session.allowsPermission("daemon.read")
            : canManage();
        const reply = await handleHostProxyRequest({
          request,
          runtime: this.hostProxy,
          source: ws,
          signal: session.delivery.requestSignal,
          authorized,
          allowCredentialReplacement: this.protectedProxySources.has(ws) && !session.isRouted(),
          canManage,
        });
        session.delivery.reply(reply);
      });
      return;
    }
    this.recordInboundSessionRequestType(message.message.type);
    const controlRpc = getControlRpcLogInfo(message.message);
    if (controlRpc) {
      const identity = this.socketIdentities.get(ws);
      let connectionFields: Record<string, unknown>;
      if (identity) {
        connectionFields = toConnectionLogFields(identity);
      } else {
        connectionFields = { clientId: activeConnection.clientId };
      }
      activeConnection.connectionLogger.warn(
        {
          ...connectionFields,
          ...controlRpc,
        },
        "ws_control_rpc_received",
      );
    }
    const startMs = performance.now();
    await activeConnection.session.handleMessage(message.message, ws);
    const durationMs = performance.now() - startMs;
    this.recordRequestLatency(message.message.type, durationMs);

    if (durationMs >= SLOW_REQUEST_THRESHOLD_MS) {
      activeConnection.connectionLogger.warn(
        {
          requestType: message.message.type,
          durationMs: Math.round(durationMs),
          inflightRequests: activeConnection.session.getRuntimeMetrics().inflightRequests,
        },
        "ws_slow_request",
      );
    }
  }

  private handleRawMessageError(params: {
    ws: WebSocketLike;
    data: Buffer | ArrayBuffer | Buffer[] | string;
    error: unknown;
    log: pino.Logger;
  }): void {
    const { ws, data, error, log } = params;
    const err = error instanceof Error ? error : new Error(String(error));
    // Inbound frames can contain hello.auth.password or session secrets.
    log.error({ errorName: err.name }, "Failed to parse/handle message");

    if (this.pendingConnections.has(ws)) {
      this.clearPendingConnection(ws);
      try {
        ws.close(WS_CLOSE_INVALID_HELLO, "Invalid hello");
      } catch {
        // ignore close errors
      }
      return;
    }

    const requestInfo = extractRequestInfoFromUnknownWsInbound(
      this.decodeRawMessagePayloadForError(data),
    );
    this.sessions.get(ws)?.session.delivery.protocolFailure(ws, {
      ...requestInfo,
      error: "Invalid message",
      code: "invalid_message",
    });
  }

  private decodeRawMessagePayloadForError(data: Buffer | ArrayBuffer | Buffer[] | string): unknown {
    try {
      return JSON.parse(bufferFromWsData(data).toString());
    } catch {
      return null;
    }
  }

  private incrementRuntimeCounter(counter: keyof WebSocketRuntimeCounters): void {
    this.runtimeMetrics.incrementCounter(counter);
  }

  private recordInboundMessageType(type: string): void {
    this.runtimeMetrics.recordInboundMessage(type);
  }

  private recordInboundSessionRequestType(type: string): void {
    this.runtimeMetrics.recordInboundSessionRequest(type);
  }

  private recordRequestLatency(type: string, durationMs: number): void {
    this.runtimeMetrics.recordRequestLatency(type, durationMs);
  }

  private collectSessionRuntimeMetrics(): WebSocketRuntimeMetrics {
    const uniqueConnections = new Set<SessionConnection>(this.externalSessionsByKey.values());
    let terminalDirectorySubscriptionCount = 0;
    let terminalSubscriptionCount = 0;
    let workspaceGitWatchedDirectoryCount = 0;
    let workspaceGitWorkspaceRecordCount = 0;
    let workspaceGitSubscriptionCount = 0;
    let inflightRequests = 0;
    let peakInflightRequests = 0;

    for (const connection of uniqueConnections) {
      const sessionMetrics = connection.session.getRuntimeMetrics();
      terminalDirectorySubscriptionCount += sessionMetrics.terminalDirectorySubscriptionCount;
      terminalSubscriptionCount += sessionMetrics.terminalSubscriptionCount;
      workspaceGitWatchedDirectoryCount += sessionMetrics.workspaceGitWatchedDirectoryCount;
      workspaceGitWorkspaceRecordCount += sessionMetrics.workspaceGitWorkspaceRecordCount;
      workspaceGitSubscriptionCount += sessionMetrics.workspaceGitSubscriptionCount;
      inflightRequests += sessionMetrics.inflightRequests;
      peakInflightRequests = Math.max(peakInflightRequests, sessionMetrics.peakInflightRequests);
      connection.session.resetPeakInflight();
    }

    return {
      ...this.checkoutDiffManager.getMetrics(),
      terminalDirectorySubscriptionCount,
      terminalSubscriptionCount,
      workspaceGitWatchedDirectoryCount,
      workspaceGitWorkspaceRecordCount,
      workspaceGitSubscriptionCount,
      inflightRequests,
      peakInflightRequests,
    };
  }

  private flushRuntimeMetrics(options?: { final?: boolean }): void {
    const runtimeMetrics = this.runtimeMetrics.snapshotAndReset();
    const activeConnections = new Set<SessionConnection>(this.sessions.values()).size;
    const activeSockets = this.sessions.size;
    const pendingConnections = this.pendingConnections.size;
    const reconnectGraceSessions = [...this.externalSessionsByKey.values()].filter(
      (connection) =>
        connection.sockets.size === 0 && connection.externalDisconnectCleanupTimeout !== null,
    ).length;
    const sessionMetrics = this.collectSessionRuntimeMetrics();
    const agentSnapshot = this.agentManager.getMetricsSnapshot();
    const gitCommandMetrics = snapshotGitCommandRuntimeMetrics();
    const loggedMetrics = {
      windowMs: runtimeMetrics.windowMs,
      final: Boolean(options?.final),
      sessions: {
        activeConnections,
        externalSessionKeys: this.externalSessionsByKey.size,
        reconnectGraceSessions,
      },
      sockets: {
        activeSockets,
        pendingConnections,
      },
      counters: runtimeMetrics.counters,
      inboundMessageTypesTop: runtimeMetrics.inboundMessageTypesTop,
      inboundSessionRequestTypesTop: runtimeMetrics.inboundSessionRequestTypesTop,
      outboundMessageTypesTop: runtimeMetrics.outboundMessageTypesTop,
      outboundSessionMessageTypesTop: runtimeMetrics.outboundSessionMessageTypesTop,
      outboundAgentStreamTypesTop: runtimeMetrics.outboundAgentStreamTypesTop,
      outboundAgentStreamAgentsTop: runtimeMetrics.outboundAgentStreamAgentsTop,
      outboundBinaryFrameTypesTop: runtimeMetrics.outboundBinaryFrameTypesTop,
      bufferedAmount: runtimeMetrics.bufferedAmount,
      eventLoopDelay: this.snapshotEventLoopDelay(),
      uptimeSeconds: getProcessUptimeSeconds(),
      memory: getProcessMemoryDiagnostics(),
      runtime: sessionMetrics,
      latency: runtimeMetrics.latency,
      agents: agentSnapshot,
      git: {
        commands: gitCommandMetrics,
        workspaceService: this.workspaceGitService.getMetrics(),
      },
    } satisfies WebSocketRuntimeMetricsLogPayload;

    this.lastRuntimeMetricsSnapshot = {
      collectedAt: new Date().toISOString(),
      ...loggedMetrics,
    };
    this.logger.info(loggedMetrics, "ws_runtime_metrics");
  }

  private getClientActivityState(session: Session, source: object): ClientPresenceState {
    const activity = session.getClientActivity(source);
    if (!activity) {
      return {
        appVisible: false,
        focusedAgentId: null,
        focusedTerminalId: null,
        lastActivityAtMs: null,
      };
    }

    return {
      appVisible: activity.appVisible,
      focusedAgentId: activity.focusedAgentId,
      focusedTerminalId: activity.focusedTerminalId,
      lastActivityAtMs: activity.lastActivityAt.getTime(),
    };
  }

  private async broadcastAgentAttention(params: {
    agentId: string;
    provider: AgentProvider;
    reason: "finished" | "error" | "permission";
    attentionTimestamp: Date | null;
  }): Promise<void> {
    const agent = this.agentManager.getAgent(params.agentId);
    if (!agent?.workspaceId) {
      return;
    }
    const clientEntries: Array<{
      ws: WebSocketLike;
      state: ClientPresenceState;
    }> = [];

    for (const [ws, connection] of this.sessions) {
      if (
        connection.session.delivery.isModern(ws)
          ? !connection.session.wantsSourceEvent(ws, "agent_attention_required")
          : !(await connection.session.subscribesToAgent(agent, ws))
      )
        continue;
      clientEntries.push({
        ws,
        state: this.getClientActivityState(connection.session, ws),
      });
    }

    const notificationEntries = clientEntries.filter(({ ws }) =>
      this.sessions.get(ws)?.session.wantsSourceNotification(ws, "agent_attention_required"),
    );
    const allStates = notificationEntries.map((e) => e.state);
    const nowMs = Date.now();
    const assistantMessage = await this.agentManager.getLastAssistantMessage(params.agentId);
    const notification = buildAgentAttentionNotificationPayload({
      reason: params.reason,
      serverId: this.serverId,
      workspaceId: agent.workspaceId,
      agentId: params.agentId,
      assistantMessage,
      permissionRequest: findLatestPermissionRequest(agent.pendingPermissions),
    });

    const plan = this.planOncePerUnreadFinish(
      params,
      computeNotificationPlan({
        allStates,
        focusTarget: { kind: "agent", id: params.agentId },
        pushEligible: isPushEligibleAttentionReason(params.reason),
        nowMs,
      }),
    );

    if (plan.shouldPush) {
      void this.pushNotificationSender.send(notification).catch((err) => {
        this.logger.warn({ err, agentId: params.agentId }, "Failed to send push notification");
      });
    }

    for (const { ws } of clientEntries) {
      const shouldNotify =
        plan.inAppRecipientIndex !== null &&
        notificationEntries[plan.inAppRecipientIndex]?.ws === ws;
      const timestamp = new Date().toISOString();
      const connection = this.sessions.get(ws);
      const attentionPayload = {
        agentId: params.agentId,
        reason: params.reason,
        timestamp,
        shouldNotify,
        notification,
      };
      const message = wrapSessionMessage(
        connection?.session.delivery.isModern(ws) ||
          connection?.session.supportsForSource(CLIENT_CAPS.selectiveAgentTimeline, ws)
          ? {
              type: "agent_attention_required",
              payload: attentionPayload,
            }
          : {
              type: "agent_stream",
              payload: {
                agentId: params.agentId,
                event: {
                  type: "attention_required",
                  provider: params.provider,
                  reason: params.reason,
                  timestamp,
                  shouldNotify,
                  notification,
                },
                timestamp,
              },
            },
      );

      if (message.type === "session" && this.sessions.get(ws)?.session.delivery.isModern(ws))
        this.sessions.get(ws)!.session.publishToSource(ws, message.message);
      else this.sendToClient(ws, message);
    }
  }

  // An agent can finish many times while its first finish is unread, for example when it
  // reacts to each event of a background task. The user hears about an unread finish once.
  // A finish that was not delivered, because the user had the agent on screen, does not count.
  private planOncePerUnreadFinish(
    params: { agentId: string; reason: string; attentionTimestamp: Date | null },
    plan: NotificationPlan,
  ): NotificationPlan {
    if (params.reason !== "finished" || params.attentionTimestamp === null) {
      return plan;
    }
    const unreadFinishAt = params.attentionTimestamp.getTime();
    if (this.notifiedUnreadFinishAt.get(params.agentId) === unreadFinishAt) {
      return { inAppRecipientIndex: null, shouldPush: false };
    }
    if (plan.shouldPush || plan.inAppRecipientIndex !== null) {
      this.notifiedUnreadFinishAt.set(params.agentId, unreadFinishAt);
    }
    return plan;
  }

  private async broadcastTerminalAttention(params: {
    terminalId: string;
    cwd: string;
    workspaceId?: string;
    terminalName: string;
    reason: TerminalAttentionReason;
  }): Promise<void> {
    const clientEntries: Array<{
      ws: WebSocketLike;
      state: ClientPresenceState;
    }> = [];

    for (const [ws, connection] of this.sessions) {
      if (
        connection.session.delivery.isModern(ws)
          ? !connection.session.wantsSourceEvent(ws, "terminal_attention_required")
          : !(await connection.session.subscribesToTerminalDirectory(
              {
                cwd: params.cwd,
                ...(params.workspaceId ? { workspaceId: params.workspaceId } : {}),
              },
              ws,
            ))
      ) {
        continue;
      }
      clientEntries.push({
        ws,
        state: this.getClientActivityState(connection.session, ws),
      });
    }

    const notificationEntries = clientEntries.filter(({ ws }) =>
      this.sessions.get(ws)?.session.wantsSourceNotification(ws, "terminal_attention_required"),
    );
    const allStates = notificationEntries.map((e) => e.state);
    const nowMs = Date.now();
    const workspaceId = params.workspaceId;

    const plan = computeNotificationPlan({
      allStates,
      focusTarget: { kind: "terminal", id: params.terminalId },
      pushEligible: true,
      nowMs,
    });

    const title = terminalAttentionTitle(params.reason);
    const body = params.terminalName;

    if (plan.shouldPush) {
      void this.pushNotificationSender
        .send({
          title,
          body,
          data: {
            serverId: this.serverId,
            terminalId: params.terminalId,
            cwd: params.cwd,
            ...(workspaceId ? { workspaceId } : {}),
          },
        })
        .catch((err) => {
          this.logger.warn(
            { err, terminalId: params.terminalId },
            "Failed to send push notification",
          );
        });
    }

    for (const { ws } of clientEntries) {
      const shouldNotify =
        plan.inAppRecipientIndex !== null &&
        notificationEntries[plan.inAppRecipientIndex]?.ws === ws;
      const message = wrapSessionMessage({
        type: "terminal_attention_required",
        payload: {
          serverId: this.serverId,
          terminalId: params.terminalId,
          cwd: params.cwd,
          ...(workspaceId ? { workspaceId } : {}),
          reason: params.reason,
          title,
          body,
          shouldNotify,
        },
      });
      if (message.type === "session" && this.sessions.get(ws)?.session.delivery.isModern(ws))
        this.sessions.get(ws)!.session.publishToSource(ws, message.message);
      else this.sendToClient(ws, message);
    }
  }
}

interface SocketRequestMetadata {
  host?: string;
  origin?: string;
  userAgent?: string;
  remoteAddress?: string;
}

function createWebSocketConnectionIdentity(
  requestMetadata: SocketRequestMetadata,
  metadata: ExternalSocketMetadata | undefined,
): WebSocketConnectionIdentity {
  return {
    connectionId: `conn_${randomUUID().replaceAll("-", "")}`,
    transport: metadata?.transport ?? "direct",
    peer: resolveConnectionPeer(requestMetadata, metadata),
    browserOrigin: requestMetadata.origin !== undefined,
    ...(requestMetadata.host ? { host: requestMetadata.host } : {}),
    ...(requestMetadata.origin ? { origin: requestMetadata.origin } : {}),
    ...(requestMetadata.userAgent ? { userAgent: requestMetadata.userAgent } : {}),
    ...(requestMetadata.remoteAddress ? { remoteAddress: requestMetadata.remoteAddress } : {}),
    ...(metadata?.relayConnectionId ? { relayConnectionId: metadata.relayConnectionId } : {}),
    ...(metadata?.securityMode ? { securityMode: metadata.securityMode } : {}),
    ...(metadata?.hubDaemonId ? { hubDaemonId: metadata.hubDaemonId } : {}),
  };
}

function sessionConnectionKey(
  principalId: string,
  clientId: string,
  permissionCeiling: readonly DaemonPermission[] | undefined,
): string {
  // Sockets share authorization and subscriptions. Keep distinct permission
  // ceilings apart even if the principal's current grants make them equivalent.
  const ceiling = permissionCeiling ? [...new Set(permissionCeiling)].sort() : null;
  return JSON.stringify([principalId, clientId, ceiling]);
}

function toConnectionLogFields(identity: WebSocketConnectionIdentity): Record<string, string> {
  return {
    connectionId: identity.connectionId,
    transport: identity.transport,
    peer: identity.peer,
    ...(identity.host ? { host: identity.host } : {}),
    ...(identity.origin ? { origin: identity.origin } : {}),
    ...(identity.userAgent ? { userAgent: identity.userAgent } : {}),
    ...(identity.remoteAddress ? { remoteAddress: identity.remoteAddress } : {}),
    ...(identity.relayConnectionId ? { relayConnectionId: identity.relayConnectionId } : {}),
    ...(identity.securityMode ? { securityMode: identity.securityMode } : {}),
    ...(identity.hubDaemonId ? { hubDaemonId: identity.hubDaemonId } : {}),
    ...(identity.clientId ? { clientId: identity.clientId } : {}),
    ...(identity.sessionId ? { sessionId: identity.sessionId } : {}),
    ...(identity.appVersion ? { appVersion: identity.appVersion } : {}),
  };
}

function resolveConnectionPeer(
  requestMetadata: SocketRequestMetadata,
  metadata: ExternalSocketMetadata | undefined,
): WebSocketConnectionIdentity["peer"] {
  if (metadata !== undefined) return "external";
  if (!requestMetadata.remoteAddress) return "local_ipc";
  return isLoopbackAddress(requestMetadata.remoteAddress) ? "loopback" : "external";
}

function isLoopbackAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized === "::1" || normalized === "0:0:0:0:0:0:0:1") return true;
  const ipv4 = normalized.startsWith("::ffff:") ? normalized.slice("::ffff:".length) : normalized;
  return ipv4.startsWith("127.");
}

function extractSocketRequestMetadata(request: unknown): SocketRequestMetadata {
  if (!request || typeof request !== "object") {
    return {};
  }

  const record = request as {
    headers?: {
      host?: unknown;
      origin?: unknown;
      "user-agent"?: unknown;
    };
    url?: unknown;
    socket?: {
      remoteAddress?: unknown;
    };
  };

  const host = typeof record.headers?.host === "string" ? record.headers.host : undefined;
  const origin = typeof record.headers?.origin === "string" ? record.headers.origin : undefined;
  const userAgent =
    typeof record.headers?.["user-agent"] === "string" ? record.headers["user-agent"] : undefined;
  const remoteAddress =
    typeof record.socket?.remoteAddress === "string" ? record.socket.remoteAddress : undefined;

  return {
    ...(host ? { host } : {}),
    ...(origin ? { origin } : {}),
    ...(userAgent ? { userAgent } : {}),
    ...(remoteAddress ? { remoteAddress } : {}),
  };
}

interface HostAuthority {
  hostname: string;
  port: string | null;
}

function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function parseHostAuthority(host: string): HostAuthority | null {
  const trimmed = host.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    if (end === -1) {
      return null;
    }
    const hostname = stripIpv6Brackets(trimmed.slice(0, end + 1)).toLowerCase();
    const rest = trimmed.slice(end + 1);
    if (!rest) {
      return { hostname, port: null };
    }
    if (!rest.startsWith(":")) {
      return null;
    }
    const port = rest.slice(1);
    return port ? { hostname, port } : null;
  }

  const firstColon = trimmed.indexOf(":");
  if (firstColon === -1) {
    return { hostname: trimmed.toLowerCase(), port: null };
  }
  if (trimmed.indexOf(":", firstColon + 1) !== -1) {
    return { hostname: trimmed.toLowerCase(), port: null };
  }
  const hostname = trimmed.slice(0, firstColon).toLowerCase();
  const port = trimmed.slice(firstColon + 1);
  return hostname && port ? { hostname, port } : null;
}

function defaultPortForOriginProtocol(protocol: string): string | null {
  if (protocol === "http:") {
    return "80";
  }
  if (protocol === "https:") {
    return "443";
  }
  return null;
}

function isLoopbackAlias(hostname: string): boolean {
  const normalized = stripIpv6Brackets(hostname).toLowerCase();
  if (normalized === "localhost" || normalized.endsWith(".localhost")) {
    return true;
  }
  if (normalized === "::1" || normalized === "0:0:0:0:0:0:0:1") {
    return true;
  }
  return /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

/**
 * Whether a page at `origin` may talk to the daemon reached at `requestHost`. The WebSocket
 * upgrade and the HTTP CORS check both use it, so a page that can connect can also fetch.
 */
export function isDaemonOriginAllowed(
  origin: string,
  requestHost: string | null,
  allowedOrigins: Set<string>,
): boolean {
  return (
    allowedOrigins.has("*") ||
    allowedOrigins.has(origin) ||
    isWebSocketSameOrigin(origin, requestHost)
  );
}

export function isWebSocketSameOrigin(
  origin: string | undefined,
  requestHost: string | null,
): boolean {
  if (!origin || !requestHost) {
    return false;
  }

  if (origin === `http://${requestHost}` || origin === `https://${requestHost}`) {
    return true;
  }

  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    return false;
  }
  const originPort = originUrl.port || defaultPortForOriginProtocol(originUrl.protocol);
  if (!originPort) {
    return false;
  }

  const requestAuthority = parseHostAuthority(requestHost);
  if (!requestAuthority) {
    return false;
  }
  const requestPort = requestAuthority.port || defaultPortForOriginProtocol(originUrl.protocol);
  if (originPort !== requestPort) {
    return false;
  }

  return isLoopbackAlias(originUrl.hostname) && isLoopbackAlias(requestAuthority.hostname);
}

function selectWebSocketProtocol(
  protocols: Set<string>,
  password: string | undefined,
): string | false {
  if (!password) {
    return protocols.values().next().value ?? false;
  }

  for (const protocol of protocols) {
    const token = extractWsBearerToken(protocol);
    if (token !== null) {
      return protocol;
    }
  }

  return false;
}

function stringifyCloseReason(reason: unknown): string | null {
  if (typeof reason === "string") {
    return reason.length > 0 ? reason : null;
  }
  if (Buffer.isBuffer(reason)) {
    const text = reason.toString();
    return text.length > 0 ? text : null;
  }
  if (reason == null) {
    return null;
  }
  const text = String(reason);
  return text.length > 0 ? text : null;
}

function getControlRpcLogInfo(
  message: Extract<WSInboundMessage, { type: "session" }>["message"],
): { requestType: string; requestId: string; reason?: string } | null {
  if (message.type === "shutdown_server_request") {
    return {
      requestType: message.type,
      requestId: message.requestId,
      reason: CLIENT_SHUTDOWN_RPC_REASON,
    };
  }
  if (message.type === "restart_server_request") {
    const reason = normalizeClientRestartRpcReason(message.reason);
    return {
      requestType: message.type,
      requestId: message.requestId,
      reason,
    };
  }
  if (message.type === "daemon.update.request") {
    return {
      requestType: message.type,
      requestId: message.requestId,
      reason: "daemon_update",
    };
  }
  return null;
}

function getSessionRequestTypeFromUnknownWsInbound(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return;
  const record = payload as { type?: unknown; message?: unknown };
  if (record.type !== "session" || !record.message || typeof record.message !== "object") return;
  const { type } = record.message as { type?: unknown };
  return typeof type === "string" ? type : undefined;
}

function extractRequestInfoFromUnknownWsInbound(
  payload: unknown,
): { requestId: string; requestType?: string } | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const record = payload as {
    type?: unknown;
    requestId?: unknown;
    message?: unknown;
  };

  // Session-wrapped messages
  if (record.type === "session" && record.message && typeof record.message === "object") {
    const msg = record.message as { requestId?: unknown; type?: unknown };
    if (typeof msg.requestId === "string") {
      return {
        requestId: msg.requestId,
        ...(typeof msg.type === "string" ? { requestType: msg.type } : {}),
      };
    }
  }

  // Non-session messages (future-proof)
  if (typeof record.requestId === "string") {
    return {
      requestId: record.requestId,
      ...(typeof record.type === "string" ? { requestType: record.type } : {}),
    };
  }

  return null;
}
