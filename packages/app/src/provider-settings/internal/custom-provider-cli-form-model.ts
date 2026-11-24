import type {
  CustomProviderCliDraft,
  CustomProviderCliResponsePayload,
} from "@getpaseo/protocol/messages";
import {
  AGENT_PROVIDER_DEFINITIONS,
  BUILTIN_PROVIDER_IDS,
  SPECIALIZED_ACP_PROVIDER_IDS,
} from "@getpaseo/protocol/provider-manifest";

export type { CustomProviderCliDraft };
export type CustomProviderCliMode = CustomProviderCliDraft["mode"];
export type CustomProviderCliTargetKind = "new" | "builtin" | "custom";
export type CustomProviderCliResult = NonNullable<CustomProviderCliResponsePayload["result"]> & {
  reason?: string;
};
export type CustomProviderCliStatus = CustomProviderCliResult["status"];
export interface CustomProviderCliResponse {
  requestId: string;
  result: CustomProviderCliResult | null;
}

export interface CustomProviderCliClient {
  locateCustomProviderCli(draft: CustomProviderCliDraft): Promise<CustomProviderCliResponse>;
  testCustomProviderCli(draft: CustomProviderCliDraft): Promise<CustomProviderCliResponse>;
  saveCustomProviderCli(draft: CustomProviderCliDraft): Promise<CustomProviderCliResponse>;
}

export interface CustomProviderCliInitialProvider {
  providerId: string;
  extends?: string;
  label?: string;
  description?: string;
  command?: readonly string[];
}

export interface CustomProviderCliFormSnapshot {
  mode: CustomProviderCliMode;
  targetKind: CustomProviderCliTargetKind;
  serverId: string;
  hostLabel: string;
  existingProviderIds: readonly string[];
  initialProvider?: CustomProviderCliInitialProvider;
  configLoaded: boolean;
}

export interface CustomProviderCliArgEntry {
  id: string;
  value: string;
  /** False for newly added blank rows until edited or explicitly confirmed as empty. */
  confirmed: boolean;
}

export interface CustomProviderCliEnvEntry {
  id: string;
  key: string;
  value: string;
}

export interface CustomProviderCliExtendsOption {
  value: string;
  label: string;
}

export interface CustomProviderCliExtendsDisplay {
  label: string;
}

export interface CustomProviderCliDirtyFields {
  label: boolean;
  description: boolean;
  command: boolean;
}

export type CustomProviderCliValidationErrorCode =
  | "providerIdRequired"
  | "providerIdInvalid"
  | "providerIdConflict"
  | "extendsRequired"
  | "extendsInvalid"
  | "labelRequired"
  | "commandRequiredForAcp"
  | "executableRequiredWithArgs"
  | "apiKeyNameRequired"
  | "invalidEnvKey"
  | "envKeyRequired"
  | "envValueRequired"
  | "duplicateEnvKey";

export interface CustomProviderCliValidationErrors {
  providerId: CustomProviderCliValidationErrorCode | null;
  extends: CustomProviderCliValidationErrorCode | null;
  label: CustomProviderCliValidationErrorCode | null;
  executable: CustomProviderCliValidationErrorCode | null;
  apiKey: CustomProviderCliValidationErrorCode | null;
  env: CustomProviderCliValidationErrorCode | null;
  duplicateEnvKeyName: string | null;
}

export type CustomProviderCliOperationState =
  | { kind: "idle" }
  | { kind: "pending"; requestToken: number }
  | { kind: "result"; status: CustomProviderCliStatus; path?: string; reason?: string }
  | { kind: "null_result" }
  | { kind: "error"; message: string };

export interface CustomProviderCliOperationTicket {
  token: number;
  serverId: string;
  draftRevision: number;
}

export interface CustomProviderCliFormState {
  mode: CustomProviderCliMode;
  targetKind: CustomProviderCliTargetKind;
  serverId: string;
  hostLabel: string;
  providerId: string;
  extendsProvider: string;
  selectedExtendsDisplay: CustomProviderCliExtendsDisplay | null;
  extendsOptions: CustomProviderCliExtendsOption[];
  label: string;
  description: string;
  executable: string;
  args: CustomProviderCliArgEntry[];
  apiKeyEnvName: string;
  apiKeyValue: string;
  envEntries: CustomProviderCliEnvEntry[];
  dirty: CustomProviderCliDirtyFields;
  draftRevision: number;
  labelResetKey: number;
  descriptionResetKey: number;
  commandResetKey: number;
  apiKeyNameResetKey: number;
  resolvedPath: string | null;
  locateState: CustomProviderCliOperationState;
  testState: CustomProviderCliOperationState;
  saveState: CustomProviderCliOperationState;
  errors: CustomProviderCliValidationErrors;
  draft: CustomProviderCliDraft | null;
  canLocate: boolean;
  canTest: boolean;
  canSave: boolean;
  showExtendsField: boolean;
  isProviderIdLocked: boolean;
  isExtendsLocked: boolean;
  isCommandRequired: boolean;
}

export interface CustomProviderCliFormModel {
  getState: () => CustomProviderCliFormState;
  subscribe: (listener: () => void) => () => void;
  close: () => void;
  applyHostLabel: (hostLabel: string) => void;
  applyExistingProviderIds: (providerIds: readonly string[]) => void;
  applyInitialConfig: (initialProvider: CustomProviderCliInitialProvider) => void;
  setProviderId: (value: string) => void;
  setExtends: (value: string, display?: CustomProviderCliExtendsDisplay) => void;
  setLabel: (value: string) => void;
  setDescription: (value: string) => void;
  setExecutable: (value: string) => void;
  addArg: () => void;
  setArg: (id: string, value: string) => void;
  confirmArg: (id: string) => void;
  removeArg: (id: string) => void;
  setApiKeyEnvName: (value: string) => void;
  setApiKeyValue: (value: string) => void;
  addEnvEntry: () => void;
  setEnvKey: (id: string, value: string) => void;
  setEnvValue: (id: string, value: string) => void;
  removeEnvEntry: (id: string) => void;
  beginLocate: () => CustomProviderCliOperationTicket | null;
  completeLocate: (
    ticket: CustomProviderCliOperationTicket,
    response: CustomProviderCliResponse,
  ) => boolean;
  failLocate: (ticket: CustomProviderCliOperationTicket, message: string) => boolean;
  beginTest: () => CustomProviderCliOperationTicket | null;
  completeTest: (
    ticket: CustomProviderCliOperationTicket,
    response: CustomProviderCliResponse,
  ) => boolean;
  failTest: (ticket: CustomProviderCliOperationTicket, message: string) => boolean;
  beginSave: () => CustomProviderCliOperationTicket | null;
  completeSave: (
    ticket: CustomProviderCliOperationTicket,
    response: CustomProviderCliResponse,
  ) => boolean;
  failSave: (ticket: CustomProviderCliOperationTicket, message: string) => boolean;
}

const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9-]*$/;
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SENSITIVE_ENV_KEY_PATTERN =
  /(api[_-]?key|token|secret|password|passwd|auth|credential|private[_-]?key)/i;
const VALID_EXTENDS_SET = new Set<string>(["acp", ...BUILTIN_PROVIDER_IDS]);
const BUILTIN_ID_SET = new Set<string>(BUILTIN_PROVIDER_IDS);

export const CUSTOM_PROVIDER_EXTENDS_OPTIONS: readonly CustomProviderCliExtendsOption[] = [
  { value: "acp", label: "ACP" },
  ...AGENT_PROVIDER_DEFINITIONS.map((definition) => ({
    value: definition.id,
    label: definition.label,
  })),
];

export function isValidCustomProviderExtends(value: string | undefined): value is string {
  return typeof value === "string" && VALID_EXTENDS_SET.has(value);
}

export function isSensitiveEnvKey(key: string): boolean {
  return SENSITIVE_ENV_KEY_PATTERN.test(key.trim());
}

export function formatExtendsLabel(value: string): string {
  return CUSTOM_PROVIDER_EXTENDS_OPTIONS.find((option) => option.value === value)?.label ?? value;
}

function defaultApiKeyEnvName(
  targetKind: CustomProviderCliTargetKind,
  extendsProvider: string,
  providerId: string,
): string {
  const base = targetKind === "builtin" ? providerId : extendsProvider;
  if (base === "claude") return "ANTHROPIC_API_KEY";
  if (base === "codex") return "OPENAI_API_KEY";
  return "";
}

function buildInitialArgs(
  command: readonly string[] | undefined,
  nextId: () => string,
): CustomProviderCliArgEntry[] {
  if (!command || command.length <= 1) return [];
  return command.slice(1).map((value) => ({ id: nextId(), value, confirmed: true }));
}

function buildExistingIdSet(existingProviderIds: readonly string[]): Set<string> {
  const ids = new Set<string>(["acp", ...BUILTIN_PROVIDER_IDS]);
  for (const id of existingProviderIds) {
    const trimmed = id.trim();
    if (trimmed) ids.add(trimmed);
  }
  return ids;
}

function resolveInitialExtends(
  snapshot: CustomProviderCliFormSnapshot,
  initialProvider: CustomProviderCliInitialProvider | undefined,
): string {
  if (snapshot.mode === "create") return "acp";
  if (snapshot.targetKind === "custom") return initialProvider?.extends ?? "";
  return "";
}

function validateProviderIdField(input: {
  mode: CustomProviderCliMode;
  providerId: string;
  extendsProvider: string;
  existingIds: ReadonlySet<string>;
}): CustomProviderCliValidationErrorCode | null {
  if (input.providerId.length === 0) return "providerIdRequired";
  if (!PROVIDER_ID_PATTERN.test(input.providerId)) return "providerIdInvalid";
  if (
    input.mode === "create" &&
    (input.existingIds.has(input.providerId) ||
      (input.extendsProvider === "acp" && SPECIALIZED_ACP_PROVIDER_IDS.includes(input.providerId)))
  ) {
    return "providerIdConflict";
  }
  return null;
}

function validateExtendsField(input: {
  mode: CustomProviderCliMode;
  targetKind: CustomProviderCliTargetKind;
  extendsProvider: string;
}): CustomProviderCliValidationErrorCode | null {
  if (input.mode !== "create" && input.targetKind !== "custom") return null;
  if (input.extendsProvider.length === 0) return "extendsRequired";
  if (!VALID_EXTENDS_SET.has(input.extendsProvider)) return "extendsInvalid";
  return null;
}

function validateExecutableField(input: {
  mode: CustomProviderCliMode;
  extendsProvider: string;
  executable: string;
  confirmedArgCount: number;
  shouldValidateCommand: boolean;
}): CustomProviderCliValidationErrorCode | null {
  if (!input.shouldValidateCommand) return null;
  if (input.executable.length === 0 && input.confirmedArgCount > 0) {
    return "executableRequiredWithArgs";
  }
  if (input.mode === "create" && input.extendsProvider === "acp" && input.executable.length === 0) {
    return "commandRequiredForAcp";
  }
  return null;
}

function validateEnvInputs(input: {
  apiKeyEnvName: string;
  apiKeyValue: string;
  envEntries: readonly CustomProviderCliEnvEntry[];
}): {
  apiKeyError: CustomProviderCliValidationErrorCode | null;
  envError: CustomProviderCliValidationErrorCode | null;
  duplicateEnvKeyName: string | null;
  envMap: Record<string, string>;
} {
  let apiKeyError: CustomProviderCliValidationErrorCode | null = null;
  let envError: CustomProviderCliValidationErrorCode | null = null;
  let duplicateEnvKeyName: string | null = null;
  const envMap: Record<string, string> = {};
  const seenKeys = new Set<string>();

  const apiKeyName = input.apiKeyEnvName.trim();
  if (input.apiKeyValue.trim().length > 0) {
    if (apiKeyName.length === 0) {
      apiKeyError = "apiKeyNameRequired";
    } else if (!ENV_KEY_PATTERN.test(apiKeyName)) {
      apiKeyError = "invalidEnvKey";
    } else {
      seenKeys.add(apiKeyName);
      envMap[apiKeyName] = input.apiKeyValue;
    }
  }

  for (const entry of input.envEntries) {
    const key = entry.key.trim();
    const hasValue = entry.value.length > 0;
    if (key.length === 0 && !hasValue) continue;
    if (key.length === 0) {
      envError ??= "envKeyRequired";
      continue;
    }
    if (!ENV_KEY_PATTERN.test(key)) {
      envError ??= "invalidEnvKey";
      continue;
    }
    if (!hasValue) {
      envError ??= "envValueRequired";
      continue;
    }
    if (seenKeys.has(key)) {
      envError ??= "duplicateEnvKey";
      duplicateEnvKeyName ??= key;
      continue;
    }
    seenKeys.add(key);
    envMap[key] = entry.value;
  }

  return { apiKeyError, envError, duplicateEnvKeyName, envMap };
}

function buildValidatedDraft(input: {
  mode: CustomProviderCliMode;
  targetKind: CustomProviderCliTargetKind;
  providerId: string;
  extendsProvider: string;
  label: string;
  description: string;
  executable: string;
  confirmedArgs: readonly string[];
  dirty: CustomProviderCliDirtyFields;
  envMap: Record<string, string>;
}): CustomProviderCliDraft {
  const draft: CustomProviderCliDraft = {
    mode: input.mode,
    providerId: input.providerId,
  };

  if (input.mode === "create" || input.targetKind === "custom") {
    draft.extends = input.extendsProvider;
  }

  if (input.mode === "create") {
    if (input.label.length > 0) draft.label = input.label;
    if (input.description.length > 0) draft.description = input.description;
    if (input.executable.length > 0) draft.command = [input.executable, ...input.confirmedArgs];
  } else {
    if (input.dirty.label && input.label.length > 0) {
      draft.label = input.label;
    }
    if (input.dirty.description) {
      // Explicit empty string signals clearing an existing description on the host.
      draft.description = input.description;
    }
    if (input.dirty.command && input.executable.length > 0) {
      draft.command = [input.executable, ...input.confirmedArgs];
    }
  }

  if (Object.keys(input.envMap).length > 0) {
    draft.env = input.envMap;
  }
  return draft;
}

function validateAndBuildDraft(input: {
  mode: CustomProviderCliMode;
  targetKind: CustomProviderCliTargetKind;
  providerId: string;
  extendsProvider: string;
  label: string;
  description: string;
  executable: string;
  args: readonly CustomProviderCliArgEntry[];
  dirty: CustomProviderCliDirtyFields;
  apiKeyEnvName: string;
  apiKeyValue: string;
  envEntries: readonly CustomProviderCliEnvEntry[];
  existingIds: ReadonlySet<string>;
}): {
  errors: CustomProviderCliValidationErrors;
  draft: CustomProviderCliDraft | null;
} {
  const providerId = input.providerId.trim();
  const extendsProvider = input.extendsProvider.trim();
  const label = input.label.trim();
  const description = input.description.trim();
  const executable = input.executable.trim();
  const confirmedArgs = input.args.filter((entry) => entry.confirmed).map((entry) => entry.value);

  const providerIdError = validateProviderIdField({
    mode: input.mode,
    providerId,
    extendsProvider,
    existingIds: input.existingIds,
  });
  const extendsError = validateExtendsField({
    mode: input.mode,
    targetKind: input.targetKind,
    extendsProvider,
  });
  const requiresLabel =
    input.mode === "create" || (input.targetKind === "custom" && input.dirty.label);
  const labelError: CustomProviderCliValidationErrorCode | null =
    requiresLabel && label.length === 0 ? "labelRequired" : null;
  const executableError = validateExecutableField({
    mode: input.mode,
    extendsProvider,
    executable,
    confirmedArgCount: confirmedArgs.length,
    shouldValidateCommand: input.mode === "create" || input.dirty.command,
  });
  const { apiKeyError, envError, duplicateEnvKeyName, envMap } = validateEnvInputs({
    apiKeyEnvName: input.apiKeyEnvName,
    apiKeyValue: input.apiKeyValue,
    envEntries: input.envEntries,
  });

  const errors: CustomProviderCliValidationErrors = {
    providerId: providerIdError,
    extends: extendsError,
    label: labelError,
    executable: executableError,
    apiKey: apiKeyError,
    env: envError,
    duplicateEnvKeyName,
  };

  const hasError =
    providerIdError !== null ||
    extendsError !== null ||
    labelError !== null ||
    executableError !== null ||
    apiKeyError !== null ||
    envError !== null;

  if (hasError) {
    return { errors, draft: null };
  }

  return {
    errors,
    draft: buildValidatedDraft({
      mode: input.mode,
      targetKind: input.targetKind,
      providerId,
      extendsProvider,
      label,
      description,
      executable,
      confirmedArgs,
      dirty: input.dirty,
      envMap,
    }),
  };
}

function deriveState(
  state: CustomProviderCliFormState,
  existingIds: ReadonlySet<string>,
): CustomProviderCliFormState {
  const { errors, draft } = validateAndBuildDraft({
    mode: state.mode,
    targetKind: state.targetKind,
    providerId: state.providerId,
    extendsProvider: state.extendsProvider,
    label: state.label,
    description: state.description,
    executable: state.executable,
    args: state.args,
    dirty: state.dirty,
    apiKeyEnvName: state.apiKeyEnvName,
    apiKeyValue: state.apiKeyValue,
    envEntries: state.envEntries,
    existingIds,
  });

  const isSaving = state.saveState.kind === "pending";
  const isLocating = state.locateState.kind === "pending";
  const isTesting = state.testState.kind === "pending";
  const hasValidDraft = draft !== null;

  return {
    ...state,
    errors,
    draft,
    canLocate: hasValidDraft && !isLocating && !isSaving,
    canTest: hasValidDraft && !isTesting && !isSaving,
    canSave: hasValidDraft && !isSaving,
    showExtendsField: state.mode === "create" || state.targetKind === "custom",
    isProviderIdLocked: state.mode === "edit",
    isExtendsLocked: state.mode === "edit",
    isCommandRequired: state.mode === "create" && state.extendsProvider.trim() === "acp",
  };
}

function buildHydratedEditState(input: {
  state: CustomProviderCliFormState;
  nextInitial: CustomProviderCliInitialProvider;
  userModifiedApiKeyName: boolean;
  nextArgId: () => string;
}): CustomProviderCliFormState {
  const { state, nextInitial } = input;
  const nextExtends =
    state.targetKind === "custom"
      ? (nextInitial.extends ?? state.extendsProvider)
      : state.extendsProvider;
  const nextApiKeyName = input.userModifiedApiKeyName
    ? state.apiKeyEnvName
    : defaultApiKeyEnvName(state.targetKind, nextExtends, state.providerId);

  const nextState: CustomProviderCliFormState = {
    ...state,
    extendsProvider: nextExtends,
    selectedExtendsDisplay: nextExtends ? { label: formatExtendsLabel(nextExtends) } : null,
    apiKeyEnvName: nextApiKeyName,
    draftRevision: state.draftRevision + 1,
    apiKeyNameResetKey:
      nextApiKeyName !== state.apiKeyEnvName
        ? state.apiKeyNameResetKey + 1
        : state.apiKeyNameResetKey,
    resolvedPath: null,
    locateState: { kind: "idle" },
    testState: { kind: "idle" },
    saveState: { kind: "idle" },
  };

  if (!state.dirty.label && nextInitial.label !== undefined) {
    nextState.label = nextInitial.label;
    nextState.labelResetKey = state.labelResetKey + 1;
  }
  if (!state.dirty.description && nextInitial.description !== undefined) {
    nextState.description = nextInitial.description;
    nextState.descriptionResetKey = state.descriptionResetKey + 1;
  }
  if (!state.dirty.command && nextInitial.command !== undefined) {
    nextState.executable = nextInitial.command[0] ?? "";
    nextState.args = buildInitialArgs(nextInitial.command, input.nextArgId);
    nextState.commandResetKey = state.commandResetKey + 1;
  }

  return nextState;
}

export function openCustomProviderCliForm(
  snapshot: CustomProviderCliFormSnapshot,
): CustomProviderCliFormModel {
  let closed = false;
  let nextRowSequence = 1;
  let nextRequestToken = 1;
  let userModifiedApiKeyName = false;
  let hydratedFromConfig = snapshot.configLoaded;
  let existingIds = buildExistingIdSet(snapshot.existingProviderIds);
  const listeners = new Set<() => void>();

  const nextRowId = (prefix: string) => `${prefix}-${nextRowSequence++}`;

  const initialProvider = snapshot.initialProvider;
  const initialExtends = resolveInitialExtends(snapshot, initialProvider);
  const initialProviderId = snapshot.mode === "edit" ? (initialProvider?.providerId ?? "") : "";
  const initialCommand = initialProvider?.command;
  const initialExecutable = initialCommand?.[0] ?? "";
  const initialArgs = buildInitialArgs(initialCommand, () => nextRowId("arg"));
  const initialApiKeyName = defaultApiKeyEnvName(
    snapshot.targetKind,
    initialExtends,
    initialProviderId,
  );

  let state: CustomProviderCliFormState = deriveState(
    {
      mode: snapshot.mode,
      targetKind: snapshot.targetKind,
      serverId: snapshot.serverId,
      hostLabel: snapshot.hostLabel,
      providerId: initialProviderId,
      extendsProvider: initialExtends,
      selectedExtendsDisplay: initialExtends ? { label: formatExtendsLabel(initialExtends) } : null,
      extendsOptions: [...CUSTOM_PROVIDER_EXTENDS_OPTIONS],
      label: initialProvider?.label ?? "",
      description: initialProvider?.description ?? "",
      executable: initialExecutable,
      args: initialArgs,
      apiKeyEnvName: initialApiKeyName,
      apiKeyValue: "",
      envEntries: [],
      dirty: { label: false, description: false, command: false },
      draftRevision: 1,
      labelResetKey: 0,
      descriptionResetKey: 0,
      commandResetKey: 0,
      apiKeyNameResetKey: 0,
      resolvedPath: null,
      locateState: { kind: "idle" },
      testState: { kind: "idle" },
      saveState: { kind: "idle" },
      errors: {
        providerId: null,
        extends: null,
        label: null,
        executable: null,
        apiKey: null,
        env: null,
        duplicateEnvKeyName: null,
      },
      draft: null,
      canLocate: false,
      canTest: false,
      canSave: false,
      showExtendsField: snapshot.mode === "create" || snapshot.targetKind === "custom",
      isProviderIdLocked: snapshot.mode === "edit",
      isExtendsLocked: snapshot.mode === "edit",
      isCommandRequired: snapshot.mode === "create" && initialExtends === "acp",
    },
    existingIds,
  );

  function publish(next: CustomProviderCliFormState): void {
    state = deriveState(next, existingIds);
    for (const listener of listeners) {
      listener();
    }
  }

  function isSavePending(): boolean {
    return state.saveState.kind === "pending";
  }

  function mutateDraft(
    updater: (current: CustomProviderCliFormState) => Partial<CustomProviderCliFormState>,
  ): void {
    if (closed || isSavePending()) return;
    const patch = updater(state);
    publish({
      ...state,
      ...patch,
      draftRevision: state.draftRevision + 1,
      resolvedPath: null,
      locateState: { kind: "idle" },
      testState: { kind: "idle" },
      saveState: { kind: "idle" },
    });
  }

  function isTicketCurrent(
    ticket: CustomProviderCliOperationTicket,
    operationState: CustomProviderCliOperationState,
  ): boolean {
    if (closed) return false;
    if (ticket.serverId !== state.serverId) return false;
    if (ticket.draftRevision !== state.draftRevision) return false;
    return operationState.kind === "pending" && operationState.requestToken === ticket.token;
  }

  function beginOperation(
    field: "locateState" | "testState" | "saveState",
  ): CustomProviderCliOperationTicket | null {
    if (closed || isSavePending() || state.draft === null) return null;
    if (field === "locateState" && !state.canLocate) return null;
    if (field === "testState" && !state.canTest) return null;
    if (field === "saveState" && !state.canSave) return null;
    const token = nextRequestToken++;
    const ticket: CustomProviderCliOperationTicket = {
      token,
      serverId: state.serverId,
      draftRevision: state.draftRevision,
    };
    publish({
      ...state,
      [field]: { kind: "pending", requestToken: token },
    });
    return ticket;
  }

  function completeOperation(
    field: "locateState" | "testState" | "saveState",
    ticket: CustomProviderCliOperationTicket,
    response: CustomProviderCliResponse,
  ): boolean {
    if (!isTicketCurrent(ticket, state[field])) return false;
    const result = response.result;
    if (result === null) {
      publish({
        ...state,
        [field]: { kind: "null_result" },
      });
      return true;
    }
    const nextResolvedPath =
      result.path !== undefined && result.path.trim().length > 0
        ? result.path.trim()
        : state.resolvedPath;
    const reason =
      "reason" in result && typeof result.reason === "string" ? result.reason : undefined;
    publish({
      ...state,
      resolvedPath: nextResolvedPath,
      [field]: {
        kind: "result",
        status: result.status,
        ...(result.path !== undefined ? { path: result.path } : {}),
        ...(reason !== undefined ? { reason } : {}),
      },
    });
    return true;
  }

  function failOperation(
    field: "locateState" | "testState" | "saveState",
    ticket: CustomProviderCliOperationTicket,
    message: string,
  ): boolean {
    if (!isTicketCurrent(ticket, state[field])) return false;
    publish({
      ...state,
      [field]: { kind: "error", message },
    });
    return true;
  }

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close: () => {
      closed = true;
      // Clear all held write-only secrets and derived draft payload on close.
      state = {
        ...state,
        apiKeyValue: "",
        envEntries: [],
        draft: null,
        resolvedPath: null,
        locateState: { kind: "idle" },
        testState: { kind: "idle" },
        saveState: { kind: "idle" },
        canLocate: false,
        canTest: false,
        canSave: false,
      };
      listeners.clear();
    },
    applyHostLabel: (hostLabel) => {
      if (closed || hostLabel === state.hostLabel) return;
      publish({ ...state, hostLabel });
    },
    applyExistingProviderIds: (providerIds) => {
      if (closed || isSavePending()) return;
      const nextSet = buildExistingIdSet(providerIds);
      if (nextSet.size === existingIds.size && [...nextSet].every((id) => existingIds.has(id))) {
        return;
      }
      existingIds = nextSet;
      publish({ ...state });
    },
    applyInitialConfig: (nextInitial) => {
      if (closed || isSavePending() || state.mode !== "edit" || hydratedFromConfig) return;
      hydratedFromConfig = true;
      publish(
        buildHydratedEditState({
          state,
          nextInitial,
          userModifiedApiKeyName,
          nextArgId: () => nextRowId("arg"),
        }),
      );
    },
    setProviderId: (value) => {
      if (state.mode === "edit") return;
      mutateDraft(() => ({ providerId: value }));
    },
    setExtends: (value, display) => {
      if (state.mode === "edit") return;
      mutateDraft((current) => {
        const nextApiKeyName = userModifiedApiKeyName
          ? current.apiKeyEnvName
          : defaultApiKeyEnvName(current.targetKind, value, current.providerId);
        return {
          extendsProvider: value,
          selectedExtendsDisplay: display ?? { label: formatExtendsLabel(value) },
          apiKeyEnvName: nextApiKeyName,
          apiKeyNameResetKey:
            nextApiKeyName !== current.apiKeyEnvName
              ? current.apiKeyNameResetKey + 1
              : current.apiKeyNameResetKey,
        };
      });
    },
    setLabel: (value) => {
      mutateDraft((current) => ({
        label: value,
        dirty: { ...current.dirty, label: true },
      }));
    },
    setDescription: (value) => {
      mutateDraft((current) => ({
        description: value,
        dirty: { ...current.dirty, description: true },
      }));
    },
    setExecutable: (value) => {
      mutateDraft((current) => ({
        executable: value,
        dirty: { ...current.dirty, command: true },
      }));
    },
    addArg: () => {
      if (closed || isSavePending()) return;
      publish({
        ...state,
        args: [...state.args, { id: nextRowId("arg"), value: "", confirmed: false }],
      });
    },
    setArg: (id, value) => {
      mutateDraft((current) => ({
        args: current.args.map((entry) =>
          entry.id === id ? { ...entry, value, confirmed: true } : entry,
        ),
        dirty: { ...current.dirty, command: true },
      }));
    },
    confirmArg: (id) => {
      mutateDraft((current) => ({
        args: current.args.map((entry) =>
          entry.id === id ? { ...entry, confirmed: true } : entry,
        ),
        dirty: { ...current.dirty, command: true },
      }));
    },
    removeArg: (id) => {
      if (closed || isSavePending()) return;
      const target = state.args.find((entry) => entry.id === id);
      if (!target) return;
      if (!target.confirmed) {
        publish({
          ...state,
          args: state.args.filter((entry) => entry.id !== id),
        });
        return;
      }
      mutateDraft((current) => ({
        args: current.args.filter((entry) => entry.id !== id),
        dirty: { ...current.dirty, command: true },
      }));
    },
    setApiKeyEnvName: (value) => {
      if (closed || isSavePending()) return;
      userModifiedApiKeyName = true;
      mutateDraft(() => ({ apiKeyEnvName: value }));
    },
    setApiKeyValue: (value) => {
      mutateDraft(() => ({ apiKeyValue: value }));
    },
    addEnvEntry: () => {
      if (closed || isSavePending()) return;
      publish({
        ...state,
        envEntries: [...state.envEntries, { id: nextRowId("env"), key: "", value: "" }],
      });
    },
    setEnvKey: (id, value) => {
      mutateDraft((current) => ({
        envEntries: current.envEntries.map((entry) =>
          entry.id === id ? { ...entry, key: value } : entry,
        ),
      }));
    },
    setEnvValue: (id, value) => {
      mutateDraft((current) => ({
        envEntries: current.envEntries.map((entry) =>
          entry.id === id ? { ...entry, value } : entry,
        ),
      }));
    },
    removeEnvEntry: (id) => {
      mutateDraft((current) => ({
        envEntries: current.envEntries.filter((entry) => entry.id !== id),
      }));
    },
    beginLocate: () => beginOperation("locateState"),
    completeLocate: (ticket, response) => completeOperation("locateState", ticket, response),
    failLocate: (ticket, message) => failOperation("locateState", ticket, message),
    beginTest: () => beginOperation("testState"),
    completeTest: (ticket, response) => completeOperation("testState", ticket, response),
    failTest: (ticket, message) => failOperation("testState", ticket, message),
    beginSave: () => beginOperation("saveState"),
    completeSave: (ticket, response) => completeOperation("saveState", ticket, response),
    failSave: (ticket, message) => failOperation("saveState", ticket, message),
  };
}

export function isBuiltinProviderId(providerId: string): boolean {
  return BUILTIN_ID_SET.has(providerId);
}
