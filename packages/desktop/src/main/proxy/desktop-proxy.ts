import { randomUUID } from "node:crypto";
import type { ProxyConfig } from "electron";
import { z } from "zod";
import {
  chromiumConfig,
  desktopProxyPolicy,
  desktopProxyScope,
  desktopProxySlots,
  directLanHosts,
  proxyAddress,
  proxySlotsForPolicy,
  urlsForPolicy,
  type DesktopProxyPolicy,
  type DesktopProxyScope,
  type DesktopProxySlot,
  type ProxyCredentials,
  type ScopeRouting,
} from "./policy.js";
import {
  desktopCredentialChanges,
  proxyRevision,
  type DesktopProxyStore,
  type ProxyCredentialChange,
  type ProxyVault,
  type StoredProxyScope,
} from "./storage.js";

const updateRequest = z.strictObject({
  scope: desktopProxyScope,
  policy: desktopProxyPolicy,
  credentials: desktopCredentialChanges.optional(),
});
const testRequest = updateRequest.extend({ expectedRevision: proxyRevision });

export interface ProxyPlan {
  policy: DesktopProxyPolicy;
  config: ProxyConfig;
  credentials: ReadonlyMap<string, ProxyCredentials>;
  pairedLanHosts: readonly string[];
  webSockets: boolean;
  controlRecovery?: true;
}

export interface DesktopProxyScopePort {
  routing: ScopeRouting;
  test(plan: ProxyPlan): Promise<void>;
  // Keep the scope paused until persistence or rollback is confirmed.
  apply(plan: ProxyPlan | null, routingOnly?: boolean): Promise<void>;
  resume(): void;
  isolate(): void;
}

interface DesktopProxyOptions {
  scopes: Partial<Record<DesktopProxyScope, DesktopProxyScopePort>>;
  store: DesktopProxyStore;
  vault: ProxyVault;
  now?: () => number;
}

type UpdateRequest = z.infer<typeof updateRequest>;
const keep = { action: "keep" } as const;
const validationTtlMs = 60_000;
const commitReceipt = z.strictObject({
  validationId: z.uuid(),
  revision: proxyRevision,
  expiresInMs: z.literal(validationTtlMs).optional(),
});
export interface DesktopProxyReceipt {
  validationId: string;
  revision: number;
  expiresInMs: number;
}

export class DesktopProxyRevisionConflict extends Error {
  readonly code = "revision-conflict";

  constructor(message = "Desktop proxy settings changed. Reload before testing again.") {
    super(message);
  }
}

export class DesktopProxyRetestRequired extends Error {}
export class DesktopProxyUnavailable extends Error {}
export class DesktopControlProxyConflict extends Error {
  constructor() {
    super("Desktop control proxy shares a device proxy credential endpoint.");
  }
}

function equalCredentials(left?: ProxyCredentials, right?: ProxyCredentials): boolean {
  return left?.username === right?.username && left?.password === right?.password;
}

function editsForEndpoints(input: UpdateRequest, previous?: StoredProxyScope) {
  const { credentials = {}, policy } = input;
  const slots = proxySlotsForPolicy(policy);
  const edits = new Map<string, ProxyCredentialChange>();
  if ("action" in credentials) {
    if (credentials.action === "replace" && !urlsForPolicy(policy).includes(credentials.proxyUrl)) {
      throw new Error("Proxy credentials require an active proxy URL.");
    }
    switch (credentials.action) {
      case "keep":
        return edits;
      case "clear":
        return edits.set(credentials.proxyUrl, { action: "clear" });
      case "replace":
        return edits.set(credentials.proxyUrl, {
          action: "replace",
          credential: credentials.credentials,
        });
    }
  }

  const previousSlots = previous ? proxySlotsForPolicy(previous.policy) : {};
  const retainedUrls = new Set(previous?.credentials.map(({ proxyUrl }) => proxyUrl));
  for (const slot of desktopProxySlots) {
    const change = credentials[slot] ?? keep;
    const edit = slotEdit(change, slots[slot], previousSlots[slot], retainedUrls);
    if (!edit) continue;
    const existing = edits.get(edit.url);
    if (existing && !equalEdits(existing, edit.action)) {
      throw new Error("Proxy slots sharing a URL require matching credentials.");
    }
    edits.set(edit.url, edit.action);
  }
  return edits;
}

function slotEdit(
  action: ProxyCredentialChange,
  activeUrl: string | undefined,
  oldUrl: string | undefined,
  retainedUrls: ReadonlySet<string>,
) {
  const changedUrl = activeUrl && oldUrl && activeUrl !== oldUrl;
  if (action.action === "keep" && changedUrl && retainedUrls.has(oldUrl)) {
    throw new Error("Changing a proxy URL requires replacing or clearing its slot credentials.");
  }
  const url = activeUrl ?? (action.action === "clear" ? oldUrl : undefined);
  if (!url) {
    if (action.action === "replace") throw new Error("Proxy credentials require an active slot.");
    return null;
  }
  if (action.action === "keep" && !retainedUrls.has(url)) {
    return { url, action: { action: "clear" } as const };
  }
  return { url, action };
}

function equalEdits(left: ProxyCredentialChange, right: ProxyCredentialChange): boolean {
  if (left.action !== right.action) return false;
  if (left.action !== "replace" || right.action !== "replace") return true;
  return equalCredentials(left.credential, right.credential);
}

function buildPlan(
  setting: StoredProxyScope,
  routing: ScopeRouting,
  vault: ProxyVault,
  replacements: ReadonlyMap<string, ProxyCredentials> = new Map(),
): ProxyPlan {
  const config = chromiumConfig(setting.policy, routing);
  const urls = urlsForPolicy(setting.policy);
  const savedUrls = new Set(setting.credentials.map(({ proxyUrl }) => proxyUrl));
  if (savedUrls.size !== setting.credentials.length) {
    throw new Error("Duplicate desktop proxy credentials.");
  }
  const activeCredentials = setting.credentials.filter(({ proxyUrl }) => urls.includes(proxyUrl));
  const opened = activeCredentials.map(
    ({ proxyUrl, encrypted }) => [proxyUrl, vault.open(encrypted)] as const,
  );
  const credentials = new Map([...opened, ...replacements]);
  const [first, second] = urls;
  if (first && second) {
    const left = proxyAddress(first);
    const right = proxyAddress(second);
    const sharedEndpoint = left.host === right.host && left.port === right.port;
    if (sharedEndpoint && !equalCredentials(credentials.get(first), credentials.get(second))) {
      throw new Error("Proxy URLs sharing a host and port require identical credentials.");
    }
  }

  return {
    policy: setting.policy,
    config,
    credentials,
    pairedLanHosts: directLanHosts(routing),
    webSockets: routing.webSockets,
  };
}

export interface DesktopProxyState {
  policy: DesktopProxyPolicy;
  credentialUrls: string[];
  credentialSlots: DesktopProxySlot[];
}

function publicState(setting: StoredProxyScope): DesktopProxyState {
  const credentialUrls = setting.credentials.map(({ proxyUrl }) => proxyUrl);
  const slots = proxySlotsForPolicy(setting.policy);
  const credentialSlots = desktopProxySlots.filter((slot) => {
    const url = slots[slot];
    return url !== undefined && credentialUrls.includes(url);
  });
  return {
    policy: structuredClone(setting.policy),
    credentialUrls,
    credentialSlots,
  };
}

interface PreparedUpdate {
  scope: DesktopProxyScope;
  port: DesktopProxyScopePort;
  next: StoredProxyScope;
  plan: ProxyPlan;
  replacements: ReadonlyMap<string, ProxyCredentials>;
}

interface PendingValidation {
  receipt: DesktopProxyReceipt;
  update: PreparedUpdate;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
}

export async function createDesktopProxy({
  scopes,
  store,
  vault,
  now = () => performance.now(),
}: DesktopProxyOptions) {
  const loaded = await store.load();
  let settings = { ...loaded, revision: loaded.revision ?? 0, scopes: { ...loaded.scopes } };
  const active = new Map<DesktopProxyScope, ProxyPlan>();
  const unavailable = new Set<DesktopProxyScope>();
  const started: { scope: DesktopProxyScope; port: DesktopProxyScopePort }[] = [];
  const validations = new Map<DesktopProxyScope, PendingValidation>();
  let pending: Promise<unknown> = Promise.resolve();

  try {
    let cleaned = false;
    for (const scope of desktopProxyScope.options) {
      const port = scopes[scope];
      const saved = settings.scopes[scope];
      if (!port || !saved) continue;
      const urls = urlsForPolicy(saved.policy);
      const credentials = saved.credentials.filter(({ proxyUrl }) => urls.includes(proxyUrl));
      const next = { ...saved, credentials };
      if (credentials.length !== saved.credentials.length) {
        settings.scopes[scope] = next;
        cleaned = true;
      }
      const plan = buildPlan(next, port.routing, vault);
      started.push({ scope, port });
      await port.apply(plan);
      active.set(scope, plan);
    }
    if (cleaned) await store.save(settings);
  } catch {
    const restored = await Promise.allSettled(
      started.map(async ({ port }) => {
        try {
          await port.apply(null);
          port.resume();
        } catch (error) {
          port.isolate();
          throw error;
        }
      }),
    );
    if (restored.some((result) => result.status === "rejected")) {
      throw new Error("Could not restore the original desktop proxy settings.");
    }
    throw new Error("Could not initialize desktop proxy settings.");
  }
  for (const { scope, port } of started) {
    try {
      port.resume();
    } catch {
      isolateScope(scope, port);
    }
  }

  function prepare(input: UpdateRequest): PreparedUpdate {
    const { scope, policy } = input;
    const port = scopes[scope];
    if (!port || unavailable.has(scope))
      throw new DesktopProxyUnavailable("Desktop proxy scope is unavailable.");
    const previous = settings.scopes[scope];
    const edits = editsForEndpoints(input, previous);
    const urls = urlsForPolicy(policy);
    const credentials = (previous?.credentials ?? []).filter(({ proxyUrl }) => {
      const change = edits.get(proxyUrl);
      return urls.includes(proxyUrl) && (!change || change.action === "keep");
    });
    const next: StoredProxyScope = { policy, credentials };
    const replacements = new Map<string, ProxyCredentials>();
    for (const [url, change] of edits) {
      if (change.action === "replace") replacements.set(url, change.credential);
    }
    const plan = buildPlan(next, port.routing, vault, replacements);
    return { scope, port, next, plan, replacements };
  }

  async function checkCandidate(port: DesktopProxyScopePort, plan: ProxyPlan): Promise<void> {
    try {
      await port.test(plan);
    } catch {
      throw new Error("The candidate desktop proxy connection failed.");
    }
  }

  function discardValidation(scope: DesktopProxyScope) {
    const previous = validations.get(scope);
    if (previous) clearTimeout(previous.timer);
    validations.delete(scope);
  }

  function isolateScope(scope: DesktopProxyScope, port: DesktopProxyScopePort) {
    unavailable.add(scope);
    discardValidation(scope);
    port.isolate();
  }

  async function save({
    scope,
    port,
    next,
    plan,
    replacements,
  }: PreparedUpdate): Promise<DesktopProxyState> {
    for (const [proxyUrl, credential] of replacements) {
      const encrypted = vault.seal(credential);
      next.credentials.push({ proxyUrl, encrypted });
    }
    const updated = {
      ...settings,
      revision: settings.revision + 1,
      scopes: { ...settings.scopes, [scope]: next },
    };
    try {
      await port.apply(plan);
      await store.save(updated);
    } catch {
      try {
        await port.apply(active.get(scope) ?? null);
        port.resume();
      } catch {
        isolateScope(scope, port);
        throw new Error("Could not restore the previous desktop proxy policy.");
      }
      throw new Error("Could not apply the desktop proxy policy.");
    }
    settings = updated;
    active.set(scope, plan);
    for (const validatedScope of validations.keys()) discardValidation(validatedScope);
    try {
      port.resume();
    } catch {
      isolateScope(scope, port);
      throw new Error("Desktop proxy policy was saved, but its session could not resume.");
    }
    return publicState(next);
  }

  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = pending.then(operation);
    pending = result.catch(() => undefined);
    return result;
  }

  function withSettings<T>(
    raw: unknown,
    operation: (input: UpdateRequest) => Promise<T>,
  ): Promise<T> {
    const parsed = updateRequest.safeParse(raw);
    if (!parsed.success) return Promise.reject(new Error("Invalid desktop proxy settings."));
    return enqueue(() => operation(parsed.data));
  }

  function state(scope: DesktopProxyScope): DesktopProxyState | null {
    if (unavailable.has(scope))
      throw new DesktopProxyUnavailable("Desktop proxy scope is unavailable.");
    const saved = scopes[scope] && settings.scopes[scope];
    return saved ? publicState(saved) : null;
  }

  return {
    state,
    refreshRouting(scope: DesktopProxyScope, stage: () => Promise<() => void>) {
      return enqueue(async () => {
        const port = scopes[scope];
        if (!port || unavailable.has(scope)) throw new DesktopProxyUnavailable();
        const undo = await stage();
        const plan = active.get(scope);
        if (!plan || plan.policy.mode === "system") return;
        try {
          await port.apply(plan, true);
        } catch (error) {
          if (error instanceof DesktopControlProxyConflict && scope === "mainWindow") {
            const system = buildPlan(
              { policy: { mode: "system" }, credentials: [] },
              port.routing,
              vault,
            );
            const recovery: ProxyPlan = { ...system, controlRecovery: true };
            try {
              await port.apply(recovery);
              port.resume();
              active.set(scope, recovery);
              discardValidation(scope);
              return;
            } catch {
              undo();
              isolateScope(scope, port);
              throw new DesktopProxyUnavailable();
            }
          }
          undo();
          try {
            await port.apply(plan, true);
            port.resume();
          } catch {
            isolateScope(scope, port);
          }
          throw new DesktopProxyUnavailable();
        }
        try {
          port.resume();
        } catch {
          undo();
          isolateScope(scope, port);
          throw new DesktopProxyUnavailable();
        }
      });
    },
    load(scope: DesktopProxyScope) {
      if (!scopes[scope]) throw new DesktopProxyUnavailable("Desktop proxy scope is unavailable.");
      const suspended = active.get(scope)?.controlRecovery === true;
      return {
        state: state(scope),
        revision: settings.revision,
        ...(suspended && { suspended: true }),
      };
    },
    test(raw: unknown): Promise<DesktopProxyReceipt> {
      const parsed = testRequest.safeParse(raw);
      if (!parsed.success) return Promise.reject(new Error("Invalid desktop proxy settings."));
      const input = parsed.data;
      return enqueue(async () => {
        if (input.expectedRevision !== settings.revision) throw new DesktopProxyRevisionConflict();
        discardValidation(input.scope);
        const update = prepare(input);
        await checkCandidate(update.port, update.plan);
        const receipt = {
          validationId: randomUUID(),
          revision: settings.revision,
          expiresInMs: validationTtlMs,
        } as const;
        const expiresAt = now() + validationTtlMs;
        const timer = setTimeout(() => discardValidation(input.scope), validationTtlMs);
        timer.unref();
        validations.set(input.scope, { receipt, update, expiresAt, timer });
        return { ...receipt };
      });
    },
    commit(scope: DesktopProxyScope, rawReceipt: unknown) {
      const parsed = commitReceipt.safeParse(rawReceipt);
      if (!parsed.success)
        return Promise.reject(new DesktopProxyRetestRequired("Invalid desktop proxy validation."));
      return enqueue(async () => {
        const receipt = parsed.data;
        if (receipt.revision !== settings.revision) {
          throw new DesktopProxyRevisionConflict("Desktop proxy validation is no longer current.");
        }
        const candidate = validations.get(scope);
        if (!candidate || candidate.receipt.validationId !== receipt.validationId) {
          throw new DesktopProxyRetestRequired("Desktop proxy validation is no longer current.");
        }
        discardValidation(scope);
        if (now() >= candidate.expiresAt)
          throw new DesktopProxyRetestRequired("Desktop proxy validation expired.");
        const saved = await save(candidate.update);
        return { ...saved, revision: settings.revision };
      });
    },
    // Standalone callers revalidate. UI should always use test + commit.
    update(raw: unknown): Promise<DesktopProxyState> {
      return withSettings(raw, async (input) => {
        const update = prepare(input);
        await checkCandidate(update.port, update.plan);
        return save(update);
      });
    },
  };
}
