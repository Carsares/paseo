import { createHash } from "node:crypto";
import { z } from "zod";

const ProviderConversationLimitSchema = z.object({
  limitId: z.string().min(1),
  resetsAt: z.iso.datetime(),
  providerTurnId: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  accountScope: z.string().min(1).optional(),
});

export const FailedConversationLimitSchema = ProviderConversationLimitSchema.extend({
  turnId: z.string().min(1),
  fingerprint: z.string(),
}).omit({ accountScope: true });

export type FailedConversationLimit = z.infer<typeof FailedConversationLimitSchema>;

export function limitFingerprint(value: unknown): string {
  return createHash("sha256")
    .update(
      JSON.stringify(value, (_key, item: unknown) =>
        item && typeof item === "object" && !Array.isArray(item)
          ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
          : item,
      ),
    )
    .digest("hex");
}

export function extractConversationLimit(event: object) {
  if (!("conversationLimit" in event)) return undefined;
  const parsed = ProviderConversationLimitSchema.safeParse(event.conversationLimit);
  // Account-scoped evidence must have a matching live account-scope inspector.
  // No provider currently supplies that independent predicate.
  if (!parsed.success || parsed.data.accountScope) return undefined;
  const { limitId, resetsAt, providerTurnId, model } = parsed.data;
  return { limitId, resetsAt, providerTurnId, model };
}
