import { Ellipsis, History, MessageSquare } from "lucide-react-native";
import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { withUnistyles } from "react-native-unistyles";
import { useAgentStreamTail } from "@/agent-stream/use-agent-stream-tail";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  mutedIconColorMapping,
  useIconButtonChromeGlyphSize,
} from "@/components/ui/icon-button-chrome";
import { ToolbarButton, ToolbarControls } from "@/components/ui/pane-content-toolbar";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { useSessionStore } from "@/stores/session-store";
import {
  buildTopicAgentKey,
  useTopicStreamViewStore,
  type TopicStreamViewMode,
} from "@/stores/topic-stream-view-store";
import type { Theme } from "@/styles/theme";
import type { StreamItem } from "@/types/stream";
import { useTopicStreamMarkAllRead } from "./topic-stream-list";

const ModeHeaderAgentKey = createContext<string | null>(null);
const MODE_SWITCH_ID = "topic-stream-mode-switch";
const EMPTY_STREAM_ITEMS: readonly StreamItem[] = [];
const ThemedEllipsis = withUnistyles(Ellipsis, (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
}));
const ThemedHistory = withUnistyles(History);
const ThemedMessageSquare = withUnistyles(MessageSquare);

/** Supply the agent whose workspace header currently renders the mode and actions. */
export function TopicStreamModeHeaderProvider({
  serverId,
  agentId,
  children,
}: {
  serverId: string;
  agentId: string | null;
  children: ReactNode;
}) {
  const agentKey = agentId ? buildTopicAgentKey(serverId, agentId) : null;
  return <ModeHeaderAgentKey.Provider value={agentKey}>{children}</ModeHeaderAgentKey.Provider>;
}

export function useTopicStreamModeInHeader(serverId: string, agentId: string): boolean {
  return useContext(ModeHeaderAgentKey) === buildTopicAgentKey(serverId, agentId);
}

export function useTopicStreamMode(
  serverId: string,
  agentId: string | undefined,
): TopicStreamViewMode {
  const agentKey = agentId ? buildTopicAgentKey(serverId, agentId) : null;
  return useTopicStreamViewStore((state) =>
    agentKey ? (state.viewModeByAgentKey[agentKey] ?? "topics") : "topics",
  );
}

export function TopicStreamModeControl({
  serverId,
  agentId,
  compact,
  workspaceId,
}: {
  serverId: string;
  agentId: string;
  compact: boolean;
  workspaceId?: string;
}) {
  const { t } = useTranslation();
  const modeIconSize = useIconButtonChromeGlyphSize("small", compact);
  const agentKey = buildTopicAgentKey(serverId, agentId);
  const viewMode = useTopicStreamMode(serverId, agentId);
  const setViewMode = useTopicStreamViewStore((state) => state.setViewMode);
  const changeMode = useCallback(
    (mode: TopicStreamViewMode) => setViewMode(agentKey, mode),
    [agentKey, setViewMode],
  );
  const topicsLabel = t("topicWorkbench.topicStream.modeTopics");
  const timelineLabel = t("topicWorkbench.topicStream.modeTimeline");
  const modeOptions = useMemo<
    (SegmentedControlOption<TopicStreamViewMode> & { onSelect: () => void })[]
  >(
    () => [
      {
        value: "topics",
        label: topicsLabel,
        testID: "topic-stream-mode-topics",
        onSelect: () => changeMode("topics"),
      },
      {
        value: "timeline",
        label: timelineLabel,
        testID: "topic-stream-mode-timeline",
        onSelect: () => changeMode("timeline"),
      },
    ],
    [changeMode, topicsLabel, timelineLabel],
  );
  const actions = workspaceId ? (
    <TopicStreamActionItems
      serverId={serverId}
      workspaceId={workspaceId}
      agentId={agentId}
      viewMode={viewMode}
    />
  ) : null;

  if (compact) {
    const showingTopics = viewMode === "topics";
    const ModeIcon = showingTopics ? ThemedMessageSquare : ThemedHistory;
    return (
      <DropdownMenu>
        <ToolbarButton
          kind="menu"
          compact
          label={showingTopics ? topicsLabel : timelineLabel}
          testID={MODE_SWITCH_ID}
        >
          <ModeIcon size={modeIconSize} uniProps={mutedIconColorMapping} />
        </ToolbarButton>
        <DropdownMenuContent align="end">
          {modeOptions.map((option) => (
            <DropdownMenuItem
              key={option.value}
              selected={viewMode === option.value}
              showSelectedCheck
              testID={option.testID}
              onSelect={option.onSelect}
            >
              {option.label}
            </DropdownMenuItem>
          ))}
          {actions ? <DropdownMenuSeparator /> : null}
          {actions}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  const switcher = (
    <SegmentedControl
      size="sm"
      options={modeOptions}
      value={viewMode}
      onValueChange={changeMode}
      testID={MODE_SWITCH_ID}
    />
  );
  return actions ? (
    <ToolbarControls>
      {switcher}
      <DropdownMenu>
        <ToolbarButton
          kind="menu"
          label={t("topicWorkbench.topicStream.moreActions")}
          testID="topic-stream-actions"
        >
          <ThemedEllipsis size={16} />
        </ToolbarButton>
        <DropdownMenuContent align="end">{actions}</DropdownMenuContent>
      </DropdownMenu>
    </ToolbarControls>
  ) : (
    switcher
  );
}

function TopicStreamActionItems({
  serverId,
  workspaceId,
  agentId,
  viewMode,
}: {
  serverId: string;
  workspaceId: string;
  agentId: string;
  viewMode: TopicStreamViewMode;
}) {
  const { t } = useTranslation();
  const agentKey = buildTopicAgentKey(serverId, agentId);
  const unreadOnly = useTopicStreamViewStore(
    (state) => state.unreadOnlyByAgentKey[agentKey] ?? false,
  );
  const toggleUnreadOnly = useTopicStreamViewStore((state) => state.toggleUnreadOnly);
  const openTodoEditor = useTopicStreamViewStore((state) => state.openTodoEditor);
  const toggleUnreadFilter = useCallback(
    () => toggleUnreadOnly(agentKey),
    [agentKey, toggleUnreadOnly],
  );
  const addTodo = useCallback(
    () => openTodoEditor({ serverId, workspaceId }),
    [openTodoEditor, serverId, workspaceId],
  );
  const streamItems = useAgentStreamTail(serverId, agentId);
  const streamHead = useSessionStore((state) =>
    state.sessions[serverId]?.agentStreamHead.get(agentId),
  );
  const { totalUnreadTopics, markAllRead } = useTopicStreamMarkAllRead({
    serverId,
    workspaceId,
    mainAgentId: agentId,
    streamItems: streamItems ?? EMPTY_STREAM_ITEMS,
    streamHead: streamHead ?? EMPTY_STREAM_ITEMS,
  });

  return (
    <>
      {viewMode === "topics" ? (
        <DropdownMenuCheckboxItem
          checked={unreadOnly}
          showSelectedCheck
          closeOnSelect
          onToggle={toggleUnreadFilter}
          testID="topic-stream-unread-only"
        >
          {t("topicWorkbench.topicStream.unreadOnly")}
        </DropdownMenuCheckboxItem>
      ) : null}
      <DropdownMenuItem
        disabled={totalUnreadTopics === 0}
        onSelect={markAllRead}
        testID="topic-stream-mark-all-read"
      >
        {t("topicWorkbench.topicStream.markAllRead")}
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={addTodo} testID="topic-stream-add-todo">
        {t("topicWorkbench.topicStream.addTodo")}
      </DropdownMenuItem>
    </>
  );
}
