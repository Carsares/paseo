import { memo, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Summary } from "lucide-react-native";
import { useDisclosureHold } from "@/agent-stream/disclosure";
import { ExpandableBadge } from "@/components/message";
import { useOverviewSummaryLabel } from "@/tool-calls/detail-level/overview/label";
import type { TurnSummaryItem } from "@/types/stream";
import { getAgentSourceGroup } from "../agent-interactions";
import { AgentSourceHeader } from "../source-header";

/**
 * The row a collapsed turn leaves under its user message, styled like a tool-call group.
 * Pressing it opens the turn's rows beneath it.
 */
export const TurnSummaryLine = memo(function TurnSummaryLine({
  item,
  serverId,
  onExpandedChange,
}: {
  item: TurnSummaryItem;
  serverId: string;
  onExpandedChange: (hostId: string, expanded: boolean) => void;
}) {
  const { t } = useTranslation();
  const label = useOverviewSummaryLabel(item.tools) || t("turnSummary.details");
  const hold = useDisclosureHold();
  const sourceGroup = getAgentSourceGroup(item);
  const setExpanded = useCallback(
    (expanded: boolean) => onExpandedChange(item.hostId, expanded),
    [onExpandedChange, item.hostId],
  );
  const toggle = useCallback(
    () => hold(() => onExpandedChange(item.hostId, !item.expanded)),
    [hold, onExpandedChange, item.expanded, item.hostId],
  );

  if (sourceGroup) {
    return (
      <AgentSourceHeader
        group={sourceGroup}
        fallbackServerId={serverId}
        expanded={item.expanded}
        onExpandedChange={setExpanded}
      />
    );
  }
  return (
    <ExpandableBadge
      testID="turn-summary"
      label={label}
      icon={Summary}
      isExpanded={item.expanded}
      onToggle={toggle}
      borderlessWhenExpanded
    />
  );
});
