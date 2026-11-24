import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";

import { registerEditorTargetHandlers } from "./ipc.js";
import { listAvailableEditorTargets, openEditorTarget } from "./registry.js";
import { createEditorTargetRuntime } from "./runtime.js";
import type {
  EditorTargetDirectoryEntry,
  EditorTargetIcon,
  EditorTargetRuntime,
} from "./target.js";
import { cursorTarget } from "./targets/cursor.js";
import { explorerTarget, fileManagerTarget, finderTarget } from "./targets/file-manager.js";
import { intellijIdeaTarget } from "./targets/intellij-idea.js";
import { pycharmTarget } from "./targets/pycharm.js";
import { vscodeTarget } from "./targets/vscode.js";
import { webstormTarget } from "./targets/webstorm.js";
import { xcodeTarget } from "./targets/xcode.js";
import { zedTarget } from "./targets/zed.js";

interface RecordedLaunch {
  command: string;
  args: string[];
}

function testDirectoryEntry(name: string): EditorTargetDirectoryEntry {
  if (name === "Package.swift") return { name, kind: "file" };
  if (name.endsWith(".xcodeproj") || name.endsWith(".xcworkspace")) {
    return { name, kind: "directory" };
  }
  return { name, kind: "other" };
}

class FakeEditorTargets implements EditorTargetRuntime {
  readonly launches: RecordedLaunch[] = [];
  readonly openedPaths: string[] = [];
  readonly revealedPaths: string[] = [];
  readonly openedMacApplications: Array<{
    applicationName: string;
    paths: string[];
  }> = [];

  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  private readonly paths = new Set<string>();
  private readonly commands = new Map<string, string>();
  private readonly macApplications = new Set<string>();
  private readonly directories = new Map<string, EditorTargetDirectoryEntry[]>();
  private readonly directoryErrors = new Map<string, Error>();

  constructor(platform: NodeJS.Platform = "linux", env: NodeJS.ProcessEnv = {}) {
    this.platform = platform;
    this.env = env;
  }

  addPath(targetPath: string): void {
    this.paths.add(targetPath);
  }

  installCommand(command: string, executable = `/bin/${command}`): void {
    this.commands.set(command, executable);
  }

  installMacApplication(applicationName: string): void {
    this.macApplications.add(applicationName);
  }

  addDirectory(targetPath: string, entries: readonly string[]): void {
    this.paths.add(targetPath);
    this.directories.set(targetPath, entries.map(testDirectoryEntry));
  }

  addDirectoryEntries(targetPath: string, entries: readonly EditorTargetDirectoryEntry[]): void {
    this.paths.add(targetPath);
    this.directories.set(targetPath, [...entries]);
  }

  listDirectory(targetPath: string): EditorTargetDirectoryEntry[] {
    const error = this.directoryErrors.get(targetPath);
    if (error) throw error;
    return this.directories.get(targetPath) ?? [];
  }

  failDirectoryRead(targetPath: string, error: Error): void {
    this.directoryErrors.set(targetPath, error);
  }

  pathExists(targetPath: string): boolean {
    return this.paths.has(targetPath);
  }

  expandHomePath(targetPath: string): string {
    return targetPath.startsWith("~/") ? `/home/me/${targetPath.slice(2)}` : targetPath;
  }

  isAbsolutePath(targetPath: string): boolean {
    return targetPath.startsWith("/") || /^[A-Z]:\//u.test(targetPath);
  }

  resolveCommand(commands: readonly string[]): string | null {
    for (const command of commands) {
      const executable = this.commands.get(command);
      if (executable) return executable;
    }
    return null;
  }

  async spawnDetached(input: { command: string; args: readonly string[] }): Promise<void> {
    this.launches.push({ command: input.command, args: [...input.args] });
  }

  async openPath(targetPath: string): Promise<void> {
    this.openedPaths.push(targetPath);
  }

  revealPath(targetPath: string): void {
    this.revealedPaths.push(targetPath);
  }

  async loadIcon(fileName: string): Promise<EditorTargetIcon> {
    return { kind: "image", dataUrl: `data:image/png;base64,${fileName}` };
  }

  hasMacApplication(applicationName: string): boolean {
    return this.macApplications.has(applicationName);
  }

  getMacApplicationBundle(applicationName: string): string | null {
    return this.hasMacApplication(applicationName) ? `/Applications/${applicationName}.app` : null;
  }

  async openMacApplication(input: {
    applicationName: string;
    applicationPath?: string;
    paths: readonly string[];
  }): Promise<void> {
    this.openedMacApplications.push({
      applicationName: input.applicationName,
      paths: [...input.paths],
    });
  }
}

describe("editor target registry", () => {
  it.skipIf(process.platform === "win32").each([
    { path: "/Applications/Rebased.app", systemInstalled: true },
    { path: "/Users/me/Applications/Rebased.app", systemInstalled: false },
  ])(
    "lists and launches Rebased at $path through desktop IPC",
    async ({ path, systemInstalled }) => {
      const temporaryDirectory = realpathSync(mkdtempSync(join(tmpdir(), "paseo-rebased-")));
      onTestFinished(() => rmSync(temporaryDirectory, { recursive: true, force: true }));
      const repoRoot = join(temporaryDirectory, "Project & tools");
      const workspacePath = join(repoRoot, "src");
      const nonRepository = join(temporaryDirectory, "ordinary-directory");
      const activeFile = join(workspacePath, "README.md");
      mkdirSync(workspacePath, { recursive: true });
      mkdirSync(nonRepository);
      writeFileSync(activeFile, "");
      const gitEnv = {
        PATH: process.env.PATH,
        GIT_CEILING_DIRECTORIES: temporaryDirectory,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      };
      execFileSync("git", ["init", "--quiet", repoRoot], { cwd: temporaryDirectory, env: gitEnv });

      const installedPaths = ["/Users/me/Applications/Rebased.app"];
      if (systemInstalled) installedPaths.push("/Applications/Rebased.app");
      const launches: RecordedLaunch[] = [];
      const runtime = createEditorTargetRuntime({
        platform: "darwin",
        env: { ...gitEnv, GIT_DIR: join(temporaryDirectory, "unrelated.git") },
        homeDirectory: "/Users/me",
        pathExists: (candidate) =>
          installedPaths.includes(candidate) ||
          (candidate.startsWith(`${temporaryDirectory}/`) && existsSync(candidate)),
        loadIcon: async () => ({ kind: "symbol", name: "folder" }),
        spawn: (command, args) => {
          launches.push({ command, args });
          const child = {
            once(event: "error" | "spawn", handler: (error?: Error) => void) {
              if (event === "spawn") queueMicrotask(() => handler());
              return child;
            },
            unref() {},
          };
          return child;
        },
      });
      const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
      registerEditorTargetHandlers({
        ipc: { handle: (channel, listener) => void handlers.set(channel, listener) },
        runtime,
      });

      const listTargets = handlers.get("paseo:editor:listTargets");
      const openTarget = handlers.get("paseo:editor:openTarget");
      if (!listTargets || !openTarget) throw new Error("Expected desktop editor IPC handlers");
      const finder = { id: "finder", kind: "file-manager" };
      const ordinaryTargets = await listTargets(null, { workspacePath: nonRepository });
      expect(ordinaryTargets).not.toContainEqual(expect.objectContaining({ id: "rebased" }));
      expect(ordinaryTargets).toContainEqual(expect.objectContaining(finder));
      expect(await listTargets(null, {})).toEqual(ordinaryTargets);

      expect(await listTargets(null, { workspacePath })).toContainEqual({
        id: "rebased",
        label: "Rebased",
        kind: "editor",
        icon: { kind: "symbol", name: "terminal" },
      });
      await openTarget(null, {
        editorId: "rebased",
        workspacePath,
        filePath: activeFile,
        line: 7,
      });
      await expect(
        openTarget(null, { editorId: "rebased", workspacePath: nonRepository }),
      ).rejects.toThrow("Could not resolve a Git repository root for Rebased");

      expect(launches).toEqual([{ command: "/usr/bin/open", args: ["-a", path, repoRoot] }]);
    },
  );

  it.each(["darwin", "linux", "win32"] as const)(
    "hides Rebased when unavailable on %s",
    async (platform) => {
      const repoRoot = platform === "win32" ? "C:/repo" : "/repo";
      const runtime = createEditorTargetRuntime({
        platform,
        env: {},
        loadIcon: async () => ({ kind: "symbol", name: "folder" }),
        pathExists: (path) =>
          path === repoRoot || (platform !== "darwin" && path === "/Applications/Rebased.app"),
      });

      const targets = await listAvailableEditorTargets(runtime, undefined, {
        workspacePath: repoRoot,
      });
      expect(targets.map(({ id }) => id)).not.toContain("rebased");
      await expect(
        openEditorTarget({ editorId: "rebased", workspacePath: repoRoot }, runtime),
      ).rejects.toThrow("Editor target unavailable: Rebased");
    },
  );

  it("lists installed target implementations in registration order", async () => {
    const runtime = new FakeEditorTargets();
    runtime.installCommand("code");
    runtime.installCommand("webstorm");

    const targets = await listAvailableEditorTargets(runtime, [
      cursorTarget,
      vscodeTarget,
      webstormTarget,
      fileManagerTarget,
    ]);

    expect(targets).toEqual([
      {
        id: "vscode",
        label: "VS Code",
        kind: "editor",
        icon: { kind: "image", dataUrl: "data:image/png;base64,vscode.png" },
      },
      {
        id: "webstorm",
        label: "WebStorm",
        kind: "editor",
        icon: { kind: "image", dataUrl: "data:image/png;base64,webstorm.png" },
      },
      {
        id: "file-manager",
        label: "Files",
        kind: "file-manager",
        icon: { kind: "symbol", name: "folder" },
      },
    ]);
  });

  it("opens a selected file at its position through the target implementation", async () => {
    const runtime = new FakeEditorTargets();
    runtime.installCommand("code");
    runtime.addPath("/repo");
    runtime.addPath("/repo/src/app.ts");

    await openEditorTarget(
      {
        editorId: "vscode",
        workspacePath: "/repo",
        filePath: "/repo/src/app.ts",
        line: 12,
        column: 4,
      },
      runtime,
      [vscodeTarget],
    );

    expect(runtime.launches).toEqual([
      {
        command: "/bin/code",
        args: ["/repo", "--goto", "/repo/src/app.ts:12:4"],
      },
    ]);
  });

  it("lets each target choose its own command and arguments", async () => {
    const runtime = new FakeEditorTargets();
    runtime.installCommand("zeditor");
    runtime.installCommand("webstorm");
    runtime.installCommand("idea");

    await zedTarget.launch(
      { workspacePath: "/repo", filePath: "/repo/src/app.ts", line: 7, column: 2 },
      runtime,
    );
    await webstormTarget.launch(
      { workspacePath: "/repo", filePath: "/repo/src/app.ts", line: 7, column: 2 },
      runtime,
    );
    await intellijIdeaTarget.launch({ workspacePath: "/repo" }, runtime);

    expect(runtime.launches).toEqual([
      { command: "/bin/zeditor", args: ["/repo", "/repo/src/app.ts:7:2"] },
      {
        command: "/bin/webstorm",
        args: ["--line", "7", "--column", "2", "/repo", "/repo/src/app.ts"],
      },
      { command: "/bin/idea", args: ["/repo"] },
    ]);
  });

  it("recognizes Windows 64-bit project IDE launchers", async () => {
    const runtime = new FakeEditorTargets("win32");
    runtime.installCommand("pycharm64", "C:/Tools/PyCharm/bin/pycharm64.exe");

    expect(await pycharmTarget.isInstalled(runtime)).toBe(true);
    await pycharmTarget.launch(
      { workspacePath: "C:/repo", filePath: "C:/repo/src/app.py", line: 6 },
      runtime,
    );

    expect(runtime.launches).toEqual([
      {
        command: "C:/Tools/PyCharm/bin/pycharm64.exe",
        args: ["--line", "6", "C:/repo", "C:/repo/src/app.py"],
      },
    ]);
  });

  it("detects and launches the macOS application when the command is absent", async () => {
    const runtime = new FakeEditorTargets("darwin");
    runtime.installMacApplication("Cursor");

    expect(await cursorTarget.isInstalled(runtime)).toBe(true);
    await cursorTarget.launch({ workspacePath: "/repo", filePath: "/repo/src/app.ts" }, runtime);

    expect(runtime.openedMacApplications).toEqual([
      {
        applicationName: "Cursor",
        paths: ["/repo", "/repo/src/app.ts"],
      },
    ]);
  });

  it("uses Cursor's bundled macOS command so file positions survive application detection", async () => {
    const runtime = new FakeEditorTargets("darwin");
    const bundledCommand = "/Applications/Cursor.app/Contents/Resources/app/bin/cursor";
    runtime.installCommand(bundledCommand, bundledCommand);

    expect(await cursorTarget.isInstalled(runtime)).toBe(true);
    await cursorTarget.launch(
      { workspacePath: "/repo", filePath: "/repo/src/app.ts", line: 18, column: 3 },
      runtime,
    );

    expect(runtime.launches).toEqual([
      {
        command: bundledCommand,
        args: ["/repo", "--goto", "/repo/src/app.ts:18:3"],
      },
    ]);
  });

  it("lists and opens Android Studio through its bundled macOS launcher", async () => {
    const runtime = new FakeEditorTargets("darwin", { HOME: "/Users/me" });
    const bundledCommand = "/Users/me/Applications/Android Studio.app/Contents/MacOS/studio";
    runtime.installCommand(bundledCommand, bundledCommand);
    runtime.addPath("/repo");
    runtime.addPath("/repo/app/src/main/MainActivity.kt");

    const targets = await listAvailableEditorTargets(runtime);

    expect(targets).toContainEqual({
      id: "android-studio",
      label: "Android Studio",
      kind: "editor",
      icon: { kind: "image", dataUrl: "data:image/png;base64,android-studio.png" },
    });

    await openEditorTarget(
      {
        editorId: "android-studio",
        workspacePath: "/repo",
        filePath: "/repo/app/src/main/MainActivity.kt",
        line: 18,
        column: 3,
      },
      runtime,
    );

    expect(runtime.launches).toEqual([
      {
        command: bundledCommand,
        args: ["/repo", "--line", "18", "--column", "3", "/repo/app/src/main/MainActivity.kt"],
      },
    ]);
  });

  it("lists Xcode only for workspaces that hold something Xcode can open", async () => {
    const runtime = new FakeEditorTargets("darwin");
    runtime.installMacApplication("Xcode");
    runtime.addDirectory("/repo/ios-app", ["ios-app.xcodeproj", "Sources"]);
    runtime.addDirectory("/repo/web-app", ["package.json", "src"]);

    const iosTargets = await listAvailableEditorTargets(runtime, [xcodeTarget], {
      workspacePath: "/repo/ios-app",
    });
    const webTargets = await listAvailableEditorTargets(runtime, [xcodeTarget], {
      workspacePath: "/repo/web-app",
    });
    const unscopedTargets = await listAvailableEditorTargets(runtime, [xcodeTarget]);

    expect(iosTargets).toEqual([
      {
        id: "xcode",
        label: "Xcode",
        kind: "editor",
        icon: { kind: "image", dataUrl: "data:image/png;base64,xcode.png" },
      },
    ]);
    expect(webTargets).toEqual([]);
    expect(unscopedTargets).toEqual([]);
  });

  it("does not mistake similarly named files and directories for Xcode documents", async () => {
    const runtime = new FakeEditorTargets("darwin");
    runtime.installMacApplication("Xcode");
    runtime.addDirectoryEntries("/repo/not-an-xcode-project", [
      { name: "Notes.xcodeproj", kind: "file" },
      { name: "App.xcworkspace", kind: "file" },
      { name: "Package.swift", kind: "directory" },
    ]);

    await expect(
      listAvailableEditorTargets(runtime, [xcodeTarget], {
        workspacePath: "/repo/not-an-xcode-project",
      }),
    ).resolves.toEqual([]);
  });

  it("hands Xcode the umbrella workspace and the requested file", async () => {
    const runtime = new FakeEditorTargets("darwin");
    runtime.installMacApplication("Xcode");
    runtime.addDirectory("/repo/Tickets", [
      "Package.swift",
      "Widgets.xcworkspace",
      "Tickets.xcworkspace",
      "Tickets.xcodeproj",
    ]);
    runtime.addPath("/repo/Tickets/Sources/App.swift");

    await openEditorTarget(
      {
        editorId: "xcode",
        workspacePath: "/repo/Tickets",
        filePath: "/repo/Tickets/Sources/App.swift",
        line: 12,
      },
      runtime,
      [xcodeTarget],
    );

    expect(runtime.openedMacApplications).toEqual([
      {
        applicationName: "Xcode",
        paths: ["/repo/Tickets/Tickets.xcworkspace", "/repo/Tickets/Sources/App.swift"],
      },
    ]);
  });

  it("falls back from Xcode workspaces to projects to Swift packages", async () => {
    const runtime = new FakeEditorTargets("darwin");
    runtime.installMacApplication("Xcode");
    runtime.addDirectory("/repo/project-only", ["Beta.xcodeproj", "Alpha.xcodeproj"]);
    runtime.addDirectory("/repo/package-only", ["Package.swift", "Sources"]);

    await openEditorTarget({ editorId: "xcode", workspacePath: "/repo/project-only" }, runtime);
    await openEditorTarget({ editorId: "xcode", workspacePath: "/repo/package-only" }, runtime);

    expect(runtime.openedMacApplications.map((entry) => entry.paths)).toEqual([
      ["/repo/project-only/Alpha.xcodeproj"],
      ["/repo/package-only/Package.swift"],
    ]);
  });

  it("refuses to launch Xcode for a directory it cannot open", async () => {
    const runtime = new FakeEditorTargets("darwin");
    runtime.installMacApplication("Xcode");
    runtime.addDirectory("/repo/web-app", ["package.json"]);

    await expect(
      openEditorTarget({ editorId: "xcode", workspacePath: "/repo/web-app" }, runtime),
    ).rejects.toThrow(/No Xcode project/u);
    expect(runtime.openedMacApplications).toEqual([]);
  });

  it("keeps installed editors in registration order when Xcode matches", async () => {
    const runtime = new FakeEditorTargets("darwin");
    runtime.installCommand("code");
    runtime.installMacApplication("Xcode");
    runtime.addDirectory("/repo", ["App.xcodeproj"]);

    const targets = await listAvailableEditorTargets(runtime, [vscodeTarget, xcodeTarget], {
      workspacePath: "/repo",
    });

    expect(targets.map((target) => target.id)).toEqual(["vscode", "xcode"]);
  });

  it.each(["EACCES", "EPERM", "ENOENT", "ENOTDIR"])(
    "keeps general editor targets when Xcode discovery fails with %s",
    async (code) => {
      const runtime = new FakeEditorTargets("darwin");
      runtime.installCommand("code");
      runtime.installMacApplication("Xcode");
      runtime.addPath("/repo");
      const error = Object.assign(new Error("Cannot read directory"), { code });
      runtime.failDirectoryRead("/repo", error);

      const targets = await listAvailableEditorTargets(
        runtime,
        [vscodeTarget, xcodeTarget, finderTarget],
        {
          workspacePath: "/repo",
        },
      );

      expect(targets.map((target) => target.id)).toEqual(["vscode", "finder"]);
      await expect(
        openEditorTarget({ editorId: "xcode", workspacePath: "/repo" }, runtime),
      ).rejects.toBe(error);
    },
  );

  it("propagates unexpected Xcode discovery failures", async () => {
    const runtime = new FakeEditorTargets("darwin");
    runtime.installMacApplication("Xcode");
    const error = Object.assign(new Error("I/O failure"), { code: "EIO" });
    runtime.failDirectoryRead("/repo", error);

    await expect(
      listAvailableEditorTargets(runtime, [xcodeTarget], { workspacePath: "/repo" }),
    ).rejects.toBe(error);
  });

  it("does not discover nested Xcode documents or list an uninstalled Xcode", async () => {
    const runtime = new FakeEditorTargets("darwin");
    runtime.addDirectory("/repo", ["App.xcodeproj"]);
    const withoutXcode = await listAvailableEditorTargets(runtime, [xcodeTarget], {
      workspacePath: "/repo",
    });
    runtime.installMacApplication("Xcode");
    runtime.addDirectory("/nested-repo", ["ios"]);
    runtime.addDirectory("/nested-repo/ios", ["App.xcworkspace"]);
    const nested = await listAvailableEditorTargets(runtime, [xcodeTarget], {
      workspacePath: "/nested-repo",
    });

    expect(withoutXcode).toEqual([]);
    expect(nested).toEqual([]);
  });

  it("detects Cursor's installed Windows command when it is absent from PATH", async () => {
    const runtime = new FakeEditorTargets("win32", {
      LOCALAPPDATA: "C:/Users/me/AppData/Local",
    });
    const installedCommand =
      "C:/Users/me/AppData/Local/Programs/cursor/resources/app/bin/cursor.cmd";
    runtime.installCommand(installedCommand, installedCommand);

    expect(await cursorTarget.isInstalled(runtime)).toBe(true);
    await cursorTarget.launch(
      { workspacePath: "C:/repo", filePath: "C:/repo/src/app.ts", line: 9 },
      runtime,
    );

    expect(runtime.launches).toEqual([
      {
        command: installedCommand,
        args: ["C:/repo", "--goto", "C:/repo/src/app.ts:9"],
      },
    ]);
  });

  it("delegates folder opening and file reveal to the system file manager", async () => {
    const runtime = new FakeEditorTargets("win32");

    expect(await explorerTarget.describe(runtime)).toEqual({
      id: "explorer",
      label: "Explorer",
      kind: "file-manager",
      icon: { kind: "symbol", name: "folder" },
    });
    await explorerTarget.launch({ workspacePath: "C:/repo" }, runtime);
    await explorerTarget.launch(
      { workspacePath: "C:/repo", filePath: "C:/repo/src/app.ts" },
      runtime,
    );

    expect(runtime.openedPaths).toEqual(["C:/repo"]);
    expect(runtime.revealedPaths).toEqual(["C:/repo/src/app.ts"]);
  });

  it("opens a home-relative folder in the file manager", async () => {
    const runtime = new FakeEditorTargets();
    runtime.addPath("/home/me/Downloads/contracts");

    await openEditorTarget(
      { editorId: "file-manager", workspacePath: "~/Downloads/contracts" },
      runtime,
      [fileManagerTarget],
    );

    expect(runtime.openedPaths).toEqual(["/home/me/Downloads/contracts"]);
  });

  it("keeps the platform file-manager ids used by stored preferences", async () => {
    const macTargets = await listAvailableEditorTargets(new FakeEditorTargets("darwin"), [
      finderTarget,
      explorerTarget,
      fileManagerTarget,
    ]);
    const windowsTargets = await listAvailableEditorTargets(new FakeEditorTargets("win32"), [
      finderTarget,
      explorerTarget,
      fileManagerTarget,
    ]);

    expect(macTargets.map((target) => target.id)).toEqual(["finder"]);
    expect(windowsTargets.map((target) => target.id)).toEqual(["explorer"]);
  });
});
