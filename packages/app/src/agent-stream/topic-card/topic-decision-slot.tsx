import type {
  TopicBlockingResolutionKind,
  WorkspaceDurableItem,
  WorkspaceDurableItemEvidence,
} from "@getpaseo/protocol/messages";
import {
  Check,
  CircleHelp,
  ExternalLink,
  RefreshCw,
  RotateCcw,
  Send,
  X,
} from "lucide-react-native";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { AdaptiveTextInput } from "@/components/adaptive-text-input";
import { Button } from "@/components/ui/button";
import { PressHighlight } from "@/components/ui/press-highlight";
import { StatusBadge } from "@/components/ui/status-badge";
import { useIsCompactFormFactor } from "@/constants/layout";
import { DurableItemEvidenceDetails } from "@/durable-items/evidence";
import { getDurableItemDecisionBlock, type DurableItemDecision } from "@/durable-items/model";
import { useActiveWorkspaceSheetOpener } from "@/screens/workspace/sheet-pane/active-workspace";
import type { WorkspaceSheetPage } from "@/screens/workspace/sheet-pane/stack";
import { useWorkspaceSheetPages } from "@/screens/workspace/sheet-pane/stack-context";
import {
  buildTopicDisclosureKey,
  useTopicStreamViewStore,
  type TopicDecisionDraftMeta,
} from "@/stores/topic-stream-view-store";
import type { Theme } from "@/styles/theme";
import { generateMessageId } from "@/types/stream";
import { useDisclosureHold } from "../disclosure";
import type { TopicBlockingPrompt, TopicUnit } from "./model";

const warningIconMapping = (theme: Theme) => ({ color: theme.colors.statusWarning });
const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const ThemedHelp = withUnistyles(CircleHelp, warningIconMapping);
const ThemedCheck = withUnistyles(Check, mutedIconMapping);
const ThemedRotate = withUnistyles(RotateCcw, mutedIconMapping);
const ThemedClose = withUnistyles(X, mutedIconMapping);
const ThemedSend = withUnistyles(Send, mutedIconMapping);
const ThemedRefresh = withUnistyles(RefreshCw, mutedIconMapping);
const ThemedExternalLink = withUnistyles(ExternalLink, mutedIconMapping);

const DECISIONS: readonly DurableItemDecision[] = ["approve", "request_changes", "reject"];

const SELECTED_STATE = { selected: true } as const;
const UNSELECTED_STATE = { selected: false } as const;

export interface TopicDecisionSubmitInput {
  topic: TopicUnit;
  resolutionKind: TopicBlockingResolutionKind;
  clientMessageId: string;
  expectedBlockingQuestionGeneration?: string;
  durableItem?: WorkspaceDurableItem;
  decision?: DurableItemDecision;
  note?: string;
}

export type TopicDecisionSubmitResult =
  | { outcome: "saved" }
  | { outcome: "evidenceStale"; message?: string }
  | {
      outcome: "staleBlockingQuestion";
      message?: string;
      latestBlockingQuestionGeneration?: string;
      hasLatestTask?: boolean;
    }
  | { outcome: "conflict"; message?: string }
  | { outcome: "error"; message: string };

export interface TopicDecisionSlotProps {
  agentKey: string;
  serverId?: string;
  workspaceId?: string;
  topic: TopicUnit;
  prompt: TopicBlockingPrompt;
  supportsButlerV1?: boolean;
  durableItemsOnline?: boolean;
  durableItemsConfirmed?: boolean;
  onRefreshDurableItems?: () => void;
  onOpenStandaloneDurableItem?: (item: WorkspaceDurableItem) => void;
  onSubmitDecision?: (input: TopicDecisionSubmitInput) => Promise<TopicDecisionSubmitResult>;
  onActivateCompactDecision?: (
    topic: TopicUnit,
    question: string,
    blockingQuestionGeneration?: string,
  ) => void;
}

function evidenceKey(evidence: WorkspaceDurableItemEvidence): string {
  return JSON.stringify([
    evidence.type,
    evidence.path,
    evidence.type === "git" ? evidence.repoRoot : null,
  ]);
}

function buildCompactEvidencePage(input: {
  serverId: string;
  workspaceId: string;
  item: WorkspaceDurableItem;
  evidence: WorkspaceDurableItemEvidence;
  key: string;
}): WorkspaceSheetPage {
  const { serverId, workspaceId, item, evidence, key } = input;
  return {
    key: JSON.stringify([
      "topic-decision-evidence",
      serverId,
      workspaceId,
      item.requestId,
      item.revision,
      key,
    ]),
    title: evidence.path,
    render: () => (
      <DurableItemEvidenceDetails
        serverId={serverId}
        workspaceId={workspaceId}
        evidence={evidence}
      />
    ),
    scrollable: true,
  };
}

const EvidencePillRow = memo(function EvidencePillRow({
  serverId,
  workspaceId,
  evidence,
  expanded,
  onPress,
}: {
  serverId: string;
  workspaceId: string;
  evidence: WorkspaceDurableItemEvidence;
  expanded: boolean;
  onPress: (evidence: WorkspaceDurableItemEvidence) => void;
}) {
  const handlePress = useCallback(() => onPress(evidence), [evidence, onPress]);
  const accessibilityState = useMemo(() => ({ expanded }), [expanded]);
  return (
    <View style={styles.evidenceRow}>
      <Button
        size="sm"
        variant="outline"
        numberOfLines={1}
        accessibilityState={accessibilityState}
        onPress={handlePress}
        testID={`topic-decision-evidence-${evidence.path}`}
      >
        {evidence.path}
      </Button>
      {expanded ? (
        <DurableItemEvidenceDetails
          serverId={serverId}
          workspaceId={workspaceId}
          evidence={evidence}
        />
      ) : null}
    </View>
  );
});

const DecisionOptionPill = memo(function DecisionOptionPill({
  option,
  index,
  selected,
  disabled,
  onSelect,
}: {
  option: string;
  index: number;
  selected: boolean;
  disabled: boolean;
  onSelect: (option: string) => void;
}) {
  const handlePress = useCallback(() => onSelect(option), [onSelect, option]);
  return (
    <PressHighlight
      accessibilityRole="button"
      accessibilityState={selected ? SELECTED_STATE : UNSELECTED_STATE}
      disabled={disabled}
      onPress={handlePress}
      style={[styles.optionPill, selected && styles.optionPillSelected]}
      testID={`topic-decision-option-${index}`}
    >
      <Text style={[styles.optionPillText, selected && styles.optionPillTextSelected]}>
        {option}
      </Text>
    </PressHighlight>
  );
});

const DurableActionIcon = memo(function DurableActionIcon({
  decision,
}: {
  decision: DurableItemDecision;
}) {
  if (decision === "approve") return <ThemedCheck size={12} />;
  if (decision === "request_changes") return <ThemedRotate size={12} />;
  return <ThemedClose size={12} />;
});

const DurableDecisionButton = memo(function DurableDecisionButton({
  topicKey,
  decision,
  isAcceptance,
  loading,
  disabled,
  onPress,
}: {
  topicKey: string;
  decision: DurableItemDecision;
  isAcceptance: boolean;
  loading: boolean;
  disabled: boolean;
  onPress: (decision: DurableItemDecision) => void;
}) {
  const { t } = useTranslation();
  const handlePress = useCallback(() => onPress(decision), [decision, onPress]);
  const label =
    decision === "approve" && isAcceptance
      ? t("topicWorkbench.durableItems.accept")
      : t(`topicWorkbench.durableItems.action.${decision}`);

  return (
    <Button
      size="sm"
      variant={decision === "approve" ? "default" : "outline"}
      loading={loading}
      disabled={disabled}
      onPress={handlePress}
      testID={`topic-decision-action-${decision}-${topicKey}`}
    >
      <DurableActionIcon decision={decision} />
      {label}
    </Button>
  );
});

const StandaloneDurableItemRedirectSection = memo(function StandaloneDurableItemRedirectSection({
  topicKey,
  item,
  onOpenStandalone,
}: {
  topicKey: string;
  item: WorkspaceDurableItem;
  onOpenStandalone?: (item: WorkspaceDurableItem) => void;
}) {
  const { t } = useTranslation();
  const handlePress = useCallback(() => {
    onOpenStandalone?.(item);
  }, [item, onOpenStandalone]);

  return (
    <View style={styles.container} testID={`topic-decision-slot-${topicKey}`}>
      <View style={styles.headerRow}>
        <StatusBadge
          size="xs"
          variant="warning"
          label={t(`topicWorkbench.durableItems.kind.${item.kind}`)}
        />
        <Text style={styles.title} numberOfLines={2}>
          {item.title}
        </Text>
      </View>

      {item.summary ? <Text style={styles.bodyText}>{item.summary}</Text> : null}

      <Text style={styles.legacyNotice} testID={`topic-decision-standalone-hint-${topicKey}`}>
        {t(
          item.kind === "authorization"
            ? "topicWorkbench.topicStream.decisionAuthorizationStandaloneHint"
            : "topicWorkbench.topicStream.decisionStandaloneRequiredHint",
        )}
      </Text>

      <View style={styles.actionsRow}>
        <Button
          size="sm"
          variant="secondary"
          disabled={!onOpenStandalone}
          onPress={handlePress}
          testID={`topic-decision-open-standalone-${topicKey}`}
        >
          <ThemedExternalLink size={12} />
          {t("topicWorkbench.topicStream.decisionOpenStandalone")}
        </Button>
      </View>
    </View>
  );
});

const DurableItemDecisionSection = memo(function DurableItemDecisionSection({
  serverId,
  workspaceId,
  topic,
  item,
  draftText,
  inputResetKey,
  durableItemsOnline,
  durableItemsConfirmed,
  staleEvidenceRevision,
  submittingAction,
  feedback,
  onChangeDraft,
  onRefreshDurableItems,
  onSubmitDurable,
}: {
  serverId?: string;
  workspaceId?: string;
  topic: TopicUnit;
  item: WorkspaceDurableItem;
  draftText: string;
  inputResetKey: number;
  durableItemsOnline: boolean;
  durableItemsConfirmed: boolean;
  staleEvidenceRevision?: number;
  submittingAction: string | null;
  feedback: string | null;
  onChangeDraft: (next: string) => void;
  onRefreshDurableItems?: () => void;
  onSubmitDurable: (decision: DurableItemDecision) => void;
}) {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const hold = useDisclosureHold();
  const sheetStack = useWorkspaceSheetPages();
  const openActiveWorkspaceSheet = useActiveWorkspaceSheetOpener();
  const [openEvidenceKey, setOpenEvidenceKey] = useState<string | null>(null);

  const toggleEvidenceKey = useCallback((key: string) => {
    setOpenEvidenceKey((current) => (current === key ? null : key));
  }, []);

  const handleOpenEvidence = useCallback(
    (evidence: WorkspaceDurableItemEvidence) => {
      if (!serverId || !workspaceId) return;
      const key = evidenceKey(evidence);
      if (isCompact) {
        const page = buildCompactEvidencePage({ serverId, workspaceId, item, evidence, key });
        if (openActiveWorkspaceSheet) {
          openActiveWorkspaceSheet(page);
          return;
        }
        if (sheetStack) {
          sheetStack.push(page);
          return;
        }
      }
      hold(() => toggleEvidenceKey(key));
    },
    [
      hold,
      isCompact,
      item,
      openActiveWorkspaceSheet,
      serverId,
      sheetStack,
      toggleEvidenceKey,
      workspaceId,
    ],
  );

  const approveBlock = getDurableItemDecisionBlock({
    item,
    online: durableItemsOnline,
    confirmed: durableItemsConfirmed,
    staleEvidenceRevision,
    decision: "approve",
  });
  const showRefreshButton =
    Boolean(onRefreshDurableItems) &&
    (approveBlock === "evidenceStale" || staleEvidenceRevision === item.revision);

  return (
    <View style={styles.container} testID={`topic-decision-slot-${topic.topicKey}`}>
      <View style={styles.headerRow}>
        <StatusBadge
          size="xs"
          variant="warning"
          label={t(`topicWorkbench.durableItems.kind.${item.kind}`)}
        />
        <Text style={styles.title} numberOfLines={2}>
          {item.title}
        </Text>
      </View>

      {item.summary ? <Text style={styles.bodyText}>{item.summary}</Text> : null}

      {item.evidence.length > 0 && serverId && workspaceId ? (
        <View style={styles.evidenceList}>
          {item.evidence.map((evidence) => {
            const key = evidenceKey(evidence);
            return (
              <EvidencePillRow
                key={key}
                serverId={serverId}
                workspaceId={workspaceId}
                evidence={evidence}
                expanded={openEvidenceKey === key}
                onPress={handleOpenEvidence}
              />
            );
          })}
        </View>
      ) : null}

      {approveBlock ? (
        <View style={styles.warningRow}>
          <Text style={styles.warningText} accessibilityLiveRegion="polite">
            {approveBlock === "evidenceStale"
              ? t("topicWorkbench.topicStream.decisionEvidenceStale")
              : t(`topicWorkbench.durableItems.${approveBlock}`)}
          </Text>
          {showRefreshButton ? (
            <Button
              size="sm"
              variant="ghost"
              onPress={onRefreshDurableItems}
              testID={`topic-decision-refresh-${topic.topicKey}`}
            >
              <ThemedRefresh size={12} />
              {t("topicWorkbench.durableItems.refresh")}
            </Button>
          ) : null}
        </View>
      ) : null}

      <AdaptiveTextInput
        initialValue={draftText}
        resetKey={inputResetKey}
        onChangeText={onChangeDraft}
        placeholder={t("topicWorkbench.topicStream.decisionNotePlaceholder")}
        style={styles.textInput}
        editable={submittingAction === null}
        testID={`topic-decision-note-input-${topic.topicKey}`}
      />

      <View style={styles.actionsRow}>
        {DECISIONS.map((decision) => {
          const decisionBlock = getDurableItemDecisionBlock({
            item,
            online: durableItemsOnline,
            confirmed: durableItemsConfirmed,
            staleEvidenceRevision,
            decision,
          });
          return (
            <DurableDecisionButton
              key={decision}
              topicKey={topic.topicKey}
              decision={decision}
              isAcceptance={item.kind === "acceptance"}
              loading={submittingAction === decision}
              disabled={submittingAction !== null || Boolean(decisionBlock)}
              onPress={onSubmitDurable}
            />
          );
        })}
      </View>

      {feedback ? (
        <Text
          style={styles.feedbackText}
          accessibilityLiveRegion="polite"
          testID={`topic-decision-feedback-${topic.topicKey}`}
        >
          {feedback}
        </Text>
      ) : null}
    </View>
  );
});

const BlockingQuestionInputArea = memo(function BlockingQuestionInputArea({
  topicKey,
  supportsButlerV1,
  isCompact,
  draftText,
  inputResetKey,
  submitting,
  canSubmit,
  onChangeDraft,
  onSubmit,
  onOpenCompact,
}: {
  topicKey: string;
  supportsButlerV1: boolean;
  isCompact: boolean;
  draftText: string;
  inputResetKey: number;
  submitting: boolean;
  canSubmit: boolean;
  onChangeDraft: (next: string) => void;
  onSubmit: () => void;
  onOpenCompact: () => void;
}) {
  const { t } = useTranslation();

  if (!supportsButlerV1) {
    return (
      <Text style={styles.legacyNotice} testID={`topic-decision-legacy-notice-${topicKey}`}>
        {t("topicWorkbench.topicStream.decisionLegacyHostNotice")}
      </Text>
    );
  }

  if (isCompact) {
    return (
      <View style={styles.compactDecisionRow}>
        {draftText.trim().length > 0 ? (
          <Button
            size="sm"
            variant="default"
            loading={submitting}
            disabled={!canSubmit || submitting}
            onPress={onSubmit}
            testID={`topic-decision-submit-${topicKey}`}
          >
            <ThemedSend size={12} />
            {t("topicWorkbench.topicStream.decisionSubmitAndContinue")}
          </Button>
        ) : null}
        <PressHighlight
          accessibilityRole="button"
          disabled={submitting}
          onPress={onOpenCompact}
          style={styles.compactTrigger}
          testID={`topic-decision-compact-trigger-${topicKey}`}
        >
          <Text style={styles.compactTriggerText} numberOfLines={1}>
            {t("topicWorkbench.topicStream.decisionCompactPlaceholder")}
          </Text>
        </PressHighlight>
      </View>
    );
  }

  return (
    <View style={styles.inputRow}>
      <AdaptiveTextInput
        initialValue={draftText}
        resetKey={inputResetKey}
        onChangeText={onChangeDraft}
        placeholder={t("topicWorkbench.topicStream.decisionBlockingPlaceholder")}
        style={styles.textInput}
        onSubmitEditing={onSubmit}
        returnKeyType="send"
        editable={!submitting}
        testID={`topic-decision-input-${topicKey}`}
      />
      <Button
        size="sm"
        variant="default"
        loading={submitting}
        disabled={!canSubmit || submitting || draftText.trim().length === 0}
        onPress={onSubmit}
        testID={`topic-decision-submit-${topicKey}`}
      >
        <ThemedSend size={12} />
        {t("topicWorkbench.topicStream.decisionSubmitAndContinue")}
      </Button>
    </View>
  );
});

function resolveBlockingSubmissionGeneration(
  promptGeneration: string | undefined,
  draftMeta: TopicDecisionDraftMeta | undefined,
): string | undefined {
  const locked = draftMeta?.blockingQuestionGeneration;
  if (!locked) return promptGeneration;
  if (
    draftMeta?.acknowledgedStaleGeneration === locked &&
    promptGeneration &&
    promptGeneration !== locked
  ) {
    return promptGeneration;
  }
  return locked;
}

export const TopicDecisionSlot = memo(function TopicDecisionSlot({
  agentKey,
  serverId,
  workspaceId,
  topic,
  prompt,
  supportsButlerV1 = false,
  durableItemsOnline = true,
  durableItemsConfirmed = true,
  onRefreshDurableItems,
  onOpenStandaloneDurableItem,
  onSubmitDecision,
  onActivateCompactDecision,
}: TopicDecisionSlotProps) {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();

  const disclosureKey = buildTopicDisclosureKey(agentKey, topic.topicKey);
  const draftText = useTopicStreamViewStore(
    (state) => state.decisionDraftByTopicKey[disclosureKey] ?? "",
  );
  const setDecisionDraft = useTopicStreamViewStore((state) => state.setDecisionDraft);
  const setDecisionDraftSubmissionIntent = useTopicStreamViewStore(
    (state) => state.setDecisionDraftSubmissionIntent,
  );
  const acknowledgeStaleDecisionDraft = useTopicStreamViewStore(
    (state) => state.acknowledgeStaleDecisionDraft,
  );

  const [inputResetKey, setInputResetKey] = useState(0);
  const [staleEvidenceRevision, setStaleEvidenceRevision] = useState<number | undefined>(undefined);
  const [submittingAction, setSubmittingAction] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  const submittingRef = useRef(false);
  const pendingClientMessageIdRef = useRef<string | null>(null);
  const pendingSubmissionKeyRef = useRef<string | null>(null);

  const durableItem = prompt.kind === "durable_item" ? prompt.item : null;
  const durableRevision = durableItem?.revision;
  const blockingTaskId = prompt.kind === "task_blocking_question" ? prompt.taskId : null;
  const blockingGeneration =
    prompt.kind === "task_blocking_question" ? prompt.blockingQuestionGeneration : undefined;
  useEffect(() => {
    setFeedback(null);
    pendingClientMessageIdRef.current = null;
    pendingSubmissionKeyRef.current = null;
  }, [blockingTaskId, durableItem?.requestId, durableRevision, prompt.kind]);

  const handleChangeDraft = useCallback(
    (next: string) => {
      setDecisionDraft(
        disclosureKey,
        next,
        blockingTaskId
          ? { taskId: blockingTaskId, blockingQuestionGeneration: blockingGeneration }
          : undefined,
      );
      setFeedback(null);
      if (
        pendingSubmissionKeyRef.current !== null &&
        !pendingSubmissionKeyRef.current.endsWith(`\0${next.trim()}`)
      ) {
        pendingClientMessageIdRef.current = null;
        pendingSubmissionKeyRef.current = null;
      }
    },
    [blockingGeneration, blockingTaskId, disclosureKey, setDecisionDraft],
  );

  const handleSelectOption = useCallback(
    (option: string) => {
      setDecisionDraft(
        disclosureKey,
        option,
        blockingTaskId
          ? {
              taskId: blockingTaskId,
              blockingQuestionGeneration: blockingGeneration,
              forceGeneration: true,
            }
          : undefined,
      );
      setInputResetKey((key) => key + 1);
      setFeedback(null);
      pendingClientMessageIdRef.current = null;
      pendingSubmissionKeyRef.current = null;
    },
    [blockingGeneration, blockingTaskId, disclosureKey, setDecisionDraft],
  );

  const allocateClientMessageId = useCallback((submissionKey: string) => {
    if (!pendingClientMessageIdRef.current || pendingSubmissionKeyRef.current !== submissionKey) {
      pendingClientMessageIdRef.current = generateMessageId();
      pendingSubmissionKeyRef.current = submissionKey;
    }
    return pendingClientMessageIdRef.current;
  }, []);

  const clearDraftAfterSave = useCallback(() => {
    pendingClientMessageIdRef.current = null;
    pendingSubmissionKeyRef.current = null;
    setDecisionDraft(disclosureKey, "");
    setInputResetKey((key) => key + 1);
  }, [disclosureKey, setDecisionDraft]);

  const handleSubmitDurable = useCallback(
    (decision: DurableItemDecision) => {
      if (!durableItem || !onSubmitDecision || submittingRef.current) return;
      const block = getDurableItemDecisionBlock({
        item: durableItem,
        online: durableItemsOnline,
        confirmed: durableItemsConfirmed,
        staleEvidenceRevision,
        decision,
      });
      if (block) return;

      const trimmedNote = draftText.trim();
      const submissionKey = `durable:${durableItem.requestId}:${durableItem.revision}:${decision}\0${trimmedNote}`;
      const clientMessageId = allocateClientMessageId(submissionKey);

      submittingRef.current = true;
      setSubmittingAction(decision);
      setFeedback(null);
      void onSubmitDecision({
        topic,
        resolutionKind: "durable_item",
        clientMessageId,
        durableItem,
        decision,
        note: trimmedNote || undefined,
      })
        .then((result) => {
          if (result.outcome === "saved") {
            clearDraftAfterSave();
          } else if (result.outcome === "evidenceStale") {
            setStaleEvidenceRevision(durableItem.revision);
            setFeedback(result.message || t("topicWorkbench.topicStream.decisionEvidenceStale"));
          } else if (result.outcome === "conflict") {
            setFeedback(result.message || t("topicWorkbench.durableItems.conflict"));
          } else {
            setFeedback(result.message ?? t("topicWorkbench.durableItems.unconfirmed"));
          }
          return result;
        })
        .catch((err) => {
          setFeedback(
            err instanceof Error ? err.message : t("topicWorkbench.durableItems.unconfirmed"),
          );
        })
        .finally(() => {
          submittingRef.current = false;
          setSubmittingAction(null);
        });
    },
    [
      allocateClientMessageId,
      clearDraftAfterSave,
      draftText,
      durableItem,
      durableItemsConfirmed,
      durableItemsOnline,
      onSubmitDecision,
      staleEvidenceRevision,
      t,
      topic,
    ],
  );

  const handleTriggerBlockingSubmit = useCallback(() => {
    if (prompt.kind !== "task_blocking_question" || !onSubmitDecision || submittingRef.current) {
      return;
    }
    if (!supportsButlerV1) return;
    const trimmedNote = draftText.trim();
    if (!trimmedNote) return;

    const storeSnapshot = useTopicStreamViewStore.getState();
    const activeMeta = storeSnapshot.decisionDraftByTopicKey[disclosureKey]?.trim()
      ? storeSnapshot.decisionDraftMetaByTopicKey[disclosureKey]
      : undefined;
    const generation = resolveBlockingSubmissionGeneration(
      prompt.blockingQuestionGeneration,
      activeMeta,
    );
    const submissionKey = `blocking:${prompt.taskId}:${generation ?? ""}\0${trimmedNote}`;
    const clientMessageId =
      activeMeta?.pendingClientMessageId && activeMeta.pendingSubmissionKey === submissionKey
        ? activeMeta.pendingClientMessageId
        : generateMessageId();
    setDecisionDraftSubmissionIntent(disclosureKey, submissionKey, clientMessageId);

    submittingRef.current = true;
    setSubmittingAction("blocking");
    setFeedback(null);
    void onSubmitDecision({
      topic,
      resolutionKind: "task_blocking_question",
      clientMessageId,
      expectedBlockingQuestionGeneration: generation,
      note: trimmedNote,
    })
      .then((result) => {
        if (result.outcome === "saved") {
          clearDraftAfterSave();
        } else if (result.outcome === "staleBlockingQuestion") {
          acknowledgeStaleDecisionDraft(
            disclosureKey,
            { taskId: prompt.taskId, submittedGeneration: generation },
            {
              latestBlockingQuestionGeneration: result.latestBlockingQuestionGeneration,
              hasLatestTask: result.hasLatestTask,
            },
          );
          setFeedback(t("topicWorkbench.topicStream.decisionBlockingQuestionStale"));
        } else {
          setFeedback(result.message || t("topicWorkbench.durableItems.unconfirmed"));
        }
        return result;
      })
      .catch((err) => {
        setFeedback(
          err instanceof Error ? err.message : t("topicWorkbench.durableItems.unconfirmed"),
        );
      })
      .finally(() => {
        submittingRef.current = false;
        setSubmittingAction(null);
      });
  }, [
    acknowledgeStaleDecisionDraft,
    clearDraftAfterSave,
    disclosureKey,
    draftText,
    onSubmitDecision,
    prompt,
    setDecisionDraftSubmissionIntent,
    supportsButlerV1,
    t,
    topic,
  ]);

  const handleOpenCompactDecision = useCallback(() => {
    if (prompt.kind !== "task_blocking_question") return;
    const storeSnapshot = useTopicStreamViewStore.getState();
    const activeMeta = storeSnapshot.decisionDraftByTopicKey[disclosureKey]?.trim()
      ? storeSnapshot.decisionDraftMetaByTopicKey[disclosureKey]
      : undefined;
    const generation = resolveBlockingSubmissionGeneration(
      prompt.blockingQuestionGeneration,
      activeMeta,
    );
    onActivateCompactDecision?.(topic, prompt.question, generation);
  }, [disclosureKey, onActivateCompactDecision, prompt, topic]);

  if (prompt.kind === "durable_item") {
    if (!prompt.canDecideInTopic) {
      return (
        <StandaloneDurableItemRedirectSection
          topicKey={topic.topicKey}
          item={prompt.item}
          onOpenStandalone={onOpenStandaloneDurableItem}
        />
      );
    }
    return (
      <DurableItemDecisionSection
        serverId={serverId}
        workspaceId={workspaceId}
        topic={topic}
        item={prompt.item}
        draftText={draftText}
        inputResetKey={inputResetKey}
        durableItemsOnline={durableItemsOnline}
        durableItemsConfirmed={durableItemsConfirmed}
        staleEvidenceRevision={staleEvidenceRevision}
        submittingAction={submittingAction}
        feedback={feedback}
        onChangeDraft={handleChangeDraft}
        onRefreshDurableItems={onRefreshDurableItems}
        onSubmitDurable={handleSubmitDurable}
      />
    );
  }

  return (
    <View style={styles.container} testID={`topic-decision-slot-${topic.topicKey}`}>
      <View style={styles.headerRow}>
        <ThemedHelp size={14} />
        <StatusBadge
          size="xs"
          variant="warning"
          label={t("topicWorkbench.topicStream.decisionNeedsInputBadge")}
        />
      </View>

      <Text style={styles.bodyText} testID={`topic-decision-question-${topic.topicKey}`}>
        {prompt.question}
      </Text>

      {prompt.options.length > 0 ? (
        <View style={styles.optionsWrap} testID={`topic-decision-options-${topic.topicKey}`}>
          {prompt.options.map((option, index) => (
            <DecisionOptionPill
              key={option}
              option={option}
              index={index}
              selected={draftText.trim() === option}
              disabled={!supportsButlerV1 || submittingAction !== null}
              onSelect={handleSelectOption}
            />
          ))}
        </View>
      ) : null}

      <BlockingQuestionInputArea
        topicKey={topic.topicKey}
        supportsButlerV1={supportsButlerV1}
        isCompact={isCompact}
        draftText={draftText}
        inputResetKey={inputResetKey}
        submitting={submittingAction === "blocking"}
        canSubmit={Boolean(onSubmitDecision)}
        onChangeDraft={handleChangeDraft}
        onSubmit={handleTriggerBlockingSubmit}
        onOpenCompact={handleOpenCompactDecision}
      />

      {feedback ? (
        <Text
          style={styles.feedbackText}
          accessibilityLiveRegion="polite"
          testID={`topic-decision-feedback-${topic.topicKey}`}
        >
          {feedback}
        </Text>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  container: {
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.statusWarning,
    backgroundColor: theme.colors.surface0,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
  },
  title: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
  },
  bodyText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    lineHeight: theme.lineHeight.content,
  },
  evidenceList: {
    gap: theme.spacing[1.5],
  },
  evidenceRow: {
    gap: theme.spacing[1],
  },
  optionsWrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[1.5],
  },
  optionPill: {
    minHeight: 28,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.full,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  optionPillSelected: {
    borderColor: theme.colors.borderAccent,
    backgroundColor: theme.colors.surface2,
  },
  optionPillText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  optionPillTextSelected: {
    fontWeight: theme.fontWeight.semibold,
  },
  inputRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  textInput: {
    flex: 1,
    minWidth: 0,
    minHeight: 34,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1.5],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  actionsRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[1.5],
  },
  warningRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[1.5],
  },
  warningText: {
    flex: 1,
    minWidth: 160,
    color: theme.colors.statusWarning,
    fontSize: theme.fontSize.sm,
  },
  legacyNotice: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  compactDecisionRow: {
    gap: theme.spacing[1.5],
  },
  compactTrigger: {
    minHeight: 34,
    justifyContent: "center",
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1.5],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  compactTriggerText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  feedbackText: {
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.sm,
  },
}));
