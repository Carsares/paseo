import { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useQueryClient } from "@tanstack/react-query";
import { create } from "zustand";
import type {
  WorkspaceDurableItem,
  WorkspaceDurableItemEvidence,
} from "@getpaseo/protocol/messages";
import { Button } from "@/components/ui/button";
import { useIsCompactFormFactor } from "@/constants/layout";
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

const DECISIONS = ["approve", "reject", "request_changes"] as const;
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

interface AgentDurableItemsProps {
  serverId: string;
  workspaceId: string;
  agentId: string | null;
  isPaneFocused?: boolean;
}

export function AgentDurableItems({ agentId, ...props }: AgentDurableItemsProps) {
  if (!agentId) return null;
  return <AgentDurableItemsList {...props} agentId={agentId} />;
}

function AgentDurableItemsList({
  serverId,
  workspaceId,
  agentId,
  isPaneFocused = true,
}: Omit<AgentDurableItemsProps, "agentId"> & { agentId: string }) {
  const workspace = useWorkspaceDurableItems(serverId, workspaceId, isPaneFocused);
  const items = workspace.result.data?.filter(
    (item) => item.workspaceId === workspaceId && item.sourceAgentId === agentId,
  );
  if (!items?.length) return null;

  return (
    <ScrollView
      style={styles.agentItems}
      contentContainerStyle={styles.agentItemsContent}
      nestedScrollEnabled
      testID="agent-durable-items"
    >
      {items.map((item) => (
        <DurableItemCardContent
          key={durableItemKey({ serverId, workspaceId, requestId: item.requestId })}
          serverId={serverId}
          snapshot={item}
          workspace={workspace}
        />
      ))}
    </ScrollView>
  );
}

function DurableItemCardContent({
  serverId,
  snapshot,
  workspace: { result, online },
}: {
  serverId: string;
  snapshot: WorkspaceDurableItem;
  workspace: ReturnType<typeof useWorkspaceDurableItems>;
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

  const evidenceByKey = new Map(item.evidence.map((evidence) => [evidenceKey(evidence), evidence]));
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
    <View style={styles.card} testID="durable-item-card">
      <Text style={styles.meta}>{t(`topicWorkbench.durableItems.kind.${item.kind}`)}</Text>
      <Text style={styles.title}>{item.title}</Text>
      {item.summary ? <Text style={styles.text}>{item.summary}</Text> : null}
      {[...evidenceByKey].map(([key, evidence]) => (
        <EvidenceRow
          key={key}
          serverId={serverId}
          workspaceId={item.workspaceId}
          evidence={evidence}
          expanded={openEvidenceKey === key}
          onPress={openEvidence}
        />
      ))}
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
  agentItems: {
    flexGrow: 0,
    flexShrink: 1,
    maxHeight: 240,
  },
  agentItemsContent: {
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  card: {
    gap: theme.spacing[2],
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface2,
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
