import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { AgentOptionControl, ProviderOptions } from "@getpaseo/protocol/agent-types";
import { RESIDENT_ROLE_SLUG_MAX_LENGTH } from "@getpaseo/protocol/agent-labels";
import { readSelectOption, readToggleOption } from "@/agent-controls/option-controls";
import type { AgentProfile } from "@getpaseo/protocol/messages";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { type ControlSize } from "@/components/ui/control-geometry";
import { ControlSizeProvider } from "@/components/ui/control-size";
import { Field, FormTextInput } from "@/components/ui/form-field";
import {
  SelectField,
  type SelectFieldDisplay,
  type SelectFieldOption,
} from "@/components/ui/select-field";
import { Switch } from "@/components/ui/switch";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useSessionStore } from "@/stores/session-store";
import { toErrorMessage } from "@/utils/error-messages";
import { AgentProfileAppearanceField } from "./agent-profile-appearance-field";
import {
  ROLE_PROMPT_MAX_LENGTH,
  type AgentProfileFormModel,
  type AgentProfileFormOption,
  type AgentProfileFormState,
  type AgentProfileSeed,
  type AgentProfileValue,
} from "../internal/profile-form-model";
import {
  useAgentProfileFormCatalog,
  useAgentProfileFormControls,
} from "../internal/use-profile-form-inputs";
import {
  useAgentProfileFormModel,
  useAgentProfileFormState,
} from "../internal/use-profile-form-model";

export interface AgentProfileEditModalProps {
  serverId: string;
  visible: boolean;
  mode: "create" | "edit";
  profile?: AgentProfile;
  seed?: AgentProfileSeed;
  onClose: () => void;
  onSave: (value: AgentProfileValue) => Promise<void>;
}

/**
 * Only reachable before the catalog lands. Every select is seeded to a concrete
 * id as soon as one exists, and none of them offer an "unset" row.
 */
const UNSET_VALUE = "";

function openKey(props: AgentProfileEditModalProps): string {
  if (props.mode === "edit") {
    return `edit:${props.profile?.id ?? ""}`;
  }
  return `create:${props.seed?.provider ?? ""}:${props.seed?.modelId ?? ""}`;
}

/**
 * Create and edit never share a mounted instance: the body is keyed on mode plus
 * profile id, so every open constructs a form model seeded from that record.
 */
export function AgentProfileEditModal(props: AgentProfileEditModalProps): ReactElement | null {
  const [renderedProps, setRenderedProps] = useState<AgentProfileEditModalProps | null>(() =>
    props.visible ? props : null,
  );
  const [sheetVisible, setSheetVisible] = useState(props.visible);
  const livePropsRef = useRef(props);
  const closeRequestedRef = useRef(false);
  livePropsRef.current = props;

  useEffect(() => {
    if (props.visible) {
      if (closeRequestedRef.current) {
        return;
      }
      setRenderedProps(props);
      setSheetVisible(true);
      return;
    }
    if (renderedProps) {
      setSheetVisible(false);
    }
  }, [props, renderedProps]);

  const requestClose = useCallback(() => {
    closeRequestedRef.current = true;
    setSheetVisible(false);
  }, []);

  const handleDismiss = useCallback(() => {
    const dismissedProps = livePropsRef.current;
    closeRequestedRef.current = false;
    setRenderedProps(null);
    setSheetVisible(false);
    if (dismissedProps.visible) {
      dismissedProps.onClose();
    }
  }, []);

  if (!renderedProps) {
    return null;
  }

  return (
    <OpenAgentProfileEditModal
      key={openKey(renderedProps)}
      {...renderedProps}
      visible={sheetVisible}
      onClose={requestClose}
      onDismiss={handleDismiss}
    />
  );
}

function toSelectOptions(options: AgentProfileFormOption[]): SelectFieldOption<string>[] {
  return options.map((option) => ({
    id: option.id,
    value: option.value,
    label: option.label,
    ...(option.description ? { description: option.description } : {}),
    testID: option.testID,
  }));
}

function OpenAgentProfileEditModal({
  serverId,
  visible,
  mode,
  profile,
  seed,
  onClose,
  onDismiss,
  onSave,
}: AgentProfileEditModalProps & { onDismiss: () => void }): ReactElement {
  const { t } = useTranslation();
  const controlSize: ControlSize = useIsCompactFormFactor() ? "md" : "sm";
  // COMPAT(agentResidentSpecialists): added in v0.18.0, remove gate after 2027-06-01.
  const supportsResidentRoles = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.agentResidentSpecialists === true,
  );
  const snapshot = useMemo(
    () => ({ mode, profile, seed, supportsResidentRoles }),
    [mode, profile, seed, supportsResidentRoles],
  );
  const model = useAgentProfileFormModel(snapshot);
  const state = useAgentProfileFormState(model);
  useAgentProfileFormCatalog({ serverId, model });
  useAgentProfileFormControls({ serverId, model, state });

  const sheetHeader = useMemo<SheetHeader>(
    () => ({
      title:
        mode === "edit"
          ? t("settings.host.agentProfiles.editProfileTitle")
          : t("settings.host.agentProfiles.addProfileTitle"),
    }),
    [mode, t],
  );

  const providerOptions = useMemo(
    () => toSelectOptions(state.providerOptions),
    [state.providerOptions],
  );
  const modelOptions = useMemo(() => toSelectOptions(state.modelOptions), [state.modelOptions]);
  const modeOptions = useMemo(() => toSelectOptions(state.modeOptions), [state.modeOptions]);
  const thinkingOptions = useMemo(
    () => toSelectOptions(state.thinkingOptions),
    [state.thinkingOptions],
  );

  const handleAppearanceChange = useCallback(
    (value: { icon: string; color: string }) => model.setAppearance(value),
    [model],
  );
  const handleProviderChange = useCallback(
    (value: string, display: SelectFieldDisplay) => model.setProvider(value, display),
    [model],
  );
  const handleModelChange = useCallback(
    (value: string, display: SelectFieldDisplay) => model.setModel(value, value ? display : null),
    [model],
  );
  const handleModeChange = useCallback(
    (value: string, display: SelectFieldDisplay) => model.setMode(value, value ? display : null),
    [model],
  );
  const handleThinkingChange = useCallback(
    (value: string, display: SelectFieldDisplay) =>
      model.setThinking(value, value ? display : null),
    [model],
  );

  const handleSave = useCallback(async () => {
    const value = model.getState().submitValue;
    if (!value) {
      return;
    }
    model.setSubmitError(null);
    model.setSubmitting(true);
    try {
      await onSave(value);
      onClose();
    } catch (error) {
      model.setSubmitError(toErrorMessage(error));
    } finally {
      model.setSubmitting(false);
    }
  }, [model, onClose, onSave]);

  const handleSavePress = useCallback(() => {
    void handleSave();
  }, [handleSave]);

  const handleCancel = useCallback(() => {
    if (state.isSubmitting) {
      return;
    }
    onClose();
  }, [onClose, state.isSubmitting]);

  return (
    <AdaptiveModalSheet
      visible={visible}
      header={sheetHeader}
      onClose={handleCancel}
      onDismiss={onDismiss}
      desktopMaxWidth={520}
      testID="agent-profile-edit-modal"
    >
      <View style={styles.body}>
        <View style={styles.nameRow}>
          <View style={styles.iconField}>
            <AgentProfileAppearanceField
              label={t("settings.host.agentProfiles.iconLabel")}
              icon={state.icon}
              color={state.color}
              onChange={handleAppearanceChange}
              disabled={state.isSubmitting}
              size={controlSize}
              testID="agent-profile-icon-field"
              triggerTestID="agent-profile-icon-trigger"
            />
          </View>
          <View style={styles.nameField}>
            <Field
              label={t("settings.host.agentProfiles.nameLabel")}
              testID="agent-profile-name-field"
            >
              <FormTextInput
                initialValue={seed?.name ?? profile?.name ?? ""}
                onChangeText={model.setName}
                placeholder={t("settings.host.agentProfiles.namePlaceholder")}
                autoCapitalize="none"
                autoCorrect={false}
                editable={!state.isSubmitting}
                size={controlSize}
                accessibilityLabel={t("settings.host.agentProfiles.nameLabel")}
                testID="agent-profile-name-input"
              />
            </Field>
          </View>
        </View>

        <SelectField
          label={t("settings.host.agentProfiles.providerLabel")}
          value={state.provider || null}
          selectedDisplay={state.providerDisplay}
          options={providerOptions}
          onChange={handleProviderChange}
          placeholder={t("settings.host.agentProfiles.providerPlaceholder")}
          emptyText={t("settings.host.agentProfiles.noProviders")}
          loading={state.catalogResolution !== "complete"}
          disabled={state.isSubmitting}
          searchable={providerOptions.length > 6}
          title={t("settings.host.agentProfiles.providerLabel")}
          size={controlSize}
          testID="agent-profile-provider-field"
          triggerTestID="agent-profile-provider-trigger"
        />

        {state.disclosure.showModelField ? (
          <SelectField
            label={t("settings.host.agentProfiles.modelLabel")}
            value={state.modelId || UNSET_VALUE}
            selectedDisplay={state.modelDisplay}
            options={modelOptions}
            onChange={handleModelChange}
            placeholder={t("settings.host.agentProfiles.modelLabel")}
            emptyText={t("settings.host.agentProfiles.noModels")}
            disabled={state.isSubmitting}
            searchable={modelOptions.length > 6}
            title={t("settings.host.agentProfiles.modelLabel")}
            size={controlSize}
            testID="agent-profile-model-field"
            triggerTestID="agent-profile-model-trigger"
          />
        ) : null}

        {state.disclosure.showModeField ? (
          <SelectField
            label={t("settings.host.agentProfiles.modeLabel")}
            value={state.modeId || UNSET_VALUE}
            selectedDisplay={state.modeDisplay}
            options={modeOptions}
            onChange={handleModeChange}
            placeholder={t("settings.host.agentProfiles.modeLabel")}
            emptyText={t("settings.host.agentProfiles.noModes")}
            disabled={state.isSubmitting}
            searchable={modeOptions.length > 6}
            title={t("settings.host.agentProfiles.modeLabel")}
            size={controlSize}
            testID="agent-profile-mode-field"
            triggerTestID="agent-profile-mode-trigger"
          />
        ) : null}

        {state.disclosure.showThinkingField ? (
          <SelectField
            label={t("settings.host.agentProfiles.thinkingLabel")}
            value={state.thinkingOptionId || UNSET_VALUE}
            selectedDisplay={state.thinkingDisplay}
            options={thinkingOptions}
            onChange={handleThinkingChange}
            placeholder={t("settings.host.agentProfiles.thinkingLabel")}
            emptyText={t("settings.host.agentProfiles.noThinkingOptions")}
            disabled={state.isSubmitting}
            searchable={thinkingOptions.length > 6}
            title={t("settings.host.agentProfiles.thinkingLabel")}
            size={controlSize}
            testID="agent-profile-thinking-field"
            triggerTestID="agent-profile-thinking-trigger"
          />
        ) : null}

        {state.disclosure.showControlsField ? (
          <Field
            label={t("settings.host.agentProfiles.featuresLabel")}
            testID="agent-profile-features-field"
          >
            <View style={styles.featureCard} testID="agent-profile-features-card">
              {state.controls.map((control, index) => (
                <AgentProfileControlRow
                  key={control.key}
                  control={control}
                  options={state.controlOptions}
                  isFirst={index === 0}
                  disabled={state.isSubmitting}
                  size={controlSize}
                  model={model}
                />
              ))}
            </View>
          </Field>
        ) : null}

        <Field
          label={t("settings.host.agentProfiles.notesLabel")}
          hint={t("settings.host.agentProfiles.notesHint")}
          testID="agent-profile-notes-field"
        >
          <FormTextInput
            initialValue={profile?.notes ?? ""}
            onChangeText={model.setNotes}
            placeholder={t("settings.host.agentProfiles.notesPlaceholder")}
            multiline
            numberOfLines={4}
            style={styles.notesInput}
            editable={!state.isSubmitting}
            size={controlSize}
            accessibilityLabel={t("settings.host.agentProfiles.notesLabel")}
            testID="agent-profile-notes-input"
          />
        </Field>

        {state.disclosure.showResidentRoleFields ? (
          <AgentProfileResidentRoleFields model={model} state={state} size={controlSize} />
        ) : null}

        {state.submitError ? (
          <Text style={styles.submitError} testID="agent-profile-submit-error">
            {state.submitError}
          </Text>
        ) : null}

        <View style={styles.actions}>
          <Button
            variant="secondary"
            style={styles.actionButton}
            onPress={handleCancel}
            disabled={state.isSubmitting}
            testID="agent-profile-cancel-button"
          >
            {t("common.actions.cancel")}
          </Button>
          <Button
            variant="default"
            style={styles.actionButton}
            onPress={handleSavePress}
            disabled={!state.canSubmit}
            testID="agent-profile-save-button"
          >
            {state.isSubmitting
              ? t("settings.host.agentProfiles.saving")
              : t("settings.host.agentProfiles.save")}
          </Button>
        </View>
      </View>
    </AdaptiveModalSheet>
  );
}

const residentToggleFields = [
  {
    field: "defaultResident",
    label: "settings.host.agentProfiles.residentRole.defaultResident",
  },
  {
    field: "residentUrgentReport",
    label: "settings.host.agentProfiles.residentRole.urgentReport",
  },
  {
    field: "residentKeepAlive",
    label: "settings.host.agentProfiles.residentRole.keepAlive",
  },
] as const;

function AgentProfileResidentRoleFields({
  model,
  state,
  size,
}: {
  model: AgentProfileFormModel;
  state: AgentProfileFormState;
  size: ControlSize;
}) {
  const { t } = useTranslation();
  const { residentRole, isSubmitting, roleSlugInvalid, rolePromptInvalid } = state;
  const slugLabel = t("settings.host.agentProfiles.residentRole.slug");
  const promptLabel = t("settings.host.agentProfiles.residentRole.prompt");
  const setRoleSlug = useCallback(
    (value: string) => model.setResidentRoleField("roleSlug", value),
    [model],
  );
  const setRolePrompt = useCallback(
    (value: string) => model.setResidentRoleField("rolePrompt", value),
    [model],
  );

  return (
    <>
      <Field
        label={slugLabel}
        hint={t("settings.host.agentProfiles.residentRole.slugHint", {
          max: RESIDENT_ROLE_SLUG_MAX_LENGTH,
        })}
        error={roleSlugInvalid ? t("settings.host.agentProfiles.residentRole.slugError") : null}
        testID="agent-profile-role-slug-field"
      >
        <FormTextInput
          initialValue={residentRole.roleSlug}
          onChangeText={setRoleSlug}
          autoCapitalize="none"
          autoCorrect={false}
          editable={!isSubmitting}
          size={size}
          accessibilityLabel={slugLabel}
          testID="agent-profile-role-slug-input"
        />
      </Field>
      <Field
        label={promptLabel}
        hint={t("settings.host.agentProfiles.residentRole.promptHint")}
        error={
          rolePromptInvalid
            ? t("settings.host.agentProfiles.residentRole.promptError", {
                max: ROLE_PROMPT_MAX_LENGTH,
              })
            : null
        }
        testID="agent-profile-role-prompt-field"
      >
        <FormTextInput
          initialValue={residentRole.rolePrompt}
          onChangeText={setRolePrompt}
          multiline
          numberOfLines={4}
          style={styles.notesInput}
          editable={!isSubmitting}
          size={size}
          accessibilityLabel={promptLabel}
          testID="agent-profile-role-prompt-input"
        />
      </Field>
      <Field
        label={t("settings.host.agentProfiles.residentRole.defaults")}
        testID="agent-profile-resident-defaults-field"
      >
        <ControlSizeProvider size={size}>
          <View style={styles.featureCard}>
            {residentToggleFields.map(({ field, label }, index) => (
              <ResidentToggleRow
                key={field}
                field={field}
                label={t(label)}
                value={residentRole[field] ?? false}
                isFirst={index === 0}
                disabled={isSubmitting}
                model={model}
              />
            ))}
          </View>
        </ControlSizeProvider>
      </Field>
    </>
  );
}

function ResidentToggleRow({
  field,
  label,
  value,
  isFirst,
  disabled,
  model,
}: {
  field: (typeof residentToggleFields)[number]["field"];
  label: string;
  value: boolean;
  isFirst: boolean;
  disabled: boolean;
  model: AgentProfileFormModel;
}) {
  const rowStyle = useMemo(
    () => [styles.featureRow, isFirst ? null : styles.featureRowBorder],
    [isFirst],
  );
  const handleToggle = useCallback(
    (next: boolean) => model.setResidentRoleField(field, next),
    [field, model],
  );
  return (
    <View style={rowStyle}>
      <View style={styles.featureMeta}>
        <Text style={styles.featureLabel}>{label}</Text>
      </View>
      <Switch
        value={value}
        onValueChange={handleToggle}
        disabled={disabled}
        accessibilityLabel={label}
        testID={`agent-profile-resident-switch-${field}`}
      />
    </View>
  );
}

function AgentProfileControlRow({
  control,
  options,
  isFirst,
  disabled,
  size,
  model,
}: {
  control: AgentOptionControl;
  options: ProviderOptions;
  isFirst: boolean;
  disabled: boolean;
  size: ControlSize;
  model: AgentProfileFormModel;
}): ReactElement {
  const rowStyle = useMemo(
    () => [styles.featureRow, isFirst ? null : styles.featureRowBorder],
    [isFirst],
  );
  const handleToggle = useCallback(
    (value: boolean) => model.setOption(control.key, value),
    [control.key, model],
  );
  const handleSelect = useCallback(
    (value: string) => model.setOption(control.key, value),
    [control.key, model],
  );
  const selectOptions = useMemo<SelectFieldOption<string>[]>(
    () =>
      control.type === "select"
        ? control.choices.map((choice) => ({
            id: choice.value,
            value: choice.value,
            label: choice.label,
            ...(choice.description ? { description: choice.description } : {}),
            testID: `agent-profile-feature-option-${control.key}-${choice.value}`,
          }))
        : [],
    [control],
  );
  const selectedValue = control.type === "select" ? readSelectOption(control, options) : null;
  const selectedDisplay = useMemo<SelectFieldDisplay | null>(() => {
    if (control.type !== "select" || !selectedValue) {
      return null;
    }
    const choice = control.choices.find((candidate) => candidate.value === selectedValue);
    return { label: choice?.label ?? selectedValue };
  }, [control, selectedValue]);

  if (control.type === "select") {
    return (
      <View style={rowStyle} testID={`agent-profile-feature-row-${control.key}`}>
        <SelectField
          label={control.label}
          value={selectedValue}
          selectedDisplay={selectedDisplay}
          options={selectOptions}
          onChange={handleSelect}
          placeholder={control.label}
          emptyText={control.label}
          disabled={disabled}
          {...(control.description ? { hint: control.description } : {})}
          title={control.label}
          size={size}
          testID={`agent-profile-feature-field-${control.key}`}
          triggerTestID={`agent-profile-feature-trigger-${control.key}`}
        />
      </View>
    );
  }

  return (
    <View style={rowStyle} testID={`agent-profile-feature-row-${control.key}`}>
      <View style={styles.featureMeta}>
        <Text style={styles.featureLabel} numberOfLines={1}>
          {control.label}
        </Text>
        {control.description ? (
          <Text style={styles.featureDescription} numberOfLines={2}>
            {control.description}
          </Text>
        ) : null}
      </View>
      <Switch
        value={readToggleOption(control, options)}
        onValueChange={handleToggle}
        disabled={disabled}
        accessibilityLabel={control.label}
        testID={`agent-profile-feature-switch-${control.key}`}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: {
    gap: theme.spacing[4],
    paddingBottom: theme.spacing[2],
  },
  nameRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[2],
  },
  // No width: the trigger is a glyph and a chevron, so it sizes to them.
  iconField: {
    flexShrink: 0,
  },
  nameField: {
    flex: 1,
  },
  featureCard: {
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    paddingHorizontal: theme.spacing[3],
  },
  featureRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
    paddingVertical: theme.spacing[3],
  },
  featureRowBorder: {
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  featureMeta: {
    flex: 1,
    gap: theme.spacing[1],
  },
  featureLabel: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  featureDescription: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  notesInput: {
    minHeight: 88,
    textAlignVertical: "top",
  },
  submitError: {
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.base,
  },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    marginTop: theme.spacing[2],
  },
  actionButton: {
    flex: 1,
  },
}));
