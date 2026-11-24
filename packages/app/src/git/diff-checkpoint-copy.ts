import { useTranslation } from "react-i18next";

const english = {
  turn: "This turn",
  worktree: "Working files",
  staged: "Staged changes",
  baseline: "Relative to baseline",
  view: "View historical changes",
  checkpointMissing: "This comparison is unavailable because a checkpoint is missing.",
  externalWrites: "Showing all changes. Some changes could not be attributed to this turn.",
  unavailable: "Historical changes are unavailable.",
  loadFailed: "Could not load historical changes.",
  partialRewind: "Conversation rewound. Files could not be restored.",
  fileRewindFailed: "Files could not be restored.",
  retryFiles: "Retry file restore",
  filesRestored: "Files restored.",
  rewindInProgress: "Another rewind is in progress.",
};

const chinese: typeof english = {
  turn: "这一轮",
  worktree: "工作区文件",
  staged: "暂存变化",
  baseline: "相对基线",
  view: "查看历史差异",
  checkpointMissing: "缺少检查点，无法比较。",
  externalWrites: "已显示全部改动。部分改动无法归属到这一轮。",
  unavailable: "无法查看历史差异。",
  loadFailed: "无法加载历史差异。",
  partialRewind: "聊天已回滚，文件恢复失败。",
  fileRewindFailed: "文件恢复失败。",
  retryFiles: "重试文件恢复",
  filesRestored: "文件已恢复。",
  rewindInProgress: "另一次回滚正在进行。",
};

export function useCheckpointCopy() {
  const { i18n } = useTranslation();
  return i18n.language?.startsWith("zh") ? chinese : english;
}
