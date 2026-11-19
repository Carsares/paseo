import { describe, expect, it, vi } from "vitest";
import { buildApplicationMenuTemplate, reloadActiveBrowserOrWindow } from "./menu.js";

vi.mock("electron", () => ({ app: { name: "Paseo" } }));

describe("buildApplicationMenuTemplate", () => {
  const shortcut = "CmdOrCtrl+Alt+Q";
  const label = "Quit and Resume Agents on Next Launch";

  function submenu(template: Electron.MenuItemConstructorOptions[], name: string) {
    const items = template.find((item) => item.label === name)?.submenu;
    if (!Array.isArray(items)) throw new Error(`Missing ${name} submenu`);
    return items;
  }

  it("puts the preserve-work quit immediately above Quit in the macOS app menu", () => {
    const onQuitAndResumeAgents = vi.fn();
    const template = buildApplicationMenuTemplate(
      { onNewWindow: vi.fn(), onQuitAndResumeAgents },
      false,
      "darwin",
    );
    const appMenu = submenu(template, "Paseo");
    const item = appMenu[appMenu.findIndex(({ role }) => role === "quit") - 1];

    expect(item).toMatchObject({ label, accelerator: shortcut });
    expect(submenu(template, "File").some(({ accelerator }) => accelerator === shortcut)).toBe(
      false,
    );
    item?.click?.({} as Electron.MenuItem, undefined, {});
    expect(onQuitAndResumeAgents).toHaveBeenCalledOnce();
  });

  it.each(["win32", "linux"] as const)(
    "puts the preserve-work quit after New Window on %s",
    (platform) => {
      const onQuitAndResumeAgents = vi.fn();
      const template = buildApplicationMenuTemplate(
        { onNewWindow: vi.fn(), onQuitAndResumeAgents },
        false,
        platform,
      );
      const fileMenu = submenu(template, "File");

      expect(fileMenu).toMatchObject([
        { label: "New Window" },
        { type: "separator" },
        { label, accelerator: shortcut },
      ]);
      fileMenu[2]?.click?.({} as Electron.MenuItem, undefined, {});
      expect(onQuitAndResumeAgents).toHaveBeenCalledOnce();
    },
  );

  it("disables zoom accelerators while capturing a shortcut without breaking the preserve-work quit item", () => {
    const template = buildApplicationMenuTemplate({ onNewWindow: vi.fn() }, true, "darwin");
    const viewMenu = submenu(template, "View");
    const appMenu = submenu(template, "Paseo");

    expect(viewMenu.find((item) => item.label === "Zoom In")?.enabled).toBe(false);
    expect(viewMenu.find((item) => item.label === "Zoom Out")?.enabled).toBe(false);
    expect(viewMenu.find((item) => item.label === "Actual Size")?.enabled).toBe(false);
    expect(appMenu.some((item) => item.label === label && item.accelerator === shortcut)).toBe(
      true,
    );
  });
});

class FakeWebContents {
  public readonly reloads: string[] = [];

  public constructor(public readonly id: number) {}

  public isLoadingMainFrame(): boolean {
    return false;
  }

  public stop(): void {
    this.reloads.push("stop");
  }

  public reload(): void {
    this.reloads.push("reload");
  }

  public reloadIgnoringCache(): void {
    this.reloads.push("force-reload");
  }
}

class BrowserReloads {
  public readonly firstWindow = { webContents: new FakeWebContents(101) };
  public readonly secondWindow = { webContents: new FakeWebContents(202) };
  public readonly firstBrowser = new FakeWebContents(11);
  public readonly secondBrowser = new FakeWebContents(22);
  public readonly resolvedHostWindowIds: number[] = [];

  public activeBrowserForHostWindow(hostWebContentsId: number): FakeWebContents | null {
    this.resolvedHostWindowIds.push(hostWebContentsId);
    return hostWebContentsId === 101 ? this.firstBrowser : this.secondBrowser;
  }
}

describe("reloadActiveBrowserOrWindow", () => {
  it("reloads only the active browser belonging to the supplied window", () => {
    const browserReloads = new BrowserReloads();

    reloadActiveBrowserOrWindow({
      win: browserReloads.firstWindow,
      getActiveBrowserContentsForHostWindow:
        browserReloads.activeBrowserForHostWindow.bind(browserReloads),
    });

    expect(browserReloads.resolvedHostWindowIds).toEqual([101]);
    expect(browserReloads.firstBrowser.reloads).toEqual(["reload"]);
    expect(browserReloads.secondBrowser.reloads).toEqual([]);
    expect(browserReloads.firstWindow.webContents.reloads).toEqual([]);
  });

  it("force reloads only the active browser belonging to the supplied window", () => {
    const browserReloads = new BrowserReloads();

    reloadActiveBrowserOrWindow({
      win: browserReloads.secondWindow,
      getActiveBrowserContentsForHostWindow:
        browserReloads.activeBrowserForHostWindow.bind(browserReloads),
      ignoreCache: true,
    });

    expect(browserReloads.resolvedHostWindowIds).toEqual([202]);
    expect(browserReloads.firstBrowser.reloads).toEqual([]);
    expect(browserReloads.secondBrowser.reloads).toEqual(["force-reload"]);
    expect(browserReloads.secondWindow.webContents.reloads).toEqual([]);
  });
});
