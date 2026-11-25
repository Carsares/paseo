import {
  modesForTarget,
  parseBypass,
  parseProxyOrigin,
  readProxySnapshot,
  slotsForLayout,
  type ProxyChange,
  type ProxyCredentialChange,
  type ProxyFailure,
  type ProxyLoadResult,
  type ProxyMode,
  type ProxySaveResult,
  type ProxySettings,
  type ProxySnapshot,
  type ProxySlot,
  type ProxyTarget,
  type ProxyTestInput,
  type ProxyTestResult,
  type ProxyValidationReceipt,
} from "./settings";

type DraftTextField = "url" | "httpUrl" | "httpsUrl" | "bypass";
type SecretField = "username" | "password";
type CredentialAction = ProxyCredentialChange["action"];

interface Draft {
  mode: ProxyMode;
  layout: "unified" | "split";
  url: string;
  httpUrl: string;
  httpsUrl: string;
  bypass: string;
  credentialActions: Record<ProxySlot, CredentialAction>;
}

type Errors = Partial<Record<DraftTextField, true>>;
type CredentialErrors = Partial<Record<SecretField | "action" | "required", true>>;

function defaultActions(): Draft["credentialActions"] {
  return { unified: "keep", http: "keep", https: "keep" };
}
type Issue = ProxyFailure["status"];
type SharedActivity =
  | { status: "idle" | "saved" | "retest-required" | "revision-conflict" }
  | { status: "testing" | "saving"; ticket: number }
  | { status: "test-failed" | "save-failed"; issue: Issue };
type Activity =
  | SharedActivity
  | { status: "tested"; receipt: ProxyValidationReceipt; expiresAt: number };

interface Ready {
  status: "ready";
  snapshot: ProxySnapshot;
  draft: Draft;
  activity: Activity;
  resetKey: number;
  credentialResetKey: number;
}

interface ReadyView extends Omit<Ready, "activity"> {
  activity: SharedActivity | { status: "tested" };
  errors: Errors;
  credentialErrors: Partial<Record<ProxySlot, CredentialErrors>>;
  canTest: boolean;
  canSave: boolean;
}

type LoadState = { status: "loading"; ticket: number } | { status: "load-failed"; issue: Issue };

type State = Ready | LoadState;
type ViewState = ReadyView | LoadState;

interface TestRequest {
  input: ProxyTestInput;
  ticket: number;
}

interface SaveRequest {
  receipt: ProxyValidationReceipt;
  ticket: number;
}

interface SecretInput {
  username: string;
  password: string;
}

function seedDraft(settings: ProxySettings): Draft {
  const draft: Draft = {
    mode: settings.mode,
    layout: "unified",
    url: "",
    httpUrl: "",
    httpsUrl: "",
    bypass: "",
    credentialActions: defaultActions(),
  };
  if (settings.mode !== "manual") return draft;
  const { endpoints } = settings;
  draft.layout = endpoints.kind;
  draft.bypass = settings.bypass.join(", ");
  if (endpoints.kind === "unified") draft.url = endpoints.url;
  else {
    draft.httpUrl = endpoints.httpUrl;
    draft.httpsUrl = endpoints.httpsUrl;
  }
  return draft;
}

function validateSettings(draft: Draft, errors: Errors): ProxySettings | null {
  const { mode, layout } = draft;
  if (mode !== "manual") return { mode };
  const bypass = parseBypass(draft.bypass);
  if (!bypass) errors.bypass = true;
  if (layout === "unified") {
    const url = parseProxyOrigin(draft.url);
    if (!url) errors.url = true;
    if (!url || !bypass) return null;
    return { mode, endpoints: { kind: layout, url }, bypass };
  }
  const httpUrl = parseProxyOrigin(draft.httpUrl);
  const httpsUrl = parseProxyOrigin(draft.httpsUrl);
  if (!httpUrl) errors.httpUrl = true;
  if (!httpsUrl) errors.httpsUrl = true;
  if (!httpUrl || !httpsUrl || !bypass) return null;
  return { mode, endpoints: { kind: layout, httpUrl, httpsUrl }, bypass };
}

function validateCredential(
  action: CredentialAction,
  secrets: SecretInput,
  errors: CredentialErrors,
): ProxyCredentialChange | null {
  if (action !== "replace") return { action };
  const { username, password } = secrets;
  if (!username && !password) errors.required = true;
  if (username.length > 1024 || /[:\p{Cc}]/u.test(username)) errors.username = true;
  if (password.length > 1024 || /\p{Cc}/u.test(password)) errors.password = true;
  if (errors.required || errors.username || errors.password) return null;
  return { action, credential: { username, password } };
}

function endpointsFor(settings: ProxySettings): Partial<Record<ProxySlot, string>> {
  if (settings.mode !== "manual") return {};
  const { endpoints } = settings;
  if (endpoints.kind === "unified") return { unified: endpoints.url };
  return { http: endpoints.httpUrl, https: endpoints.httpsUrl };
}

function validateCredentialChanges(
  state: Ready,
  settings: ProxySettings,
  secrets: Record<ProxySlot, SecretInput>,
  errors: ReadyView["credentialErrors"],
): ProxyChange["credentials"] | null {
  if (settings.mode !== "manual") return {};
  const previous = endpointsFor(state.snapshot.settings);
  const proposed = endpointsFor(settings);
  const changes: ProxyChange["credentials"] = {};
  let valid = true;
  for (const slot of slotsForLayout(settings.endpoints.kind)) {
    const slotErrors: CredentialErrors = {};
    errors[slot] = slotErrors;
    const action = state.draft.credentialActions[slot];
    const changesStoredOrigin =
      state.snapshot.credentialSlots.includes(slot) && previous[slot] !== proposed[slot];
    if (action === "keep" && changesStoredOrigin) slotErrors.action = true;
    const credential = validateCredential(action, secrets[slot], slotErrors);
    if (credential && !slotErrors.action) changes[slot] = credential;
    else valid = false;
  }
  return valid ? changes : null;
}

function sameSettings(left: ProxySettings, right: ProxySettings): boolean {
  if (left.mode !== right.mode) return false;
  if (left.mode !== "manual" || right.mode !== "manual") return true;
  const a = left.endpoints;
  const b = right.endpoints;
  if (a.kind === "unified" && b.kind === "unified" && a.url !== b.url) return false;
  if (
    a.kind === "split" &&
    b.kind === "split" &&
    (a.httpUrl !== b.httpUrl || a.httpsUrl !== b.httpsUrl)
  )
    return false;
  return a.kind === b.kind && left.bypass.join(",") === right.bypass.join(",");
}

export function openProxyForm(target: ProxyTarget, now = () => performance.now()) {
  const modes = modesForTarget(target);
  const secrets: Record<ProxySlot, SecretInput> = {
    unified: { username: "", password: "" },
    http: { username: "", password: "" },
    https: { username: "", password: "" },
  };
  const subscribers = new Set<() => void>();
  let sequence = 0;
  let state: State = { status: "loading", ticket: sequence };
  let view: ViewState = state;
  let candidate: ProxyChange | null = null;

  function forgetSecrets() {
    for (const secret of Object.values(secrets)) {
      secret.username = "";
      secret.password = "";
    }
  }

  function publish(next: State) {
    state = next;
    candidate = null;
    if (next.status !== "ready") {
      view = next;
    } else {
      const errors: Errors = {};
      const credentialErrors: ReadyView["credentialErrors"] = {};
      const settings = validateSettings(next.draft, errors);
      const { activity, ...visible } = next;
      const canEdit = next.snapshot.access === "edit" && activity.status !== "revision-conflict";
      const canValidate = canEdit && activity.status !== "saving" && activity.status !== "testing";
      if (settings && canValidate) {
        const credentials = validateCredentialChanges(next, settings, secrets, credentialErrors);
        if (credentials) {
          const changesCredentials = Object.values(credentials).some(
            ({ action }) => action !== "keep",
          );
          const changed = !sameSettings(settings, next.snapshot.settings) || changesCredentials;
          if (changed) candidate = { settings, credentials };
        }
      }
      if (activity.status === "tested") {
        // Only the backend keeps the tested credentials. Blank inputs can start a new draft.
        for (const error of Object.values(credentialErrors)) delete error.required;
      }
      const activityView: ReadyView["activity"] =
        activity.status === "tested" ? { status: "tested" } : activity;
      view = {
        ...visible,
        activity: activityView,
        errors,
        credentialErrors,
        canTest: candidate !== null,
        canSave: canEdit && activity.status === "tested",
      };
    }
    for (const listener of subscribers) listener();
  }

  function reset(snapshot: ProxySnapshot, activity: Activity) {
    forgetSecrets();
    publish({
      status: "ready",
      snapshot,
      draft: seedDraft(snapshot.settings),
      activity,
      resetKey: ++sequence,
      credentialResetKey: sequence,
    });
  }

  function editable(): Ready | null {
    if (state.status !== "ready" || state.snapshot.access !== "edit") return null;
    if (state.activity.status === "saving" || state.activity.status === "revision-conflict")
      return null;
    return state;
  }

  function edit(next: Ready, draft: Draft) {
    publish({ ...next, draft, activity: { status: "idle" } });
  }

  function rejectOperation(
    next: Ready,
    kind: "test-failed" | "save-failed",
    issue: Issue | "revision-conflict" | "retest-required",
  ) {
    if (issue === "revision-conflict" || issue === "retest-required") {
      publish({ ...next, activity: { status: issue } });
      return;
    }
    const activity = { status: kind, issue };
    if (issue === "denied") {
      reset({ ...next.snapshot, access: "read-only" }, activity);
      return;
    }
    publish({ ...next, activity });
  }

  return {
    getState: () => view,
    subscribe(listener: () => void) {
      subscribers.add(listener);
      return () => {
        subscribers.delete(listener);
      };
    },
    close() {
      forgetSecrets();
      publish({ status: "loading", ticket: ++sequence });
    },
    beginLoad() {
      forgetSecrets();
      const ticket = ++sequence;
      publish({ status: "loading", ticket });
      return ticket;
    },
    completeLoad(ticket: number, response: ProxyLoadResult) {
      if (state.status !== "loading" || state.ticket !== ticket) return;
      if (response.status !== "loaded") {
        publish({ status: "load-failed", issue: response.status });
        return;
      }
      const snapshot = readProxySnapshot(target, response.snapshot);
      if (snapshot) reset(snapshot, { status: "idle" });
      else publish({ status: "load-failed", issue: "unavailable" });
    },
    setMode(mode: ProxyMode) {
      const next = editable();
      if (!next || !modes.includes(mode) || mode === next.draft.mode) return;
      const draft = { ...next.draft, mode };
      if (mode !== "manual") {
        forgetSecrets();
        draft.credentialActions = defaultActions();
      }
      edit(next, draft);
    },
    setLayout(layout: Draft["layout"]) {
      const next = editable();
      if (!next || next.draft.mode !== "manual" || next.draft.layout === layout) return;
      forgetSecrets();
      edit(next, { ...next.draft, layout, credentialActions: defaultActions() });
    },
    setText(field: DraftTextField, text: string) {
      const next = editable();
      if (!next || next.draft.mode !== "manual" || next.draft[field] === text) return;
      if (field === "bypass" && !next.snapshot.supportsBypass) return;
      edit(next, { ...next.draft, [field]: text });
    },
    setCredentialAction(slot: ProxySlot, action: CredentialAction) {
      const next = editable();
      if (!next || next.draft.mode !== "manual") return;
      if (!slotsForLayout(next.draft.layout).includes(slot)) return;
      if (action === next.draft.credentialActions[slot]) return;
      if (action === "clear" && !next.snapshot.credentialSlots.includes(slot)) return;
      if (action === "replace" && next.snapshot.supportsCredentialReplacement === false) return;
      secrets[slot] = { username: "", password: "" };
      const credentialActions = { ...next.draft.credentialActions, [slot]: action };
      edit(next, { ...next.draft, credentialActions });
    },
    setSecret(slot: ProxySlot, field: SecretField, text: string) {
      const next = editable();
      if (!next || next.draft.credentialActions[slot] !== "replace") return;
      if (secrets[slot][field] === text) return;
      secrets[slot][field] = text;
      edit(next, next.draft);
    },
    beginTest(): TestRequest | null {
      if (state.status !== "ready" || view.status !== "ready" || !view.canTest || !candidate)
        return null;
      const ticket = ++sequence;
      const input = { change: candidate, expectedRevision: state.snapshot.revision };
      forgetSecrets();
      publish({ ...state, credentialResetKey: ticket, activity: { status: "testing", ticket } });
      return { ticket, input };
    },
    completeTest(ticket: number, response: ProxyTestResult) {
      if (state.status !== "ready" || state.activity.status !== "testing") return;
      if (state.activity.ticket !== ticket) return;
      if (response.status !== "passed") {
        rejectOperation(state, "test-failed", response.status);
        return;
      }
      const { validationId, revision, expiresInMs } = response.receipt;
      const validId = typeof validationId === "string" && validationId.trim().length > 0;
      const validLifetime = Number.isSafeInteger(expiresInMs) && expiresInMs > 0;
      if (!validId || !validLifetime || revision !== state.snapshot.revision) {
        rejectOperation(state, "test-failed", "failed");
        return;
      }
      const receipt = { validationId, revision, expiresInMs };
      publish({
        ...state,
        activity: { status: "tested", receipt, expiresAt: now() + expiresInMs },
      });
    },
    beginSave(): SaveRequest | null {
      const current = editable();
      if (!current || current.activity.status !== "tested") return null;
      const { receipt, expiresAt } = current.activity;
      if (now() >= expiresAt) {
        rejectOperation(current, "save-failed", "retest-required");
        return null;
      }
      const ticket = ++sequence;
      publish({ ...current, activity: { status: "saving", ticket } });
      return { receipt, ticket };
    },
    completeSave(ticket: number, response: ProxySaveResult) {
      if (state.status !== "ready" || state.activity.status !== "saving") return;
      if (state.activity.ticket !== ticket) return;
      if (response.status !== "saved") {
        rejectOperation(state, "save-failed", response.status);
        return;
      }
      const snapshot = readProxySnapshot(target, response.snapshot);
      if (snapshot) reset(snapshot, { status: "saved" });
      else {
        forgetSecrets();
        publish({ status: "load-failed", issue: "unavailable" });
      }
    },
  };
}

export type ProxyFormModel = ReturnType<typeof openProxyForm>;
export type ProxyFormView = ReturnType<ProxyFormModel["getState"]>;
export type ProxyFormReadyView = Extract<ProxyFormView, { status: "ready" }>;
