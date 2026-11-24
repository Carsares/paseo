import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

export const taskEventLimit = 32;
export const TaskEventSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{32}$/),
  kind: z.enum([
    "created",
    "dispatched",
    "turn_completed",
    "turn_failed",
    "turn_canceled",
    "idle",
    "error",
    "closed",
    "reset",
    "reported_completed",
    "reported_blocked",
    "archived",
  ]),
  agentId: z
    .string()
    .min(1)
    .refine((id) => Buffer.byteLength(id) <= 128),
  at: z.iso.datetime(),
  order: z.number().int().nonnegative(),
  runtime: z.uuid().optional(),
  generation: z.number().int().nonnegative().optional(),
  resetEpoch: z.number().int().nonnegative(),
  lifecycle: z.enum(["initializing", "idle", "running", "error", "closed", "archived"]).optional(),
});

export type TaskEvent = z.infer<typeof TaskEventSchema>;
const runtime = randomUUID();
let lastOrder = 0;

export function nextTaskEventOrder() {
  return (lastOrder = Math.max(lastOrder + 2, Date.now() * 1000));
}

export function taskEvent(
  agentId: string,
  kind: TaskEvent["kind"],
  resetEpoch: number | undefined,
  lifecycle?: TaskEvent["lifecycle"],
  key: string = randomUUID(),
  order?: number,
): TaskEvent {
  const epoch = resetEpoch ?? 0;
  // Allocate at observation time. Bindings can commit these same observations later.
  const eventOrder = order ?? nextTaskEventOrder();
  return {
    id: createHash("sha256")
      .update(JSON.stringify([agentId, kind, epoch, key]))
      .digest("hex")
      .slice(0, 32),
    kind,
    agentId,
    at: new Date(Math.floor(eventOrder / 1000)).toISOString(),
    order: eventOrder,
    runtime,
    lifecycle,
    resetEpoch: epoch,
  };
}

export function compareTaskEvents(left: TaskEvent, right: TaskEvent): number {
  return (left.generation ?? 0) - (right.generation ?? 0) || left.order - right.order;
}

/** Keep observation order within a daemon run, even when its wall clock starts behind disk. */
export function orderTaskEvents(
  events: readonly TaskEvent[],
  persisted: Iterable<TaskEvent>,
): readonly TaskEvent[] {
  if (!events.length) return events;
  let latest: TaskEvent | undefined;
  for (const event of persisted) {
    if (!latest || compareTaskEvents(event, latest) > 0) latest = event;
  }
  if (!latest) return events;
  const generation = (latest.generation ?? 0) + Number(latest.runtime !== events[0]?.runtime);
  return generation ? events.map((event) => ({ ...event, generation })) : events;
}

export function mergeTaskEvents(current: readonly TaskEvent[], updates: readonly TaskEvent[]) {
  const byId = new Map(current.map((event) => [event.id, event]));
  for (const event of updates) {
    if (!byId.has(event.id)) byId.set(event.id, event);
  }
  return [...byId.values()]
    .sort((a, b) => compareTaskEvents(a, b) || a.id.localeCompare(b.id))
    .slice(-taskEventLimit);
}
