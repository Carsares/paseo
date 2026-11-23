import { z } from "zod";
import { RESIDENT_ROLE_SLUG_MAX_LENGTH, RESIDENT_ROLE_SLUG_PATTERN } from "./agent-labels.js";

export const ResidentRoleSlugSchema = z
  .string()
  .max(RESIDENT_ROLE_SLUG_MAX_LENGTH)
  .regex(RESIDENT_ROLE_SLUG_PATTERN);

/**
 * A named provider configuration with optional role defaults. Provider settings
 * mirror AgentSessionConfig. The role prompt is for starting a specialist and
 * is separate from the provider's live configuration.
 */
export const AgentProfileSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    /** A key into the client's icon registry, not a glyph. Unknown keys draw the default. */
    icon: z.string().optional(),
    /** An identity colour name shared with host badges. Unknown values draw unthemed. */
    color: z.string().optional(),
    provider: z.string(),
    model: z.string().optional(),
    modeId: z.string().optional(),
    thinkingOptionId: z.string().optional(),
    // COMPAT(featureValues): added in v0.15.0, remove after 2027-05-01. Read as `options`.
    featureValues: z.record(z.string(), z.unknown()).optional(),
    /** Provider options applied when the profile creates an agent. */
    options: z.record(z.string(), z.unknown()).optional(),
    /** Free text, surfaced to orchestrating agents by the `list_profiles` MCP tool. */
    notes: z.string().optional(),
    roleSlug: ResidentRoleSlugSchema.optional(),
    rolePrompt: z.string().max(16384).optional(),
    defaultResident: z.boolean().optional(),
    residentUrgentReport: z.boolean().optional(),
    residentKeepAlive: z.boolean().optional(),
  })
  .passthrough();

export type AgentProfile = z.infer<typeof AgentProfileSchema>;

export const AgentSkillSelectionSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("all") }).strict(),
  z.object({ mode: z.literal("custom"), skills: z.array(z.string()) }).strict(),
]);
export type AgentSkillSelection = z.infer<typeof AgentSkillSelectionSchema>;
