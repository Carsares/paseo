import { z } from "zod";
import { validateProxyBypass } from "./proxy-policy.js";

function hasNoControlCharacters(value: string): boolean {
  return !/\p{Cc}/u.test(value);
}

const proxyEndpoint = z
  .string()
  .max(2048)
  .transform((value, context) => {
    // Check the raw syntax too: URL normalizes dot paths, empty query/fragment markers and userinfo.
    if (/^https?:\/\/[^\s/?#@\\]+\/?$/i.test(value) && hasNoControlCharacters(value)) {
      try {
        const origin = new URL(value);
        if (origin.port !== "0") return origin.origin;
      } catch {
        // Report a field error without echoing the input.
      }
    }
    context.addIssue({ code: "custom", message: "Invalid HTTP proxy origin" });
    return z.NEVER;
  });

const manual = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("unified"), url: proxyEndpoint }),
  z.strictObject({ kind: z.literal("split"), httpUrl: proxyEndpoint, httpsUrl: proxyEndpoint }),
]);
const controlPlane = z
  .strictObject({
    relay: z.enum(["preserve", "override"]).optional(),
    hub: z.enum(["preserve", "override"]).optional(),
    routed: z.enum(["preserve", "override"]).optional(),
  })
  .optional();
const settingsSchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("inherit"), controlPlane }),
  z.strictObject({ mode: z.literal("direct"), controlPlane }),
  z.strictObject({
    mode: z.literal("manual"),
    proxy: manual,
    bypass: z.array(z.string().max(512)).max(128).optional(),
    controlPlane,
  }),
]);

export type HostProxySettings = z.infer<typeof settingsSchema>;
export type ProxySlot = "unified" | "http" | "https";
export type ProxyControlPlane = "relay" | "hub" | "routed";
export const proxySlots: readonly ProxySlot[] = ["unified", "http", "https"];

export function parseHostProxySettings(value: unknown): HostProxySettings {
  const result = settingsSchema.safeParse(value);
  if (!result.success) throw new Error("Invalid host proxy settings");
  const settings = result.data;
  if (Object.values(settings.controlPlane ?? {}).includes("override")) {
    throw new Error("Control plane proxy override requires authenticated recovery support");
  }
  if (settings.mode === "manual") validateProxyBypass(settings.bypass ?? []);
  return settings;
}

export function proxyEndpoints(settings: HostProxySettings): Partial<Record<ProxySlot, string>> {
  if (settings.mode !== "manual") return {};
  return settings.proxy.kind === "unified"
    ? { unified: settings.proxy.url }
    : { http: settings.proxy.httpUrl, https: settings.proxy.httpsUrl };
}

const credentialsSchema = z
  .strictObject({
    username: z
      .string()
      .max(1024)
      .refine((value) => !value.includes(":") && hasNoControlCharacters(value)),
    password: z.string().max(1024).refine(hasNoControlCharacters),
  })
  .refine(({ username, password }) => Boolean(username || password));

export type ProxyCredential = z.infer<typeof credentialsSchema>;
const credentials = z.strictObject({
  unified: credentialsSchema.optional(),
  http: credentialsSchema.optional(),
  https: credentialsSchema.optional(),
});
export type ProxyCredentials = z.infer<typeof credentials>;

const change = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("keep") }),
  z.strictObject({ action: z.literal("replace"), credential: credentialsSchema }),
  z.strictObject({ action: z.literal("clear") }),
]);
const changes = z.strictObject({
  unified: change.optional(),
  http: change.optional(),
  https: change.optional(),
});

export type ProxyCredentialChanges = z.infer<typeof changes>;

export function parseProxyCredentials(value: unknown): ProxyCredentials {
  const result = credentials.safeParse(value);
  if (!result.success) throw new Error("Invalid stored proxy credentials");
  return result.data;
}

export function updateProxyCredentials(
  before: HostProxySettings,
  after: HostProxySettings,
  current: ProxyCredentials,
  update: ProxyCredentialChanges = {},
): ProxyCredentials {
  const parsed = changes.safeParse(update);
  if (!parsed.success) throw new Error("Invalid proxy credential update");
  const previous = proxyEndpoints(before);
  const next = proxyEndpoints(after);
  const result: ProxyCredentials = {};
  for (const slot of proxySlots) {
    const action = parsed.data[slot];
    if (!next[slot]) {
      if (action?.action === "replace" || (action?.action === "keep" && current[slot])) {
        throw new Error("Proxy credential update requires a configured endpoint");
      }
      continue;
    }
    if (action?.action === "replace") result[slot] = action.credential;
    else if (action?.action !== "clear" && current[slot]) {
      if (previous[slot] !== next[slot]) {
        throw new Error("Changing a proxy endpoint requires replacing or clearing its credentials");
      }
      result[slot] = current[slot];
    }
  }
  return result;
}
