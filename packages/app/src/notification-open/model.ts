import { buildHostRootRoute } from "@/utils/host-routes";
import type { NotificationOpenSource, NotificationTap } from "./source";

export const WEB_NOTIFICATION_CLICK_EVENT = "paseo:web-notification-click";

export type NotificationOpenTarget =
  | {
      kind: "todo_due";
      serverId: string;
      workspaceId: string;
      agentId?: string;
      topicKey?: string;
      todoId?: string;
    }
  | { kind: "agent"; serverId: string; agentId: string; workspaceId?: string; topicKey?: string }
  | { kind: "terminal"; serverId: string; workspaceId: string; terminalId: string }
  | { kind: "host"; serverId: string };

function readId(data: object, key: string): string {
  const value: unknown = Reflect.get(data, key);
  return typeof value === "string" ? value.trim() : "";
}

export function parseNotificationOpenTarget(data: unknown): NotificationOpenTarget | null {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const serverId = readId(data, "serverId");
  if (!serverId) return null;
  const workspaceId = readId(data, "workspaceId");
  const reason = readId(data, "reason");
  if (reason === "todo_due" && workspaceId) {
    const agentId = readId(data, "agentId");
    const topicKey = readId(data, "topicKey");
    const todoId = readId(data, "todoId");
    return {
      kind: "todo_due",
      serverId,
      workspaceId,
      ...(agentId ? { agentId } : {}),
      ...(topicKey ? { topicKey } : {}),
      ...(todoId ? { todoId } : {}),
    };
  }
  const terminalId = readId(data, "terminalId");
  if (workspaceId && terminalId) return { kind: "terminal", serverId, workspaceId, terminalId };
  const agentId = readId(data, "agentId");
  if (agentId) {
    const topicKey = readId(data, "topicKey");
    return {
      kind: "agent",
      serverId,
      agentId,
      ...(reason === "finished" && workspaceId && topicKey ? { workspaceId, topicKey } : {}),
    };
  }
  return { kind: "host", serverId };
}

interface NotificationOpenRouterDeps {
  source: NotificationOpenSource;
  openAgent: (target: Omit<Extract<NotificationOpenTarget, { kind: "agent" }>, "kind">) => void;
  openRoute: (route: string) => void;
  openTerminal: (target: Extract<NotificationOpenTarget, { kind: "terminal" }>) => void;
  openTodoDue?: (target: Extract<NotificationOpenTarget, { kind: "todo_due" }>) => void;
  whenReadyToNavigate: () => Promise<void>;
}

export function createNotificationOpenRouter(deps: NotificationOpenRouterDeps) {
  const handledIds = new Set<string>();
  let launchTaken = false;
  async function receive(tap: NotificationTap) {
    if (handledIds.has(tap.id)) return;
    handledIds.add(tap.id);
    await deps.whenReadyToNavigate();
    const target = parseNotificationOpenTarget(tap.data);
    if (target?.kind === "todo_due") {
      if (deps.openTodoDue) {
        deps.openTodoDue(target);
      } else if (target.agentId) {
        deps.openAgent({ serverId: target.serverId, agentId: target.agentId });
      }
    } else if (target?.kind === "agent") {
      const { kind: _, ...agent } = target;
      deps.openAgent(agent);
    } else if (target?.kind === "terminal") {
      deps.openTerminal(target);
    } else if (target?.kind === "host") {
      deps.openRoute(buildHostRootRoute(target.serverId));
    }
    deps.source.acknowledge(tap);
  }
  return {
    start() {
      const unsubscribe = deps.source.subscribe((tap) => {
        void receive(tap);
      });
      if (!launchTaken) {
        launchTaken = true;
        void deps.source.takeLaunchTap().then((tap) => {
          return tap ? receive(tap) : undefined;
        });
      }
      return unsubscribe;
    },
  };
}
