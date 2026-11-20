import { app } from "electron";

import { createDesktopSettingsStore } from "./desktop-settings.js";

let desktopSettingsStore: ReturnType<typeof createDesktopSettingsStore> | null = null;

export function getDesktopSettingsStore(): ReturnType<typeof createDesktopSettingsStore> {
  desktopSettingsStore ??= createDesktopSettingsStore({
    userDataPath: app.getPath("userData"),
  });
  return desktopSettingsStore;
}
