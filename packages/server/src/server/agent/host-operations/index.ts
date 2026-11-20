import type {
  AgentPermissionResponse,
  AgentSessionConfig,
  AgentStreamEvent,
} from "../agent-sdk-types.js";
import { getParentAddressFromLabels, parentAddressLabels } from "@getpaseo/protocol/agent-labels";
import type { AgentAddress } from "@getpaseo/protocol/addresses";
import type { ActiveTurnBehavior, AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  DaemonClient,
  DaemonConnectionError,
  type FetchWorkspacesEntry,
  type WaitForFinishResult,
} from "@getpaseo/client/internal/daemon-client";
import type { DaemonTransportFactory } from "@getpaseo/client/internal/daemon-client-transport-types";
import type { HostDirectory } from "@getpaseo/protocol/hosts";
import { OWNER_PERMISSIONS } from "../../authorization/index.js";
import type { ConnectedHosts } from "../../connected-hosts/index.js";
import { resolveRequiredProviderModel } from "../mcp-shared.js";
import { selectAgentListItems } from "../agent-projections.js";
import { summarizeAgentActivity } from "../activity-curator.js";
import {
  MAX_SUBAGENT_DEPTH,
  REMOTE_HIERARCHY_DEPTH_LABEL,
  resolveInheritedHierarchyMode,
} from "../hierarchy-policy.js";
import {
  inheritAgentBackground,
  inheritWorkspaceBackground,
  type BackgroundCaller,
} from "../create-agent/intent.js";
import { expandUserPath } from "../../path-utils.js";
import type { PaseoToolExecutionContext, PaseoToolResult } from "../tools/types.js";

export class HostOperationRejectedError extends Error {
  readonly code: unknown;
  constructor(error: unknown) {
    super(error instanceof Error ? error.message : String(error), { cause: error });
    this.name = "HostOperationRejectedError";
    this.code = error instanceof Error && "code" in error ? error.code : undefined;
  }
}
function isAmbiguousPromptFailure(error: unknown): boolean {
  if (error instanceof DaemonConnectionError) return true;
  return error instanceof Error && error.message.startsWith("Timeout waiting for message");
}
export type HostOperation = (
  input: Record<string, unknown>,
  context: PaseoToolExecutionContext,
) => Promise<PaseoToolResult>;
export interface HostOperations {
  createAgent: HostOperation;
  createWorkspace: HostOperation;
  listWorkspaces: HostOperation;
  sendPrompt: HostOperation;
  respondToPermission: HostOperation;
  getStatus: HostOperation;
  getActivity: HostOperation;
  listAgents: HostOperation;
}
/** Connection authority at the host boundary, independent of child lifecycle. */
export class HostObservationError extends Error {
  constructor(
    readonly reason: "connecting" | "unreachable" | "removed",
    cause?: unknown,
  ) {
    super(`Host observation ${reason}`, { cause });
    this.name = "HostObservationError";
  }
}
export interface HostObservation {
  wait(agentId: string, signal: AbortSignal): Promise<WaitForFinishResult>;
  observe(
    agentId: string,
    handler: (
      snapshot: AgentSnapshotPayload | null,
      event?: AgentStreamEvent,
      lastMessage?: string | null,
    ) => void,
    signal: AbortSignal,
    onError: (error: unknown) => void,
  ): Promise<() => Promise<void>>;
}
export interface ToolHosts {
  directory(): Promise<HostDirectory>;
  use<T>(
    serverId: string,
    action: (client: DaemonClient) => Promise<T>,
    signal?: AbortSignal,
    directParentAgentId?: string,
  ): Promise<T>;
}

const DIRECT_PARENT_SOURCE = "mcp-direct-parent:";
export const DIRECT_PARENT_ROUTE_ACK = ":direct-parent";

export function readDirectParentRoute(sourceId: string): AgentAddress | undefined {
  const parts = sourceId.split(":");
  if (parts.length !== 4 || parts[0] !== "route") return;
  try {
    const producer = decodeURIComponent(parts[3]!);
    if (!producer.startsWith(DIRECT_PARENT_SOURCE)) return;
    const agentId = producer.slice(DIRECT_PARENT_SOURCE.length);
    if (agentId) return { agentId, serverId: decodeURIComponent(parts[2]!) };
  } catch {
    return;
  }
}

export class DirectParentRequiredError extends Error {
  constructor() {
    super("You can only manage your direct subagents.");
  }
}

export function assertDirectParent(
  labels: Record<string, string> | undefined,
  serverId: string,
  expected: AgentAddress,
): void {
  const parent = getParentAddressFromLabels(labels, serverId);
  if (parent?.agentId !== expected.agentId || parent.serverId !== expected.serverId) {
    throw new DirectParentRequiredError();
  }
}

/** Daemon MCP has the daemon's authority, bounded by the destination's admission of its link. */
export function createToolHosts(hosts: ConnectedHosts): ToolHosts {
  return {
    directory: () => hosts.list(),
    async use(serverId, action, signal, directParentAgentId) {
      const lifetime = new AbortController();
      let routeFailure: unknown;
      const transportFactory: DaemonTransportFactory = () => {
        const opens = new Set<() => void>();
        const closes = new Set<(event?: unknown) => void>();
        const errors = new Set<(event: unknown) => void>();
        const messages = new Set<(data: unknown, binary: boolean) => void>();
        let closed = false;
        let route: Awaited<ReturnType<ConnectedHosts["openRoute"]>> | undefined;
        void hosts
          .openRoute({
            serverId,
            scopeId: randomUUID(),
            sourceId: directParentAgentId ? DIRECT_PARENT_SOURCE + directParentAgentId : "mcp",
            originSessionId: "mcp",
            permissions: OWNER_PERMISSIONS,
            signal: signal ? AbortSignal.any([lifetime.signal, signal]) : lifetime.signal,
            frame: (data) => {
              for (const listener of messages) listener(data, typeof data !== "string");
            },
            ended: (code, message) => {
              for (const listener of errors)
                listener(Object.assign(new Error(message), { code, serverId }));
              for (const listener of closes) listener();
            },
          })
          .then((opened) => {
            route = opened;
            if (closed) opened.close();
            else for (const listener of opens) listener();
            return undefined;
          })
          .catch((error) => {
            routeFailure = error;
            for (const listener of errors) listener(error);
            for (const listener of closes) listener(error);
          });
        return {
          send: (data) => {
            if (!route) throw new Error("Host route is not open");
            route.send(data instanceof ArrayBuffer ? new Uint8Array(data) : data);
          },
          close: () => {
            closed = true;
            route?.close();
          },
          onOpen: (listener) => {
            opens.add(listener);
            return () => opens.delete(listener);
          },
          onClose: (listener) => {
            closes.add(listener);
            return () => closes.delete(listener);
          },
          onError: (listener) => {
            errors.add(listener);
            return () => errors.delete(listener);
          },
          onMessage: (listener) => {
            messages.add(listener);
            return () => messages.delete(listener);
          },
        };
      };
      const client = new DaemonClient({
        url: "ws://host-route/ws",
        clientId: randomUUID(),
        transportFactory,
        reconnect: { enabled: false },
      });
      const stop = () => void client.close();
      signal?.addEventListener("abort", stop, { once: true });
      try {
        signal?.throwIfAborted();
        await client.connect().catch((error) => {
          // The action has not run; no application request could have been transmitted.
          throw new HostOperationRejectedError(routeFailure ?? error);
        });
        if (directParentAgentId) {
          const source = client.getLastServerInfoMessage()?.sourceId;
          if (
            !source?.endsWith(DIRECT_PARENT_ROUTE_ACK) ||
            readDirectParentRoute(source.slice(0, -DIRECT_PARENT_ROUTE_ACK.length))?.agentId !==
              directParentAgentId
          ) {
            // COMPAT(directParentRoute): added in v0.16.0, remove after 2027-05-19.
            throw new HostOperationRejectedError(
              new Error("Update the destination Paseo host to use direct-parent operations."),
            );
          }
        }
        return await action(client);
      } finally {
        signal?.removeEventListener("abort", stop);
        lifetime.abort();
        await client.close();
      }
    },
  };
}

const remoteCreate = z
  .object({
    provider: z.string().min(1),
    title: z.string().trim().min(1).max(60),
    initialPrompt: z.string().min(1),
    workspaceId: z.string().min(1),
    labels: z.record(z.string(), z.string()).optional(),
    notifyOnFinish: z.boolean().optional(),
    background: z.boolean().optional(),
    idempotencyKey: z.string().optional(),
    settings: z
      .object({
        modeId: z.string().optional(),
        thinkingOptionId: z.string().optional(),
        features: z.record(z.string(), z.unknown()).optional(),
      })
      .optional(),
  })
  .strict();
const result = (structuredContent: unknown): PaseoToolResult => ({
  content: [],
  structuredContent,
});

function assertRemoteHierarchySupport(
  client: DaemonClient,
  callerAgentId: string | undefined,
  labels: Record<string, string> | undefined,
): void {
  // COMPAT(agentHierarchyControl): added in v0.16.0, remove gate after 2027-05-19.
  if (
    callerAgentId &&
    labels?.[REMOTE_HIERARCHY_DEPTH_LABEL] === String(MAX_SUBAGENT_DEPTH) &&
    client.getLastServerInfoMessage()?.features?.agentHierarchyControl !== true
  ) {
    throw new HostOperationRejectedError(
      new Error("Update the destination Paseo host to create a Level-2 subagent."),
    );
  }
}

function shouldObserveRemoteFollowups(
  client: DaemonClient,
  labels: Record<string, string> | undefined,
  notifyOnFinish: boolean | undefined,
): boolean {
  // COMPAT(agentFinishReportPull): added in v0.16.0, remove gate after 2027-05-19.
  return (
    notifyOnFinish !== false &&
    labels?.[REMOTE_HIERARCHY_DEPTH_LABEL] === "1" &&
    client.getLastServerInfoMessage()?.features?.agentFinishReportPull === true
  );
}

export function createHostResolver(input: {
  serverId: string;
  local: HostOperations;
  hosts: () => ToolHosts;
  callerAgentId?: string;
  trackRemoteChild?(childAgentId: string, serverId: string): Promise<void>;
  /** The destination can't see the caller, so its defaults resolve before routing. */
  caller: () =>
    | (BackgroundCaller & {
        provider: string;
        currentModeId: string | null;
        labels?: Record<string, string>;
        config: Pick<AgentSessionConfig, "providerOptions">;
      })
    | null;
  lockedCwd?: string;
}) {
  return {
    directory: () => input.hosts().directory(),
    async use<T>(
      serverId: string | undefined,
      action: (host: HostOperations) => Promise<T>,
      directParentAgentId?: string,
    ): Promise<T> {
      const destination = serverId ?? input.serverId;
      if (destination === input.serverId) return action(input.local);
      if (input.lockedCwd)
        throw new Error("This caller is restricted to its local working directory");
      const use = (invoke: (client: DaemonClient) => Promise<T>) =>
        input.hosts().use(destination, invoke, undefined, directParentAgentId);
      return use(async (client) =>
        action({
          async createAgent(args) {
            const parsed = remoteCreate.parse(args);
            assertRemoteHierarchySupport(client, input.callerAgentId, parsed.labels);
            const { provider, model } = resolveRequiredProviderModel(parsed.provider);
            const caller = input.caller();
            const sameProviderCaller = caller?.provider === provider ? caller : null;
            // Same-provider children inherit the caller's mode, as they would on the same host.
            const modeId =
              parsed.settings?.modeId ??
              (sameProviderCaller
                ? (resolveInheritedHierarchyMode(
                    sameProviderCaller.currentModeId,
                    sameProviderCaller.labels,
                  ) ?? undefined)
                : undefined);
            const inheritedOptions = sameProviderCaller?.config.providerOptions;
            const workspace = await client.findWorkspace(parsed.workspaceId);
            if (!workspace) throw new Error(`Workspace ${parsed.workspaceId} not found`);
            const labels: Record<string, string> = {
              ...parsed.labels,
              ...(input.callerAgentId
                ? parentAddressLabels({ agentId: input.callerAgentId, serverId: input.serverId })
                : {}),
            };
            const snapshot = await client.createAgent({
              config: {
                provider,
                model,
                cwd: workspace.workspaceDirectory,
                title: parsed.title,
                modeId,
                ...(inheritedOptions && Object.keys(inheritedOptions).length > 0
                  ? { providerOptions: { ...inheritedOptions, ...parsed.settings?.features } }
                  : { featureValues: parsed.settings?.features }),
                thinkingOptionId: parsed.settings?.thinkingOptionId,
              },
              workspaceId: parsed.workspaceId,
              // Older hosts reject any background with a workspaceId, so a visible create omits it.
              ...(inheritAgentBackground(parsed.background, caller) ? { background: true } : {}),
              labels,
              initialPrompt: parsed.initialPrompt,
              idempotencyKey: parsed.idempotencyKey,
            });
            if (shouldObserveRemoteFollowups(client, labels, undefined))
              await input.trackRemoteChild?.(snapshot.id, destination);
            return result({
              agentId: snapshot.id,
              type: snapshot.provider,
              status: snapshot.status,
              cwd: snapshot.cwd,
              workspaceId: snapshot.workspaceId,
              currentModeId: snapshot.currentModeId,
              availableModes: snapshot.availableModes,
            });
          },
          async sendPrompt(args) {
            const agentId = args.agentId as string;
            // Human sends retain the established mode RPC on older connected hosts.
            // Agent sends apply their requested mode when the recipient dispatches the batch.
            if (!input.callerAgentId && args.sessionMode !== undefined) {
              await client.setAgentMode(agentId, args.sessionMode as string);
            }
            const agent = (
              await client.fetchAgent(agentId).catch((error) => {
                // Snapshot preflight precedes sendMessage, so failure is definitely unsent.
                throw new HostOperationRejectedError(error);
              })
            )?.agent;
            if (!agent)
              throw new HostOperationRejectedError(new Error(`Agent ${agentId} not found`));
            const parent = getParentAddressFromLabels(agent.labels, destination);
            if (
              parent?.serverId === input.serverId &&
              parent.agentId === input.callerAgentId &&
              shouldObserveRemoteFollowups(
                client,
                agent.labels,
                args.notifyOnFinish as boolean | undefined,
              )
            ) {
              await input.trackRemoteChild?.(agentId, destination).catch((error) => {
                throw new HostOperationRejectedError(error);
              });
            }
            const receipt = await client
              .sendMessage(agentId, args.prompt as string, {
                waitForDispatch: args.requireParentOwnership === true ? true : undefined,
                sessionMode: input.callerAgentId
                  ? (args.sessionMode as string | undefined)
                  : undefined,
                sourceAgentId: input.callerAgentId,
                sourceAgentServerId: input.callerAgentId ? input.serverId : undefined,
                activeTurnBehavior:
                  (args.activeTurnBehavior as ActiveTurnBehavior | undefined) ??
                  (input.callerAgentId ? "steer" : "interrupt"),
              })
              .catch((error) => {
                if (isAmbiguousPromptFailure(error)) throw error;
                throw new HostOperationRejectedError(error);
              });
            return result({
              success: true,
              ...receipt,
              status: agent.status,
              guidance:
                receipt.deliveryStatus === "queued"
                  ? "Queued for delivery after two quiet seconds. You will get notified when the prompted agent finishes, errors, or needs permission unless notifyOnFinish is false."
                  : "Dispatch acknowledged. Observe completion using get_agent_status/get_agent_activity or SDK/RPC subscriptions and wait APIs.",
            });
          },
          async respondToPermission(args) {
            const agentId = args.agentId as string;
            const requestId = args.requestId as string;
            const agent = (await client.fetchAgent(agentId))?.agent;
            if (!agent || agent.archivedAt) throw new Error(`Agent ${agentId} is unavailable`);
            if (input.callerAgentId) {
              assertDirectParent(agent.labels, destination, {
                agentId: input.callerAgentId,
                serverId: input.serverId,
              });
            }
            if (!agent.pendingPermissions.some((request) => request.id === requestId)) {
              throw new Error(`Permission request ${requestId} is no longer pending`);
            }
            await client.respondToPermissionAndWait(
              agentId,
              requestId,
              args.response as AgentPermissionResponse,
            );
            return result({ success: true });
          },
          async getStatus(args) {
            const agent = (await client.fetchAgent(args.agentId as string))?.agent;
            if (!agent) throw new Error(`Agent ${args.agentId} not found`);
            return result({ status: agent.status, snapshot: agent });
          },
          async getActivity(args) {
            const agentId = args.agentId as string;
            const limit = args.limit as number | undefined;
            const timeline = await client.fetchAgentTimeline(agentId, {
              direction: "tail",
              limit: limit ?? 0,
            });
            const agent = (await client.fetchAgent(agentId))?.agent;
            if (!agent) throw new Error(`Agent ${agentId} not found`);
            return result({
              agentId,
              ...summarizeAgentActivity(
                timeline.entries.map((entry) => entry.item),
                limit,
              ),
              currentModeId: agent.currentModeId,
            });
          },
          async listAgents(args) {
            const { entries } = await client.fetchAgents({
              includeBackground: args.includeBackground === true,
              filter: { includeArchived: args.includeArchived === true },
            });
            return result({
              agents: selectAgentListItems(
                entries.map((entry) => entry.agent),
                {
                  cwd: (args.cwd as string | undefined)?.trim()
                    ? expandUserPath(args.cwd as string)
                    : undefined,
                  statuses: args.statuses as AgentSnapshotPayload["status"][] | undefined,
                  sinceHours: args.sinceHours as number | undefined,
                  limit: args.limit as number | undefined,
                },
              ),
            });
          },
          async listWorkspaces(args) {
            const { entries } = await client.fetchWorkspaces({
              includeBackground: args.includeBackground === true,
            });
            return result({ workspaces: entries.map(workspaceSummary) });
          },
          async createWorkspace(args) {
            const isolation = z.enum(["local", "worktree"]).parse(args.isolation);
            const path = z.string().min(1).parse(args.path);
            const response = await client.createWorkspace({
              source:
                isolation === "local"
                  ? { kind: "directory", path, projectId: args.projectId as string | undefined }
                  : {
                      kind: "worktree",
                      cwd: path,
                      projectId: args.projectId as string | undefined,
                      action:
                        args.mode === "checkout-branch" || args.mode === "checkout-pr"
                          ? "checkout"
                          : "branch-off",
                      baseBranch: args.baseBranch as string | undefined,
                      branchName: args.branchName as string | undefined,
                      refName: args.branch as string | undefined,
                      githubPrNumber: args.prNumber as number | undefined,
                      worktreeSlug: args.worktreeSlug as string | undefined,
                    },
              title: args.title as string | undefined,
              background: inheritWorkspaceBackground(
                args.background as boolean | undefined,
                input.caller(),
              ),
            });
            if (response.error || !response.workspace)
              throw new Error(response.error ?? "Workspace creation failed");
            return result(workspaceSummary(response.workspace));
          },
        }),
      );
    },
  };
}
function workspaceSummary(workspace: FetchWorkspacesEntry) {
  return {
    workspaceId: workspace.id,
    projectId: workspace.projectId,
    cwd: workspace.workspaceDirectory,
    isolation: workspace.workspaceKind === "worktree" ? "worktree" : "local",
    kind: workspace.workspaceKind === "checkout" ? "local_checkout" : workspace.workspaceKind,
    title: workspace.title,
    background: workspace.background,
  };
}

function remoteObservation(client: DaemonClient): HostObservation {
  let updates = Promise.resolve();
  return {
    async observe(agentId, handler, signal, onError) {
      const observation = client.observeTimeline([agentId], { signal });
      let started: { turnId: string; timestamp: string } | undefined;
      async function readTurnResponse(turnId: string, startedAt?: string): Promise<string | null> {
        const chunks: string[] = [];
        let cursor: { epoch: string; seq: number } | undefined;
        do {
          signal.throwIfAborted();
          const page = await client.fetchAgentTimeline(agentId, {
            direction: cursor ? "before" : "tail",
            cursor,
            limit: 200,
          });
          // Retraction changes the timeline epoch. Discard a partial read across that boundary.
          if (cursor && page.reset) return null;
          for (const entry of page.entries.toReversed()) {
            if (entry.turnId !== turnId) {
              if (startedAt && entry.timestamp < startedAt)
                return chunks.length ? chunks.toReversed().join("") : null;
              continue;
            }
            if (entry.item.type === "assistant_message") chunks.push(entry.item.text);
            else if (chunks.length) return chunks.toReversed().join("");
          }
          cursor = page.hasOlder ? (page.startCursor ?? undefined) : undefined;
        } while (cursor);
        return chunks.length ? chunks.toReversed().join("") : null;
      }
      async function refreshTerminal(
        event: Extract<
          AgentStreamEvent,
          { type: "turn_completed" | "turn_canceled" | "turn_failed" }
        >,
        endedAt: string,
        startedAt?: string,
      ): Promise<void> {
        const snapshot = (await client.fetchAgent(agentId))?.agent;
        if (!snapshot) return;
        const failed = event.type === "turn_failed";
        const running = snapshot.status === "running" || snapshot.status === "initializing";
        if (running) {
          // An interrupt can keep the old turn busy until its replacement starts.
          if (event.type === "turn_canceled") return;
          const active = snapshot.activeTurn;
          const nextTurnStarted =
            event.turnId &&
            ((started && started.turnId !== event.turnId) ||
              (active?.startedAt && active.turnId !== event.turnId && active.startedAt >= endedAt));
          if (!nextTurnStarted && (!failed || !startedAt)) return;
        }
        // The latest wait may already describe another turn. Read only rows owned by this event.
        const lastMessage = event.turnId ? await readTurnResponse(event.turnId, startedAt) : null;
        const status = failed ? "error" : "idle";
        handler(
          {
            ...snapshot,
            status,
            lastError: failed ? event.error : undefined,
            activeTurn: null,
            pendingPermissions: [],
          },
          event,
          lastMessage,
        );
      }
      const refreshPermission = async (event: AgentStreamEvent) => {
        let snapshot = (await client.fetchAgent(agentId))?.agent ?? null;
        let lastMessage: string | null = null;
        if (
          snapshot &&
          (snapshot.status === "idle" ||
            snapshot.status === "closed" ||
            snapshot.status === "error" ||
            snapshot.pendingPermissions.length > 0)
        ) {
          // A new turn may start between the snapshot and the current-response read.
          // Bound that wait and refresh state instead of attributing the old event to it.
          const current = await client.waitForFinish(agentId, 100);
          if (current.status === "timeout") {
            // Queued delivery can leave a closed/error snapshot visible before the new turn.
            // A timed-out wait has not established an outcome for that queued work.
            if (event.type === "permission_resolved") handler(snapshot, event);
            return;
          }
          if (!current.final && current.error && current.error !== `Agent not found: ${agentId}`)
            throw new Error(current.error);
          snapshot = current.final;
          lastMessage = current.lastMessage;
        }
        handler(snapshot, event, lastMessage);
      };
      const unsubscribe = observation.subscribe({
        snapshot: () => {},
        update: (message) => {
          if (message.type !== "agent_stream" || message.payload.agentId !== agentId) return;
          const event = message.payload.event;
          if (event.type === "turn_started") {
            if (event.turnId)
              started = { turnId: event.turnId, timestamp: message.payload.timestamp };
            return;
          }
          if (event.type === "permission_requested" || event.type === "permission_resolved") {
            updates = updates.then(() => refreshPermission(event)).catch(onError);
          } else if (
            event.type === "turn_completed" ||
            event.type === "turn_canceled" ||
            event.type === "turn_failed"
          ) {
            if (started && event.turnId && started.turnId !== event.turnId) return;
            const startedAt = started?.turnId === event.turnId ? started?.timestamp : undefined;
            updates = updates
              .then(() => refreshTerminal(event, message.payload.timestamp, startedAt))
              .catch(onError);
          }
        },
        error: onError,
      });
      try {
        await observation.ready;
        // The initial wait publishes the baseline after any terminal events received while opening.
        const active = (await client.fetchAgent(agentId))?.agent.activeTurn;
        if (active?.startedAt) started ??= { turnId: active.turnId, timestamp: active.startedAt };
      } catch (error) {
        unsubscribe();
        await observation.release();
        throw error;
      }
      return async () => {
        unsubscribe();
        await observation.release();
      };
    },
    wait: (agentId, signal) => {
      const close = () => void client.close();
      signal.addEventListener("abort", close, { once: true });
      return client
        .waitForFinish(agentId, 0)
        .then(async (outcome) => {
          // Publish stream events already received before considering a later baseline snapshot.
          await updates;
          if (!outcome.final && outcome.error && outcome.error !== `Agent not found: ${agentId}`)
            throw new Error(outcome.error);
          return outcome;
        })
        .finally(() => signal.removeEventListener("abort", close));
    },
  };
}

/** Shares routed status observation with daemon services independently of MCP execution. */
export function createHostObservationResolver(input: {
  serverId: string;
  local: HostObservation;
  hosts(): ToolHosts;
}) {
  return {
    async use<T>(
      serverId: string | undefined,
      action: (host: HostObservation) => Promise<T>,
      signal?: AbortSignal,
    ): Promise<T> {
      if (!serverId || serverId === input.serverId) return action(input.local);
      const hosts = input.hosts();
      async function classify(error: unknown): Promise<HostObservationError> {
        // This is the origin's authoritative registration directory, not a destination RPC error.
        const row = (await hosts.directory()).hosts.find((host) => host.serverId === serverId);
        if (!row) return new HostObservationError("removed", error);
        if (row.status === "connecting") return new HostObservationError("connecting", error);
        return new HostObservationError("unreachable", error);
      }
      async function fail(error: unknown): Promise<never> {
        throw await classify(error);
      }
      try {
        return await hosts.use(
          serverId,
          (client) => {
            const remote = remoteObservation(client);
            return action({
              wait: (agentId, lifetime) => remote.wait(agentId, lifetime).catch(fail),
              observe(agentId, handler, lifetime, onError) {
                async function report(error: unknown): Promise<void> {
                  try {
                    onError(await classify(error));
                  } catch (failure) {
                    onError(failure);
                  }
                }
                return remote.observe(agentId, handler, lifetime, report).catch(fail);
              },
            });
          },
          signal,
        );
      } catch (error) {
        if (error instanceof HostObservationError) throw error;
        return fail(error);
      }
    },
  };
}
