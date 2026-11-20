import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { beginComposerWork, useHandoffInputLocked } from "@/composer/handoff-input-lock";
import { useToast } from "@/contexts/toast-context";
import { isAgentArchiving } from "@/hooks/use-archive-agent";
import { selectHostFeature, useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { toErrorMessage } from "@/utils/error-messages";
import { findWorkspaceMainAgentId } from "./select-tree";

type QuickAction = "summarize" | "audit";

const prompts = {
  summarize: {
    zh: "请把附件中的工作区会话汇总作为参考资料，梳理活跃和已关闭会话的已完成工作、待办事项和主要风险。",
    en: "Use the attached workspace session summary as reference material. Summarize completed work, pending tasks, and key risks across active and closed sessions.",
  },
  audit: {
    zh: "请将附件中的工作区会话汇总与当前 git status 和 git diff（含暂存区）对照，按会话列出改动文件，标出多个会话都改过的文件、无法确认的归属以及未完成事项。只报告发现。",
    en: "Compare the attached workspace session summary with the current git status and git diff, including staged changes. Attribute changed files to sessions, flag files touched by more than one session and any uncertain attribution, and list unfinished work. Report findings only.",
  },
};

export function MainControlQuickActions({
  mainAgentId,
  serverId,
  workspaceId,
  onPromptSent,
}: {
  mainAgentId: string;
  serverId: string;
  workspaceId: string;
  onPromptSent: () => void;
}) {
  const { i18n } = useTranslation();
  const isChinese = i18n.language?.startsWith("zh") === true;
  const toast = useToast();
  const queryClient = useQueryClient();
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  const handoffLocked = useHandoffInputLocked(serverId, mainAgentId);
  // COMPAT(workspaceAgentsSummary): added in v0.16.0, remove gate after 2027-05-20.
  const supported = useHostFeature(serverId, "workspaceAgentsSummary");
  const inFlight = useRef(false);
  const [busyAction, setBusyAction] = useState<QuickAction | null>(null);

  const runAction = useCallback(
    async (action: QuickAction) => {
      if (!client || !connected || handoffLocked || inFlight.current) return;
      inFlight.current = true;
      setBusyAction(action);
      try {
        const summary = await client.summarizeWorkspaceAgents({ workspaceId });
        const state = useSessionStore.getState();
        const agents = state.sessions[serverId]?.agents;
        if (
          !selectHostFeature(state, serverId, "workspaceAgentsSummary") ||
          findWorkspaceMainAgentId(agents ? { serverId, agents } : undefined, workspaceId) !==
            mainAgentId ||
          isAgentArchiving({ queryClient, serverId, agentId: mainAgentId })
        ) {
          toast.error(
            isChinese ? "主控会话已变更，请重试。" : "The main session changed. Try again.",
          );
          return;
        }
        const releaseSubmission = beginComposerWork(serverId, mainAgentId, "submit");
        if (!releaseSubmission) {
          toast.error(
            isChinese
              ? "会话正在发送消息或切换提供方，请重试。"
              : "The session is sending a message or switching providers. Try again.",
          );
          return;
        }
        try {
          await client.sendAgentMessage(mainAgentId, prompts[action][isChinese ? "zh" : "en"], {
            attachments: [summary.attachment],
          });
          onPromptSent();
        } finally {
          releaseSubmission();
        }
      } catch (error) {
        toast.error(toErrorMessage(error));
      } finally {
        inFlight.current = false;
        setBusyAction(null);
      }
    },
    [
      client,
      connected,
      handoffLocked,
      isChinese,
      mainAgentId,
      onPromptSent,
      queryClient,
      serverId,
      toast,
      workspaceId,
    ],
  );
  const summarize = useCallback(() => void runAction("summarize"), [runAction]);
  const audit = useCallback(() => void runAction("audit"), [runAction]);

  if (!supported || !workspaceId) return null;

  const disabled = !client || !connected || handoffLocked || busyAction !== null;
  return (
    <View style={styles.actions}>
      <Button
        size="sm"
        style={styles.pill}
        testID="main-control-summarize-sessions"
        loading={busyAction === "summarize"}
        disabled={disabled}
        onPress={summarize}
      >
        {isChinese ? "汇总全部会话进展" : "Summarize all sessions"}
      </Button>
      <Button
        size="sm"
        style={styles.pill}
        testID="main-control-audit-changes"
        loading={busyAction === "audit"}
        disabled={disabled}
        onPress={audit}
      >
        {isChinese ? "盘点未提交改动归属" : "Audit uncommitted changes"}
      </Button>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  actions: {
    width: "100%",
    maxWidth: theme.contentMaxWidth,
    alignSelf: "center",
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[3],
    paddingBottom: theme.spacing[1],
  },
  pill: { borderRadius: theme.borderRadius.full },
}));
