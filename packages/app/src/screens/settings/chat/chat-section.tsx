import { useCallback, useMemo } from "react";
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import {
  SettingsCard,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
} from "@/components/settings";
import { isNative } from "@/constants/platform";
import { useAppSettings, type ChatDisplay } from "@/hooks/use-settings";

const CHAT_DISPLAYS: readonly ChatDisplay[] = ["full", "collapseToolCalls", "collapseTurns"];

export function ChatSection() {
  const { t, i18n } = useTranslation();
  const isChinese = i18n.language?.startsWith("zh");
  const { settings, updateSettings } = useAppSettings();

  const chatDisplayOptions = useMemo(
    () =>
      CHAT_DISPLAYS.map((value) => ({
        value,
        label: t(`settings.general.chatDisplay.options.${value}`),
      })),
    [t],
  );

  const changeChatDisplay = useCallback(
    (chatDisplay: ChatDisplay) => void updateSettings({ chatDisplay }),
    [updateSettings],
  );
  const changeAutoExpandReasoning = useCallback(
    (autoExpandReasoning: boolean) => void updateSettings({ autoExpandReasoning }),
    [updateSettings],
  );
  const changeShowAgentInteractions = useCallback(
    (showAgentInteractions: boolean) => void updateSettings({ showAgentInteractions }),
    [updateSettings],
  );
  const changeDefaultWorkspaceMainAgent = useCallback(
    (defaultWorkspaceMainAgent: boolean) => void updateSettings({ defaultWorkspaceMainAgent }),
    [updateSettings],
  );
  const changeChatOutline = useCallback(
    (chatOutlineEnabled: boolean) => void updateSettings({ chatOutlineEnabled }),
    [updateSettings],
  );

  return (
    <View>
      <SettingsSection title={t("settings.appearance.detailLevel.title")}>
        <SettingsCard>
          <SettingsSwitch
            label={t("settings.general.autoExpandReasoning.label")}
            hint={t("settings.general.autoExpandReasoning.description")}
            value={settings.autoExpandReasoning}
            onValueChange={changeAutoExpandReasoning}
          />
          <SettingsSwitch
            label={t("settings.general.showAgentInteractions.label")}
            hint={t("settings.general.showAgentInteractions.description")}
            value={settings.showAgentInteractions}
            onValueChange={changeShowAgentInteractions}
          />
          <SettingsSwitch
            label={isChinese ? "默认启用主标签会话" : "Default main tab for new workspaces"}
            hint={
              isChinese
                ? "新建工作空间时自动创建置顶的主控会话，并将新建标签默认挂载为其子会话（不影响已有工作空间）。"
                : "Automatically create a pinned main control session in new workspaces and attach new agent tabs under it."
            }
            value={settings.defaultWorkspaceMainAgent}
            onValueChange={changeDefaultWorkspaceMainAgent}
          />
          <SettingsSelect
            label={t("settings.general.chatDisplay.label")}
            hint={t("settings.general.chatDisplay.description")}
            value={settings.chatDisplay}
            options={chatDisplayOptions}
            onValueChange={changeChatDisplay}
          />
          {isNative ? null : (
            <SettingsSwitch
              label={t("settings.appearance.chatOutline.title")}
              hint={t("settings.appearance.chatOutline.description")}
              value={settings.chatOutlineEnabled}
              onValueChange={changeChatOutline}
            />
          )}
        </SettingsCard>
      </SettingsSection>
    </View>
  );
}
