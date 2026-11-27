import { ChevronDown, X } from "lucide-react-native";
import { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, Text, View, type LayoutChangeEvent } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useQueryClient } from "@tanstack/react-query";
import { create } from "zustand";
import type {
  WorkspaceDurableItem,
  WorkspaceDurableItemEvidence,
} from "@getpaseo/protocol/messages";
import { CHAT_COLUMN_RAIL_DATASET } from "@/chat-rail";
import { Button } from "@/components/ui/button";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isWeb } from "@/constants/platform";
import { useStableEvent } from "@/hooks/use-stable-event";
import {
  useActiveWorkspaceSheetOpener,
  useSheetPaneHostIfAny,
  useWorkspaceSheetPages,
  type WorkspaceSheetPage,
} from "@/screens/workspace/sheet-pane";
import { DurableItemEvidenceDetails } from "./evidence";
import {
  durableItemKey,
  getDurableItemDecisionBlock,
  submitDurableItemDecision,
  type DurableItemDecision,
} from "./model";
import {
  getOnlineDurableItemsClient,
  reconcileDurableItemDecision,
  useWorkspaceDurableItems,
} from "./queries";
import { useReminderDismissalStore } from "./reminder-dismissal-store";

const DECISIONS = ["approve", "reject", "request_changes"] as const;
const EMPTY_REMINDERS: readonly WorkspaceDurableItem[] = [];
const DismissIcon = withUnistyles(X, (theme) => ({ color: theme.colors.foregroundMuted }));
const ScrollHintIcon = withUnistyles(ChevronDown, (theme) => ({
  color: theme.colors.foregroundMuted,
  size: theme.iconSize.sm,
}));
// Keep a rejected revision blocked across chat and inbox cards, including after remounting.
const useStaleEvidence = create<Readonly<Record<string, number>>>(() => ({}));

function evidenceKey(evidence: WorkspaceDurableItemEvidence) {
  return JSON.stringify([
    evidence.type,
    evidence.path,
    evidence.type === "git" ? evidence.repoRoot : null,
  ]);
}

function EvidenceRow({
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
  const press = useCallback(() => onPress(evidence), [onPress, evidence]);
  const accessibilityState = useMemo(() => ({ expanded }), [expanded]);
  return (
    <View>
      <Button
        size="sm"
        variant="outline"
        numberOfLines={1}
        accessibilityState={accessibilityState}
        onPress={press}
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
}

function DecisionButton({
  decision,
  isAcceptance,
  disabled,
  loading,
  onPress,
}: {
  decision: DurableItemDecision;
  isAcceptance: boolean;
  disabled: boolean;
  loading: boolean;
  onPress: (decision: DurableItemDecision) => void;
}) {
  const { t } = useTranslation();
  const press = useCallback(() => onPress(decision), [onPress, decision]);
  return (
    <Button
      size="sm"
      variant={decision === "approve" ? "secondary" : "outline"}
      loading={loading}
      disabled={disabled}
      onPress={press}
    >
      {t(
        decision === "approve" && isAcceptance
          ? "topicWorkbench.durableItems.accept"
          : `topicWorkbench.durableItems.action.${decision}`,
      )}
    </Button>
  );
}

/** The persisted request is the source of card state and evidence, independent of chat text. */
export function DurableItemCard({
  serverId,
  item,
}: {
  serverId: string;
  item: WorkspaceDurableItem;
}) {
  const workspace = useWorkspaceDurableItems(serverId, item.workspaceId);
  return <DurableItemCardContent serverId={serverId} snapshot={item} workspace={workspace} />;
}

export function useAgentDurableReminders(
  serverId: string,
  workspaceId: string,
  agentId: string | null,
  isPaneFocused = true,
) {
  const workspace = useWorkspaceDurableItems(serverId, workspaceId, isPaneFocused, !!agentId);
  const revisions = useReminderDismissalStore((state) => state.revisions);
  const items = useMemo(
    () =>
      agentId && revisions && workspace.result.data
        ? workspace.result.data.filter(
            (item) =>
              item.workspaceId === workspaceId &&
              item.sourceAgentId === agentId &&
              item.status === "pending" &&
              item.revision > (revisions[durableItemKey({ serverId, ...item })] ?? -1),
          )
        : EMPTY_REMINDERS,
    [agentId, revisions, serverId, workspaceId, workspace.result.data],
  );
  return { items, workspace };
}

export function AgentDurableItems({
  serverId,
  reminders: { items, workspace },
  trackClearance = 0,
}: {
  serverId: string;
  reminders: ReturnType<typeof useAgentDurableReminders>;
  trackClearance?: number;
}) {
  if (!items.length) return null;

  const hasMultipleItems = items.length > 1;
  return (
    <View
      style={[styles.agentItemsRail, { marginBottom: trackClearance }]}
      dataSet={CHAT_COLUMN_RAIL_DATASET}
      testID="agent-durable-items-rail"
    >
      <ScrollView
        style={[styles.agentItems, hasMultipleItems && styles.agentItemList]}
        contentContainerStyle={[
          styles.agentItemsContent,
          !hasMultipleItems && styles.singleItemContent,
        ]}
        nestedScrollEnabled
        keyboardShouldPersistTaps="handled"
        testID="agent-durable-items"
      >
        {items.map((item) => (
          <DurableItemCardContent
            key={durableItemKey({ serverId, ...item })}
            serverId={serverId}
            snapshot={item}
            workspace={workspace}
            dismissible
          />
        ))}
      </ScrollView>
    </View>
  );
}

function ReminderBody({ children }: { children: React.ReactNode }) {
  const [viewportHeight, setViewportHeight] = useState(0);
  const [contentHeight, setContentHeight] = useState(0);
  const measureViewport = useCallback(
    (event: LayoutChangeEvent) => setViewportHeight(event.nativeEvent.layout.height),
    [],
  );
  const measureContent = useCallback((_width: number, height: number) => {
    setContentHeight(height);
  }, []);
  const canScroll = viewportHeight > 0 && contentHeight - viewportHeight > 1;

  return (
    <View style={styles.reminderBody}>
      <ScrollView
        style={styles.reminderScroller}
        onLayout={measureViewport}
        onContentSizeChange={measureContent}
        nestedScrollEnabled
        persistentScrollbar
        keyboardShouldPersistTaps="handled"
        testID="durable-item-reminder-body"
      >
        <View style={styles.bodyContent}>{children}</View>
      </ScrollView>
      {canScroll ? (
        <View style={styles.scrollHint} aria-hidden testID="durable-item-reminder-scroll-hint">
          <ScrollHintIcon />
        </View>
      ) : null}
    </View>
  );
}

function DurableItemBody({
  serverId,
  item,
  isReminder,
  openEvidenceKey,
  onOpenEvidence,
}: {
  serverId: string;
  item: WorkspaceDurableItem;
  isReminder: boolean;
  openEvidenceKey: string | null;
  onOpenEvidence: (evidence: WorkspaceDurableItemEvidence) => void;
}) {
  const evidenceByKey = new Map(item.evidence.map((evidence) => [evidenceKey(evidence), evidence]));
  const body = (
    <>
      <Text style={[styles.title, isReminder && styles.reminderText]}>{item.title}</Text>
      {item.summary ? (
        <Text style={[styles.text, isReminder && styles.reminderText]}>{item.summary}</Text>
      ) : null}
      {[...evidenceByKey].map(([key, evidence]) => (
        <EvidenceRow
          key={key}
          serverId={serverId}
          workspaceId={item.workspaceId}
          evidence={evidence}
          expanded={openEvidenceKey === key}
          onPress={onOpenEvidence}
        />
      ))}
    </>
  );
  return isReminder ? <ReminderBody>{body}</ReminderBody> : body;
}

function DurableItemCardContent({
  serverId,
  snapshot,
  workspace: { result, online },
  dismissible = false,
}: {
  serverId: string;
  snapshot: WorkspaceDurableItem;
  workspace: ReturnType<typeof useWorkspaceDurableItems>;
  dismissible?: boolean;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const compact = useIsCompactFormFactor();
  const sheetHost = useSheetPaneHostIfAny();
  const sheetStack = useWorkspaceSheetPages();
  const openActiveWorkspaceSheet = useActiveWorkspaceSheetOpener();
  const current = result.data?.find(({ requestId }) => requestId === snapshot.requestId);
  const item = current && current.revision >= snapshot.revision ? current : snapshot;
  const address = durableItemKey({
    serverId,
    workspaceId: item.workspaceId,
    requestId: item.requestId,
  });
  const dismiss = useCallback(
    () => useReminderDismissalStore.getState().dismiss(address, item.revision),
    [address, item.revision],
  );
  const [openEvidenceKey, setOpenEvidenceKey] = useState<string | null>(null);
  const staleEvidenceRevision = useStaleEvidence((state) => state[address]);
  const [feedback, setFeedback] = useState<"conflict" | "unconfirmed" | null>(null);
  const submittingRef = useRef(false);
  const [submitting, setSubmitting] = useState<DurableItemDecision | null>(null);
  const confirmed = result.isSuccess && result.fetchStatus === "idle" && current === item;
  const blockFor = (decision: DurableItemDecision) =>
    getDurableItemDecisionBlock({ item, online, confirmed, staleEvidenceRevision, decision });
  let blockMessage: ReturnType<typeof blockFor> | "checkFailed" | "unavailable" =
    blockFor("approve");
  if (blockMessage === "checking") {
    if (result.isError) blockMessage = "checkFailed";
    else if (result.isSuccess && !current) blockMessage = "unavailable";
  }

  const openEvidence = useStableEvent((evidence: WorkspaceDurableItemEvidence) => {
    const key = evidenceKey(evidence);
    if (compact) {
      const page: WorkspaceSheetPage = {
        key: JSON.stringify([address, item.revision, key]),
        title: evidence.path,
        render: () => (
          <DurableItemEvidenceDetails
            serverId={serverId}
            workspaceId={item.workspaceId}
            evidence={evidence}
          />
        ),
        scrollable: true,
      };
      if (
        sheetStack &&
        sheetHost?.serverId === serverId &&
        sheetHost.workspaceId === item.workspaceId
      ) {
        sheetStack.push(page);
        return;
      }
      if (openActiveWorkspaceSheet) {
        // A registered stack can reject a duplicate or a callback from a previous workspace.
        openActiveWorkspaceSheet(page);
        return;
      }
    }
    setOpenEvidenceKey((open) => (open === key ? null : key));
  });
  const retry = useStableEvent(() => void result.refetch());

  const decide = useStableEvent(async (decision: DurableItemDecision) => {
    if (submittingRef.current || item.status !== "pending" || blockFor(decision)) return;
    if (decision === "approve" && useStaleEvidence.getState()[address] === item.revision) return;
    const client = getOnlineDurableItemsClient(serverId);
    if (!client) return;
    submittingRef.current = true;
    setSubmitting(decision);
    setFeedback(null);
    try {
      const response = await submitDurableItemDecision(client, item, decision);
      if (response.outcome === "evidenceStale") {
        useStaleEvidence.setState((state) => ({
          [address]: Math.max(item.revision, state[address] ?? item.revision),
        }));
      } else if (response.outcome !== "saved") {
        setFeedback(response.outcome);
      }
      await reconcileDurableItemDecision(queryClient, serverId, item.workspaceId, response.item);
    } catch {
      setFeedback("unconfirmed");
      await reconcileDurableItemDecision(queryClient, serverId, item.workspaceId, null);
    } finally {
      submittingRef.current = false;
      setSubmitting(null);
    }
  });

  let terminalLabel: string | null = null;
  if (item.status === "decided")
    terminalLabel = t(`topicWorkbench.durableItems.result.${item.decision}`);
  if (item.status === "expired") terminalLabel = t("topicWorkbench.durableItems.expired");

  return (
    <View style={[styles.card, dismissible && styles.reminderCard]} testID="durable-item-card">
      <View style={styles.header}>
        <Text style={styles.meta}>{t(`topicWorkbench.durableItems.kind.${item.kind}`)}</Text>
        {dismissible ? (
          <ToolbarButton
            compact
            label={t("topicWorkbench.durableItems.dismissReminder")}
            onPress={dismiss}
          >
            <DismissIcon size={14} />
          </ToolbarButton>
        ) : null}
      </View>
      <DurableItemBody
        serverId={serverId}
        item={item}
        isReminder={dismissible}
        openEvidenceKey={openEvidenceKey}
        onOpenEvidence={openEvidence}
      />
      {terminalLabel ? (
        <Text style={styles.text} accessibilityLiveRegion="polite">
          {terminalLabel}
        </Text>
      ) : (
        <>
          {blockMessage ? (
            <Text style={styles.meta} accessibilityLiveRegion="polite">
              {t(`topicWorkbench.durableItems.${blockMessage}`)}
            </Text>
          ) : null}
          {online && result.isError ? (
            <Button size="sm" variant="ghost" loading={result.isFetching} onPress={retry}>
              {t("topicWorkbench.durableItems.refresh")}
            </Button>
          ) : null}
          <View style={styles.actions}>
            {DECISIONS.map((decision) => (
              <DecisionButton
                key={decision}
                decision={decision}
                isAcceptance={item.kind === "acceptance"}
                loading={submitting === decision}
                disabled={submitting !== null || Boolean(blockFor(decision))}
                onPress={decide}
              />
            ))}
          </View>
        </>
      )}
      {feedback ? (
        <Text style={styles.meta} accessibilityLiveRegion="polite">
          {t(`topicWorkbench.durableItems.${feedback}`)}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  agentItemsRail: {
    flexShrink: 1,
    alignItems: "center",
    width: "100%",
    paddingHorizontal: theme.spacing[4],
  },
  agentItems: {
    flexGrow: 0,
    flexShrink: 1,
    width: "100%",
    maxWidth: theme.contentMaxWidth,
  },
  agentItemList: {
    maxHeight: 300,
  },
  agentItemsContent: {
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[2],
  },
  singleItemContent: {
    flexShrink: 1,
  },
  card: {
    gap: theme.spacing[2],
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface2,
  },
  reminderCard: {
    flexShrink: 1,
    minWidth: 0,
  },
  reminderBody: {
    flexShrink: 1,
    minHeight: 0,
  },
  reminderScroller: {
    flexGrow: 0,
    flexShrink: 1,
    maxHeight: 144,
  },
  reminderText: {
    minWidth: 0,
    ...(isWeb ? { overflowWrap: "anywhere" as const } : {}),
  },
  bodyContent: {
    gap: theme.spacing[2],
  },
  scrollHint: {
    alignItems: "flex-end",
    paddingRight: theme.spacing[1],
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  text: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  meta: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[1],
  },
}));
