import { useCallback } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { SettingsCard, SettingsRow } from "@/components/settings";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { Alert, type AlertVariant } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { ControlSize } from "@/components/ui/control-geometry";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { useIsCompactFormFactor } from "@/constants/layout";
import type { ProxySettingsCopy } from "@/i18n/domains/settings";
import { useProxySettingsCopy } from "./copy";
import type { ProxyFormModel, ProxyFormReadyView } from "./form-model";
import {
  modesForTarget,
  slotsForLayout,
  type ProxySlot,
  type ProxySettingsAdapter,
  type ProxySnapshot,
  type ProxyTarget,
} from "./settings";
import { useProxyForm } from "./use-proxy-form";

export interface ProxySettingsFormProps {
  target: ProxyTarget;
  hostLabel?: string;
  adapter: ProxySettingsAdapter;
}

export function ProxySettingsForm(props: ProxySettingsFormProps) {
  const { target } = props;
  const key = target.kind === "host" ? `host:${target.hostId}` : "device";
  return <OpenProxySettingsForm key={key} {...props} />;
}

function OpenProxySettingsForm({ target, hostLabel, adapter }: ProxySettingsFormProps) {
  const copy = useProxySettingsCopy();
  const { state, model, reload, test, save } = useProxyForm(target, adapter);
  const size = useIsCompactFormFactor() ? "md" : "sm";
  const scope = target.kind === "host" ? hostLabel || target.hostId : copy.device;
  const traffic = target.kind === "host" ? copy.hostTraffic : copy.deviceTraffic;

  return (
    <SettingsSection title={copy.title} flush>
      <SettingsCard>
        <SettingsRow label={copy.scope} hint={traffic}>
          <Text style={styles.value}>{scope}</Text>
        </SettingsRow>
        <SettingsRow label={copy.control} />
      </SettingsCard>
      {state.status === "loading" ? (
        <Text accessibilityLiveRegion="polite" style={styles.value}>
          {copy.loading}
        </Text>
      ) : null}
      {state.status === "load-failed" ? (
        <LoadIssue issue={state.issue} reload={reload} copy={copy} />
      ) : null}
      {state.status === "ready" ? (
        <>
          {state.snapshot.suspended ? <Alert variant="info" title={copy.suspended} /> : null}
          <Summary snapshot={state.snapshot} copy={copy} />
          <OperationNotice activity={state.activity} reload={reload} copy={copy} />
          {state.snapshot.access === "edit" ? (
            <ReadyEditor
              target={target}
              size={size}
              state={state}
              model={model}
              onTest={test}
              onSave={save}
              copy={copy}
            />
          ) : (
            <Text style={styles.value}>{copy.readOnly}</Text>
          )}
        </>
      ) : null}
    </SettingsSection>
  );
}

function LoadIssue({
  issue,
  reload,
  copy,
}: {
  issue: "denied" | "unavailable" | "failed";
  reload: () => Promise<void>;
  copy: ProxySettingsCopy;
}) {
  const title = {
    denied: copy.loadDenied,
    unavailable: copy.unavailable,
    failed: copy.loadFailed,
  }[issue];
  return (
    <Alert variant="error" title={title}>
      <Button variant="outline" onPress={reload}>
        {copy.retry}
      </Button>
    </Alert>
  );
}

function Summary({ snapshot, copy }: { snapshot: ProxySnapshot; copy: ProxySettingsCopy }) {
  const { settings } = snapshot;
  const parts: string[] = [copy.modes[settings.mode]];
  if (settings.mode === "manual") {
    parts.push(copy.layouts[settings.endpoints.kind], copy.summaryBypass(settings.bypass.length));
  }
  const credentialSummary =
    snapshot.credentialSlots.length > 0 ? copy.credentialPresent : copy.credentialAbsent;
  return (
    <SettingsCard>
      <SettingsRow label={copy.summary}>
        <Text style={styles.value}>{parts.join(" · ")}</Text>
      </SettingsRow>
      <SettingsRow label={copy.credentials}>
        <Text style={styles.value}>{credentialSummary}</Text>
      </SettingsRow>
    </SettingsCard>
  );
}

interface Notice {
  variant: AlertVariant;
  title: string;
}

function noticeFor(
  activity: ProxyFormReadyView["activity"],
  copy: ProxySettingsCopy,
): Notice | null {
  switch (activity.status) {
    case "idle":
      return null;
    case "testing":
      return { variant: "info", title: copy.testing };
    case "saving":
      return { variant: "info", title: copy.saving };
    case "tested":
      return { variant: "success", title: copy.tested };
    case "saved":
      return { variant: "success", title: copy.saved };
    case "retest-required":
      return { variant: "warning", title: copy.retestRequired };
    case "revision-conflict":
      return { variant: "warning", title: copy.revisionConflict };
    case "test-failed":
    case "save-failed": {
      if (activity.issue === "denied") return { variant: "error", title: copy.denied };
      if (activity.issue === "unavailable") return { variant: "error", title: copy.unavailable };
      const title = activity.status === "test-failed" ? copy.testFailed : copy.saveFailed;
      return { variant: "error", title };
    }
  }
}

interface OperationNoticeProps {
  activity: ProxyFormReadyView["activity"];
  reload: () => Promise<void>;
  copy: ProxySettingsCopy;
}

function OperationNotice({ activity, reload, copy }: OperationNoticeProps) {
  const notice = noticeFor(activity, copy);
  if (!notice) return null;
  return (
    <View accessibilityLiveRegion="polite">
      <Alert {...notice}>
        {activity.status === "revision-conflict" ? (
          <Button variant="outline" onPress={reload}>
            {copy.reload}
          </Button>
        ) : null}
      </Alert>
    </View>
  );
}

interface EditorFields {
  size: ControlSize;
  state: ProxyFormReadyView;
  model: ProxyFormModel;
  disabled: boolean;
  copy: ProxySettingsCopy;
}

type RouteField = "url" | "httpUrl" | "httpsUrl" | "bypass";

function RouteInput({
  size,
  state,
  model,
  disabled,
  copy,
  field,
  label,
}: EditorFields & { field: RouteField; label: string }) {
  const onChangeText = useCallback((value: string) => model.setText(field, value), [field, model]);
  const errorText = field === "bypass" ? copy.invalidBypass : copy.invalidUrl;
  return (
    <Field label={label} error={state.errors[field] ? errorText : null}>
      <FormTextInput
        size={size}
        accessibilityLabel={label}
        editable={!disabled}
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="off"
        placeholder={field === "bypass" ? copy.bypassExample : "http://proxy.example:8080"}
        initialValue={state.draft[field]}
        resetKey={state.resetKey}
        onChangeText={onChangeText}
      />
    </Field>
  );
}

function ManualFields({
  targetKind,
  ...props
}: EditorFields & { targetKind: ProxyTarget["kind"] }) {
  const { state, size, model, disabled, copy } = props;
  const { layout } = state.draft;
  const splitUrls = copy.splitUrls[targetKind];
  return (
    <>
      <Field label={copy.layout}>
        <SegmentedControl
          size={size}
          options={[
            { value: "unified", label: copy.layouts.unified, disabled },
            { value: "split", label: copy.layouts.split, disabled },
          ]}
          value={layout}
          onValueChange={model.setLayout}
        />
      </Field>
      {layout === "unified" ? (
        <RouteInput key="unified" {...props} field="url" label={copy.url} />
      ) : (
        <>
          <RouteInput {...props} field="httpUrl" label={splitUrls.httpUrl} />
          <RouteInput {...props} field="httpsUrl" label={splitUrls.httpsUrl} />
        </>
      )}
      {state.snapshot.supportsBypass ? (
        <RouteInput {...props} field="bypass" label={copy.bypass} />
      ) : null}
    </>
  );
}

interface CredentialFieldsProps extends EditorFields {
  slot: ProxySlot;
}

function CredentialFields(props: CredentialFieldsProps) {
  const { size, state, model, disabled, copy, slot } = props;
  const { draft, snapshot, credentialErrors } = state;
  const stored = snapshot.credentialSlots.includes(slot);
  const action = draft.credentialActions[slot];
  const setAction = useCallback(
    (value: typeof action) => model.setCredentialAction(slot, value),
    [model, slot],
  );
  const actions: Array<typeof action> = ["keep"];
  if (snapshot.supportsCredentialReplacement !== false) actions.push("replace");
  if (stored) actions.push("clear");
  const options = actions.map((value) => ({
    value,
    label: copy.credentialActions[value],
    disabled,
  }));
  const errors = credentialErrors[slot];
  const label = copy.credentialFields[slot];
  return (
    <>
      <Field label={label} error={errors?.action ? copy.readdress : null}>
        <SegmentedControl size={size} value={action} options={options} onValueChange={setAction} />
      </Field>
      {action === "replace" ? (
        <ReplacementInputs key={state.credentialResetKey} {...props} />
      ) : null}
    </>
  );
}

function ReplacementInputs({ size, state, model, disabled, copy, slot }: CredentialFieldsProps) {
  const errors = state.credentialErrors[slot];
  const username = copy.username[slot];
  const password = copy.password[slot];
  const setUsername = useCallback(
    (text: string) => model.setSecret(slot, "username", text),
    [model, slot],
  );
  const setPassword = useCallback(
    (text: string) => model.setSecret(slot, "password", text),
    [model, slot],
  );
  let usernameError = null;
  if (errors?.username) usernameError = copy.invalidUsername;
  else if (errors?.required) usernameError = copy.credentialRequired;
  return (
    <>
      <Field label={username} error={usernameError}>
        <FormTextInput
          size={size}
          accessibilityLabel={username}
          editable={!disabled}
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="off"
          textContentType="none"
          onChangeText={setUsername}
        />
      </Field>
      <Field label={password} error={errors?.password ? copy.invalidPassword : null}>
        <FormTextInput
          size={size}
          accessibilityLabel={password}
          editable={!disabled}
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="off"
          textContentType="none"
          secureTextEntry
          onChangeText={setPassword}
        />
      </Field>
    </>
  );
}

interface ReadyEditorProps extends Omit<EditorFields, "disabled"> {
  target: ProxyTarget;
  onTest: () => void;
  onSave: () => Promise<void>;
}

function ReadyEditor({ target, size, state, model, onTest, onSave, copy }: ReadyEditorProps) {
  const { draft } = state;
  const disabled =
    state.activity.status === "saving" || state.activity.status === "revision-conflict";
  const fields = { size, state, model, disabled, copy };
  const slots = draft.mode === "manual" ? slotsForLayout(draft.layout) : [];
  const removesCredentials = state.snapshot.credentialSlots.some((slot) => !slots.includes(slot));
  const modeOptions = modesForTarget(target).map((value) => ({
    value,
    disabled,
    label: copy.modes[value],
  }));
  return (
    <View style={styles.editor}>
      <Field label={copy.mode}>
        <SegmentedControl
          size={size}
          value={draft.mode}
          options={modeOptions}
          onValueChange={model.setMode}
        />
      </Field>
      {draft.mode === "manual" ? <ManualFields {...fields} targetKind={target.kind} /> : null}
      {slots.length > 0 && state.snapshot.supportsCredentialReplacement === false ? (
        <Text style={styles.value}>{copy.credentialSecureConnection}</Text>
      ) : null}
      {slots.map((slot) => (
        <CredentialFields key={slot} {...fields} slot={slot} />
      ))}
      {removesCredentials ? <Text style={styles.value}>{copy.removesCredentials}</Text> : null}
      <View style={styles.actions}>
        <Button variant="outline" disabled={!state.canTest} onPress={onTest}>
          {copy.test}
        </Button>
        <Button disabled={!state.canSave} onPress={onSave}>
          {copy.save}
        </Button>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  value: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  editor: { gap: theme.spacing[3] },
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
}));
