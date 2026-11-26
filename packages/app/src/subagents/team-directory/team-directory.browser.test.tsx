import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { View } from "react-native";
import { expect, it } from "vitest";
import { page } from "vitest/browser";
import { i18n } from "@/i18n/i18next";
import type { TeamDirectoryTab } from "@/stores/team-directory-view-store";
import { TeamDirectoryTabs } from "./team-directory";

const directoryWidth = { width: 256 };

function DirectoryHeader() {
  const [tab, setTab] = useState<TeamDirectoryTab>("messages");
  return (
    <View style={directoryWidth}>
      <TeamDirectoryTabs
        unreadCount={128}
        totalTodosTabCount={237}
        runningCount={116}
        activeTab={tab}
        onSelect={setTab}
      />
    </View>
  );
}

it("shows all three Chinese tabs at 256px with capped badges and accurate accessible counts", async () => {
  const language = i18n.language;
  await i18n.changeLanguage("zh-CN");
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  try {
    await act(async () => root.render(<DirectoryHeader />));
    const rail = page.getByTestId("team-directory-tabs-scroll").element();
    const messages = page.getByTestId("team-directory-tab-messages");
    const todos = page.getByTestId("team-directory-tab-todos");
    const team = page.getByTestId("team-directory-tab-agents");
    await expect.element(messages).toHaveAccessibleName("未读动态 (128)");
    await expect.element(todos).toHaveAccessibleName("待办清单 (237)");
    await expect.element(team).toHaveAccessibleName("团队成员 (116)");

    const railBounds = rail.getBoundingClientRect();
    expect(railBounds.width).toBeLessThanOrEqual(256);
    expect(rail.scrollLeft).toBe(0);
    for (const [tab, label] of [
      [messages, "未读99+"],
      [todos, "待办99+"],
      [team, "团队成员99+"],
    ] as const) {
      await expect.element(tab).toHaveTextContent(label);
      const bounds = tab.element().getBoundingClientRect();
      expect(bounds.left).toBeGreaterThanOrEqual(railBounds.left);
      expect(bounds.right).toBeLessThanOrEqual(railBounds.right);
    }
    await act(async () => team.click());
    await expect.element(team).toHaveAttribute("aria-selected", "true");
    await expect.element(page.getByTestId("team-directory-hide")).not.toBeInTheDocument();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    await i18n.changeLanguage(language);
  }
});
