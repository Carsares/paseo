export type ProxyTarget = { kind: "device" } | { kind: "host"; hostId: string };

export type ProxyMode = "system" | "inherit" | "direct" | "manual";

export type ProxyEndpoints =
  | { kind: "unified"; url: string }
  | { kind: "split"; httpUrl: string; httpsUrl: string };

export type ProxySlot = "unified" | "http" | "https";

export function slotsForLayout(layout: ProxyEndpoints["kind"]): readonly ProxySlot[] {
  if (layout === "unified") return ["unified"];
  return ["http", "https"];
}

export type ProxySettings =
  | { mode: Exclude<ProxyMode, "manual"> }
  | { mode: "manual"; endpoints: ProxyEndpoints; bypass: readonly string[] };

export interface ProxySnapshot {
  access: "edit" | "read-only";
  revision: number;
  settings: ProxySettings;
  credentialSlots: readonly ProxySlot[];
  supportsBypass: boolean;
  supportsCredentialReplacement?: boolean;
  suspended?: boolean;
}

export type ProxyCredentialChange =
  | { action: "keep" }
  | { action: "clear" }
  | { action: "replace"; credential: { username: string; password: string } };

export interface ProxyChange {
  settings: ProxySettings;
  credentials: Partial<Record<ProxySlot, ProxyCredentialChange>>;
}

export interface ProxyFailure {
  status: "denied" | "unavailable" | "failed";
}

export interface ProxyTestInput {
  change: ProxyChange;
  expectedRevision: number;
}

export interface ProxyValidationReceipt {
  validationId: string;
  revision: number;
  expiresInMs: number;
}

interface ProxyRevisionConflict {
  status: "revision-conflict";
}

export type ProxyLoadResult = { status: "loaded"; snapshot: ProxySnapshot } | ProxyFailure;
export type ProxyTestResult =
  | { status: "passed"; receipt: ProxyValidationReceipt }
  | ProxyRevisionConflict
  | ProxyFailure;
export type ProxySaveResult =
  | { status: "saved"; snapshot: ProxySnapshot }
  | { status: "retest-required" }
  | ProxyRevisionConflict
  | ProxyFailure;

/** Test validates without saving. Save commits the backend's tested draft for this target.
 * The backend owns access, revision checking, and expiry. Aborting is advisory.
 */
export interface ProxySettingsAdapter {
  load(target: ProxyTarget, signal: AbortSignal): Promise<ProxyLoadResult>;
  test(target: ProxyTarget, input: ProxyTestInput, signal: AbortSignal): Promise<ProxyTestResult>;
  save(
    target: ProxyTarget,
    receipt: ProxyValidationReceipt,
    signal: AbortSignal,
  ): Promise<ProxySaveResult>;
}

export function modesForTarget(target: ProxyTarget): readonly ProxyMode[] {
  if (target.kind === "device") return ["system", "direct", "manual"];
  return ["inherit", "direct", "manual"];
}

export function parseProxyOrigin(input: string): string | null {
  const origin = input.trim();
  // Check the original authority before URL parsing can normalize away a path or empty user info.
  if (!/^https?:\/\/[^\s/@?#\\]+\/?$/iu.test(origin)) return null;
  if (origin.length > 2048 || /\p{Cc}/u.test(origin)) return null;
  try {
    const url = new URL(origin);
    if (url.port === "0") return null;
    return url.origin;
  } catch {
    return null;
  }
}

function isBypassRule(rule: string): boolean {
  if (rule === "*") return true;
  if (rule.length > 512) return false;
  if (rule.includes("/")) return isSubnetRule(rule);
  if (/^[a-f\d.:]+$/iu.test(rule) && rule.includes(":")) {
    if (parseProxyOrigin(`http://[${rule}]`)) return true;
  }
  const match = /^(\[[a-f\d:.]+\]|(?:\*?\.)?[\p{L}\p{N}\p{M}._-]+)(?::(\d{1,5}))?$/iu.exec(rule);
  if (!match) return false;
  const [, host, port] = match;
  if (port && (Number(port) < 1 || Number(port) > 65535)) return false;
  const hostname = host.replace(/^\*?\./u, "").replace(/\.$/u, "");
  return parseProxyOrigin(`http://${hostname}`) !== null;
}

function isSubnetRule(rule: string): boolean {
  const match = /^(\[[a-f\d:.]+\]|[a-f\d:.]+)\/(\d{1,3})$/iu.exec(rule);
  if (!match) return false;
  const [, address, bits] = match;
  const prefix = Number(bits);
  if (address.includes(":")) {
    const bracketed = address.startsWith("[") ? address : `[${address}]`;
    const origin = parseProxyOrigin(`http://${bracketed}`);
    if (!origin) return false;
    if (origin.startsWith("http://[::ffff:") && prefix < 96) return false;
    return prefix <= 128;
  }
  const origin = parseProxyOrigin(`http://${address}`);
  return prefix <= 32 && /^\d+\.\d+\.\d+\.\d+$/u.test(address) && origin === `http://${address}`;
}

export function parseBypass(input: string): string[] | null {
  const rules = input.split(/[,\s]+/u).filter(Boolean);
  if (rules.length > 128 || !rules.every(isBypassRule)) return null;
  return rules;
}

export function readProxySnapshot(
  target: ProxyTarget,
  snapshot: ProxySnapshot,
): ProxySnapshot | null {
  const {
    access,
    revision,
    credentialSlots,
    settings,
    supportsBypass,
    supportsCredentialReplacement,
    suspended,
  } = snapshot;
  const capabilities = {
    supportsBypass,
    supportsCredentialReplacement,
    ...(target.kind === "device" && suspended === true && { suspended: true }),
  };
  if (!Number.isSafeInteger(revision) || revision < 0) return null;
  const { mode } = settings;
  if (!modesForTarget(target).includes(mode)) return null;
  if (mode !== "manual")
    return { access, revision, ...capabilities, credentialSlots: [], settings: { mode } };

  const { endpoints, bypass } = settings;
  if (bypass.length > 128 || !bypass.every(isBypassRule)) return null;
  let safeEndpoints: ProxyEndpoints;
  if (endpoints.kind === "unified") {
    const url = parseProxyOrigin(endpoints.url);
    if (!url) return null;
    safeEndpoints = { kind: "unified", url };
  } else {
    const httpUrl = parseProxyOrigin(endpoints.httpUrl);
    const httpsUrl = parseProxyOrigin(endpoints.httpsUrl);
    if (!httpUrl || !httpsUrl) return null;
    safeEndpoints = { kind: "split", httpUrl, httpsUrl };
  }
  return {
    access,
    revision,
    ...capabilities,
    credentialSlots: slotsForLayout(safeEndpoints.kind).filter((slot) =>
      credentialSlots.includes(slot),
    ),
    settings: { mode, endpoints: safeEndpoints, bypass: [...bypass] },
  };
}
