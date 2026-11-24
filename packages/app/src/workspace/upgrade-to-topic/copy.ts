export const topicUpgradeEnglish = {
  title: "Upgrade to topic",
  preserve:
    "Keep this workspace, its files, and its session history. Other sessions keep their current roles.",
  choose: "Choose the Main Session",
  existing:
    "This workspace already has a Main Session. Confirm the session to keep it in that role.",
  empty: "There are no sessions to choose from. You can bind a Main Session later.",
  unnamed: "Untitled session",
  disconnected: "Reconnect to the host to upgrade this workspace.",
  unsupported: "Update the host to upgrade this workspace.",
  forbidden: "You need permission to read and manage this workspace.",
  unavailable: "This workspace is no longer available for upgrade.",
  upgraded: "This workspace is already a topic.",
  changed: "The workspace changed. Review the available sessions before confirming.",
  loadError: "Could not load the workspace sessions.",
  submitError: "The host did not confirm the upgrade. Try again to check the workspace and retry.",
  loading: "Loading sessions…",
  confirm: "Upgrade workspace",
};

export const topicUpgradeChinese: Record<keyof typeof topicUpgradeEnglish, string> = {
  title: "升级为专题",
  preserve: "保留当前工作区、文件和会话历史。其他会话的角色保持不变。",
  choose: "选择主控会话",
  existing: "此工作区已有主控会话。请确认继续使用该会话。",
  empty: "目前没有可选会话。升级后仍可绑定主控会话。",
  unnamed: "未命名会话",
  disconnected: "重新连接主机后可升级此工作区。",
  unsupported: "更新主机后可升级此工作区。",
  forbidden: "你需要此工作区的读取和管理权限。",
  unavailable: "此工作区已无法升级。",
  upgraded: "此工作区已是专题。",
  changed: "工作区已发生变化。确认前请查看可选会话。",
  loadError: "无法加载工作区会话。",
  submitError: "主机没有确认升级。重试时会先检查工作区是否已经升级。",
  loading: "正在加载会话…",
  confirm: "升级工作区",
};
