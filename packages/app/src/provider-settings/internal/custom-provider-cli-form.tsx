import { Plus, Trash2 } from "lucide-react-native";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactElement,
} from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Alert, type AlertVariant } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { ToolbarButton, paneContentToolbarIconSize } from "@/components/ui/pane-content-toolbar";
import {
  SelectField,
  type SelectFieldDisplay,
  type SelectFieldOption,
} from "@/components/ui/select-field";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { useHosts } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { CODE_SURFACE_DATASET } from "@/styles/code-surface";
import type { Theme } from "@/styles/theme";
import { toErrorMessage } from "@/utils/error-messages";
import {
  isSensitiveEnvKey,
  openCustomProviderCliForm,
  type CustomProviderCliArgEntry,
  type CustomProviderCliClient,
  type CustomProviderCliEnvEntry,
  type CustomProviderCliFormModel,
  type CustomProviderCliFormSnapshot,
  type CustomProviderCliFormState,
  type CustomProviderCliInitialProvider,
  type CustomProviderCliOperationState,
  type CustomProviderCliStatus,
  type CustomProviderCliValidationErrorCode,
} from "./custom-provider-cli-form-model";
import {
  readCustomProviderConfig,
  useCustomProviderCliClient,
  type CustomProviderEditTarget,
} from "./provider-config";
import { OVERLAY_SHEET_FRAME, type ProviderSheetFrame } from "./sheet-frame";

const ThemedTrash = withUnistyles(Trash2);
const destructiveColorMapping = (theme: Theme) => ({ color: theme.colors.destructive });

export type CustomProviderCliFormSheetProps = (
  | {
      mode: "create";
      target?: undefined;
    }
  | {
      mode: "edit";
      target: CustomProviderEditTarget;
    }
) & {
  serverId: string;
  visible: boolean;
  onClose: () => void;
  /** Called with the saved provider ID after save returns status "ok". */
  onSaved?: (providerId: string) => void;
  frame?: ProviderSheetFrame;
  /** Optional override for tests; defaults to the host runtime client. */
  client?: CustomProviderCliClient | null;
};

function buildOpenKey(props: CustomProviderCliFormSheetProps): string {
  if (props.mode === "edit") {
    return `edit:${props.serverId}:${props.target.targetKind}:${props.target.initialProvider.providerId}`;
  }
  return `create:${props.serverId}`;
}

/**
 * Fresh mount per open (see docs/forms.md): returns null when closed and keys the open form on
 * mode + host + target identity so edit never contaminates create or another host.
 */
export function CustomProviderCliFormSheet(
  props: CustomProviderCliFormSheetProps,
): ReactElement | null {
  if (!props.visible) {
    return null;
  }
  return <OpenCustomProviderCliFormSheet key={buildOpenKey(props)} {...props} />;
}

export function useCustomProviderCliFormModel(
  snapshot: CustomProviderCliFormSnapshot,
): CustomProviderCliFormModel {
  const [model] = useState(() => openCustomProviderCliForm(snapshot));

  useEffect(() => {
    return () => {
      model.close();
    };
  }, [model]);

  useEffect(() => {
    model.applyHostLabel(snapshot.hostLabel);
  }, [model, snapshot.hostLabel]);

  useEffect(() => {
    model.applyExistingProviderIds(snapshot.existingProviderIds);
  }, [model, snapshot.existingProviderIds]);

  useEffect(() => {
    if (snapshot.configLoaded && snapshot.initialProvider) {
      model.applyInitialConfig(snapshot.initialProvider);
    }
  }, [model, snapshot.configLoaded, snapshot.initialProvider]);

  return model;
}

function OpenCustomProviderCliFormSheet({
  mode,
  target,
  serverId,
  visible,
  onClose,
  onSaved,
  frame = OVERLAY_SHEET_FRAME,
  client: clientOverride,
}: CustomProviderCliFormSheetProps): ReactElement {
  const { t } = useTranslation();
  const hosts = useHosts();
  const serverHostname = useSessionStore(
    (store) => store.sessions[serverId]?.serverInfo?.hostname ?? null,
  );
  const { config } = useDaemonConfig(serverId);
  const { entries } = useProvidersSnapshot(serverId);
  const runtimeClient = useCustomProviderCliClient(serverId);
  const client = clientOverride !== undefined ? clientOverride : runtimeClient;

  const hostLabel = useMemo(() => {
    const profile = hosts.find((candidate) => candidate.serverId === serverId);
    return profile?.label || serverHostname || serverId;
  }, [hosts, serverHostname, serverId]);

  const existingProviderIds = useMemo(() => {
    const ids = new Set<string>();
    for (const entry of entries ?? []) {
      ids.add(entry.provider);
    }
    for (const key of Object.keys(config?.providers ?? {})) {
      ids.add(key);
    }
    return [...ids];
  }, [config?.providers, entries]);

  const liveInitialProvider = useMemo<CustomProviderCliInitialProvider | undefined>(() => {
    if (mode !== "edit" || !target) return undefined;
    const providerId = target.initialProvider.providerId;
    const configured = readCustomProviderConfig(config, providerId);
    if (!configured) return target.initialProvider;
    return {
      providerId,
      extends: configured.extends ?? target.initialProvider.extends,
      label: configured.label ?? target.initialProvider.label,
      description: configured.description ?? target.initialProvider.description,
      command: configured.command ?? target.initialProvider.command,
    };
  }, [config, mode, target]);

  const snapshot = useMemo<CustomProviderCliFormSnapshot>(
    () => ({
      mode,
      targetKind: mode === "edit" && target ? target.targetKind : "new",
      serverId,
      hostLabel,
      existingProviderIds,
      initialProvider: liveInitialProvider,
      configLoaded: config !== null,
    }),
    [config, existingProviderIds, hostLabel, liveInitialProvider, mode, serverId, target],
  );

  const model = useCustomProviderCliFormModel(snapshot);
  const state = useSyncExternalStore(model.subscribe, model.getState, model.getState);

  const handleLocate = useCallback(() => {
    if (!client) return;
    const draft = model.getState().draft;
    const ticket = model.beginLocate();
    if (!ticket || !draft) return;
    void client
      .locateCustomProviderCli(draft)
      .then((response) => model.completeLocate(ticket, response))
      .catch((error: unknown) => model.failLocate(ticket, toErrorMessage(error)));
  }, [client, model]);

  const handleTest = useCallback(() => {
    if (!client) return;
    const draft = model.getState().draft;
    const ticket = model.beginTest();
    if (!ticket || !draft) return;
    void client
      .testCustomProviderCli(draft)
      .then((response) => model.completeTest(ticket, response))
      .catch((error: unknown) => model.failTest(ticket, toErrorMessage(error)));
  }, [client, model]);

  const handleSave = useCallback(() => {
    if (!client) return;
    const draft = model.getState().draft;
    const ticket = model.beginSave();
    if (!ticket || !draft) return;
    void client
      .saveCustomProviderCli(draft)
      .then((response) => {
        const applied = model.completeSave(ticket, response);
        if (applied && response.result?.status === "ok") {
          onSaved?.(draft.providerId);
          onClose();
        }
        return applied;
      })
      .catch((error: unknown) => model.failSave(ticket, toErrorMessage(error)));
  }, [client, model, onClose, onSaved]);

  const isSaving = state.saveState.kind === "pending";
  const canSave = Boolean(client) && state.canSave;
  const saveButtonLabel = resolveSaveButtonLabel(isSaving, state.mode, t);

  const title = useMemo(() => {
    if (state.mode === "create") {
      return t("settings.providers.customCli.createTitle");
    }
    if (state.targetKind === "builtin") {
      return t("settings.providers.customCli.overrideTitle", { name: state.providerId });
    }
    return t("settings.providers.customCli.editTitle", {
      name: state.label.trim() || state.providerId,
    });
  }, [state.label, state.mode, state.providerId, state.targetKind, t]);

  const header = useMemo<SheetHeader>(
    () => ({
      title,
      back: frame.returns
        ? {
            onPress: onClose,
            accessibilityLabel: t("settings.providers.detail.backToProviders"),
          }
        : undefined,
    }),
    [frame.returns, onClose, t, title],
  );

  const footer = useMemo(
    () => (
      <View style={styles.footer}>
        <Button
          style={styles.footerButton}
          variant="secondary"
          onPress={onClose}
          disabled={isSaving}
          testID="custom-cli-cancel"
        >
          {t("common.actions.cancel")}
        </Button>
        <Button
          style={styles.footerButton}
          variant="default"
          onPress={handleSave}
          disabled={!canSave}
          loading={isSaving}
          testID="custom-cli-save"
        >
          {saveButtonLabel}
        </Button>
      </View>
    ),
    [canSave, handleSave, isSaving, onClose, saveButtonLabel, t],
  );

  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={onClose}
      showCloseButton={!frame.returns}
      desktopMaxWidth={frame.desktopMaxWidth ?? 540}
      desktopHeight={frame.desktopHeight}
      snapPoints={frame.snapPoints}
      footer={footer}
      testID="custom-cli-form-sheet"
    >
      <CustomProviderCliFormBody
        model={model}
        state={state}
        hasClient={Boolean(client)}
        onLocate={handleLocate}
        onTest={handleTest}
      />
    </AdaptiveModalSheet>
  );
}

export interface CustomProviderCliFormBodyProps {
  model: CustomProviderCliFormModel;
  state: CustomProviderCliFormState;
  hasClient: boolean;
  onLocate: () => void;
  onTest: () => void;
}

export function CustomProviderCliFormBody({
  model,
  state,
  hasClient,
  onLocate,
  onTest,
}: CustomProviderCliFormBodyProps): ReactElement {
  const { t } = useTranslation();
  const compact = useIsCompactFormFactor();
  const showRequiredErrors = state.draftRevision > 1;

  const providerIdError = resolveValidationErrorMessage(
    state.errors.providerId,
    showRequiredErrors,
    state.errors.duplicateEnvKeyName,
    t,
  );
  const extendsError = resolveValidationErrorMessage(
    state.errors.extends,
    showRequiredErrors,
    state.errors.duplicateEnvKeyName,
    t,
  );
  const labelError = resolveValidationErrorMessage(
    state.errors.label,
    showRequiredErrors,
    state.errors.duplicateEnvKeyName,
    t,
  );
  const executableError = resolveValidationErrorMessage(
    state.errors.executable,
    showRequiredErrors,
    state.errors.duplicateEnvKeyName,
    t,
  );
  const apiKeyError = resolveValidationErrorMessage(
    state.errors.apiKey,
    true,
    state.errors.duplicateEnvKeyName,
    t,
  );
  const envError = resolveValidationErrorMessage(
    state.errors.env,
    true,
    state.errors.duplicateEnvKeyName,
    t,
  );

  const saveFeedback = resolveOperationFeedback("save", state.saveState, state.hostLabel, t);
  const isSaving = state.saveState.kind === "pending";
  const showSaveError =
    saveFeedback !== null && (state.saveState.kind !== "result" || state.saveState.status !== "ok");

  const executablePlaceholder = resolveExecutablePlaceholder(state, t);

  const addArgButton = useMemo(
    () => (
      <Button
        variant="ghost"
        size="sm"
        leftIcon={Plus}
        onPress={model.addArg}
        disabled={isSaving}
        testID="custom-cli-add-arg"
      >
        {t("settings.providers.customCli.actions.addArgument")}
      </Button>
    ),
    [isSaving, model.addArg, t],
  );

  const addEnvButton = useMemo(
    () => (
      <Button
        variant="ghost"
        size="sm"
        leftIcon={Plus}
        onPress={model.addEnvEntry}
        disabled={isSaving}
        testID="custom-cli-add-env"
      >
        {t("settings.providers.customCli.actions.addEnv")}
      </Button>
    ),
    [isSaving, model.addEnvEntry, t],
  );

  return (
    <View style={styles.form} testID="custom-cli-form">
      <HostSummaryCard state={state} />

      {state.showExtendsField ? (
        <ExtendsField model={model} state={state} error={extendsError} disabled={isSaving} />
      ) : null}

      <Field
        label={t("settings.providers.customCli.fields.providerId")}
        error={providerIdError}
        testID="custom-cli-provider-id-field"
      >
        {state.isProviderIdLocked ? (
          <View style={styles.readonlyBox} testID="custom-cli-id-readonly">
            <Text style={styles.readonlyMonoText} selectable dataSet={CODE_SURFACE_DATASET}>
              {state.providerId}
            </Text>
          </View>
        ) : (
          <FormTextInput
            initialValue={state.providerId}
            onChangeText={model.setProviderId}
            editable={!isSaving}
            placeholder={t("settings.providers.customCli.fields.providerIdPlaceholder")}
            autoCapitalize="none"
            autoCorrect={false}
            accessibilityLabel={t("settings.providers.customCli.fields.providerId")}
            testID="custom-cli-provider-id-input"
          />
        )}
      </Field>

      <Field
        label={t("settings.providers.customCli.fields.label")}
        error={labelError}
        testID="custom-cli-label-field"
      >
        <FormTextInput
          initialValue={state.label}
          resetKey={state.labelResetKey}
          onChangeText={model.setLabel}
          editable={!isSaving}
          placeholder={
            state.targetKind === "builtin"
              ? t("settings.providers.customCli.fields.labelOptionalPlaceholder")
              : t("settings.providers.customCli.fields.labelPlaceholder")
          }
          accessibilityLabel={t("settings.providers.customCli.fields.label")}
          testID="custom-cli-label-input"
        />
      </Field>

      <Field
        label={t("settings.providers.customCli.fields.description")}
        testID="custom-cli-description-field"
      >
        <FormTextInput
          initialValue={state.description}
          resetKey={state.descriptionResetKey}
          onChangeText={model.setDescription}
          editable={!isSaving}
          placeholder={t("settings.providers.customCli.fields.descriptionPlaceholder")}
          accessibilityLabel={t("settings.providers.customCli.fields.description")}
          testID="custom-cli-description-input"
        />
      </Field>

      <Field
        label={t("settings.providers.customCli.fields.executable")}
        error={executableError}
        testID="custom-cli-executable-field"
      >
        <FormTextInput
          initialValue={state.executable}
          resetKey={state.commandResetKey}
          onChangeText={model.setExecutable}
          editable={!isSaving}
          placeholder={executablePlaceholder}
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel={t("settings.providers.customCli.fields.executable")}
          testID="custom-cli-executable-input"
        />
      </Field>

      <Field
        label={t("settings.providers.customCli.fields.arguments")}
        trailing={addArgButton}
        testID="custom-cli-args-field"
      >
        {state.args.length > 0 ? (
          <View style={styles.listStack}>
            {state.args.map((arg, index) => (
              <ArgumentRow
                key={arg.id}
                entry={arg}
                index={index}
                resetKey={state.commandResetKey}
                compact={compact}
                disabled={isSaving}
                onChange={model.setArg}
                onConfirmEmpty={model.confirmArg}
                onRemove={model.removeArg}
              />
            ))}
          </View>
        ) : (
          <Text style={styles.emptyListHint}>
            {t("settings.providers.customCli.fields.noArguments")}
          </Text>
        )}
      </Field>

      <VerificationSection
        state={state}
        hasClient={hasClient}
        onLocate={onLocate}
        onTest={onTest}
      />

      <Field
        label={t("settings.providers.customCli.fields.apiKey")}
        hint={t("settings.providers.customCli.fields.apiKeyHint")}
        error={apiKeyError}
        testID="custom-cli-api-key-field"
      >
        <View style={styles.envPairRow}>
          <View style={styles.envKeyColumn}>
            <FormTextInput
              initialValue={state.apiKeyEnvName}
              resetKey={state.apiKeyNameResetKey}
              onChangeText={model.setApiKeyEnvName}
              editable={!isSaving}
              placeholder={t("settings.providers.customCli.fields.apiKeyNamePlaceholder")}
              autoCapitalize="none"
              autoCorrect={false}
              accessibilityLabel={t("settings.providers.customCli.fields.apiKeyNameLabel")}
              testID="custom-cli-api-key-name"
            />
          </View>
          <View style={styles.envValueColumn}>
            <FormTextInput
              initialValue=""
              onChangeText={model.setApiKeyValue}
              editable={!isSaving}
              placeholder={
                state.mode === "edit"
                  ? t("settings.providers.customCli.fields.secretKeepPlaceholder")
                  : t("settings.providers.customCli.fields.secretPlaceholder")
              }
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              accessibilityLabel={t("settings.providers.customCli.fields.apiKeyValueLabel")}
              testID="custom-cli-api-key-value"
            />
          </View>
        </View>
      </Field>

      <Field
        label={t("settings.providers.customCli.fields.env")}
        hint={t("settings.providers.customCli.fields.envHint")}
        error={envError}
        trailing={addEnvButton}
        testID="custom-cli-env-field"
      >
        {state.envEntries.length > 0 ? (
          <View style={styles.listStack}>
            {state.envEntries.map((entry, index) => (
              <EnvEntryRow
                key={entry.id}
                entry={entry}
                index={index}
                compact={compact}
                disabled={isSaving}
                onChangeKey={model.setEnvKey}
                onChangeValue={model.setEnvValue}
                onRemove={model.removeEnvEntry}
              />
            ))}
          </View>
        ) : null}
      </Field>

      {showSaveError ? (
        <OperationFeedbackAlert
          feedback={saveFeedback}
          testID="custom-cli-save-error"
          pathTestID="custom-cli-save-path"
        />
      ) : null}
    </View>
  );
}

function HostSummaryCard({ state }: { state: CustomProviderCliFormState }): ReactElement {
  const { t } = useTranslation();
  const shownHostPath = state.resolvedPath ?? (state.executable.trim() || null);
  return (
    <View style={styles.hostCard} testID="custom-cli-host-summary">
      <View style={styles.hostRow}>
        <Text style={styles.hostMetaLabel}>{t("settings.providers.customCli.hostLabel")}</Text>
        <Text style={styles.hostMetaValue} numberOfLines={1} testID="custom-cli-host">
          {state.hostLabel}
        </Text>
      </View>
      <View style={styles.hostRow}>
        <Text style={styles.hostMetaLabel}>
          {state.resolvedPath
            ? t("settings.providers.customCli.resolvedPathLabel")
            : t("settings.providers.customCli.commandPathLabel")}
        </Text>
        <Text
          style={shownHostPath ? styles.hostPathValue : styles.hostPathEmpty}
          numberOfLines={2}
          selectable={Boolean(shownHostPath)}
          dataSet={shownHostPath ? CODE_SURFACE_DATASET : undefined}
          testID="custom-cli-host-path"
        >
          {shownHostPath ?? t("settings.providers.customCli.pathNotSet")}
        </Text>
      </View>
    </View>
  );
}

function ExtendsField({
  model,
  state,
  error,
  disabled,
}: {
  model: CustomProviderCliFormModel;
  state: CustomProviderCliFormState;
  error: string | null;
  disabled: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const extendsOptions = useMemo<SelectFieldOption<string>[]>(
    () =>
      state.extendsOptions.map((option) => ({
        id: option.value,
        value: option.value,
        label: option.value === "acp" ? t("settings.providers.customCli.extendsAcp") : option.label,
        testID: `custom-cli-extends-option-${option.value}`,
      })),
    [state.extendsOptions, t],
  );
  const selectedExtendsDisplay = useMemo<SelectFieldDisplay | null>(() => {
    if (!state.selectedExtendsDisplay) return null;
    if (state.extendsProvider === "acp") {
      return { label: t("settings.providers.customCli.extendsAcp") };
    }
    return state.selectedExtendsDisplay;
  }, [state.extendsProvider, state.selectedExtendsDisplay, t]);

  const handleSelectExtends = useCallback(
    (value: string, display: SelectFieldDisplay) => {
      model.setExtends(value, display);
    },
    [model],
  );

  if (state.isExtendsLocked) {
    return (
      <Field label={t("settings.providers.customCli.fields.extends")}>
        <View style={styles.readonlyBox} testID="custom-cli-extends-readonly">
          <Text style={styles.readonlyText}>
            {selectedExtendsDisplay?.label ?? state.extendsProvider}
          </Text>
        </View>
      </Field>
    );
  }

  return (
    <SelectField
      label={t("settings.providers.customCli.fields.extends")}
      value={state.extendsProvider || null}
      selectedDisplay={selectedExtendsDisplay}
      options={extendsOptions}
      onChange={handleSelectExtends}
      placeholder={t("settings.providers.customCli.fields.extendsPlaceholder")}
      emptyText={t("settings.providers.customCli.fields.extendsEmpty")}
      error={error}
      disabled={disabled}
      searchable={false}
      title={t("settings.providers.customCli.fields.extends")}
      triggerTestID="custom-cli-extends-trigger"
    />
  );
}

function VerificationSection({
  state,
  hasClient,
  onLocate,
  onTest,
}: {
  state: CustomProviderCliFormState;
  hasClient: boolean;
  onLocate: () => void;
  onTest: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const isLocating = state.locateState.kind === "pending";
  const isTesting = state.testState.kind === "pending";
  const canLocate = hasClient && state.canLocate;
  const canTest = hasClient && state.canTest;
  const locateFeedback = resolveOperationFeedback("locate", state.locateState, state.hostLabel, t);
  const testFeedback = resolveOperationFeedback("test", state.testState, state.hostLabel, t);

  return (
    <View style={styles.verifySection} testID="custom-cli-verify-section">
      <View style={styles.verifyActions}>
        <Button
          style={styles.verifyButton}
          variant="outline"
          onPress={onLocate}
          disabled={!canLocate}
          loading={isLocating}
          testID="custom-cli-locate-button"
        >
          {isLocating
            ? t("settings.providers.customCli.actions.locating")
            : t("settings.providers.customCli.actions.locatePath")}
        </Button>
        <Button
          style={styles.verifyButton}
          variant="secondary"
          onPress={onTest}
          disabled={!canTest}
          loading={isTesting}
          testID="custom-cli-test-button"
        >
          {isTesting
            ? t("settings.providers.customCli.actions.testing")
            : t("settings.providers.customCli.actions.testLaunch")}
        </Button>
      </View>

      {locateFeedback ? (
        <OperationFeedbackAlert
          feedback={locateFeedback}
          testID="custom-cli-locate-result"
          pathTestID="custom-cli-locate-path"
        />
      ) : null}

      {testFeedback ? (
        <OperationFeedbackAlert
          feedback={testFeedback}
          testID="custom-cli-test-result"
          pathTestID="custom-cli-test-path"
        />
      ) : null}
    </View>
  );
}

function ArgumentRow({
  entry,
  index,
  resetKey,
  compact,
  disabled,
  onChange,
  onConfirmEmpty,
  onRemove,
}: {
  entry: CustomProviderCliArgEntry;
  index: number;
  resetKey: number;
  compact: boolean;
  disabled: boolean;
  onChange: (id: string, value: string) => void;
  onConfirmEmpty: (id: string) => void;
  onRemove: (id: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  const handleChange = useCallback(
    (text: string) => onChange(entry.id, text),
    [entry.id, onChange],
  );
  const handleConfirmEmpty = useCallback(
    () => onConfirmEmpty(entry.id),
    [entry.id, onConfirmEmpty],
  );
  const handleRemove = useCallback(() => onRemove(entry.id), [entry.id, onRemove]);

  return (
    <View style={styles.argRow}>
      <View style={styles.argInputWrapper}>
        <FormTextInput
          initialValue={entry.value}
          resetKey={resetKey}
          onChangeText={handleChange}
          editable={!disabled}
          placeholder={t("settings.providers.customCli.fields.argumentPlaceholder")}
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel={t("settings.providers.customCli.fields.argumentItemLabel", {
            index: index + 1,
          })}
          testID={`custom-cli-arg-${index}`}
        />
      </View>
      {!entry.confirmed ? (
        <Button
          variant="outline"
          size="sm"
          onPress={handleConfirmEmpty}
          disabled={disabled}
          testID={`custom-cli-arg-confirm-empty-${index}`}
        >
          {t("settings.providers.customCli.actions.keepEmptyArg")}
        </Button>
      ) : null}
      <ToolbarButton
        label={t("settings.providers.customCli.actions.removeArgument", { index: index + 1 })}
        onPress={handleRemove}
        disabled={disabled}
        compact={compact}
        testID={`custom-cli-arg-remove-${index}`}
      >
        <ThemedTrash
          size={paneContentToolbarIconSize(compact)}
          uniProps={destructiveColorMapping}
        />
      </ToolbarButton>
    </View>
  );
}

function EnvEntryRow({
  entry,
  index,
  compact,
  disabled,
  onChangeKey,
  onChangeValue,
  onRemove,
}: {
  entry: CustomProviderCliEnvEntry;
  index: number;
  compact: boolean;
  disabled: boolean;
  onChangeKey: (id: string, value: string) => void;
  onChangeValue: (id: string, value: string) => void;
  onRemove: (id: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  const handleChangeKey = useCallback(
    (text: string) => onChangeKey(entry.id, text),
    [entry.id, onChangeKey],
  );
  const handleChangeValue = useCallback(
    (text: string) => onChangeValue(entry.id, text),
    [entry.id, onChangeValue],
  );
  const handleRemove = useCallback(() => onRemove(entry.id), [entry.id, onRemove]);
  const secure = isSensitiveEnvKey(entry.key);

  return (
    <View style={styles.argRow}>
      <View style={styles.envKeyColumn}>
        <FormTextInput
          initialValue={entry.key}
          onChangeText={handleChangeKey}
          editable={!disabled}
          placeholder={t("settings.providers.customCli.fields.envKeyPlaceholder")}
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel={t("settings.providers.customCli.fields.envKeyLabel", {
            index: index + 1,
          })}
          testID={`custom-cli-env-key-${index}`}
        />
      </View>
      <View style={styles.envValueColumn}>
        <FormTextInput
          initialValue={entry.value}
          onChangeText={handleChangeValue}
          editable={!disabled}
          placeholder={t("settings.providers.customCli.fields.envValuePlaceholder")}
          secureTextEntry={secure}
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel={t("settings.providers.customCli.fields.envValueLabel", {
            index: index + 1,
          })}
          testID={`custom-cli-env-value-${index}`}
        />
      </View>
      <ToolbarButton
        label={t("settings.providers.customCli.actions.removeEnv", { index: index + 1 })}
        onPress={handleRemove}
        disabled={disabled}
        compact={compact}
        testID={`custom-cli-env-remove-${index}`}
      >
        <ThemedTrash
          size={paneContentToolbarIconSize(compact)}
          uniProps={destructiveColorMapping}
        />
      </ToolbarButton>
    </View>
  );
}

interface OperationFeedback {
  variant: AlertVariant;
  title: string;
  description: string;
  path?: string;
}

function OperationFeedbackAlert({
  feedback,
  testID,
  pathTestID,
}: {
  feedback: OperationFeedback;
  testID: string;
  pathTestID: string;
}): ReactElement {
  const description = useMemo(
    () => (
      <View style={styles.feedbackDescription}>
        <Text style={styles.feedbackText}>{feedback.description}</Text>
        {feedback.path ? (
          <Text
            style={styles.feedbackPath}
            selectable
            dataSet={CODE_SURFACE_DATASET}
            testID={pathTestID}
          >
            {feedback.path}
          </Text>
        ) : null}
      </View>
    ),
    [feedback.description, feedback.path, pathTestID],
  );

  return (
    <Alert
      variant={feedback.variant}
      size="sm"
      title={feedback.title}
      description={description}
      testID={testID}
    />
  );
}

type TranslateFn = ReturnType<typeof useTranslation>["t"];

function resolveSaveButtonLabel(
  isSaving: boolean,
  mode: CustomProviderCliFormState["mode"],
  t: TranslateFn,
): string {
  if (isSaving) return t("settings.providers.customCli.actions.saving");
  if (mode === "edit") return t("settings.providers.customCli.actions.saveChanges");
  return t("settings.providers.customCli.actions.addProvider");
}

function resolveExecutablePlaceholder(state: CustomProviderCliFormState, t: TranslateFn): string {
  if (state.isCommandRequired) {
    return t("settings.providers.customCli.fields.executableAcpPlaceholder");
  }
  if (state.mode === "edit") {
    return t("settings.providers.customCli.fields.executableKeepPlaceholder");
  }
  return t("settings.providers.customCli.fields.executableOptionalPlaceholder");
}

function resolveAlertVariant(status: CustomProviderCliStatus): AlertVariant {
  if (status === "ok") return "success";
  if (status === "unsupported") return "warning";
  return "error";
}

const VALIDATION_ERROR_KEYS = {
  providerIdRequired: "settings.providers.customCli.validation.providerIdRequired",
  providerIdInvalid: "settings.providers.customCli.validation.providerIdInvalid",
  providerIdConflict: "settings.providers.customCli.validation.providerIdConflict",
  extendsRequired: "settings.providers.customCli.validation.extendsRequired",
  extendsInvalid: "settings.providers.customCli.validation.extendsInvalid",
  labelRequired: "settings.providers.customCli.validation.labelRequired",
  commandRequiredForAcp: "settings.providers.customCli.validation.commandRequiredForAcp",
  executableRequiredWithArgs: "settings.providers.customCli.validation.executableRequiredWithArgs",
  apiKeyNameRequired: "settings.providers.customCli.validation.apiKeyNameRequired",
  invalidEnvKey: "settings.providers.customCli.validation.invalidEnvKey",
  envKeyRequired: "settings.providers.customCli.validation.envKeyRequired",
  envValueRequired: "settings.providers.customCli.validation.envValueRequired",
  duplicateEnvKey: "settings.providers.customCli.validation.duplicateEnvKey",
} as const satisfies Record<CustomProviderCliValidationErrorCode, string>;

const OPERATION_RESULT_KEYS = {
  locate: {
    ok: {
      title: "settings.providers.customCli.results.locate.okTitle",
      description: "settings.providers.customCli.results.locate.okDescription",
    },
    invalid: {
      title: "settings.providers.customCli.results.locate.invalidTitle",
      description: "settings.providers.customCli.results.locate.invalidDescription",
    },
    unavailable: {
      title: "settings.providers.customCli.results.locate.unavailableTitle",
      description: "settings.providers.customCli.results.locate.unavailableDescription",
    },
    unsupported: {
      title: "settings.providers.customCli.results.locate.unsupportedTitle",
      description: "settings.providers.customCli.results.locate.unsupportedDescription",
    },
    blocked: {
      title: "settings.providers.customCli.results.locate.blockedTitle",
      description: "settings.providers.customCli.results.locate.blockedDescription",
    },
    failed: {
      title: "settings.providers.customCli.results.locate.failedTitle",
      description: "settings.providers.customCli.results.locate.failedDescription",
    },
  },
  test: {
    ok: {
      title: "settings.providers.customCli.results.test.okTitle",
      description: "settings.providers.customCli.results.test.okDescription",
    },
    invalid: {
      title: "settings.providers.customCli.results.test.invalidTitle",
      description: "settings.providers.customCli.results.test.invalidDescription",
    },
    unavailable: {
      title: "settings.providers.customCli.results.test.unavailableTitle",
      description: "settings.providers.customCli.results.test.unavailableDescription",
    },
    unsupported: {
      title: "settings.providers.customCli.results.test.unsupportedTitle",
      description: "settings.providers.customCli.results.test.unsupportedDescription",
    },
    blocked: {
      title: "settings.providers.customCli.results.test.blockedTitle",
      description: "settings.providers.customCli.results.test.blockedDescription",
    },
    failed: {
      title: "settings.providers.customCli.results.test.failedTitle",
      description: "settings.providers.customCli.results.test.failedDescription",
    },
  },
  save: {
    ok: {
      title: "settings.providers.customCli.results.save.okTitle",
      description: "settings.providers.customCli.results.save.okDescription",
    },
    invalid: {
      title: "settings.providers.customCli.results.save.invalidTitle",
      description: "settings.providers.customCli.results.save.invalidDescription",
    },
    unavailable: {
      title: "settings.providers.customCli.results.save.unavailableTitle",
      description: "settings.providers.customCli.results.save.unavailableDescription",
    },
    unsupported: {
      title: "settings.providers.customCli.results.save.unsupportedTitle",
      description: "settings.providers.customCli.results.save.unsupportedDescription",
    },
    blocked: {
      title: "settings.providers.customCli.results.save.blockedTitle",
      description: "settings.providers.customCli.results.save.blockedDescription",
    },
    failed: {
      title: "settings.providers.customCli.results.save.failedTitle",
      description: "settings.providers.customCli.results.save.failedDescription",
    },
  },
} as const satisfies Record<
  "locate" | "test" | "save",
  Record<CustomProviderCliStatus, { title: string; description: string }>
>;

function resolveValidationErrorMessage(
  code: CustomProviderCliValidationErrorCode | null,
  includeRequired: boolean,
  duplicateKeyName: string | null,
  t: TranslateFn,
): string | null {
  if (!code) return null;
  if (
    !includeRequired &&
    (code === "providerIdRequired" ||
      code === "extendsRequired" ||
      code === "labelRequired" ||
      code === "commandRequiredForAcp")
  ) {
    return null;
  }
  if (code === "duplicateEnvKey") {
    return t(VALIDATION_ERROR_KEYS.duplicateEnvKey, {
      key: duplicateKeyName ?? "",
    });
  }
  return t(VALIDATION_ERROR_KEYS[code]);
}

function resolveOperationFeedback(
  operation: "locate" | "test" | "save",
  opState: CustomProviderCliOperationState,
  hostLabel: string,
  t: TranslateFn,
): OperationFeedback | null {
  if (opState.kind === "idle" || opState.kind === "pending") return null;
  if (opState.kind === "error") {
    return {
      variant: "error",
      title: t(OPERATION_RESULT_KEYS[operation].failed.title, { host: hostLabel }),
      description: opState.message,
    };
  }
  if (opState.kind === "null_result") {
    return {
      variant: "error",
      title: t("settings.providers.customCli.results.noResponseTitle"),
      description: t("settings.providers.customCli.results.noResponseDescription", {
        host: hostLabel,
      }),
    };
  }
  const status: CustomProviderCliStatus = opState.status;
  if (status === "blocked" && opState.reason === "reload_required") {
    return {
      variant: "error",
      title: t("settings.providers.customCli.results.reloadRequiredTitle"),
      description: t("settings.providers.customCli.results.reloadRequiredDescription", {
        host: hostLabel,
      }),
      path: opState.path,
    };
  }
  const variant = resolveAlertVariant(status);
  const keys = OPERATION_RESULT_KEYS[operation][status];
  return {
    variant,
    title: t(keys.title, { host: hostLabel }),
    description: t(keys.description, { host: hostLabel }),
    path: opState.path,
  };
}

const styles = StyleSheet.create((theme) => ({
  form: {
    gap: theme.spacing[4],
  },
  hostCard: {
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    gap: theme.spacing[2],
  },
  hostRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
  },
  hostMetaLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    flexShrink: 0,
  },
  hostMetaValue: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    flexShrink: 1,
    textAlign: "right",
  },
  hostPathValue: {
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
    flexShrink: 1,
    textAlign: "right",
  },
  hostPathEmpty: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    flexShrink: 1,
    textAlign: "right",
  },
  readonlyBox: {
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  readonlyText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  readonlyMonoText: {
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
  },
  listStack: {
    gap: theme.spacing[2],
  },
  emptyListHint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  argRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  argInputWrapper: {
    flex: 1,
    minWidth: 0,
  },
  envPairRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  envKeyColumn: {
    flex: 1,
    minWidth: 0,
  },
  envValueColumn: {
    flex: 1,
    minWidth: 0,
  },
  verifySection: {
    gap: theme.spacing[3],
  },
  verifyActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  verifyButton: {
    flexGrow: 1,
  },
  feedbackDescription: {
    gap: theme.spacing[1],
  },
  feedbackText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  feedbackPath: {
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
  },
  footer: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
  },
  footerButton: {
    flexShrink: 0,
  },
}));
