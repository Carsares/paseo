import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { router } from "expo-router";
import {
  View,
  Pressable,
  Keyboard,
  useWindowDimensions,
  type LayoutChangeEvent,
} from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useShallow } from "zustand/shallow";
import { Settings2 } from "lucide-react-native";
import { readSelectOption, type ComposerOptionControls } from "@/agent-controls/option-controls";
import { formatThinkingOptionLabel } from "@/agent-controls/labels";
import { CombinedModelSelector } from "@/components/combined-model-selector";
import type { ProviderSelectorProvider } from "@/provider-selection/provider-selection";
import { filterSelectableModels } from "@/provider-selection/model-catalog";
import { useSessionStore } from "@/stores/session-store";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { useStableEvent } from "@/hooks/use-stable-event";
import { mergeProviderPreferences, useFormPreferences } from "@/hooks/use-form-preferences";
import {
  AgentModeControl,
  useLiveAgentModeControl,
  type AgentModeControlValue,
} from "@/composer/agent-controls/mode-control";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import type {
  AgentOptionControl,
  JsonValue,
  ProviderOptions,
  AgentMode,
  AgentModelDefinition,
  AgentProvider,
} from "@getpaseo/protocol/agent-types";
import type { AgentProviderDefinition } from "@getpaseo/protocol/provider-manifest";
import {
  getAgentControlHintKey,
  resolveAgentModelSelection,
  resolveProviderSnapshotEntry,
} from "@/composer/agent-controls/utils";
import { useIsCompactFormFactor } from "@/constants/layout";
import {
  controlSizingForLayout,
  TOOLBAR_CONTROL_GAP,
  type ToolbarGlyphs,
  toolbarSlot,
} from "@/components/ui/control-geometry";
import { readMeasuredWidth } from "@/hooks/use-container-width";
import { useToast } from "@/contexts/toast-context";
import { toErrorMessage } from "@/utils/error-messages";
import { showProviderNoticeToast } from "@/utils/provider-notice-toast";
import {
  useAgentControlCommandCenterActions,
  type AgentControlCommandCenterSource,
} from "@/command-center/agent-control-registration";
import { useShortcutKeys } from "@/hooks/use-shortcut-keys";
import { useComposerKeyboardScope } from "@/composer/keyboard-scope";
import {
  composerToolbarGeometry,
  resolveComposerControlDensity,
  resolveComposerControlPresentation,
  type ComposerControlDensity,
  type ComposerControlPresentation,
} from "@/composer/agent-controls/layout";
import { ComposerControlLayoutProvider } from "@/composer/agent-controls/layout-context";
import { ComposerToolbarGlyph } from "@/composer/agent-controls/glyph";
import {
  ComposerControls,
  ControlTooltipHint,
  type ComposerControlItem,
} from "@/composer/agent-controls/composer-control";
import {
  useAgentControlItems,
  useEffortCycleShortcut,
  useModelPickerShortcut,
} from "@/composer/agent-controls/control-items";
import { isMainControlAgent, isResidentAgent } from "@getpaseo/protocol/agent-labels";
import { CompactModelSheet } from "@/composer/agent-controls/model-sheet";
import {
  buildCrossProviderSwitchDisclosurePlan,
  confirmCrossProviderSwitchFlow,
  hasBlankContextSwitchPermissions,
  isAgentTurnRunning,
  precheckModelThinkingCompatibility,
  readLiveTopicMetadataDisclosure,
  type CrossProviderContextMode,
  type CrossProviderSwitchDisclosurePlan,
  type CrossProviderSwitchTarget,
  type LiveAgentSwitchSnapshot,
  type TopicMetadataDisclosureState,
  type WorkspaceBatchModelPicker,
} from "./model-sheet-flow";
import { ProviderSwitchDisclosureModal } from "./provider-switch-disclosure";
import { useHostFeature } from "@/runtime/host-features";
import {
  resolveAgentControlsProfileProviders,
  resolveAgentControlsSelectorProviders,
  routeAgentModelSelection,
} from "@/composer/agent-controls/provider-routing";
import { useComposerSheetBridge } from "@/composer/agent-controls/sheet-bridge";
import { draftComposerAgent } from "@/composer/draft/composer-agent";
import { agentComposer } from "@/composer/agent-composer";
import { useCrossProviderAgentHandoff } from "@/composer/cross-provider-handoff";
import { composerModelFromHalves } from "@/composer/halves-model";
import { ComposerModelProvider } from "@/composer/model";
import { ComposerAgentProvider, useComposerInput } from "@/composer/session";
import { PluginComposerItems, usePluginComposerItemCount } from "@/plugins/composer-items";
import {
  PluginToolbarSlot,
  useToolbarSlotWidth,
} from "@/composer/agent-controls/plugin-toolbar-slot";
import { WorkspaceMainSheetControl, WorkspaceMainToolbarSlot } from "./workspace-main-control";
import type { WorkspaceMainControlValue } from "@/composer/draft/workspace-main-preference";
import {
  useAgentProfileEditor,
  useAgentProfilePicker,
  type AgentProfileApplyTarget,
  type AgentProfileEditorControls,
  type AgentProfilePicker,
  type AgentProfileSeed,
  type DraftAgentProfileControls,
  type MaterializedAgentProfile,
} from "@/agent-profiles";
import { buildSettingsHostSectionRoute } from "@/utils/host-routes";

interface AgentControlOption {
  id: string;
  label: string;
}

const EMPTY_AGENT_PROVIDER_DEFINITIONS: AgentProviderDefinition[] = [];
const EMPTY_OPTIONS: ProviderOptions = {};

interface ControlledAgentControlsProps {
  provider: string;
  modelOptions?: AgentControlOption[];
  selectedModelId?: string;
  onSelectModel?: (modelId: string) => void;
  onSelectProviderAndModel?: (provider: string, modelId: string) => void;
  thinkingOptions?: AgentControlOption[];
  selectedThinkingOptionId?: string;
  onSelectThinkingOption?: (thinkingOptionId: string) => void;
  disabled?: boolean;
  isModelLoading?: boolean;
  modelSelectorProviders?: ProviderSelectorProvider[];
  agentProfiles?: AgentProfilePicker | null;
  onApplyAgentProfile?: (profileId: string) => void;
  onEditAgentProfiles?: () => void;
  onCreateAgentProfile?: (seed: AgentProfileSeed) => void;
  onEditAgentProfile?: (profileId: string) => void;
  optionControls?: ComposerOptionControls;
  onDropdownClose?: () => void;
  onModelSelectorOpen?: () => void;
  onRetryModelProvider?: (provider: AgentProvider) => void;
  isRetryingModelProvider?: boolean;
  modeControl?: AgentModeControlValue | null;
  modelSelectorServerId?: string | null;
  isCompactLayout?: boolean;
  workspaceMain?: WorkspaceMainControlValue;
  batchModels?: WorkspaceBatchModelPicker;
}

export interface DraftAgentControlsProps {
  providerDefinitions: AgentProviderDefinition[];
  selectedProvider: AgentProvider | null;
  modeOptions: AgentMode[];
  selectedMode: string;
  onSelectMode: (modeId: string) => void;
  models: AgentModelDefinition[];
  selectedModel: string;
  effectiveModelId: string;
  onSelectModel: (modelId: string) => void;
  isModelLoading: boolean;
  modelSelectorProviders: ProviderSelectorProvider[];
  isAllModelsLoading: boolean;
  /** `false` when the provider is unknown or not ready. */
  onSelectProviderAndModel: (provider: AgentProvider, modelId: string) => boolean;
  thinkingOptions: NonNullable<AgentModelDefinition["thinkingOptions"]>;
  selectedThinkingOptionId: string;
  onSelectThinkingOption: (thinkingOptionId: string) => void;
  onApplyAgentProfile: DraftAgentProfileControls["applyProfile"];
  /** The controls the daemon described for the draft; absent until it answers. */
  optionControls?: ComposerOptionControls;
  /** What the draft will create with, edits included, whether or not the daemon has answered. */
  options: ProviderOptions;
  onSetOption: (key: string, value: unknown) => void;
  onDropdownClose?: () => void;
  onModelSelectorOpen?: () => void;
  onRetryModelProvider?: (provider: AgentProvider) => void;
  isRetryingModelProvider?: boolean;
  disabled?: boolean;
  modelSelectorServerId?: string | null;
  isCompactLayout?: boolean;
  workspaceMain?: WorkspaceMainControlValue;
  batchModels?: WorkspaceBatchModelPicker;
  /** Which composer a plugin's `useComposer()` reports. */
  context?: "draft" | "new-workspace";
  /** What plugins set on the agent this draft creates. */
  metadata: Record<string, JsonValue>;
  onSetMetadata: (patch: Record<string, JsonValue>) => void;
}

interface AgentControlsProps {
  showToolbar: boolean;
  agentId: string;
  serverId: string;
  onDropdownClose?: () => void;
  isCompactLayout?: boolean;
}

function AgentControlCommandCenterRegistration({
  sourceId,
  enabled,
  controls,
}: {
  sourceId: string;
  enabled: boolean;
  controls: AgentControlCommandCenterSource;
}) {
  const { isCommandCenterTarget } = useComposerKeyboardScope();
  useAgentControlCommandCenterActions({
    sourceId,
    enabled: enabled && isCommandCenterTarget,
    controls,
  });
  return null;
}

function findOptionLabel(
  options: AgentControlOption[] | undefined,
  selectedId: string | undefined,
  fallback: string,
) {
  if (!options || options.length === 0) {
    return fallback;
  }
  const selected = options.find((option) => option.id === selectedId);
  return selected?.label ?? fallback;
}

function toCommandCenterModes(modeControl: AgentModeControlValue | null) {
  if (!modeControl) return undefined;
  return {
    options: modeControl.modeOptions,
    selectedId: modeControl.selectedModeId,
    select: modeControl.onSelectMode,
  };
}

function getModeProviderDefinitions(modeControl: AgentModeControlValue | null) {
  return modeControl?.providerDefinitions ?? EMPTY_AGENT_PROVIDER_DEFINITIONS;
}

type ActiveSheet = "features" | null;

function resolveHasAnyControl({
  canSelectModel,
  thinkingOptions,
  controls,
  hasMode,
  pluginItemCount,
  hasWorkspaceMain,
}: {
  canSelectModel: boolean;
  thinkingOptions: AgentControlOption[] | undefined;
  controls: readonly AgentOptionControl[] | undefined;
  hasMode: boolean;
  pluginItemCount: number;
  hasWorkspaceMain: boolean;
}) {
  return (
    canSelectModel ||
    Boolean(thinkingOptions?.length) ||
    Boolean(controls?.length) ||
    hasMode ||
    pluginItemCount > 0 ||
    hasWorkspaceMain
  );
}

function toThinkingControlOptions(options: AgentControlOption[] | undefined): AgentControlOption[] {
  return (options ?? []).map((option) => ({
    id: option.id,
    label: formatThinkingOptionLabel(option),
  }));
}

/**
 * The picker's edit shortcut. Agent profiles are host config, so it lands on the
 * host settings section that owns the list.
 */
function useEditAgentProfilesNavigation(
  serverId: string | null,
  isSupported: boolean,
): (() => void) | undefined {
  const handleEdit = useCallback(() => {
    if (!serverId) return;
    router.push(buildSettingsHostSectionRoute(serverId, "agents"));
  }, [serverId]);
  return serverId && isSupported ? handleEdit : undefined;
}

function resolveAgentProfileEditorActions(
  isSupported: boolean,
  editor: AgentProfileEditorControls,
): {
  create?: (seed: AgentProfileSeed) => void;
  edit?: (profileId: string) => void;
} {
  if (!isSupported) {
    return {};
  }
  return {
    create: editor.openCreateFromModel,
    edit: editor.openEdit,
  };
}

function buildFallbackModelSelectorProviders(
  provider: string,
  modelOptions: AgentControlOption[] | undefined,
): ProviderSelectorProvider[] {
  if (!modelOptions || modelOptions.length === 0) {
    return [];
  }
  return [
    {
      id: provider,
      label: provider,
      modelSelection: {
        kind: "models",
        rows: modelOptions.map((option) => ({
          favoriteKey: `${provider}:${option.id}`,
          provider,
          providerLabel: provider,
          modelId: option.id,
          modelLabel: option.label,
        })),
      },
    },
  ];
}

function pickModel({
  nextProviderId,
  modelId,
  currentProvider,
  onSelectModel,
  onSelectProviderAndModel,
}: {
  nextProviderId: string;
  modelId: string;
  currentProvider: string;
  onSelectModel?: (modelId: string) => void;
  onSelectProviderAndModel?: (provider: string, modelId: string) => void;
}) {
  if (onSelectProviderAndModel) {
    onSelectProviderAndModel(nextProviderId, modelId);
    return;
  }
  if (nextProviderId === currentProvider) {
    onSelectModel?.(modelId);
  }
}

type AgentControlsSlice = {
  provider: string;
  cwd: string | null;
  workspaceId: string | null;
  status: string;
  turnPhase: string;
  hasConversationHistory: boolean;
  pendingPermissionsCount: number;
  isMainControl: boolean;
  isRoleSeat: boolean;
  runtimeModelId: string | null;
  model: string | null | undefined;
  options: ProviderOptions | undefined;
  controls: AgentOptionControl[] | undefined;
  runtimeThinkingOptionId: string | null;
  thinkingOptionId: string | null | undefined;
  lastUsage: unknown;
  metadata: Record<string, JsonValue> | undefined;
} | null;

function selectAgentControlsSlice(
  state: ReturnType<typeof useSessionStore.getState>,
  serverId: string,
  agentId: string,
): AgentControlsSlice {
  const session = state.sessions[serverId];
  const currentAgent = session?.agents?.get(agentId) ?? session?.agentDetails?.get(agentId);
  if (!currentAgent) {
    return null;
  }
  return {
    provider: currentAgent.provider,
    cwd: currentAgent.cwd,
    workspaceId: currentAgent.workspaceId ?? null,
    status: currentAgent.status,
    turnPhase: currentAgent.turn.phase,
    hasConversationHistory: currentAgent.lastUserMessageAt !== null,
    pendingPermissionsCount: currentAgent.pendingPermissions.length,
    isMainControl: isMainControlAgent(currentAgent),
    isRoleSeat: isMainControlAgent(currentAgent) || isResidentAgent(currentAgent),
    runtimeModelId: currentAgent.runtimeInfo?.model ?? null,
    model: currentAgent.model,
    options: currentAgent.options,
    controls: currentAgent.controls,
    runtimeThinkingOptionId: currentAgent.runtimeInfo?.thinkingOptionId ?? null,
    thinkingOptionId: currentAgent.thinkingOptionId,
    lastUsage: currentAgent.lastUsage,
    metadata: currentAgent.metadata,
  };
}

function findProviderSnapshotModel(
  entry: ReturnType<typeof resolveProviderSnapshotEntry>,
  modelId: string,
) {
  return (
    entry?.models?.find((model) => model.id === modelId || model.aliases?.includes(modelId)) ?? null
  );
}

function resolveSnapshotModeIds(
  entry: ReturnType<typeof resolveProviderSnapshotEntry>,
): string[] | null {
  if (entry?.status !== "ready" || !entry.modes) {
    return null;
  }
  return entry.modes.map((mode) => mode.id);
}

function densityFolds(density: ComposerControlDensity): boolean {
  return resolveComposerControlPresentation(density).foldControls;
}

function ControlledAgentControls({
  provider,
  modelOptions,
  selectedModelId,
  onSelectModel,
  onSelectProviderAndModel,
  thinkingOptions,
  selectedThinkingOptionId,
  onSelectThinkingOption,
  disabled = false,
  isModelLoading = false,
  modelSelectorProviders,
  agentProfiles = null,
  onApplyAgentProfile,
  onEditAgentProfiles,
  onCreateAgentProfile,
  onEditAgentProfile,
  optionControls,
  onDropdownClose,
  onModelSelectorOpen,
  onRetryModelProvider,
  isRetryingModelProvider = false,
  modeControl,
  modelSelectorServerId = null,
  isCompactLayout,
  workspaceMain,
  batchModels,
}: ControlledAgentControlsProps) {
  const { t } = useTranslation();
  const isCompactFormFactor = useIsCompactFormFactor();
  const isCompact = isCompactLayout ?? isCompactFormFactor;
  // Control sizes follow the window layout, as the toolbar's stylesheet does. A narrow pane in a
  // wide window (`isCompactLayout`) changes which labels show, never how large a control is.
  const toolbarSizing = controlSizingForLayout(isCompactFormFactor);
  const toolbarGeometry = useMemo(() => composerToolbarGeometry(toolbarSizing), [toolbarSizing]);
  const { fontScale } = useWindowDimensions();
  const [activeSheet, setActiveSheet] = useState<ActiveSheet>(null);
  const [openSelector, setOpenSelector] = useState<string | null>(null);
  // A compact composer always folds its controls into the model sheet; the width budget only
  // decides whether the model keeps its label.
  const minimumDensity: ComposerControlDensity = isCompact ? "compact" : "full";
  const initialDensity = minimumDensity;
  const [density, setDensity] = useState<ComposerControlDensity>(initialDensity);
  const densityRef = useRef<ComposerControlDensity>(initialDensity);
  const availableWidthRef = useRef(0);

  const canSelectModel = Boolean(onSelectModel);
  const canSelectThinking = Boolean(
    onSelectThinkingOption && thinkingOptions && thinkingOptions.length > 0,
  );
  const pluginItemCount = usePluginComposerItemCount(modelSelectorServerId);
  const { width: pluginItemsWidth, onLayout: handlePluginItemsLayout } = useToolbarSlotWidth();
  const { width: workspaceMainWidth, onLayout: handleWorkspaceMainLayout } = useToolbarSlotWidth();
  const hasWorkspaceMain = Boolean(workspaceMain);
  const hasMode = Boolean(modeControl);

  const formattedThinkingOptions = useMemo(
    () => toThinkingControlOptions(thinkingOptions),
    [thinkingOptions],
  );
  const displayThinking = findOptionLabel(
    formattedThinkingOptions,
    selectedThinkingOptionId,
    formattedThinkingOptions[0]?.label ?? t("agentControls.thinking.unknown"),
  );

  const hasAnyControl = resolveHasAnyControl({
    canSelectModel,
    thinkingOptions,
    controls: optionControls?.controls,
    hasMode,
    pluginItemCount,
    hasWorkspaceMain,
  });
  const featureControls = useMemo(
    () =>
      (optionControls?.controls ?? []).map((control) => {
        if (control.type === "toggle") return { type: "toggle" as const };
        if (control.desktopTrigger === "icon") return { type: "select" as const, label: null };
        const selected = readSelectOption(control, optionControls?.options ?? {});
        const choice = control.choices.find((candidate) => candidate.value === selected);
        return {
          type: "select" as const,
          label: choice?.label ?? control.label,
        };
      }),
    [optionControls],
  );
  const controlPresence = useMemo(
    () => ({
      hasModel: canSelectModel,
      hasThinking: canSelectThinking,
      hasMode,
      features: featureControls,
      pluginItemsWidth,
      workspaceMainWidth: hasWorkspaceMain ? Math.max(1, workspaceMainWidth) : 0,
      fontScale,
    }),
    [
      canSelectModel,
      canSelectThinking,
      featureControls,
      fontScale,
      hasWorkspaceMain,
      hasMode,
      pluginItemsWidth,
      workspaceMainWidth,
    ],
  );
  const presentation = useMemo(() => resolveComposerControlPresentation(density), [density]);
  const layoutContextValue = useMemo(
    () => ({
      glyphs: toolbarGeometry.glyphs,
      presentation,
    }),
    [presentation, toolbarGeometry],
  );

  const updateDensityForWidth = useCallback(
    (availableWidth: number) => {
      const nextDensity = resolveComposerControlDensity({
        availableWidth,
        currentDensity: densityRef.current,
        controls: controlPresence,
        geometry: toolbarGeometry,
        minimumDensity,
      });
      if (nextDensity === densityRef.current) return;
      // Folding swaps the toolbar controls for the model sheet and back, so whatever menu or
      // sheet was open belonged to controls that are gone.
      if (densityFolds(nextDensity) !== densityFolds(densityRef.current)) {
        setOpenSelector(null);
        setActiveSheet(null);
      }
      densityRef.current = nextDensity;
      setDensity(nextDensity);
    },
    [controlPresence, minimumDensity, toolbarGeometry],
  );

  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const availableWidth = readMeasuredWidth(event);
      if (availableWidth === null) return;
      availableWidthRef.current = availableWidth;
      updateDensityForWidth(availableWidth);
    },
    [updateDensityForWidth],
  );

  useEffect(() => {
    if (availableWidthRef.current > 0) {
      updateDensityForWidth(availableWidthRef.current);
    }
  }, [updateDensityForWidth]);

  const fallbackModelSelectorProviders = useMemo(
    () => buildFallbackModelSelectorProviders(provider, modelOptions),
    [modelOptions, provider],
  );
  const effectiveModelSelectorProviders = modelSelectorProviders ?? fallbackModelSelectorProviders;

  const thinking = useMemo(
    () =>
      canSelectThinking && onSelectThinkingOption
        ? {
            options: formattedThinkingOptions,
            selectedId: selectedThinkingOptionId,
            onSelect: onSelectThinkingOption,
            displayLabel: displayThinking,
          }
        : null,
    [
      canSelectThinking,
      displayThinking,
      formattedThinkingOptions,
      onSelectThinkingOption,
      selectedThinkingOptionId,
    ],
  );
  const effortKeys = useEffortCycleShortcut(thinking, disabled);
  const items = useAgentControlItems({
    surface: presentation.foldControls ? "sheet" : "toolbar",
    presentation,
    thinking,
    optionControls,
  });

  const handleToolbarOpenChange = useCallback(
    (id: string | null) => {
      setOpenSelector(id);
      if (id === null) onDropdownClose?.();
    },
    [onDropdownClose],
  );

  const handleModelSelect = useCallback(
    (nextProviderId: string, modelId: string) => {
      pickModel({
        nextProviderId,
        modelId,
        currentProvider: provider,
        onSelectModel,
        onSelectProviderAndModel,
      });
    },
    [onSelectModel, onSelectProviderAndModel, provider],
  );

  const handleOpenSheet = useCallback((sheet: Exclude<ActiveSheet, null>) => {
    Keyboard.dismiss();
    setActiveSheet(sheet);
  }, []);

  const handleCloseSheet = useCallback(() => {
    setActiveSheet(null);
    if (!presentation.foldControls) onDropdownClose?.();
  }, [onDropdownClose, presentation.foldControls]);

  if (!hasAnyControl) {
    return null;
  }

  return (
    <ComposerControlLayoutProvider value={layoutContextValue}>
      <View style={styles.container} onLayout={handleLayout} testID="agent-controls-toolbar">
        {!presentation.foldControls || (!canSelectModel && workspaceMain) ? (
          <DesktopAgentControlsContent
            provider={provider}
            selectedModelId={selectedModelId}
            thinkingItems={items.thinking}
            effortKeys={effortKeys}
            featureItems={items.features}
            onApplyAgentProfile={onApplyAgentProfile}
            onEditAgentProfiles={onEditAgentProfiles}
            onCreateAgentProfile={onCreateAgentProfile}
            onEditAgentProfile={onEditAgentProfile}
            onDropdownClose={onDropdownClose}
            onModelSelectorOpen={onModelSelectorOpen}
            onRetryModelProvider={onRetryModelProvider}
            isRetryingModelProvider={isRetryingModelProvider}
            agentProfiles={agentProfiles}
            disabled={disabled}
            isModelLoading={isModelLoading}
            canSelectModel={canSelectModel}
            modelSelectorProviders={effectiveModelSelectorProviders}
            openSelector={openSelector}
            handleDesktopModelSelect={handleModelSelect}
            handleToolbarOpenChange={handleToolbarOpenChange}
            handleSheetOpenChange={setOpenSelector}
            modeControl={modeControl}
            presentation={presentation}
            hasPluginItems={pluginItemsWidth > 0}
            glyphs={layoutContextValue.glyphs}
            activeSheet={activeSheet}
            handleOpenSheet={handleOpenSheet}
            handleCloseSheet={handleCloseSheet}
            modelSelectorServerId={modelSelectorServerId}
            workspaceMain={workspaceMain}
            batchModels={batchModels}
          />
        ) : (
          <SheetAgentControlsContent
            provider={provider}
            selectedModelId={selectedModelId}
            thinkingItems={items.thinking}
            effortKeys={effortKeys}
            featureItems={items.features}
            onApplyAgentProfile={onApplyAgentProfile}
            onEditAgentProfiles={onEditAgentProfiles}
            onCreateAgentProfile={onCreateAgentProfile}
            onEditAgentProfile={onEditAgentProfile}
            onDropdownClose={onDropdownClose}
            onModelSelectorOpen={onModelSelectorOpen}
            onRetryModelProvider={onRetryModelProvider}
            isRetryingModelProvider={isRetryingModelProvider}
            agentProfiles={agentProfiles}
            disabled={disabled}
            isModelLoading={isModelLoading}
            canSelectModel={canSelectModel}
            modelSelectorProviders={effectiveModelSelectorProviders}
            openSelector={openSelector}
            displayThinking={thinking ? displayThinking : null}
            handleSheetModelSelect={handleModelSelect}
            handleSheetOpenChange={setOpenSelector}
            modeControl={modeControl}
            glyphs={layoutContextValue.glyphs}
            showLabels={presentation.showModelLabel}
            modelSelectorServerId={modelSelectorServerId}
            canSwitchProvider={Boolean(onSelectProviderAndModel)}
            workspaceMain={workspaceMain}
            batchModels={batchModels}
          />
        )}
        <TrailingAgentControls
          serverId={modelSelectorServerId}
          disabled={disabled}
          compact={isCompact}
          showInline={!presentation.aggregateFeatures}
          pluginItemsWidth={pluginItemsWidth}
          measurePlugins={handlePluginItemsLayout}
          workspaceMain={workspaceMain}
          workspaceMainWidth={workspaceMainWidth}
          measureWorkspaceMain={handleWorkspaceMainLayout}
        />
      </View>
    </ComposerControlLayoutProvider>
  );
}

function TrailingAgentControls({
  serverId,
  disabled,
  compact,
  showInline,
  pluginItemsWidth,
  measurePlugins,
  workspaceMain,
  workspaceMainWidth,
  measureWorkspaceMain,
}: {
  serverId: string | null;
  disabled: boolean;
  compact: boolean;
  showInline: boolean;
  pluginItemsWidth: number;
  measurePlugins: (event: LayoutChangeEvent) => void;
  workspaceMain?: WorkspaceMainControlValue;
  workspaceMainWidth: number;
  measureWorkspaceMain: (event: LayoutChangeEvent) => void;
}) {
  if (compact) return null;
  return (
    <>
      <PluginToolbarSlot
        serverId={serverId}
        width={pluginItemsWidth}
        fits={showInline}
        onLayout={measurePlugins}
      />
      {workspaceMain ? (
        <WorkspaceMainToolbarSlot
          control={workspaceMain}
          disabled={disabled}
          visible={showInline && workspaceMainWidth > 0}
          onLayout={measureWorkspaceMain}
        />
      ) : null}
    </>
  );
}

interface AgentControlsContentProps {
  provider: string;
  selectedModelId?: string;
  thinkingItems: ComposerControlItem[];
  effortKeys: ReturnType<typeof useShortcutKeys>;
  featureItems: ComposerControlItem[];
  onApplyAgentProfile?: (profileId: string) => void;
  onEditAgentProfiles?: () => void;
  onCreateAgentProfile?: (seed: AgentProfileSeed) => void;
  onEditAgentProfile?: (profileId: string) => void;
  onDropdownClose?: () => void;
  onModelSelectorOpen?: () => void;
  onRetryModelProvider?: (provider: AgentProvider) => void;
  isRetryingModelProvider: boolean;
  agentProfiles: AgentProfilePicker | null;
  disabled: boolean;
  isModelLoading: boolean;
  canSelectModel: boolean;
  modelSelectorProviders: ProviderSelectorProvider[];
  openSelector: string | null;
  handleSheetOpenChange: (id: string | null) => void;
  modeControl?: AgentModeControlValue | null;
  glyphs: ToolbarGlyphs;
  modelSelectorServerId: string | null;
  workspaceMain?: WorkspaceMainControlValue;
  batchModels?: WorkspaceBatchModelPicker;
}

interface DesktopAgentControlsContentProps extends AgentControlsContentProps {
  handleDesktopModelSelect: (providerId: string, modelId: string) => void;
  handleToolbarOpenChange: (id: string | null) => void;
  presentation: ComposerControlPresentation;
  hasPluginItems: boolean;
  activeSheet: ActiveSheet;
  handleOpenSheet: (sheet: Exclude<ActiveSheet, null>) => void;
  handleCloseSheet: () => void;
}

function DesktopAgentControlsContent(props: DesktopAgentControlsContentProps) {
  const sheetBridge = useComposerSheetBridge();
  const { t } = useTranslation();
  const {
    provider,
    selectedModelId,
    thinkingItems,
    effortKeys,
    featureItems,
    onApplyAgentProfile,
    onEditAgentProfiles,
    onCreateAgentProfile,
    onEditAgentProfile,
    onDropdownClose,
    onModelSelectorOpen,
    onRetryModelProvider,
    isRetryingModelProvider,
    agentProfiles,
    disabled,
    isModelLoading,
    canSelectModel,
    modelSelectorProviders,
    openSelector,
    handleDesktopModelSelect,
    handleToolbarOpenChange,
    handleSheetOpenChange,
    modeControl,
    presentation,
    hasPluginItems,
    glyphs,
    activeSheet,
    handleOpenSheet,
    handleCloseSheet,
    modelSelectorServerId,
    workspaceMain,
    batchModels,
  } = props;
  const { action: toggleAction, keys: modelKeys } = useModelPickerShortcut(disabled);
  const modelTooltipLabel = t(getAgentControlHintKey("model"));
  const modelToolbar = useMemo(
    () => ({
      glyph: glyphs.label,
      showCaret: presentation.showCarets,
      tooltip: <ControlTooltipHint label={modelTooltipLabel} shortcutKeys={modelKeys} />,
    }),
    [glyphs.label, presentation.showCarets, modelTooltipLabel, modelKeys],
  );
  const featuresSheetHeader = useMemo<SheetHeader>(
    () => ({ title: t("agentControls.features.title") }),
    [t],
  );
  const handleOpenFeatures = useCallback(() => handleOpenSheet("features"), [handleOpenSheet]);
  const hasFeatures = featureItems.length > 0 || hasPluginItems || Boolean(workspaceMain);
  return (
    <>
      {canSelectModel && batchModels ? (
        <CompactModelSheet
          providers={modelSelectorProviders}
          selectedProvider={provider}
          selectedModel={selectedModelId ?? ""}
          thinkingLabel={null}
          effortKeys={effortKeys}
          onSelect={handleDesktopModelSelect}
          profiles={agentProfiles}
          onApplyProfile={onApplyAgentProfile}
          onEditProfiles={onEditAgentProfiles}
          onCreateProfile={onCreateAgentProfile}
          onEditProfile={onEditAgentProfile}
          contextBridge={sheetBridge}
          isLoading={isModelLoading}
          disabled={disabled}
          onOpen={onModelSelectorOpen}
          onClose={onDropdownClose}
          onRetryProvider={onRetryModelProvider}
          isRetryingProvider={isRetryingModelProvider}
          serverId={modelSelectorServerId}
          glyphs={glyphs}
          showLabels
          canSwitchProvider
          batchModels={batchModels}
        />
      ) : null}
      {canSelectModel && !batchModels ? (
        <View style={styles.modelControl}>
          <CombinedModelSelector
            providers={modelSelectorProviders}
            selectedProvider={provider}
            selectedModel={selectedModelId ?? ""}
            onSelect={handleDesktopModelSelect}
            profiles={agentProfiles}
            onApplyProfile={onApplyAgentProfile}
            onEditProfiles={onEditAgentProfiles}
            onCreateProfile={onCreateAgentProfile}
            onEditProfile={onEditAgentProfile}
            isLoading={isModelLoading}
            disabled={disabled}
            toggleAction={toggleAction}
            onOpen={onModelSelectorOpen}
            onClose={onDropdownClose}
            onRetryProvider={onRetryModelProvider}
            isRetryingProvider={isRetryingModelProvider}
            serverId={modelSelectorServerId}
            desktopPlacement="top-start"
            desktopMinWidth={360}
            toolbar={modelToolbar}
          />
        </View>
      ) : null}

      <ComposerControls
        items={thinkingItems}
        shortcutKeys={effortKeys}
        surface="toolbar"
        disabled={disabled}
        openId={openSelector}
        onOpenIdChange={handleToolbarOpenChange}
      />

      {modeControl ? <AgentModeControl {...modeControl} onClose={onDropdownClose} /> : null}

      {presentation.aggregateFeatures && hasFeatures ? (
        <>
          <Pressable
            onPress={handleOpenFeatures}
            disabled={disabled}
            style={styles.modeIconBadge}
            accessibilityRole="button"
            accessibilityLabel={t("agentControls.features.open")}
            testID="agent-controls-features"
          >
            <ComposerToolbarGlyph role="icon">
              <Settings2
                size={glyphs.icon.size}
                strokeWidth={glyphs.icon.strokeWidth}
                color={(glyphs.icon.tone === "foreground" ? styles.glyph : styles.mutedGlyph).color}
              />
            </ComposerToolbarGlyph>
          </Pressable>
          <AdaptiveModalSheet
            header={featuresSheetHeader}
            visible={activeSheet === "features"}
            onClose={handleCloseSheet}
            contextBridge={sheetBridge}
            testID="agent-features-sheet"
          >
            <ComposerControls
              items={featureItems}
              surface="sheet"
              disabled={disabled}
              openId={openSelector}
              onOpenIdChange={handleSheetOpenChange}
            />
            <PluginComposerItems serverId={modelSelectorServerId} surface="sheet" />
            {workspaceMain ? (
              <WorkspaceMainSheetControl control={workspaceMain} disabled={disabled} />
            ) : null}
          </AdaptiveModalSheet>
        </>
      ) : (
        <ComposerControls
          items={featureItems}
          surface="toolbar"
          disabled={disabled}
          openId={openSelector}
          onOpenIdChange={handleToolbarOpenChange}
          onActionComplete={onDropdownClose}
        />
      )}
    </>
  );
}

interface SheetAgentControlsContentProps extends AgentControlsContentProps {
  showLabels: boolean;
  displayThinking: string | null;
  handleSheetModelSelect: (providerId: string, modelId: string) => void;
  canSwitchProvider: boolean;
}

function SheetAgentControlsContent(props: SheetAgentControlsContentProps) {
  const sheetBridge = useComposerSheetBridge();
  const {
    provider,
    selectedModelId,
    thinkingItems,
    effortKeys,
    featureItems,
    onApplyAgentProfile,
    onEditAgentProfiles,
    onCreateAgentProfile,
    onEditAgentProfile,
    onDropdownClose,
    onModelSelectorOpen,
    onRetryModelProvider,
    isRetryingModelProvider,
    agentProfiles,
    disabled,
    isModelLoading,
    canSelectModel,
    modelSelectorProviders,
    openSelector,
    displayThinking,
    handleSheetModelSelect,
    handleSheetOpenChange,
    modeControl,
    glyphs,
    showLabels,
    modelSelectorServerId,
    canSwitchProvider,
    workspaceMain,
    batchModels,
  } = props;

  const sheetControls = (
    <View style={styles.combinedSheetControls} testID="agent-controls-combined-sheet-controls">
      <ComposerControls
        items={thinkingItems}
        surface="sheet"
        disabled={disabled}
        openId={openSelector}
        onOpenIdChange={handleSheetOpenChange}
      />

      {modeControl ? <AgentModeControl {...modeControl} surface="sheet" /> : null}

      <ComposerControls
        items={featureItems}
        surface="sheet"
        disabled={disabled}
        openId={openSelector}
        onOpenIdChange={handleSheetOpenChange}
      />
      <PluginComposerItems serverId={modelSelectorServerId} surface="sheet" />
      {workspaceMain ? (
        <WorkspaceMainSheetControl control={workspaceMain} disabled={disabled} />
      ) : null}
    </View>
  );

  return canSelectModel ? (
    <CompactModelSheet
      providers={modelSelectorProviders}
      selectedProvider={provider}
      selectedModel={selectedModelId ?? ""}
      thinkingLabel={displayThinking}
      effortKeys={effortKeys}
      onSelect={handleSheetModelSelect}
      profiles={agentProfiles}
      onApplyProfile={onApplyAgentProfile}
      onEditProfiles={onEditAgentProfiles}
      onCreateProfile={onCreateAgentProfile}
      onEditProfile={onEditAgentProfile}
      contextBridge={sheetBridge}
      isLoading={isModelLoading}
      disabled={disabled}
      onOpen={onModelSelectorOpen}
      onClose={onDropdownClose}
      onRetryProvider={onRetryModelProvider}
      isRetryingProvider={isRetryingModelProvider}
      serverId={modelSelectorServerId}
      glyphs={glyphs}
      showLabels={showLabels}
      canSwitchProvider={canSwitchProvider}
      batchModels={batchModels}
    >
      {sheetControls}
    </CompactModelSheet>
  ) : null;
}

function useAgentOptionControls(
  agent: { controls?: AgentOptionControl[]; options?: ProviderOptions } | null | undefined,
  onSetOption: ComposerOptionControls["onSetOption"],
): ComposerOptionControls {
  const controls = agent?.controls;
  const options = agent?.options;
  return useMemo(
    () => ({ controls: controls ?? [], options: options ?? EMPTY_OPTIONS, onSetOption }),
    [controls, onSetOption, options],
  );
}

function useAtomicBlankContextSwitch(serverId: string, supportsInPlaceSwitch: boolean) {
  const supportsBlankContext = useHostFeature(serverId, "agentProviderSwitchBlankContext");
  const permissions = useSessionStore(
    (state) => state.sessions[serverId]?.client?.getLastServerInfoMessage?.()?.permissions,
  );
  const supportsFeature = supportsBlankContext && supportsInPlaceSwitch;
  const hasPermissions = hasBlankContextSwitchPermissions(permissions);
  return {
    supportsFeature,
    hasPermissions,
    allowed: supportsFeature && hasPermissions,
  };
}

export const AgentControls = memo(function AgentControls({
  showToolbar,
  agentId,
  serverId,
  onDropdownClose,
  isCompactLayout,
}: AgentControlsProps) {
  const { t } = useTranslation();
  const { preferences, updatePreferences } = useFormPreferences();
  const supportsTopic = useHostFeature(serverId, "topicWorkbenchV1");
  const supportsTaskLedger = useHostFeature(serverId, "workspaceTaskLedger");
  const [pendingProviderSwitch, setPendingProviderSwitch] = useState<{
    plan: CrossProviderSwitchDisclosurePlan;
    target: CrossProviderSwitchTarget;
    expectedSeat: { serverId: string; agentId: string };
  } | null>(null);
  const [isConfirmingProviderSwitch, setIsConfirmingProviderSwitch] = useState(false);
  const pendingProviderSwitchResolveRef = useRef<((switched: boolean) => void) | null>(null);
  const openDisclosureSeqRef = useRef(0);
  useEffect(() => {
    openDisclosureSeqRef.current += 1;
    setPendingProviderSwitch(null);
    pendingProviderSwitchResolveRef.current?.(false);
    pendingProviderSwitchResolveRef.current = null;
    return () => {
      pendingProviderSwitchResolveRef.current?.(false);
      pendingProviderSwitchResolveRef.current = null;
    };
  }, [agentId, serverId]);
  const agent = useSessionStore(
    useShallow((state) => selectAgentControlsSlice(state, serverId, agentId)),
  );
  const agentProvider = agent?.provider;
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const handoff = useCrossProviderAgentHandoff({ serverId, agentId });
  const { handoffToProvider } = handoff;
  const blankContextGate = useAtomicBlankContextSwitch(
    serverId,
    handoff.supportsSeamlessContextSwitch,
  );
  const toast = useToast();
  const modeControl = useLiveAgentModeControl(serverId, agentId);
  const commandCenterModes = toCommandCenterModes(modeControl);
  const modeProviderDefinitions = getModeProviderDefinitions(modeControl);

  const {
    entries: snapshotEntries,
    isLoading: snapshotIsLoading,
    isRefreshing: snapshotIsRefreshing,
    refresh: refreshSnapshot,
    refetchIfStale: refetchSnapshotIfStale,
  } = useProvidersSnapshot(serverId, { cwd: agent?.cwd });

  const snapshotSelectedEntry = useMemo(
    () => resolveProviderSnapshotEntry(snapshotEntries, agentProvider),
    [snapshotEntries, agentProvider],
  );

  const models = filterSelectableModels(snapshotSelectedEntry?.models ?? null);
  const selectedProviderIsLoading = snapshotSelectedEntry?.status === "loading";

  const agentModelSelectorProviders = useMemo(() => {
    const fallbackProviders: ProviderSelectorProvider[] = agentProvider
      ? [{ id: agentProvider, label: agentProvider, modelSelection: { kind: "loading" } }]
      : [];
    return resolveAgentControlsSelectorProviders({
      canSwitchProvider: handoff.canSwitchProvider,
      agentProvider,
      snapshotEntries,
      snapshotSelectedEntry,
      fallbackProviders,
      isConnected: Boolean(client),
    });
  }, [agentProvider, client, handoff.canSwitchProvider, snapshotEntries, snapshotSelectedEntry]);

  const modelSelection = resolveAgentModelSelection({
    models,
    runtimeModelId: agent?.runtimeModelId,
    configuredModelId: agent?.model,
    runtimeThinkingOptionId: agent?.runtimeThinkingOptionId,
    explicitThinkingOptionId: agent?.thinkingOptionId,
  });

  const modelOptions = useMemo<AgentControlOption[]>(() => {
    return (models ?? []).map((model) => ({ id: model.id, label: model.label }));
  }, [models]);

  const thinkingOptions = useMemo<AgentControlOption[]>(() => {
    return (modelSelection.thinkingOptions ?? []).map((option) => ({
      id: option.id,
      label: formatThinkingOptionLabel(option),
    }));
  }, [modelSelection.thinkingOptions]);

  const activeModelId = modelSelection.activeModelId;

  const applySameProviderPostModelSwitch = useStableEvent(
    async (input: {
      activeClient: NonNullable<typeof client>;
      targetModelLabel: string;
      thinkingPrecheck: ReturnType<typeof precheckModelThinkingCompatibility>;
      isSilentSeat: boolean;
      isRunning: boolean;
    }) => {
      const { activeClient, targetModelLabel, thinkingPrecheck, isSilentSeat, isRunning } = input;
      if (thinkingPrecheck.kind === "clear") {
        const notice = await activeClient.setAgentThinkingOption(agentId, null);
        showProviderNoticeToast(toast, notice);
        toast.show(t("topicWorkbench.modelSwitch.thinkingCleared", { model: targetModelLabel }));
        return;
      }
      if (thinkingPrecheck.kind === "adjust") {
        const notice = await activeClient.setAgentThinkingOption(
          agentId,
          thinkingPrecheck.thinkingOptionId,
        );
        showProviderNoticeToast(toast, notice);
        toast.show(
          t("topicWorkbench.modelSwitch.thinkingAdjusted", {
            model: targetModelLabel,
            thinking: thinkingPrecheck.thinkingLabel,
          }),
        );
        return;
      }
      if (isSilentSeat) {
        toast.show(
          t("topicWorkbench.modelSwitch.silentConfigUpdated", { model: targetModelLabel }),
        );
      } else if (isRunning) {
        toast.show(t("topicWorkbench.modelSwitch.runningNextTurn", { model: targetModelLabel }));
      }
    },
  );

  const handleSelectModel = useCallback(
    async (modelId: string) => {
      const currentSlice = selectAgentControlsSlice(useSessionStore.getState(), serverId, agentId);
      const provider = currentSlice?.provider;
      if (!client || !provider) {
        return;
      }
      const targetModel =
        models?.find((model) => model.id === modelId || model.aliases?.includes(modelId)) ?? null;
      const targetModelLabel = targetModel?.label ?? modelId;
      const thinkingPrecheck = precheckModelThinkingCompatibility({
        targetModel,
        currentThinkingOptionId:
          currentSlice.runtimeThinkingOptionId ?? currentSlice.thinkingOptionId ?? null,
        savedThinkingOptionId:
          preferences.providerPreferences?.[provider]?.thinkingByModel?.[modelId] ?? null,
      });
      const isSilentSeat = currentSlice.status === "closed" && !currentSlice.hasConversationHistory;
      const isRunning = isAgentTurnRunning(currentSlice.status, currentSlice.turnPhase);

      try {
        await client.setAgentModel(agentId, modelId);
        await applySameProviderPostModelSwitch({
          activeClient: client,
          targetModelLabel,
          thinkingPrecheck,
          isSilentSeat,
          isRunning,
        });
        await updatePreferences((current) =>
          mergeProviderPreferences({
            preferences: current,
            provider,
            updates: {
              model: modelId,
              ...(thinkingPrecheck.kind === "adjust"
                ? { thinkingByModel: { [modelId]: thinkingPrecheck.thinkingOptionId } }
                : {}),
            },
          }),
        );
      } catch (error) {
        console.warn("[AgentControls] setAgentModel or persist preference failed", error);
        toast.error(toErrorMessage(error));
      }
    },
    [
      agentId,
      applySameProviderPostModelSwitch,
      client,
      models,
      preferences.providerPreferences,
      serverId,
      toast,
      updatePreferences,
    ],
  );
  const settlePendingProviderSwitch = useCallback((switched: boolean) => {
    const resolve = pendingProviderSwitchResolveRef.current;
    pendingProviderSwitchResolveRef.current = null;
    resolve?.(switched);
  }, []);

  const executeModelCarrySummarySwitch = useStableEvent(
    async (targetProvider: AgentProvider, modelId: string) => {
      const currentProvider = selectAgentControlsSlice(
        useSessionStore.getState(),
        serverId,
        agentId,
      )?.provider;
      await routeAgentModelSelection({
        currentProvider,
        nextProvider: targetProvider,
        modelId,
        selectSameProviderModel: handleSelectModel,
        handoffToProvider: handoff.canSwitchProvider ? handoffToProvider : undefined,
        persistCrossProviderModelPreference: handoff.supportsSeamlessContextSwitch
          ? undefined
          : async (provider, selectedModel) => {
              await updatePreferences((current) =>
                mergeProviderPreferences({
                  preferences: current,
                  provider,
                  updates: { model: selectedModel || undefined },
                }),
              );
            },
      });
    },
  );
  const readLiveSwitchSnapshot = useStableEvent(
    (targetServerId: string, targetAgentId: string): LiveAgentSwitchSnapshot | null => {
      const liveState = useSessionStore.getState();
      const session = liveState.sessions[targetServerId];
      const liveAgent =
        session?.agents?.get(targetAgentId) ?? session?.agentDetails?.get(targetAgentId);
      const liveSlice = selectAgentControlsSlice(liveState, targetServerId, targetAgentId);
      if (!liveAgent || !liveSlice || liveAgent.archivedAt) {
        return null;
      }
      return {
        serverId: targetServerId,
        agentId: liveAgent.id,
        provider: liveSlice.provider,
        workspaceId: liveSlice.workspaceId,
        isMainControl: liveSlice.isMainControl,
        isRoleSeat: liveSlice.isRoleSeat,
        status: liveSlice.status,
        turnPhase: liveSlice.turnPhase,
        hasConversationHistory: liveSlice.hasConversationHistory,
        pendingPermissionsCount: liveSlice.pendingPermissionsCount,
        currentThinkingOptionId:
          liveSlice.runtimeThinkingOptionId ?? liveSlice.thinkingOptionId ?? null,
        livePermissions: session?.client?.getLastServerInfoMessage?.()?.permissions,
      };
    },
  );
  const readLiveTopicMetadata = useStableEvent(
    (
      snapshot: Pick<LiveAgentSwitchSnapshot, "serverId" | "isMainControl" | "workspaceId">,
    ): Promise<TopicMetadataDisclosureState> =>
      readLiveTopicMetadataDisclosure({
        client: useSessionStore.getState().sessions[snapshot.serverId]?.client ?? null,
        workspaceId: snapshot.workspaceId,
        isMainControl: snapshot.isMainControl,
        supportsTopic,
      }),
  );
  const createProviderSwitchPlan = useStableEvent(
    (input: {
      snapshot: LiveAgentSwitchSnapshot;
      target: CrossProviderSwitchTarget;
      topicMetadataState: TopicMetadataDisclosureState;
    }) => {
      const { snapshot, target, topicMetadataState } = input;
      const sourceEntry = resolveProviderSnapshotEntry(snapshotEntries, snapshot.provider);
      const targetEntry = resolveProviderSnapshotEntry(snapshotEntries, target.targetProvider);
      const targetModelId = target.modelId ?? "";
      const targetModel = targetModelId
        ? findProviderSnapshotModel(targetEntry, targetModelId)
        : null;
      const savedThinkingOptionId = targetModelId
        ? (preferences.providerPreferences?.[target.targetProvider]?.thinkingByModel?.[
            targetModelId
          ] ?? null)
        : null;
      const supportsAtomicBlankContextSwitch =
        blankContextGate.supportsFeature &&
        hasBlankContextSwitchPermissions(snapshot.livePermissions);
      return buildCrossProviderSwitchDisclosurePlan({
        sourceProvider: snapshot.provider,
        sourceProviderLabel: sourceEntry?.provider ?? snapshot.provider,
        targetProvider: target.targetProvider,
        targetProviderLabel: targetEntry?.provider ?? target.targetProvider,
        targetModelId,
        targetModelLabel: targetModel?.label ?? targetModelId,
        targetModel,
        currentThinkingOptionId: snapshot.currentThinkingOptionId,
        savedThinkingOptionId,
        skipThinkingPrecheck: target.kind === "profile",
        agentStatus: snapshot.status,
        turnPhase: snapshot.turnPhase,
        hasConversationHistory: snapshot.hasConversationHistory,
        // Real server prompt assembly (`withWorkspaceTopicPrompt` / `workspaceTaskLedgerPrompt`)
        // attaches topic metadata and workspace task ledger only to the Main Control seat.
        topicMetadataState,
        hasWorkspaceTaskLedger: Boolean(
          snapshot.isMainControl && supportsTaskLedger && snapshot.workspaceId,
        ),
        hasRolePrompt: snapshot.isRoleSeat,
        pendingPermissionsCount: snapshot.pendingPermissionsCount,
        supportsAtomicBlankContextSwitch,
      });
    },
  );
  const openCrossProviderDisclosure = useStableEvent(
    async (target: CrossProviderSwitchTarget): Promise<boolean> => {
      const beforeSnapshot = readLiveSwitchSnapshot(serverId, agentId);
      if (!beforeSnapshot || !handoff.canSwitchProvider) return false;
      const normalizedTargetProvider = target.targetProvider.trim();
      if (!normalizedTargetProvider || normalizedTargetProvider === beforeSnapshot.provider) {
        return false;
      }
      const requestSeq = openDisclosureSeqRef.current + 1;
      openDisclosureSeqRef.current = requestSeq;
      let topicMetadataState = await readLiveTopicMetadata(beforeSnapshot);
      if (openDisclosureSeqRef.current !== requestSeq) return false;
      let postSnapshot = readLiveSwitchSnapshot(serverId, agentId);
      if (!postSnapshot || postSnapshot.provider === normalizedTargetProvider) return false;
      if (
        postSnapshot.workspaceId !== beforeSnapshot.workspaceId ||
        postSnapshot.isMainControl !== beforeSnapshot.isMainControl
      ) {
        topicMetadataState = await readLiveTopicMetadata(postSnapshot);
        if (openDisclosureSeqRef.current !== requestSeq) return false;
        postSnapshot = readLiveSwitchSnapshot(serverId, agentId);
        if (!postSnapshot || postSnapshot.provider === normalizedTargetProvider) return false;
      }
      const normalizedTarget: CrossProviderSwitchTarget = {
        ...target,
        targetProvider: normalizedTargetProvider,
      };
      const plan = createProviderSwitchPlan({
        snapshot: postSnapshot,
        target: normalizedTarget,
        topicMetadataState,
      });
      if (plan.isSilentSeat && !blankContextGate.supportsFeature) {
        toast.error(t("topicWorkbench.modelSwitch.blankContextUpdateHost"));
        return false;
      }
      if (plan.isSilentSeat && !hasBlankContextSwitchPermissions(postSnapshot.livePermissions)) {
        toast.error(t("providerSelection.unavailable"));
        return false;
      }
      settlePendingProviderSwitch(false);
      return new Promise<boolean>((resolve) => {
        pendingProviderSwitchResolveRef.current = resolve;
        setPendingProviderSwitch({
          plan,
          target: normalizedTarget,
          expectedSeat: { serverId, agentId },
        });
      });
    },
  );
  const handleSelectProviderAndModel = useStableEvent(
    async (nextProvider: string, modelId: string) => {
      const currentSlice = selectAgentControlsSlice(useSessionStore.getState(), serverId, agentId);
      const currentProvider = currentSlice?.provider;
      if (!currentProvider || !currentSlice) return;
      const normalizedTargetProvider = nextProvider.trim() || currentProvider;
      if (normalizedTargetProvider === currentProvider) {
        await handleSelectModel(modelId);
        return;
      }
      await openCrossProviderDisclosure({
        kind: "model",
        targetProvider: normalizedTargetProvider,
        modelId,
      });
    },
  );
  const handleCancelProviderSwitch = useCallback(() => {
    if (!isConfirmingProviderSwitch) {
      setPendingProviderSwitch(null);
      settlePendingProviderSwitch(false);
    }
  }, [isConfirmingProviderSwitch, settlePendingProviderSwitch]);
  const runConfirmProviderSwitch = useStableEvent(
    async (
      pending: {
        plan: CrossProviderSwitchDisclosurePlan;
        target: CrossProviderSwitchTarget;
        expectedSeat: { serverId: string; agentId: string };
      },
      contextMode: CrossProviderContextMode,
    ) => {
      setIsConfirmingProviderSwitch(true);
      try {
        const result = await confirmCrossProviderSwitchFlow({
          plan: pending.plan,
          target: pending.target,
          contextMode,
          expectedSeat: pending.expectedSeat,
          canSwitchProvider: handoff.canSwitchProvider,
          supportsBlankFeature: blankContextGate.supportsFeature,
          readLiveSnapshot: () =>
            readLiveSwitchSnapshot(pending.expectedSeat.serverId, pending.expectedSeat.agentId),
          readLiveTopicMetadata,
          rebuildPlan: (snapshot, topicMetadataState) =>
            createProviderSwitchPlan({
              snapshot,
              target: pending.target,
              topicMetadataState,
            }),
          handoffToProvider,
          executeModelCarrySummary: executeModelCarrySummarySwitch,
        });
        if (result.status === "disclosure-changed") {
          setPendingProviderSwitch((current) =>
            current ? { ...current, plan: result.updatedPlan } : null,
          );
          return;
        }
        if (result.status === "cancelled") {
          setPendingProviderSwitch(null);
          settlePendingProviderSwitch(false);
          return;
        }
        if (result.status === "blocked") {
          toast.error(
            result.reason === "update-host"
              ? t("topicWorkbench.modelSwitch.blankContextUpdateHost")
              : t("providerSelection.unavailable"),
          );
          setPendingProviderSwitch(null);
          settlePendingProviderSwitch(false);
          return;
        }
        setPendingProviderSwitch(null);
        settlePendingProviderSwitch(result.switched);
      } catch (error) {
        console.warn("[AgentControls] cross-provider switch failed", error);
        toast.error(toErrorMessage(error));
        setPendingProviderSwitch(null);
        settlePendingProviderSwitch(false);
      } finally {
        setIsConfirmingProviderSwitch(false);
      }
    },
  );
  const handleConfirmProviderSwitch = useCallback(
    (contextMode: CrossProviderContextMode) => {
      if (!pendingProviderSwitch || isConfirmingProviderSwitch) return;
      void runConfirmProviderSwitch(pendingProviderSwitch, contextMode);
    },
    [isConfirmingProviderSwitch, pendingProviderSwitch, runConfirmProviderSwitch],
  );

  const profileProviders = useMemo(
    () =>
      resolveAgentControlsProfileProviders({
        canSwitchProvider: handoff.canSwitchProvider,
        agentProvider,
        snapshotEntries,
      }),
    [agentProvider, handoff.canSwitchProvider, snapshotEntries],
  );
  const profileModeIds = useMemo(
    () => resolveSnapshotModeIds(snapshotSelectedEntry),
    [snapshotSelectedEntry],
  );
  const handleSwitchProviderProfile = useCallback(
    (profile: MaterializedAgentProfile) =>
      openCrossProviderDisclosure({
        kind: "profile",
        targetProvider: profile.provider,
        modelId: profile.modelId || null,
        modeId: profile.modeId || null,
        thinkingOptionId: profile.thinkingOptionId || null,
        providerOptions: profile.options,
      }),
    [openCrossProviderDisclosure],
  );
  const profileTarget = useMemo<AgentProfileApplyTarget>(
    () => ({
      kind: "agent",
      agentId,
      availableModeIds: profileModeIds,
      currentProvider: agentProvider,
      onSwitchProvider: handoff.canSwitchProvider ? handleSwitchProviderProfile : undefined,
      switchesProviderInPlace: handoff.supportsSeamlessContextSwitch,
    }),
    [
      agentId,
      agentProvider,
      handoff.canSwitchProvider,
      handoff.supportsSeamlessContextSwitch,
      handleSwitchProviderProfile,
      profileModeIds,
    ],
  );
  const agentProfiles = useAgentProfilePicker({
    serverId,
    availableProviders: profileProviders,
    target: profileTarget,
  });
  const handleEditAgentProfiles = useEditAgentProfilesNavigation(serverId, agentProfiles !== null);
  const profileEditor = useAgentProfileEditor(serverId);
  const profileActions = resolveAgentProfileEditorActions(agentProfiles !== null, profileEditor);

  const handleSelectThinkingOption = useCallback(
    (thinkingOptionId: string) => {
      if (!client || !agentProvider) {
        return;
      }
      if (activeModelId) {
        void updatePreferences((current) =>
          mergeProviderPreferences({
            preferences: current,
            provider: agentProvider,
            updates: {
              model: activeModelId,
              thinkingByModel: {
                [activeModelId]: thinkingOptionId,
              },
            },
          }),
        ).catch((error) => {
          console.warn("[AgentControls] persist thinking preference failed", error);
        });
      }
      void client
        .setAgentThinkingOption(agentId, thinkingOptionId)
        .then((notice) => showProviderNoticeToast(toast, notice))
        .catch((error) => {
          console.warn("[AgentControls] setAgentThinkingOption failed", error);
          toast.error(toErrorMessage(error));
        });
    },
    [activeModelId, agentId, agentProvider, client, toast, updatePreferences],
  );

  const handleSetOption = useCallback(
    (key: string, value: unknown) => {
      if (!client || !agentProvider) {
        return;
      }
      void updatePreferences((current) =>
        mergeProviderPreferences({
          preferences: current,
          provider: agentProvider,
          updates: {
            options: {
              [key]: value,
            },
          },
        }),
      ).catch((error) => {
        console.warn("[AgentControls] persist option preference failed", error);
      });
      void client.setAgentOptions(agentId, { [key]: value }).catch((error) => {
        console.warn("[AgentControls] setAgentOptions failed", error);
        toast.error(toErrorMessage(error));
      });
    },
    [agentId, agentProvider, client, toast, updatePreferences],
  );

  const agentOptionControls = useAgentOptionControls(agent, handleSetOption);

  // The agent's composer exists apart from this component; while this is mounted, prompt
  // commands go through the input the user is typing in.
  const composer = useMemo(() => agentComposer(serverId, agentId), [agentId, serverId]);
  const composerInput = useComposerInput();
  useEffect(
    () =>
      composerInput
        ? composer.attachInput({
            isLive: composerInput.isLive,
            setText: composerInput.setText,
            insertText: composerInput.insertText,
            isRevealed: composerInput.isRevealed,
            focus: composerInput.focus,
          })
        : undefined,
    [composer, composerInput],
  );

  const commandCenterControls = useMemo<AgentControlCommandCenterSource>(
    () => ({
      serverId,
      ownerKey: agentId,
      provider: agentProvider,
      providerDefinitions: modeProviderDefinitions,
      models: {
        providers: agentModelSelectorProviders,
        selectedProvider: agentProvider,
        selectedModelId: activeModelId,
        select: handleSelectProviderAndModel,
      },
      thinking: {
        options: modelSelection.thinkingOptions,
        selectedId: modelSelection.selectedThinkingId,
        select: handleSelectThinkingOption,
      },
      modes: commandCenterModes,
      optionControls: client ? agentOptionControls : null,
    }),
    [
      activeModelId,
      agentOptionControls,
      client,
      agentId,
      agentModelSelectorProviders,
      agentProvider,
      commandCenterModes,
      handleSelectProviderAndModel,
      handleSelectThinkingOption,
      modeProviderDefinitions,
      modelSelection.selectedThinkingId,
      modelSelection.thinkingOptions,
      serverId,
    ],
  );

  const commandCenterRegistration = (
    <AgentControlCommandCenterRegistration
      sourceId={`agent:${serverId}:${agentId}`}
      enabled={Boolean(client)}
      controls={commandCenterControls}
    />
  );

  const handleModelSelectorOpen = useCallback(() => {
    if (handoff.canSwitchProvider) {
      refetchSnapshotIfStale();
      return;
    }
    refetchSnapshotIfStale(agentProvider);
  }, [agentProvider, handoff.canSwitchProvider, refetchSnapshotIfStale]);

  const handleRetryModelProvider = useCallback(
    (provider: AgentProvider) => {
      void refreshSnapshot([provider]);
    },
    [refreshSnapshot],
  );

  if (!agent) {
    return null;
  }

  const isLiveAgentRunning = isAgentTurnRunning(agent.status, agent.turnPhase);

  return (
    <ComposerModelProvider value={composer}>
      {commandCenterRegistration}
      <ProviderSwitchDisclosureModal
        plan={pendingProviderSwitch?.plan ?? null}
        isRunning={isLiveAgentRunning}
        pending={isConfirmingProviderSwitch}
        onCancel={handleCancelProviderSwitch}
        onConfirm={handleConfirmProviderSwitch}
      />
      {showToolbar ? (
        <>
          {profileEditor.element}
          <ControlledAgentControls
            provider={agent.provider}
            modelSelectorProviders={agentModelSelectorProviders}
            modelOptions={modelOptions}
            selectedModelId={modelSelection.activeModelId ?? undefined}
            onSelectModel={handleSelectModel}
            onSelectProviderAndModel={
              handoff.canSwitchProvider ? handleSelectProviderAndModel : undefined
            }
            agentProfiles={agentProfiles}
            onApplyAgentProfile={agentProfiles?.applyProfile}
            onEditAgentProfiles={handleEditAgentProfiles}
            onCreateAgentProfile={profileActions.create}
            onEditAgentProfile={profileActions.edit}
            thinkingOptions={thinkingOptions.length > 0 ? thinkingOptions : undefined}
            selectedThinkingOptionId={modelSelection.selectedThinkingId ?? undefined}
            onSelectThinkingOption={handleSelectThinkingOption}
            optionControls={agentOptionControls}
            isModelLoading={snapshotIsLoading || selectedProviderIsLoading}
            onModelSelectorOpen={handleModelSelectorOpen}
            onRetryModelProvider={handleRetryModelProvider}
            isRetryingModelProvider={snapshotIsRefreshing}
            onDropdownClose={onDropdownClose}
            disabled={!client}
            modeControl={modeControl}
            modelSelectorServerId={serverId}
            isCompactLayout={isCompactLayout}
          />
        </>
      ) : null}
    </ComposerModelProvider>
  );
});

export function DraftAgentControls({
  showToolbar,
  draftId,
  serverId,
  providerDefinitions,
  selectedProvider,
  modeOptions,
  selectedMode,
  onSelectMode,
  models,
  selectedModel,
  effectiveModelId,
  onSelectModel,
  isModelLoading: _isModelLoading,
  modelSelectorProviders,
  isAllModelsLoading,
  onSelectProviderAndModel,
  thinkingOptions,
  selectedThinkingOptionId,
  onSelectThinkingOption,
  onApplyAgentProfile,
  optionControls,
  options,
  onSetOption,
  onDropdownClose,
  onModelSelectorOpen,
  onRetryModelProvider,
  isRetryingModelProvider = false,
  disabled = false,
  modelSelectorServerId = null,
  isCompactLayout,
  context = "draft",
  workspaceMain,
  batchModels,
  metadata,
  onSetMetadata,
}: DraftAgentControlsProps & { draftId: string; serverId: string; showToolbar: boolean }) {
  const mappedThinkingOptions = useMemo<AgentControlOption[]>(() => {
    return toThinkingControlOptions(thinkingOptions);
  }, [thinkingOptions]);

  const effectiveSelectedThinkingOption = selectedThinkingOptionId || mappedThinkingOptions[0]?.id;

  const modelOptions = useMemo<AgentControlOption[]>(
    () =>
      models.map((model) => ({
        id: model.id,
        label: model.label,
      })),
    [models],
  );

  // The draft form is the one surface that can switch provider, so every profile
  // the host can actually run is offered here.
  const profileProviders = useMemo(
    () => modelSelectorProviders.map((entry) => entry.id),
    [modelSelectorProviders],
  );
  const profileTarget = useMemo<AgentProfileApplyTarget>(
    () => ({
      kind: "draft",
      controls: {
        applyProfile: onApplyAgentProfile,
      },
    }),
    [onApplyAgentProfile],
  );
  const agentProfiles = useAgentProfilePicker({
    serverId: modelSelectorServerId,
    availableProviders: profileProviders,
    target: profileTarget,
  });
  const handleEditAgentProfiles = useEditAgentProfilesNavigation(
    modelSelectorServerId,
    agentProfiles !== null,
  );
  const profileEditor = useAgentProfileEditor(modelSelectorServerId);
  const profileActions = resolveAgentProfileEditorActions(agentProfiles !== null, profileEditor);

  const modeControl = useMemo<AgentModeControlValue | null>(
    () =>
      selectedProvider && modeOptions.length > 0
        ? {
            provider: selectedProvider,
            providerDefinitions,
            modeOptions,
            selectedModeId: selectedMode,
            onSelectMode,
            disabled,
          }
        : null,
    [selectedProvider, providerDefinitions, modeOptions, selectedMode, onSelectMode, disabled],
  );

  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  const isLocked = useCallback(() => disabledRef.current, []);
  const composerAgent = useMemo(
    () =>
      draftComposerAgent({
        context,
        disabled,
        isLocked,
        selectedProvider,
        selectedModel,
        selectedMode,
        thinking: effectiveSelectedThinkingOption ?? null,
        options,
        metadata,
        onSelectProviderAndModel,
        onSelectModel,
        onSelectMode,
        onSelectThinkingOption,
        onSetOption,
        onSetMetadata,
      }),
    [
      context,
      disabled,
      isLocked,
      effectiveSelectedThinkingOption,
      metadata,
      onSelectMode,
      onSelectModel,
      onSelectProviderAndModel,
      onSelectThinkingOption,
      onSetMetadata,
      onSetOption,
      options,
      selectedMode,
      selectedModel,
      selectedProvider,
    ],
  );

  const composerInput = useComposerInput();
  const composerModel = useMemo(
    () =>
      composerInput
        ? composerModelFromHalves({ agent: composerAgent, input: composerInput })
        : null,
    [composerAgent, composerInput],
  );

  const commandCenterControls = useMemo<AgentControlCommandCenterSource>(
    () => ({
      serverId,
      ownerKey: draftId,
      provider: selectedProvider,
      providerDefinitions,
      models: {
        providers: modelSelectorProviders,
        selectedProvider,
        selectedModelId: effectiveModelId,
        select: (provider, modelId) => {
          onSelectProviderAndModel(provider, modelId);
        },
      },
      thinking: {
        options: thinkingOptions,
        selectedId: selectedThinkingOptionId,
        select: onSelectThinkingOption,
      },
      modes: toCommandCenterModes(modeControl),
      optionControls: optionControls ?? null,
    }),
    [
      serverId,
      draftId,
      selectedProvider,
      providerDefinitions,
      modelSelectorProviders,
      effectiveModelId,
      onSelectProviderAndModel,
      thinkingOptions,
      selectedThinkingOptionId,
      onSelectThinkingOption,
      modeControl,
      optionControls,
    ],
  );

  return (
    <ComposerAgentProvider value={composerAgent}>
      <ComposerModelProvider value={composerModel}>
        <AgentControlCommandCenterRegistration
          sourceId={`draft:${serverId}:${draftId}`}
          enabled={!disabled}
          controls={commandCenterControls}
        />
        {showToolbar ? (
          <>
            {profileEditor.element}
            <ControlledAgentControls
              provider={selectedProvider ?? ""}
              modelSelectorProviders={modelSelectorProviders}
              modelOptions={modelOptions}
              selectedModelId={batchModels ? effectiveModelId : selectedModel}
              onSelectModel={onSelectModel}
              onSelectProviderAndModel={onSelectProviderAndModel}
              isModelLoading={isAllModelsLoading}
              agentProfiles={agentProfiles}
              onApplyAgentProfile={agentProfiles?.applyProfile}
              onEditAgentProfiles={handleEditAgentProfiles}
              onCreateAgentProfile={profileActions.create}
              onEditAgentProfile={profileActions.edit}
              thinkingOptions={mappedThinkingOptions.length > 0 ? mappedThinkingOptions : undefined}
              selectedThinkingOptionId={effectiveSelectedThinkingOption}
              onSelectThinkingOption={onSelectThinkingOption}
              optionControls={optionControls}
              onDropdownClose={onDropdownClose}
              onModelSelectorOpen={onModelSelectorOpen}
              onRetryModelProvider={onRetryModelProvider}
              isRetryingModelProvider={isRetryingModelProvider}
              disabled={disabled}
              modeControl={modeControl}
              modelSelectorServerId={modelSelectorServerId}
              isCompactLayout={isCompactLayout}
              workspaceMain={workspaceMain}
              batchModels={batchModels}
            />
          </>
        ) : null}
      </ComposerModelProvider>
    </ComposerAgentProvider>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    minWidth: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: TOOLBAR_CONTROL_GAP,
    // Clips pickers that run out of room.
    overflow: "hidden",
  },
  modelControl: {
    minWidth: 0,
    flexShrink: 1,
  },
  modeIconBadge: {
    ...toolbarSlot(),
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 0,
    flexShrink: 0,
    backgroundColor: "transparent",
    borderRadius: theme.borderRadius.full,
  },
  combinedSheetControls: {
    gap: theme.spacing[1],
  },
  glyph: { color: theme.colors.foreground },
  mutedGlyph: { color: theme.colors.foregroundMuted },
}));
