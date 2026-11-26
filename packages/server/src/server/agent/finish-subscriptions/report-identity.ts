import { z } from "zod";

const prefix = "paseo-report-v1:";
const supersessionSchema = z.object({
  id: z.string().uuid(),
  finishedIds: z.array(z.string().startsWith("automatic-parent:")).max(64),
  turnId: z.string().optional(),
  taskId: z.string().min(1).optional(),
  rootMessageId: z.string().min(1).optional(),
});

/** Push and pull share this opaque ID, including when either peer runs an older daemon. */
export function encodeParentReportIdentity(
  id: string,
  finishedIds: string[],
  turnId: string | undefined,
  topic?: { taskId?: string; rootMessageId?: string },
): string {
  const { taskId, rootMessageId } = topic ?? {};
  if (!finishedIds.length && !turnId && !taskId && !rootMessageId) return id;
  return (
    prefix +
    JSON.stringify({ id, finishedIds: finishedIds.slice(0, 64), turnId, taskId, rootMessageId })
  );
}

export function decodeParentReportIdentity(id: string): z.infer<typeof supersessionSchema> {
  if (id.startsWith(prefix)) {
    try {
      return supersessionSchema.parse(JSON.parse(id.slice(prefix.length)));
    } catch {
      // Unrecognized report IDs still use the original opaque identity.
    }
  }
  return { id, finishedIds: [] };
}
