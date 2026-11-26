import { z } from "zod";

export const AgentReportStatusSchema = z.enum(["completed", "blocked"]);

/** Semantic provenance, independent of provider envelopes and timeline presentation. */
export const AgentMessageSchema = z.object({
  event: z.enum(["message", "finished", "errored", "permission-required", "closed"]),
  sender: z.object({
    id: z.string().min(1),
    serverId: z.string().min(1).optional(),
    title: z.string().min(1).optional(),
  }),
  text: z.string(),
  reportStatus: AgentReportStatusSchema.optional(),
  taskId: z.string().min(1).optional(),
  rootMessageId: z.string().min(1).optional(),
});

export type AgentMessage = z.infer<typeof AgentMessageSchema>;
