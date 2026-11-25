import { useTranslation } from "react-i18next";
import { proxySettingsCopy, type ProxySettingsCopy } from "@/i18n/domains/settings";

export function useProxySettingsCopy(): ProxySettingsCopy {
  const { i18n } = useTranslation();
  return i18n.resolvedLanguage === "zh-CN" ? proxySettingsCopy["zh-CN"] : proxySettingsCopy.en;
}
