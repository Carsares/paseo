import { useMemo, type ReactNode } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { Switch } from "@/components/ui/switch";

export function TopicFields({
  compact,
  locked,
  topicText,
  direction,
  onTopicChange,
  onDirectionChange,
  hidden,
  onHiddenChange,
  preset,
  onPresetChange,
  supportsPreset,
  presetControls,
  questionOpen,
  canAskQuestion,
  onQuestionToggle,
  onDirect,
}: {
  compact: boolean;
  locked: boolean;
  topicText: string;
  direction: string;
  onTopicChange: (value: string) => void;
  onDirectionChange: (value: string) => void;
  hidden: boolean;
  onHiddenChange: (value: boolean) => void;
  preset: boolean;
  onPresetChange: (value: boolean) => void;
  supportsPreset: boolean;
  presetControls: ReactNode;
  questionOpen: boolean;
  canAskQuestion: boolean;
  onQuestionToggle: () => void;
  onDirect: () => void;
}) {
  const { t } = useTranslation();
  const size = compact ? "md" : "sm";
  const hideLabel = t("topicWorkbench.hide");
  const presetLabel = t("topicWorkbench.preset");
  const privacySwitch = useMemo(
    () => (
      <Switch
        accessibilityLabel={hideLabel}
        value={hidden}
        disabled={locked}
        onValueChange={onHiddenChange}
      />
    ),
    [hideLabel, hidden, locked, onHiddenChange],
  );
  const presetSwitch = useMemo(
    () => (
      <Switch
        accessibilityLabel={presetLabel}
        value={preset}
        disabled={locked}
        onValueChange={onPresetChange}
      />
    ),
    [presetLabel, preset, locked, onPresetChange],
  );
  const questionState = useMemo(
    () => ({ expanded: questionOpen, disabled: locked || !canAskQuestion }),
    [questionOpen, locked, canAskQuestion],
  );
  return (
    <View style={styles.fields}>
      <Field label={t("topicWorkbench.topic")}>
        <FormTextInput
          size={size}
          accessibilityLabel={t("topicWorkbench.topic")}
          editable={!locked}
          initialValue={topicText}
          onChangeText={onTopicChange}
          multiline
          style={styles.multiline}
          testID="new-topic-title"
        />
      </Field>
      <Field label={t("topicWorkbench.direction")}>
        <FormTextInput
          size={size}
          accessibilityLabel={t("topicWorkbench.direction")}
          editable={!locked}
          initialValue={direction}
          onChangeText={onDirectionChange}
          multiline
          style={styles.multiline}
          testID="new-topic-direction"
        />
      </Field>
      <Field label={hideLabel} hint={t("topicWorkbench.privacyHint")} trailing={privacySwitch}>
        {null}
      </Field>
      {supportsPreset ? (
        <Field label={presetLabel} trailing={presetSwitch}>
          {null}
        </Field>
      ) : null}
      {presetControls}
      <View style={styles.actions}>
        <Button
          variant="outline"
          size={size}
          disabled={questionState.disabled}
          accessibilityState={questionState}
          onPress={onQuestionToggle}
        >
          {t("topicWorkbench.question")}
        </Button>
        <Button variant="ghost" size={size} disabled={locked} onPress={onDirect}>
          {t("topicWorkbench.direct")}
        </Button>
      </View>
    </View>
  );
}

export function TopicCreationStatus({ message }: { message: string }) {
  return (
    <Text accessibilityLiveRegion="polite" style={styles.status}>
      {message}
    </Text>
  );
}

const styles = StyleSheet.create((theme) => ({
  fields: { gap: theme.spacing[3], paddingHorizontal: theme.spacing[4] },
  multiline: { minHeight: 48 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[2] },
  status: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));
