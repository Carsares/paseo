import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveModalSheet, SheetHeaderSubtitle } from "@/components/adaptive-modal-sheet";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { PressHighlight } from "@/components/ui/press-highlight";
import { useIsCompactFormFactor } from "@/constants/layout";
import {
  resolveCrossProviderOutboundItems,
  type CrossProviderContextMode,
  type CrossProviderOutboundItem,
  type CrossProviderSwitchDisclosurePlan,
} from "./model-sheet-flow";

interface ProviderSwitchDisclosureModalProps {
  plan: CrossProviderSwitchDisclosurePlan | null;
  /** Live subscribed turn-running state so confirm re-enables automatically once a turn settles. */
  isRunning?: boolean;
  pending: boolean;
  onCancel: () => void;
  onConfirm: (contextMode: CrossProviderContextMode) => void;
}

function outboundItemKey(item: CrossProviderOutboundItem) {
  switch (item) {
    case "handoff-summary":
      return "topicWorkbench.modelSwitch.outboundHandoffSummary" as const;
    case "topic-metadata":
      return "topicWorkbench.modelSwitch.outboundTopicMetadata" as const;
    case "topic-hidden":
      return "topicWorkbench.modelSwitch.outboundTopicHidden" as const;
    case "topic-unverified":
      return "topicWorkbench.modelSwitch.outboundTopicUnverified" as const;
    case "task-ledger":
      return "topicWorkbench.modelSwitch.outboundTaskLedger" as const;
    case "role-prompt":
      return "topicWorkbench.modelSwitch.outboundRolePrompt" as const;
    case "blank-only":
      return "topicWorkbench.modelSwitch.outboundNoneBlank" as const;
  }
}

function DisclosureAlerts({
  plan,
  isRunning,
}: {
  plan: CrossProviderSwitchDisclosurePlan;
  isRunning: boolean;
}) {
  const { t } = useTranslation();
  return (
    <>
      {isRunning ? (
        <Alert variant="warning" title={t("topicWorkbench.modelSwitch.runningWaitNote")} />
      ) : null}

      {plan.isSilentSeat ? (
        <Alert variant="info" title={t("topicWorkbench.modelSwitch.silentSeatNote")} />
      ) : null}

      {plan.pendingPermissionsCount > 0 ? (
        <Alert
          variant="warning"
          title={t("topicWorkbench.modelSwitch.pendingPermissionsNote", {
            count: plan.pendingPermissionsCount,
          })}
        />
      ) : null}

      {plan.disclosureChangedReason === "topic" ? (
        <Alert
          variant="warning"
          title={t("topicWorkbench.modelSwitch.topicDisclosureChangedNote")}
        />
      ) : null}

      {plan.disclosureChangedReason === "session" ? (
        <Alert variant="warning" title={t("topicWorkbench.modelSwitch.sessionStateChangedNote")} />
      ) : null}

      {plan.topicMetadataState.status === "unverified" ? (
        <Alert
          variant="warning"
          title={t("topicWorkbench.modelSwitch.topicDisclosureUnverifiedNote")}
        />
      ) : null}

      {plan.thinkingPrecheck.kind === "adjust" ? (
        <Text style={styles.hint} testID="provider-switch-thinking-precheck">
          {t("topicWorkbench.modelSwitch.thinkingPrecheckAdjusted", {
            thinking: plan.thinkingPrecheck.thinkingLabel,
          })}
        </Text>
      ) : null}

      {plan.thinkingPrecheck.kind === "clear" ? (
        <Text style={styles.hint} testID="provider-switch-thinking-precheck">
          {t("topicWorkbench.modelSwitch.thinkingPrecheckCleared")}
        </Text>
      ) : null}
    </>
  );
}

export function ProviderSwitchDisclosureModal({
  plan,
  isRunning,
  pending,
  onCancel,
  onConfirm,
}: ProviderSwitchDisclosureModalProps) {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const size = isCompact ? "md" : "sm";
  const [contextMode, setContextMode] = useState<CrossProviderContextMode>("carry-summary");
  const defaultContextMode = plan?.defaultContextMode ?? null;
  const planSessionKey = plan
    ? `${plan.sourceProvider}:${plan.targetProvider}:${plan.targetModelId}:${plan.targetModelLabel}:${plan.isSilentSeat ? "1" : "0"}:${plan.canChooseFreshBlank ? "1" : "0"}`
    : null;

  useEffect(() => {
    if (planSessionKey && defaultContextMode) {
      setContextMode(defaultContextMode);
    }
  }, [defaultContextMode, planSessionKey]);

  const header = useMemo(
    () =>
      plan
        ? {
            title: t("topicWorkbench.modelSwitch.crossProviderTitle", {
              target: plan.targetModelLabel
                ? `${plan.targetProviderLabel} · ${plan.targetModelLabel}`
                : plan.targetProviderLabel,
            }),
            subtitle: (
              <SheetHeaderSubtitle
                text={t("topicWorkbench.modelSwitch.crossProviderSubtitle", {
                  source: plan.sourceProviderLabel,
                  target: plan.targetProviderLabel,
                })}
              />
            ),
          }
        : { title: "" },
    [plan, t],
  );

  const outboundItems = useMemo(
    () => (plan ? resolveCrossProviderOutboundItems(plan, contextMode) : []),
    [contextMode, plan],
  );

  const selectCarrySummary = useCallback(() => setContextMode("carry-summary"), []);
  const selectFreshBlank = useCallback(() => setContextMode("fresh-blank"), []);
  const handleConfirm = useCallback(() => onConfirm(contextMode), [contextMode, onConfirm]);
  const accessibilityByMode = useMemo(
    () => ({
      carrySummary: { checked: contextMode === "carry-summary", disabled: pending },
      freshBlank: { checked: contextMode === "fresh-blank", disabled: pending },
    }),
    [contextMode, pending],
  );

  if (!plan) {
    return null;
  }

  const effectiveIsRunning = isRunning ?? plan.isRunning;
  const confirmDisabled = pending || effectiveIsRunning;

  return (
    <AdaptiveModalSheet
      visible
      header={header}
      showCloseButton={!pending}
      onClose={onCancel}
      testID="provider-switch-disclosure-sheet"
    >
      <View style={styles.body}>
        <DisclosureAlerts plan={plan} isRunning={effectiveIsRunning} />

        {!plan.isSilentSeat ? (
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>
              {t("topicWorkbench.modelSwitch.contextModeTitle")}
            </Text>
            <View style={styles.card}>
              <PressHighlight
                style={[styles.modeRow, contextMode === "carry-summary" && styles.modeRowSelected]}
                highlightStyle={styles.rowHighlight}
                accessibilityRole="radio"
                accessibilityState={accessibilityByMode.carrySummary}
                disabled={pending}
                onPress={selectCarrySummary}
                testID="provider-switch-mode-carry"
              >
                <View style={styles.modeContent}>
                  <Text style={styles.modeTitle}>
                    {t("topicWorkbench.modelSwitch.contextCarrySummary")}
                  </Text>
                  <Text style={styles.modeHint}>
                    {t("topicWorkbench.modelSwitch.contextCarrySummaryHint", {
                      provider: plan.targetProviderLabel,
                    })}
                  </Text>
                </View>
              </PressHighlight>
              {plan.canChooseFreshBlank ? (
                <PressHighlight
                  style={[
                    styles.modeRow,
                    styles.rowBorder,
                    contextMode === "fresh-blank" && styles.modeRowSelected,
                  ]}
                  highlightStyle={styles.rowHighlight}
                  accessibilityRole="radio"
                  accessibilityState={accessibilityByMode.freshBlank}
                  disabled={pending}
                  onPress={selectFreshBlank}
                  testID="provider-switch-mode-blank"
                >
                  <View style={styles.modeContent}>
                    <Text style={styles.modeTitle}>
                      {t("topicWorkbench.modelSwitch.contextFreshBlank")}
                    </Text>
                    <Text style={styles.modeHint}>
                      {t("topicWorkbench.modelSwitch.contextFreshBlankHint")}
                    </Text>
                  </View>
                </PressHighlight>
              ) : null}
            </View>
          </View>
        ) : null}

        <View style={styles.section}>
          <Text style={styles.sectionLabel}>
            {t("topicWorkbench.modelSwitch.outboundTitle", {
              provider: plan.targetProviderLabel,
            })}
          </Text>
          <View style={styles.card}>
            {outboundItems.map((item, index) => (
              <View
                key={item}
                style={[styles.outboundRow, index > 0 && styles.rowBorder]}
                testID={`provider-switch-outbound-${item}`}
              >
                <Text style={styles.outboundText}>{t(outboundItemKey(item))}</Text>
              </View>
            ))}
          </View>
        </View>

        <View style={styles.actions}>
          <Button variant="secondary" size={size} disabled={pending} onPress={onCancel}>
            {t("common.actions.cancel")}
          </Button>
          <Button
            variant="default"
            size={size}
            disabled={confirmDisabled}
            loading={pending}
            onPress={handleConfirm}
            testID="provider-switch-confirm"
          >
            {t("topicWorkbench.modelSwitch.confirmSwitch")}
          </Button>
        </View>
      </View>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: {
    gap: theme.spacing[3],
  },
  section: {
    gap: theme.spacing[1.5],
  },
  sectionLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  hint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  card: {
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface1,
    overflow: "hidden",
  },
  rowBorder: {
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
  },
  modeRow: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  modeRowSelected: {
    backgroundColor: theme.colors.surface2,
  },
  rowHighlight: {
    backgroundColor: theme.colors.interactionHighlight,
  },
  modeContent: {
    gap: theme.spacing[0.5],
  },
  modeTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
  },
  modeHint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  outboundRow: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  outboundText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  actions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
  },
}));
