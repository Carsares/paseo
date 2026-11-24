import {
  getParentAddressFromLabels,
  isMainControlAgent,
  RESIDENT_ROLE_MAX_LENGTH,
  RESIDENT_ROLE_SLUG_MAX_LENGTH,
} from "@getpaseo/protocol/agent-labels";
import type { AgentProfile, ServerInfoStatusPayload } from "@getpaseo/protocol/messages";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useShallow } from "zustand/shallow";
import { AdaptiveModalSheet, SheetHeaderSubtitle } from "@/components/adaptive-modal-sheet";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ControlSizeProvider } from "@/components/ui/control-size";
import type { ControlSize } from "@/components/ui/control-geometry";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { SelectField } from "@/components/ui/select-field";
import { Switch } from "@/components/ui/switch";
import { useIsCompactFormFactor } from "@/constants/layout";
import { daemonConfigQueryKey } from "@/data/daemon-config";
import { useReplicaQuery } from "@/data/query";
import { toErrorMessage } from "@/utils/error-messages";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import {
  residentActionsForAgent,
  supportsResidentAction,
  type ResidentRequest,
} from "./resident-actions";
import { openResidentForm } from "./resident-form-model";

export type OpenResidentDialogRequest = ResidentRequest & {
  initialProfileId?: string;
  /** Enables safe generation reset for a Topic Main Control seat without widening resident-actions.ts. */
  allowTopicMainReset?: boolean;
};

type Permission = NonNullable<ServerInfoStatusPayload["permissions"]>[number];

function allowsPermission(
  permissions: readonly Permission[] | undefined,
  permission: Permission,
): boolean {
  return permissions?.includes(permission) ?? true;
}

function canResetTopicMainControl(
  agentId: string,
  session: ReturnType<typeof useSessionStore.getState>["sessions"][string] | undefined,
): boolean {
  const agent = session?.agents.get(agentId);
  if (!agent || agent.archivedAt || agent.background || !agent.workspaceId) return false;
  if (!isMainControlAgent(agent)) return false;
  const permissions = session?.client?.getLastServerInfoMessage?.()?.permissions;
  return (
    allowsPermission(permissions, "workspace.write") && allowsPermission(permissions, "hub.execute")
  );
}

function isEligibleDialogAction(
  request: OpenResidentDialogRequest,
  session: ReturnType<typeof useSessionStore.getState>["sessions"][string] | undefined,
): boolean {
  if (sessionResidentActions(request.serverId, request.agentId, session).includes(request.action)) {
    return true;
  }
  return (
    request.action === "reset" &&
    request.allowTopicMainReset === true &&
    canResetTopicMainControl(request.agentId, session)
  );
}

function isAgentRunningForReset(
  agent: ReturnType<typeof useSessionStore.getState>["sessions"][string]["agents"] extends Map<
    string,
    infer T
  >
    ? T | undefined
    : never,
): boolean {
  if (!agent) return false;
  return (
    agent.status === "running" || agent.status === "initializing" || agent.turn.phase === "open"
  );
}

type OpenResidentDialog = (request: OpenResidentDialogRequest) => void;
const ResidentDialogContext = createContext<OpenResidentDialog | null>(null);

export function ResidentDialogProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<OpenResidentDialogRequest | null>(null);
  const open = useCallback<OpenResidentDialog>(
    (next) => setRequest((current) => current ?? next),
    [],
  );
  const close = useCallback(() => setRequest(null), []);
  return (
    <ResidentDialogContext.Provider value={open}>
      {children}
      {request ? <ResidentDialog request={request} onClose={close} /> : null}
    </ResidentDialogContext.Provider>
  );
}

export function useOpenResidentDialog(): OpenResidentDialog | null {
  return useContext(ResidentDialogContext);
}

export function useResidentDialogBridge() {
  const open = useContext(ResidentDialogContext);
  return useCallback(
    (children: ReactNode) => (
      <ResidentDialogContext.Provider value={open}>{children}</ResidentDialogContext.Provider>
    ),
    [open],
  );
}

function sessionResidentActions(
  serverId: string,
  agentId: string,
  session: ReturnType<typeof useSessionStore.getState>["sessions"][string] | undefined,
) {
  return residentActionsForAgent({
    serverId,
    agentId,
    agents: session?.agents,
    permissions: session?.client?.getLastServerInfoMessage?.()?.permissions,
  });
}

export function useResidentActions(serverId: string, agentId: string | null) {
  const open = useContext(ResidentDialogContext);
  const actions = useSessionStore(
    useShallow((state) => {
      if (!open || !agentId) return [];
      return sessionResidentActions(serverId, agentId, state.sessions[serverId]);
    }),
  );
  const features = useSessionStore((state) => state.sessions[serverId]?.serverInfo?.features);
  return useMemo(
    () =>
      actions.map((action) => ({
        action,
        supported: supportsResidentAction(features, action),
        onSelect: () => {
          if (agentId) open?.({ serverId, agentId, action });
        },
      })),
    [actions, agentId, features, open, serverId],
  );
}

export function useCreateResidentAction(serverId: string, agentId: string | null) {
  return useResidentActions(serverId, agentId).find(
    ({ action, supported }) => supported && action === "create",
  )?.onSelect;
}

const dialogKeys = {
  create: ["subagents.resident.createTitle", "subagents.resident.confirmCreate"],
  bind: ["subagents.resident.bindTitle", "subagents.resident.confirmBind"],
  unbind: ["subagents.resident.unbindTitle", "subagents.resident.confirmUnbind"],
  reset: ["subagents.resident.resetTitle", "subagents.resident.confirmReset"],
} as const;

type ResidentForm = ReturnType<typeof openResidentForm>;
type ResidentFormState = ReturnType<ResidentForm["getState"]>;

function useResidentPresets(
  serverId: string,
  client: ReturnType<typeof useHostRuntimeClient>,
  enabled: boolean,
) {
  const { t } = useTranslation();
  return useReplicaQuery({
    queryKey: daemonConfigQueryKey(serverId),
    enabled: enabled && Boolean(client),
    pushEvent: "status:daemon_config_changed",
    queryFn: async () => {
      if (!client) throw new Error(t("common.errors.daemonClientUnavailable"));
      return (await client.getDaemonConfig()).config;
    },
  });
}

function useSubmitResidentForm({
  client,
  model,
  request,
  allowSubmit,
  onClose,
}: {
  client: ReturnType<typeof useHostRuntimeClient>;
  model: ResidentForm;
  request: OpenResidentDialogRequest;
  allowSubmit: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return useCallback(async () => {
    if (!client || !allowSubmit) return;
    const { action, agentId, serverId } = request;
    let createdAgentId: string | undefined;
    const ok = await model.submit(async ({ profileId, overrides, reset }) => {
      const session = useSessionStore.getState().sessions[serverId];
      if (!isEligibleDialogAction(request, session)) {
        throw new Error(t("providerSelection.unavailable"));
      }
      switch (action) {
        case "reset":
          return client.resetAgentSession(agentId, reset);
        case "bind":
          return client.setAgentResident(agentId, true, overrides);
        case "unbind":
          return client.setAgentResident(agentId, false);
        case "create": {
          if (!profileId) return;
          const result = await client.createResidentAgent(agentId, profileId, overrides);
          createdAgentId = result.agentId;
        }
      }
    });
    if (!ok) return;
    onClose();
    if (createdAgentId) {
      // The host returns the same ID when that parent already has the requested role.
      const workspaceId = useSessionStore
        .getState()
        .sessions[serverId]?.agents.get(agentId)?.workspaceId;
      navigateToAgent({ serverId, workspaceId, agentId: createdAgentId, asTab: true });
    }
  }, [allowSubmit, client, model, request, onClose, t]);
}

function unavailableReason({
  connected,
  hasServerInfo,
  supported,
  eligible,
}: {
  connected: boolean;
  hasServerInfo: boolean;
  supported: boolean;
  eligible: boolean;
}) {
  if (!connected) return "workspace.terminal.hostDisconnected";
  if (!hasServerInfo) return "common.states.loading";
  if (!supported) return "subagents.resident.updateHost";
  if (!eligible) return "providerSelection.unavailable";
  return null;
}

function isResetConfirmationSatisfied(input: {
  isTopicMainReset: boolean;
  isRunning: boolean;
  interrupt: boolean;
  clearVisibleTimeline: boolean;
  confirmClearTimeline: boolean;
}): boolean {
  if (!input.isTopicMainReset) return true;
  if (input.isRunning && !input.interrupt) return false;
  if (input.clearVisibleTimeline && !input.confirmClearTimeline) return false;
  return true;
}

function useResidentDialogContext(request: OpenResidentDialogRequest) {
  const { serverId, agentId, action, allowTopicMainReset } = request;
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  const serverInfo = useSessionStore((store) => store.sessions[serverId]?.serverInfo);
  const agent = useSessionStore((store) => store.sessions[serverId]?.agents.get(agentId));
  const residentEligible = useResidentActions(serverId, agentId).some(
    (item) => item.action === action,
  );
  const isTopicMainReset = action === "reset" && allowTopicMainReset === true;
  const topicMainResetEligible = useSessionStore(
    (store) => isTopicMainReset && canResetTopicMainControl(agentId, store.sessions[serverId]),
  );
  const unavailable = unavailableReason({
    connected: connected && Boolean(client),
    hasServerInfo: Boolean(serverInfo),
    supported: supportsResidentAction(serverInfo?.features, action),
    eligible: residentEligible || topicMainResetEligible,
  });
  return {
    client,
    agent,
    isTopicMainReset,
    hasParent: getParentAddressFromLabels(agent?.labels, serverId) !== null,
    isRunning: isAgentRunningForReset(agent),
    unavailable,
    canUseAction: unavailable === null,
  };
}

function ResidentDialog({
  request,
  onClose,
}: {
  request: OpenResidentDialogRequest;
  onClose: () => void;
}) {
  const { serverId, action, initialProfileId } = request;
  const { t } = useTranslation();
  const size = useIsCompactFormFactor() ? "md" : "sm";
  const [model] = useState(() => openResidentForm(action));
  const [sheetRevision, setSheetRevision] = useState(0);
  const [confirmClearTimeline, setConfirmClearTimeline] = useState(false);
  const state = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  const { client, agent, isTopicMainReset, hasParent, isRunning, unavailable, canUseAction } =
    useResidentDialogContext(request);
  const presets = useResidentPresets(serverId, client, action === "create" && canUseAction);
  useEffect(() => {
    if (action !== "create" || !initialProfileId || state.preset !== null) return;
    const match = presets.data?.agentProfiles?.find((profile) => profile.id === initialProfileId);
    if (match) model.selectPreset(match);
  }, [action, initialProfileId, model, presets.data?.agentProfiles, state.preset]);
  const handleToggleClearTimeline = useCallback(
    (next: boolean) => {
      model.setClearVisibleTimeline(next);
      if (!next) setConfirmClearTimeline(false);
    },
    [model],
  );
  const selectedPresetId = state.preset?.id;
  const presetAvailable =
    presets.isSuccess &&
    presets.data.agentProfiles?.some((profile) => profile.id === selectedPresetId) === true;
  const waiting = state.phase === "pending";
  const resetConfirmed = isResetConfirmationSatisfied({
    isTopicMainReset,
    isRunning,
    interrupt: state.interrupt,
    clearVisibleTimeline: state.clearVisibleTimeline,
    confirmClearTimeline,
  });
  const allowSubmit =
    canUseAction && state.canSubmit && resetConfirmed && (action !== "create" || presetAvailable);
  const [defaultTitleKey, confirmKey] = dialogKeys[action];
  const titleKey = isTopicMainReset ? "topicWorkbench.directory.resetMainTitle" : defaultTitleKey;

  const header = useMemo(
    () => ({
      title: t(titleKey),
      subtitle: agent?.title ? <SheetHeaderSubtitle text={agent.title} /> : undefined,
    }),
    [t, titleKey, agent?.title],
  );
  const handleClose = useCallback(() => {
    if (model.getState().phase !== "pending") onClose();
  }, [model, onClose]);
  const handleDismiss = useCallback(() => {
    // Native swipe and Back can dismiss the sheet while a request is in flight.
    if (model.getState().phase === "pending") setSheetRevision((revision) => revision + 1);
  }, [model]);
  const handleSubmit = useSubmitResidentForm({ client, request, model, allowSubmit, onClose });

  return (
    <AdaptiveModalSheet
      key={sheetRevision}
      visible
      header={header}
      showCloseButton={!waiting}
      onClose={handleClose}
      onDismiss={handleDismiss}
      testID={`resident-${action}-dialog`}
    >
      <ControlSizeProvider size={size}>
        <View style={styles.body}>
          {unavailable ? (
            <Text style={styles.description}>{t(unavailable)}</Text>
          ) : (
            <ResidentFields
              action={action}
              hasParent={hasParent}
              isTopicMainReset={isTopicMainReset}
              isRunning={isRunning}
              confirmClearTimeline={confirmClearTimeline}
              onToggleClearTimeline={handleToggleClearTimeline}
              onConfirmClearTimeline={setConfirmClearTimeline}
              model={model}
              state={state}
              size={size}
              presets={presets}
            />
          )}
          {state.error ? <ResidentError message={state.error} /> : null}
          <View style={styles.actions}>
            <Button variant="secondary" size={size} disabled={waiting} onPress={handleClose}>
              {t("common.actions.cancel")}
            </Button>
            {canUseAction ? (
              <Button
                variant={action === "reset" ? "destructive" : "default"}
                size={size}
                disabled={!allowSubmit}
                loading={waiting}
                onPress={handleSubmit}
                testID="resident-confirm"
              >
                {t(confirmKey)}
              </Button>
            ) : null}
          </View>
        </View>
      </ControlSizeProvider>
    </AdaptiveModalSheet>
  );
}

interface ResidentFieldsProps {
  model: ResidentForm;
  state: ResidentFormState;
  size: ControlSize;
}

function ResidentResetFields({
  isTopicMainReset,
  isRunning,
  confirmClearTimeline,
  onToggleClearTimeline,
  onConfirmClearTimeline,
  model,
  state,
}: {
  isTopicMainReset: boolean;
  isRunning: boolean;
  confirmClearTimeline: boolean;
  onToggleClearTimeline: (next: boolean) => void;
  onConfirmClearTimeline: (next: boolean) => void;
  model: ResidentForm;
  state: ResidentFormState;
}) {
  const { t } = useTranslation();
  const waiting = state.phase === "pending";
  return (
    <>
      <Text style={styles.description}>
        {t(
          isTopicMainReset
            ? "topicWorkbench.directory.resetMainDescription"
            : "subagents.resident.resetDescription",
        )}
      </Text>
      {isTopicMainReset && isRunning && !state.interrupt ? (
        <Alert variant="warning" title={t("topicWorkbench.directory.resetMainRunningWarning")} />
      ) : null}
      <ResidentToggle
        label={t("subagents.resident.interrupt")}
        value={state.interrupt}
        disabled={waiting}
        onChange={model.setInterrupt}
      />
      <ResidentToggle
        label={t("subagents.resident.clearVisibleTimeline")}
        value={state.clearVisibleTimeline}
        disabled={waiting}
        onChange={onToggleClearTimeline}
      />
      {state.clearVisibleTimeline ? (
        <Text style={styles.description}>
          {t("subagents.resident.clearVisibleTimelineDescription")}
        </Text>
      ) : null}
      {isTopicMainReset && state.clearVisibleTimeline ? (
        <ResidentToggle
          label={t("topicWorkbench.directory.resetMainClearConfirmLabel")}
          value={confirmClearTimeline}
          disabled={waiting}
          onChange={onConfirmClearTimeline}
        />
      ) : null}
      {isTopicMainReset && state.clearVisibleTimeline ? (
        <Text style={styles.description}>
          {t("topicWorkbench.directory.resetMainClearConfirmHint")}
        </Text>
      ) : null}
    </>
  );
}

function ResidentFields({
  action,
  hasParent,
  isTopicMainReset,
  isRunning,
  confirmClearTimeline,
  onToggleClearTimeline,
  onConfirmClearTimeline,
  presets,
  model,
  state,
  size,
}: ResidentFieldsProps & {
  action: ResidentRequest["action"];
  hasParent: boolean;
  isTopicMainReset: boolean;
  isRunning: boolean;
  confirmClearTimeline: boolean;
  onToggleClearTimeline: (next: boolean) => void;
  onConfirmClearTimeline: (next: boolean) => void;
  presets: ReturnType<typeof useResidentPresets>;
}) {
  const { t } = useTranslation();
  switch (action) {
    case "create":
      return (
        <>
          <ResidentPresetField model={model} state={state} size={size} presets={presets} />
          {state.preset ? <ResidentRoleFields model={model} state={state} size={size} /> : null}
        </>
      );
    case "bind":
      return <ResidentRoleFields model={model} state={state} size={size} />;
    case "unbind":
      return hasParent ? (
        <Text style={styles.description}>{t("subagents.resident.unbindDescription")}</Text>
      ) : null;
    case "reset":
      return (
        <ResidentResetFields
          isTopicMainReset={isTopicMainReset}
          isRunning={isRunning}
          confirmClearTimeline={confirmClearTimeline}
          onToggleClearTimeline={onToggleClearTimeline}
          onConfirmClearTimeline={onConfirmClearTimeline}
          model={model}
          state={state}
        />
      );
  }
}

function ResidentPresetField({
  model,
  state,
  size,
  presets,
}: ResidentFieldsProps & { presets: ReturnType<typeof useResidentPresets> }) {
  const { t } = useTranslation();
  const { refetch } = presets;
  const profiles = presets.data?.agentProfiles;
  const emptyProfiles = t("subagents.resident.emptyProfiles");
  const options = useMemo(
    () => (profiles ?? []).map(({ id, name }) => ({ id, value: id, label: name })),
    [profiles],
  );
  const display = useMemo(
    () => (state.preset ? { label: state.preset.name } : null),
    [state.preset],
  );
  const handleSelect = useCallback(
    (id: AgentProfile["id"]) => {
      const preset = profiles?.find((profile) => profile.id === id);
      if (preset) model.selectPreset(preset);
    },
    [profiles, model],
  );
  const retry = useCallback(() => void refetch(), [refetch]);

  if (presets.isError) {
    return (
      <>
        <ResidentError message={toErrorMessage(presets.error)} />
        <Button size={size} variant="secondary" onPress={retry}>
          {t("common.actions.retry")}
        </Button>
      </>
    );
  }
  if (presets.isSuccess && options.length === 0) {
    return <Text style={styles.description}>{emptyProfiles}</Text>;
  }

  return (
    <SelectField
      label={t("subagents.resident.profile")}
      value={state.preset?.id ?? null}
      selectedDisplay={display}
      options={options}
      onChange={handleSelect}
      placeholder={t("common.actions.select")}
      emptyText={emptyProfiles}
      loading={presets.isPending}
      disabled={state.phase === "pending"}
      size={size}
      testID="resident-profile"
    />
  );
}

function ResidentRoleFields({ model, state, size }: ResidentFieldsProps) {
  const { t } = useTranslation();
  const waiting = state.phase === "pending";
  const roleLabel = t("subagents.resident.role");
  const slugLabel = t("subagents.resident.roleSlug");
  return (
    <>
      <Field label={roleLabel}>
        <FormTextInput
          accessibilityLabel={roleLabel}
          initialValue={state.role}
          onChangeText={model.setRole}
          placeholder={state.preset?.name}
          maxLength={RESIDENT_ROLE_MAX_LENGTH}
          autoCorrect={false}
          editable={!waiting}
          size={size}
        />
      </Field>
      <Field
        label={slugLabel}
        hint={t("settings.host.agentProfiles.residentRole.slugHint", {
          max: RESIDENT_ROLE_SLUG_MAX_LENGTH,
        })}
        error={
          state.roleSlugInvalid ? t("settings.host.agentProfiles.residentRole.slugError") : null
        }
      >
        <FormTextInput
          accessibilityLabel={slugLabel}
          initialValue={state.roleSlug}
          onChangeText={model.setRoleSlug}
          placeholder={state.preset?.roleSlug ?? "code-review"}
          autoCapitalize="none"
          autoCorrect={false}
          editable={!waiting}
          size={size}
        />
      </Field>
      <ResidentToggle
        label={t("subagents.resident.urgentReport")}
        value={state.urgentReport}
        disabled={waiting}
        onChange={model.setUrgentReport}
      />
      <ResidentToggle
        label={t("subagents.resident.keepAlive")}
        value={state.keepAlive}
        disabled={waiting}
        onChange={model.setKeepAlive}
      />
    </>
  );
}

function ResidentError({ message }: { message: string }) {
  const { t } = useTranslation();
  return (
    <Text accessibilityRole="alert" style={styles.error}>
      {t("subagents.resident.error", { message })}
    </Text>
  );
}

function ResidentToggle({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: boolean;
  disabled: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <View style={styles.toggle}>
      <Text style={styles.toggleLabel}>{label}</Text>
      <Switch
        accessibilityLabel={label}
        value={value}
        disabled={disabled}
        onValueChange={onChange}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: { gap: theme.spacing[3] },
  description: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.base },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.base },
  toggle: { flexDirection: "row", alignItems: "center", gap: theme.spacing[3] },
  toggleLabel: { flex: 1, color: theme.colors.foreground, fontSize: theme.fontSize.base },
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
  },
}));
