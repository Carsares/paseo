import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  Keyboard,
  ScrollView,
  Text,
  View,
  type LayoutChangeEvent,
  type PressableStateCallbackType,
} from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { AgentProvider } from "@getpaseo/protocol/agent-types";
import type { AgentProfilePicker, AgentProfileSeed } from "@/agent-profiles";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import type { ContextBridge } from "@/components/ui/isolated-bottom-sheet-modal";
import { ComboboxTrigger } from "@/components/ui/combobox-trigger";
import { Button } from "@/components/ui/button";
import { TailEllipsisText } from "@/components/ui/tail-ellipsis-text";
import { useProviderIcon } from "@/components/provider-icons";
import { ModelBrowser, useModelBrowser } from "@/components/model-browser";
import { resolveModelBrowserScrolling } from "@/components/model-browser-view";
import { AgentControlTrigger } from "@/composer/agent-controls/control";
import { ComposerToolbarGlyph } from "@/composer/agent-controls/glyph";
import { resolveModelTriggerLabels } from "@/composer/agent-controls/layout";
import {
  findWorkspaceBatchModel,
  MAX_WORKSPACE_BATCH_MODELS,
  resolveModelSheetOpening,
  toggleWorkspaceBatchModel,
  type WorkspaceBatchModelPicker,
} from "@/composer/agent-controls/model-sheet-flow";
import type { ProviderSelectorProvider } from "@/provider-selection/provider-selection";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative, isWeb } from "@/constants/platform";
import { readMeasuredWidth } from "@/hooks/use-container-width";
import {
  toolbarContentSlot,
  toolbarSlot,
  type ToolbarGlyphs,
} from "@/components/ui/control-geometry";
import { getAgentControlHintKey, shortModelLabel } from "./utils";
import { useShortcutKeys } from "@/hooks/use-shortcut-keys";
import { useKeyboardToggle } from "@/hooks/use-keyboard-toggle";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ControlTooltipHint } from "./composer-control";
import { useModelPickerShortcut } from "./control-items";

const SNAP_POINTS = ["80%", "90%"];
const MODEL_LIST_TOP_INSET = 4;
const MODEL_ROW_STRIDE = 44;
const MODEL_VIEWPORT_VISIBLE_ROWS = 4.5;
const FIXED_MODEL_VIEWPORT_HEIGHT =
  MODEL_LIST_TOP_INSET + MODEL_ROW_STRIDE * MODEL_VIEWPORT_VISIBLE_ROWS;

interface CompactModelSheetProps {
  providers: ProviderSelectorProvider[];
  selectedProvider: string;
  selectedModel: string;
  thinkingLabel: string | null;
  effortKeys: ReturnType<typeof useShortcutKeys>;
  onSelect: (provider: string, modelId: string) => void;
  isLoading: boolean;
  profiles?: AgentProfilePicker | null;
  onApplyProfile?: (profileId: string) => void;
  onEditProfiles?: () => void;
  onCreateProfile?: (seed: AgentProfileSeed) => void;
  onEditProfile?: (profileId: string) => void;
  onOpen?: () => void;
  onClose?: () => void;
  onRetryProvider?: (provider: AgentProvider) => void;
  isRetryingProvider?: boolean;
  disabled?: boolean;
  serverId?: string | null;
  glyphs: ToolbarGlyphs;
  /** False when the toolbar is too narrow for labels: the trigger shows the provider glyph only. */
  showLabels: boolean;
  canSwitchProvider: boolean;
  batchModels?: WorkspaceBatchModelPicker;
  /** Carries the composer's contexts into the sheets, which draw away from it. */
  contextBridge?: ContextBridge | null;
  children?: ReactNode;
}

function resolveModelSheetProfileActions(
  onCreateProfile: ((seed: AgentProfileSeed) => void) | undefined,
  onEditProfile: ((profileId: string) => void) | undefined,
  close: () => void,
): {
  create?: (seed: AgentProfileSeed) => void;
  edit?: (profileId: string) => void;
} {
  return {
    create: onCreateProfile
      ? (seed: AgentProfileSeed) => {
          close();
          onCreateProfile(seed);
        }
      : undefined,
    edit: onEditProfile
      ? (profileId: string) => {
          close();
          onEditProfile(profileId);
        }
      : undefined,
  };
}

/**
 * Measures the folded model control and decides which labels it shows; see
 * `resolveModelTriggerLabels`. The full width is keyed by what was measured, so a new label is
 * `measuring` until its own width is known instead of reusing the previous label's.
 */
function useModelTriggerLabels(input: {
  modelLabel: string;
  thinkingLabel: string | null;
  glyphSize: number;
}) {
  const { modelLabel, thinkingLabel, glyphSize } = input;
  const measuredKey = `${glyphSize}\n${modelLabel}\n${thinkingLabel ?? ""}`;
  const [availableWidth, setAvailableWidth] = useState<number | undefined>(undefined);
  const [fullWidth, setFullWidth] = useState<{ key: string; width: number } | null>(null);

  const onFrameLayout = useCallback((event: LayoutChangeEvent) => {
    const width = readMeasuredWidth(event);
    if (width !== null) setAvailableWidth(width);
  }, []);
  const onFullLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const width = readMeasuredWidth(event);
      if (width !== null) setFullWidth({ key: measuredKey, width });
    },
    [measuredKey],
  );

  const labels = resolveModelTriggerLabels({
    hasThinking: thinkingLabel !== null,
    measurements: {
      availableWidth,
      fullWidth: fullWidth?.key === measuredKey ? fullWidth.width : undefined,
    },
  });
  return { labels, measuredKey, onFrameLayout, onFullLayout };
}

function useModelSheetBatch({
  batchModels,
  isOpen,
  availableProviders,
  selectedProvider,
  selectedModel,
}: Pick<CompactModelSheetProps, "batchModels" | "selectedProvider" | "selectedModel"> & {
  isOpen: boolean;
  availableProviders: ProviderSelectorProvider[];
}) {
  const [isSelectingBatch, setIsSelectingBatch] = useState(false);
  const shiftActivate = useRef(false);
  useEffect(() => {
    if (!isWeb || !isOpen || !batchModels) return;
    // ModelBrowser shares its activation callback with other consumers. Keep the
    // pointer modifier local to this open picker so ordinary selection is unchanged.
    const capture = (event: PointerEvent | KeyboardEvent) => {
      shiftActivate.current = event.shiftKey;
    };
    window.addEventListener("pointerdown", capture, true);
    window.addEventListener("pointerup", capture, true);
    window.addEventListener("keydown", capture, true);
    return () => {
      shiftActivate.current = false;
      window.removeEventListener("pointerdown", capture, true);
      window.removeEventListener("pointerup", capture, true);
      window.removeEventListener("keydown", capture, true);
    };
  }, [batchModels, isOpen]);
  const selectBatchModel = useCallback(
    (provider: string, modelId: string) => {
      if (!batchModels || (!isSelectingBatch && !shiftActivate.current)) return false;
      if (batchModels.disabledReason) return true;
      const model = findWorkspaceBatchModel(availableProviders, provider, modelId);
      if (!model) return true;
      const current = findWorkspaceBatchModel(availableProviders, selectedProvider, selectedModel);
      const models =
        !isSelectingBatch && batchModels.models.length === 0 && current
          ? [current]
          : batchModels.models;
      const next = toggleWorkspaceBatchModel({ models, model });
      setIsSelectingBatch(true);
      if (next) batchModels.onChange(next);
      return true;
    },
    [availableProviders, batchModels, isSelectingBatch, selectedModel, selectedProvider],
  );
  return { isSelectingBatch, setIsSelectingBatch, selectBatchModel };
}

function SelectedBatchModel({
  picker,
  model,
}: {
  picker: WorkspaceBatchModelPicker;
  model: WorkspaceBatchModelPicker["models"][number];
}) {
  const { t } = useTranslation();
  const remove = useCallback(() => {
    picker.onChange(
      picker.models.filter(
        (entry) => entry.provider !== model.provider || entry.modelId !== model.modelId,
      ),
    );
  }, [model.modelId, model.provider, picker]);
  return (
    <Button
      variant="ghost"
      onPress={remove}
      accessibilityLabel={t("newWorkspace.batch.removeModel", {
        model: model.modelLabel,
        provider: model.providerLabel,
      })}
    >
      {model.modelLabel}
    </Button>
  );
}

function ModelSheetBatchControls({
  picker,
  selecting,
  onStart,
  onCancel,
  onClose,
  countLabel,
}: {
  picker: WorkspaceBatchModelPicker;
  selecting: boolean;
  onStart: () => void;
  onCancel: () => void;
  onClose: () => void;
  countLabel: string;
}) {
  const { t } = useTranslation();
  const count = picker.models.length;
  const reason =
    picker.disabledReason ??
    (count >= MAX_WORKSPACE_BATCH_MODELS ? t("newWorkspace.batch.limit") : undefined);
  return (
    <View style={styles.batchControls}>
      <View style={styles.batchActions}>
        {selecting ? (
          <>
            <Text accessibilityLiveRegion="polite" style={styles.triggerText}>
              {countLabel}
            </Text>
            <Button variant="ghost" onPress={onCancel} testID="workspace-batch-cancel">
              {t("common.actions.cancel")}
            </Button>
            <Button
              variant="secondary"
              onPress={onClose}
              disabled={count === 0 || Boolean(picker.disabledReason)}
              testID="workspace-batch-done"
            >
              {t("newWorkspace.batch.keepModels")}
            </Button>
          </>
        ) : (
          <Button
            variant="secondary"
            onPress={onStart}
            disabled={Boolean(picker.disabledReason)}
            accessibilityHint={picker.disabledReason}
            testID="workspace-batch-select"
          >
            {t("newWorkspace.batch.selectModels")}
          </Button>
        )}
      </View>
      {reason ? <Text style={[styles.triggerText, styles.batchReason]}>{reason}</Text> : null}
      {selecting && count > 0 ? (
        <View style={styles.batchActions}>
          {picker.models.map((model) => (
            <SelectedBatchModel
              key={JSON.stringify([model.provider, model.modelId])}
              picker={picker}
              model={model}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

function useModelSheetTriggerLabels(
  batchModels: WorkspaceBatchModelPicker | undefined,
  browser: ReturnType<typeof useModelBrowser>,
) {
  const { t } = useTranslation();
  const count = batchModels?.models.length ?? 0;
  const batchCountLabel = t("newWorkspace.batch.count", { count, max: MAX_WORKSPACE_BATCH_MODELS });
  if (count > 0) {
    return {
      hasBatch: true,
      batchCountLabel,
      modelLabel: batchCountLabel,
      accessibilityLabel: batchCountLabel,
    };
  }
  return {
    hasBatch: false,
    batchCountLabel,
    modelLabel: shortModelLabel(browser.triggerLabel),
    accessibilityLabel: t("modelSelector.selectedModel", { model: browser.selectedModelLabel }),
  };
}

export function CompactModelSheet({
  providers,
  selectedProvider,
  selectedModel,
  thinkingLabel,
  effortKeys,
  onSelect,
  isLoading,
  profiles = null,
  onApplyProfile,
  onEditProfiles,
  onCreateProfile,
  onEditProfile,
  onOpen,
  onClose,
  onRetryProvider,
  isRetryingProvider = false,
  disabled = false,
  serverId = null,
  glyphs,
  showLabels,
  canSwitchProvider,
  batchModels,
  contextBridge = null,
  children,
}: CompactModelSheetProps) {
  const { t } = useTranslation();
  const usesBottomSheet = useIsCompactFormFactor();
  const autoFocusSearch = isWeb && !usesBottomSheet;
  const modelBrowserScrolling = resolveModelBrowserScrolling({
    isNative,
    isCompact: usesBottomSheet,
  });
  const [isOpen, setIsOpen] = useState(false);
  const [isModelBrowserOpen, setIsModelBrowserOpen] = useState(false);
  const availableProviders = useMemo(() => {
    if (canSwitchProvider) return providers;
    const fixedProvider =
      providers.find((entry) => entry.id === selectedProvider) ?? providers[0] ?? null;
    return fixedProvider ? [fixedProvider] : [];
  }, [canSwitchProvider, providers, selectedProvider]);
  const rootBrowser = useModelBrowser({
    providers: availableProviders,
    selectedProvider,
    selectedModel,
    isLoading,
    autoFocusSearch,
    profiles,
    serverId,
  });
  const modelBrowser = useModelBrowser({
    providers: availableProviders,
    selectedProvider,
    selectedModel,
    isLoading,
    autoFocusSearch,
    profiles,
    serverId,
  });
  const ModelIcon = useProviderIcon(selectedProvider, serverId);
  const hasSelectedProvider = selectedProvider.trim().length > 0;
  const trigger = useModelSheetTriggerLabels(batchModels, rootBrowser);
  const { isSelectingBatch, setIsSelectingBatch, selectBatchModel } = useModelSheetBatch({
    batchModels,
    isOpen,
    availableProviders,
    selectedProvider,
    selectedModel,
  });
  const rootHeader = useMemo(
    () => ({
      ...rootBrowser.header,
      title: t("modelSelector.selectModel"),
      search:
        rootBrowser.header.search && !canSwitchProvider
          ? {
              ...rootBrowser.header.search,
              placeholder: t("modelSelector.searchPlaceholder"),
            }
          : rootBrowser.header.search,
    }),
    [canSwitchProvider, rootBrowser.header, t],
  );

  const open = useCallback(() => {
    Keyboard.dismiss();
    rootBrowser.showAll();
    setIsSelectingBatch(trigger.hasBatch);
    setIsOpen(true);
    onOpen?.();
  }, [onOpen, rootBrowser, setIsSelectingBatch, trigger.hasBatch]);

  const close = useCallback(() => {
    const onlyModel = batchModels?.models.length === 1 ? batchModels.models[0] : undefined;
    if (onlyModel && !batchModels?.disabledReason) {
      onSelect(onlyModel.provider, onlyModel.modelId);
      batchModels?.onChange([]);
    }
    setIsModelBrowserOpen(false);
    setIsOpen(false);
    rootBrowser.reset();
    modelBrowser.reset();
    onClose?.();
  }, [batchModels, modelBrowser, onClose, onSelect, rootBrowser]);

  const handleSearchSelect = useCallback(
    (provider: string, modelId: string) => {
      if (selectBatchModel(provider, modelId)) return;
      onSelect(provider, modelId);
      Keyboard.dismiss();
      rootBrowser.showAll();
    },
    [onSelect, rootBrowser, selectBatchModel],
  );

  const openModelBrowser = useCallback(() => {
    Keyboard.dismiss();
    const destination = resolveModelSheetOpening({
      canSwitchProvider,
      providers: availableProviders,
      selectedProvider,
    });
    if (destination.kind === "all") {
      modelBrowser.showAll();
    } else {
      modelBrowser.drillDown(destination.providerId, destination.providerLabel);
    }
    setIsModelBrowserOpen(true);
  }, [availableProviders, canSwitchProvider, modelBrowser, selectedProvider]);

  const closeModelBrowser = useCallback(() => {
    setIsModelBrowserOpen(false);
    modelBrowser.reset();
  }, [modelBrowser]);

  const handleBrowserSelect = useCallback(
    (provider: string, modelId: string) => {
      if (selectBatchModel(provider, modelId)) return;
      onSelect(provider, modelId);
      closeModelBrowser();
    },
    [closeModelBrowser, onSelect, selectBatchModel],
  );

  const handleDesktopSelect = useCallback(
    (provider: string, modelId: string) => {
      if (selectBatchModel(provider, modelId)) return;
      onSelect(provider, modelId);
      close();
    },
    [close, onSelect, selectBatchModel],
  );

  const handleApplyProfile = useCallback(
    (profileId: string) => {
      onApplyProfile?.(profileId);
      close();
    },
    [close, onApplyProfile],
  );

  const handleEditProfiles = useCallback(() => {
    close();
    onEditProfiles?.();
  }, [close, onEditProfiles]);

  const profileActions = resolveModelSheetProfileActions(onCreateProfile, onEditProfile, close);
  const startBatchSelection = useCallback(() => {
    setIsSelectingBatch(true);
    if (usesBottomSheet && !isModelBrowserOpen) openModelBrowser();
  }, [isModelBrowserOpen, openModelBrowser, setIsSelectingBatch, usesBottomSheet]);
  const cancelBatchSelection = useCallback(() => {
    batchModels?.onChange([]);
    setIsSelectingBatch(false);
  }, [batchModels, setIsSelectingBatch]);
  const batchControls = useMemo(
    () =>
      batchModels ? (
        <ModelSheetBatchControls
          picker={batchModels}
          selecting={isSelectingBatch}
          onStart={startBatchSelection}
          onCancel={cancelBatchSelection}
          onClose={close}
          countLabel={trigger.batchCountLabel}
        />
      ) : null,
    [
      trigger.batchCountLabel,
      batchModels,
      cancelBatchSelection,
      close,
      isSelectingBatch,
      startBatchSelection,
    ],
  );

  const toggle = useCallback(() => {
    if (isOpen) {
      close();
      return;
    }
    open();
  }, [close, isOpen, open]);

  const mobileRootContent = useMemo(
    () => (
      <View style={styles.mobileRootContent} testID="agent-controls-settings-list">
        <View style={styles.controlsContent}>
          <AgentControlTrigger
            icon={ModelIcon}
            surface="sheet"
            label={t("modelSelector.model")}
            value={rootBrowser.selectedModelLabel}
            disabled={disabled}
            onPress={openModelBrowser}
            accessibilityLabel={t("modelSelector.selectedModel", {
              model: rootBrowser.selectedModelLabel,
            })}
            testID="agent-controls-model"
          />
          {children}
        </View>
      </View>
    ),
    [ModelIcon, children, disabled, openModelBrowser, rootBrowser.selectedModelLabel, t],
  );

  return (
    <>
      <ModelSheetTrigger
        ModelIcon={hasSelectedProvider ? ModelIcon : null}
        modelLabel={trigger.modelLabel}
        thinkingLabel={thinkingLabel}
        glyphs={glyphs}
        iconOnly={!showLabels && hasSelectedProvider}
        isOpen={isOpen}
        searchFocused={rootBrowser.isSearchFocused || modelBrowser.isSearchFocused}
        disabled={disabled}
        onPress={toggle}
        accessibilityLabel={trigger.accessibilityLabel}
        effortKeys={effortKeys}
      />

      <AdaptiveModalSheet
        header={rootHeader}
        visible={isOpen}
        onClose={close}
        snapPoints={SNAP_POINTS}
        scrollable={false}
        contentStyle={styles.sheetBody}
        contextBridge={contextBridge}
        testID="agent-controls-model-sheet"
      >
        <View
          style={[
            styles.modelViewport,
            usesBottomSheet ? styles.flexibleModelViewport : styles.fixedModelViewport,
          ]}
          testID="agent-controls-model-viewport"
        >
          <ModelBrowser
            state={rootBrowser}
            onSelect={usesBottomSheet ? handleSearchSelect : handleDesktopSelect}
            onApplyProfile={isSelectingBatch ? undefined : handleApplyProfile}
            onEditProfiles={onEditProfiles ? handleEditProfiles : undefined}
            onCreateProfile={profileActions.create}
            onEditProfile={profileActions.edit}
            onRetryProvider={onRetryProvider}
            isRetryingProvider={isRetryingProvider}
            scrolling={modelBrowserScrolling}
            searchAllOnFocus={usesBottomSheet}
            rootBrowseContent={usesBottomSheet ? mobileRootContent : undefined}
            showProfilesSection={!isSelectingBatch}
          />
        </View>
        {!isModelBrowserOpen ? batchControls : null}
        {!usesBottomSheet && children ? (
          <>
            <View style={styles.modelViewportDivider} />
            <ScrollView
              style={styles.controlsScroll}
              contentContainerStyle={styles.controlsContent}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
              testID="agent-controls-settings-list"
            >
              {children}
            </ScrollView>
          </>
        ) : null}
      </AdaptiveModalSheet>

      {usesBottomSheet ? (
        <AdaptiveModalSheet
          header={modelBrowser.header}
          visible={isModelBrowserOpen}
          onClose={closeModelBrowser}
          snapPoints={SNAP_POINTS}
          scrollable={false}
          presentation="push"
          contentStyle={styles.sheetBody}
          contextBridge={contextBridge}
          testID="agent-controls-model-browser-sheet"
        >
          <View
            style={[styles.modelViewport, styles.flexibleModelViewport]}
            testID="agent-controls-model-browser-viewport"
          >
            <ModelBrowser
              state={modelBrowser}
              onSelect={handleBrowserSelect}
              onEditProfiles={onEditProfiles ? handleEditProfiles : undefined}
              onCreateProfile={profileActions.create}
              onEditProfile={profileActions.edit}
              onRetryProvider={onRetryProvider}
              isRetryingProvider={isRetryingProvider}
              scrolling={modelBrowserScrolling}
              searchAllOnFocus
              showProfilesSection={false}
            />
          </View>
          {batchControls}
        </AdaptiveModalSheet>
      ) : null}
    </>
  );
}

/**
 * The folded model control in the toolbar: the provider glyph, then the model and thinking
 * labels for as long as they fit.
 */
interface ModelSheetTriggerProps {
  /** The selected provider's glyph, or null before a provider is selected. */
  ModelIcon: ReturnType<typeof useProviderIcon> | null;
  modelLabel: string;
  thinkingLabel: string | null;
  glyphs: ToolbarGlyphs;
  iconOnly: boolean;
  isOpen: boolean;
  searchFocused: boolean;
  disabled: boolean;
  onPress: () => void;
  accessibilityLabel: string;
  effortKeys: ReturnType<typeof useShortcutKeys>;
}

function ModelSheetTrigger({
  ModelIcon,
  modelLabel,
  thinkingLabel,
  glyphs,
  iconOnly,
  isOpen,
  searchFocused,
  disabled,
  onPress,
  accessibilityLabel,
  effortKeys,
}: ModelSheetTriggerProps) {
  const { t } = useTranslation();
  const { action: toggleAction, keys: modelKeys } = useModelPickerShortcut(disabled);
  useKeyboardToggle({
    action: toggleAction,
    disabled,
    open: isOpen,
    searchFocused,
    onToggle: onPress,
  });

  const glyphRole = iconOnly ? "icon" : "label";
  const glyph = glyphs[glyphRole];
  const triggerLabels = useModelTriggerLabels({
    modelLabel,
    thinkingLabel: iconOnly ? null : thinkingLabel,
    glyphSize: glyph.size,
  });
  const providerIconColor =
    glyph.tone === "foreground" ? styles.providerIconForeground.color : styles.providerIcon.color;
  const triggerStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType) => [
      styles.trigger,
      iconOnly && styles.triggerIconOnly,
      hovered && styles.triggerHovered,
      (pressed || isOpen) && styles.triggerPressed,
      disabled && styles.triggerDisabled,
    ],
    [disabled, iconOnly, isOpen],
  );

  const trigger = (
    <View style={styles.triggerFrame} onLayout={triggerLabels.onFrameLayout}>
      <ComboboxTrigger
        collapsable={false}
        disabled={disabled}
        onPress={onPress}
        style={triggerStyle}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        testID="combined-model-selector"
        chevron={null}
      >
        {ModelIcon ? (
          <ComposerToolbarGlyph role={glyphRole}>
            <ModelIcon
              size={glyph.size}
              strokeWidth={glyph.strokeWidth}
              color={providerIconColor}
            />
          </ComposerToolbarGlyph>
        ) : null}
        {!iconOnly ? (
          <View
            style={[
              styles.triggerLabels,
              triggerLabels.labels === "measuring" && styles.triggerLabelsMeasuring,
            ]}
          >
            <TailEllipsisText
              text={modelLabel}
              style={styles.triggerText}
              testID="combined-model-selector-model-label"
            />
            {thinkingLabel && triggerLabels.labels !== "model" ? (
              <Text
                style={styles.triggerThinking}
                numberOfLines={1}
                testID="combined-model-selector-thinking-label"
              >
                {thinkingLabel}
              </Text>
            ) : null}
          </View>
        ) : null}
      </ComboboxTrigger>
      {!iconOnly && thinkingLabel ? (
        <View
          // Keyed by what it measures: a retained node whose size does not change emits no new
          // layout event, so new labels would never be measured.
          key={triggerLabels.measuredKey}
          style={[styles.trigger, styles.triggerMeasurer]}
          onLayout={triggerLabels.onFullLayout}
          pointerEvents="none"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          aria-hidden
        >
          {ModelIcon ? <ComposerToolbarGlyph role={glyphRole}>{null}</ComposerToolbarGlyph> : null}
          <View style={styles.triggerLabels}>
            <Text style={[styles.triggerText, styles.triggerMeasuredText]} numberOfLines={1}>
              {modelLabel}
            </Text>
            <Text style={styles.triggerThinking} numberOfLines={1}>
              {thinkingLabel}
            </Text>
          </View>
        </View>
      ) : null}
    </View>
  );

  return (
    <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
      <TooltipTrigger asChild triggerRefProp="ref">
        {trigger}
      </TooltipTrigger>
      <TooltipContent side="top" align="center" offset={8}>
        <ControlTooltipHint label={t(getAgentControlHintKey("model"))} shortcutKeys={modelKeys} />
        {effortKeys ? (
          <ControlTooltipHint
            label={t("settings.shortcuts.help.cycleEffort")}
            shortcutKeys={effortKeys}
          />
        ) : null}
      </TooltipContent>
    </Tooltip>
  );
}

const styles = StyleSheet.create((theme) => ({
  batchControls: {
    gap: theme.spacing[1],
    paddingVertical: theme.spacing[1],
  },
  batchReason: {
    // Match the ModelBrowser row inset, leading icon slot, and gap before its label.
    paddingHorizontal: (isWeb ? theme.spacing[3] : theme.spacing[6]) + 16 + theme.spacing[2],
  },
  batchActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  trigger: {
    minWidth: 0,
    flexShrink: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    ...toolbarContentSlot(),
    borderRadius: theme.borderRadius.full,
    backgroundColor: "transparent",
  },
  triggerIconOnly: {
    ...toolbarSlot(),
    flexShrink: 0,
    paddingHorizontal: 0,
    justifyContent: "center",
  },
  triggerHovered: {
    backgroundColor: theme.colors.surface2,
  },
  triggerPressed: {
    backgroundColor: theme.colors.surface2,
  },
  triggerDisabled: {
    opacity: 0.5,
  },
  triggerText: {
    minWidth: 0,
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
  },
  triggerLabels: {
    minWidth: 0,
    flexShrink: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  triggerLabelsMeasuring: {
    opacity: 0,
  },
  /** The space the trigger may take; the trigger itself stays as wide as its content. */
  triggerFrame: {
    minWidth: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexDirection: "row",
    alignItems: "center",
  },
  /** An invisible copy of the trigger with both labels untruncated. */
  triggerMeasurer: {
    position: "absolute",
    left: 0,
    top: 0,
    flexShrink: 0,
    opacity: 0,
  },
  triggerMeasuredText: {
    flexShrink: 0,
  },
  triggerThinking: {
    flexShrink: 0,
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
  },
  providerIcon: {
    color: theme.colors.foregroundMuted,
  },
  providerIconForeground: {
    color: theme.colors.foreground,
  },
  sheetBody: {
    paddingHorizontal: 0,
    paddingTop: 0,
    paddingBottom: 0,
    gap: 0,
  },
  modelViewport: {
    overflow: "hidden",
    backgroundColor: theme.colors.surfaceSidebar,
  },
  flexibleModelViewport: {
    flex: 1,
    minHeight: 0,
  },
  fixedModelViewport: {
    height: FIXED_MODEL_VIEWPORT_HEIGHT,
    minHeight: FIXED_MODEL_VIEWPORT_HEIGHT,
  },
  modelViewportDivider: {
    height: 1,
    flexShrink: 0,
    backgroundColor: theme.colors.border,
  },
  controlsScroll: {
    flex: 1,
    minHeight: 0,
  },
  mobileRootContent: {
    backgroundColor: theme.colors.surfaceSidebar,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  controlsContent: {
    paddingHorizontal: theme.spacing[2],
    paddingTop: theme.spacing[3],
    paddingBottom: theme.spacing[3],
    gap: theme.spacing[1],
  },
}));
