import { Crown } from "lucide-react-native";
import { useCallback, useMemo } from "react";
import { Text, View, type LayoutChangeEvent, type PressableStateCallbackType } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { toolbarContentSlot } from "@/components/ui/control-geometry";
import { PressHighlight } from "@/components/ui/press-highlight";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { isWeb } from "@/constants/platform";
import { ICON_SIZE } from "@/styles/theme";
import type { WorkspaceMainControlValue } from "@/composer/draft/workspace-main-preference";
import { useComposerControlLayout } from "./layout-context";
import { ComposerToolbarGlyph } from "./glyph";
import { ControlTooltipHint } from "./composer-control";

export function WorkspaceMainToolbarSlot({
  control,
  disabled,
  visible,
  onLayout,
}: {
  control: WorkspaceMainControlValue;
  disabled: boolean;
  visible: boolean;
  onLayout: (event: LayoutChangeEvent) => void;
}) {
  const { t } = useTranslation();
  const { glyphs } = useComposerControlLayout();
  const label = t("agentControls.workspaceMain.label");
  const { checked, onChange } = control;
  const locked = disabled || control.disabled || !visible;
  const selectedTone = checked ? styles.selectedText : styles.label;
  const tone = locked ? styles.muted : selectedTone;
  const accessibilityState = useMemo(() => ({ checked, disabled: locked }), [checked, locked]);
  const handlePress = useCallback(() => onChange(!checked), [checked, onChange]);
  const toolbarStyle = useCallback(
    ({ hovered }: PressableStateCallbackType) => [
      styles.toolbar,
      (checked || (hovered && !locked)) && styles.highlight,
    ],
    [checked, locked],
  );
  return (
    <View
      style={[styles.toolbarSlot, !visible && styles.measuring]}
      onLayout={onLayout}
      accessibilityElementsHidden={!visible}
      importantForAccessibility={visible ? "auto" : "no-hide-descendants"}
      aria-hidden={!visible}
    >
      <Tooltip enabledOnDesktop={visible}>
        <TooltipTrigger asChild>
          <View>
            <PressHighlight
              testID="composer-workspace-main"
              accessibilityRole="switch"
              accessibilityLabel={label}
              accessibilityHint={control.hint}
              accessibilityState={accessibilityState}
              aria-checked={checked}
              disabled={locked}
              onPress={handlePress}
              style={toolbarStyle}
              highlightStyle={styles.highlight}
            >
              <ComposerToolbarGlyph role="label">
                <Crown
                  size={glyphs.label.size}
                  strokeWidth={glyphs.label.strokeWidth}
                  color={tone.color}
                />
              </ComposerToolbarGlyph>
              <Text style={[styles.toolbarLabel, tone]} numberOfLines={1}>
                {label}
              </Text>
            </PressHighlight>
          </View>
        </TooltipTrigger>
        <TooltipContent>
          <ControlTooltipHint label={control.hint ?? label} />
        </TooltipContent>
      </Tooltip>
    </View>
  );
}

export function WorkspaceMainSheetControl({
  control,
  disabled,
}: {
  control: WorkspaceMainControlValue;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const label = t("agentControls.workspaceMain.label");
  const locked = disabled || control.disabled;
  return (
    <View style={styles.sheet}>
      <Crown
        size={ICON_SIZE.md}
        color={(control.checked && !locked ? styles.selectedText : styles.muted).color}
      />
      <View style={styles.sheetCopy}>
        <Text style={locked ? styles.muted : styles.selectedText}>{label}</Text>
        {control.hint ? <Text style={styles.hint}>{control.hint}</Text> : null}
      </View>
      <Switch
        testID="composer-workspace-main"
        accessibilityLabel={label}
        value={control.checked}
        disabled={locked}
        onValueChange={control.onChange}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  toolbarSlot: { flexShrink: 0 },
  toolbar: {
    ...toolbarContentSlot(),
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    borderRadius: theme.borderRadius.full,
  },
  measuring: {
    position: "absolute",
    left: 0,
    top: 0,
    opacity: 0,
    pointerEvents: "none",
    ...(isWeb ? { visibility: "hidden" as const } : {}),
  },
  toolbarLabel: { fontSize: theme.fontSize.sm },
  label: { color: theme.colors.foregroundMuted },
  muted: { color: theme.colors.foregroundExtraMuted },
  selectedText: { color: theme.colors.foreground },
  highlight: { backgroundColor: theme.colors.interactionHighlight },
  sheet: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
  },
  sheetCopy: { flex: 1, gap: theme.spacing[1] },
  hint: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));
