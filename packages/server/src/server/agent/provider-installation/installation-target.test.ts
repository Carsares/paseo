import { link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { findInstallationLaunchPath, readInstallationActivityKeys } from "./installation-target.js";

let home: string;
let versions: string;
let entry: string;

beforeEach(async () => {
  home = await mkdtemp(path.join(await realpath(tmpdir()), "paseo-cli-installation-"));
  versions = path.join(home, ".local/share/claude/versions");
  entry = path.join(home, ".local/bin/claude");
  await mkdir(versions, { recursive: true });
  await mkdir(path.dirname(entry), { recursive: true });
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

test("Windows Claude discovery falls back to the WinGet package when PATH has no match", async () => {
  const packageDir = path.join(
    home,
    "Microsoft",
    "WinGet",
    "Packages",
    "Anthropic.ClaudeCode_test",
  );
  await mkdir(packageDir, { recursive: true });
  const claude = path.join(packageDir, "claude.exe");
  await writeFile(claude, "");

  const locateClaude = (searchPath: string) =>
    findInstallationLaunchPath("claude", {
      cwd: home,
      platform: "win32",
      env: { Path: searchPath, PATHEXT: ".EXE", LOCALAPPDATA: home },
      winGetFallback: true,
    });
  await expect(locateClaude(path.join(home, "missing"))).resolves.toBe(claude);

  const pathClaude = path.join(home, "claude.EXE");
  await writeFile(pathClaude, "");
  await expect(locateClaude(home)).resolves.toBe(pathClaude);
});

test("Windows launch discovery follows the effective PATH and PATHEXT without running files", async () => {
  const launcherDir = path.join(home, "launchers with spaces");
  await mkdir(launcherDir);
  const preferred = path.join(launcherDir, "paseo-test-cli.CMD");
  await writeFile(preferred, "");
  await writeFile(path.join(launcherDir, "paseo-test-cli.EXE"), "");

  await expect(
    findInstallationLaunchPath("paseo-test-cli", {
      cwd: home,
      platform: "win32",
      env: { Path: 'missing;"launchers with spaces"', PATHEXT: ".CMD;.EXE", Pathext: ".EXE" },
    }),
  ).resolves.toBe(preferred);

  await expect(
    findInstallationLaunchPath(path.join("launchers with spaces", "paseo-test-cli"), {
      cwd: home,
      platform: "win32",
      env: { PATHEXT: ".CMD" },
    }),
  ).resolves.toBe(preferred);

  const explicit = path.join(launcherDir, "paseo-test-cli.EXE");
  await expect(
    findInstallationLaunchPath(explicit, {
      cwd: home,
      platform: "win32",
      env: { PATHEXT: ".CMD" },
    }),
  ).resolves.toBe(explicit);

  const local = path.join(home, "paseo-test-cli.CMD");
  await writeFile(local, "");
  const lookup = {
    cwd: home,
    platform: "win32" as const,
    env: { PATH: launcherDir, PATHEXT: ".CMD" },
  };
  await expect(findInstallationLaunchPath("paseo-test-cli", lookup)).resolves.toBe(preferred);
  await expect(findInstallationLaunchPath("paseo-test-cli.EXE", lookup)).resolves.toBe(explicit);
  await expect(
    findInstallationLaunchPath("paseo-test-cli", { ...lookup, searchWindowsLaunchDirectory: true }),
  ).resolves.toBe(local);
  await expect(
    findInstallationLaunchPath("paseo-test-cli", {
      ...lookup,
      searchWindowsLaunchDirectory: true,
      env: { ...lookup.env, NoDefaultCurrentDirectoryInExePath: "" },
    }),
  ).resolves.toBe(preferred);
});

test.skipIf(process.platform === "win32")(
  "preserves filesystem traversal in explicit paths containing symlinks and parent segments",
  async () => {
    const target = path.join(home, "target");
    await mkdir(path.join(target, "nested"), { recursive: true });
    await symlink(path.join(target, "nested"), path.join(home, "link"));
    const executable = path.join(target, "cli");
    await writeFile(executable, "", { mode: 0o700 });
    const explicit = `${home}/link/../cli`;

    await expect(findInstallationLaunchPath(explicit, { cwd: home })).resolves.toBe(explicit);
    await expect(findInstallationLaunchPath("link/../cli", { cwd: home })).resolves.toBe(explicit);
    await expect(realpath(explicit)).resolves.toBe(executable);
    await writeFile(path.join(home, "cli"), "", { mode: 0o700 });
    await expect(
      findInstallationLaunchPath("cli", { cwd: home, path: `link/..${path.delimiter}${home}` }),
    ).resolves.toBe(explicit);
  },
);

test.skipIf(process.platform === "win32")(
  "identifies hard links and a launch entry without executing either",
  async () => {
    const executable = path.join(versions, "1.2.3");
    await writeFile(executable, Buffer.from("7f454c46", "hex"), { mode: 0o700 });
    await symlink(executable, entry);
    const alias = path.join(home, "alias");
    await link(executable, alias);

    const canonicalKeys = await readInstallationActivityKeys(entry);
    const aliasKeys = await readInstallationActivityKeys(alias);
    expect(canonicalKeys.filter((key) => key.startsWith("file:"))).toEqual(
      aliasKeys.filter((key) => key.startsWith("file:")),
    );

    await expect(
      findInstallationLaunchPath("claude", { cwd: home, path: ".local/bin" }),
    ).resolves.toBe(entry);
    expect(canonicalKeys).toContain(`path:${entry}`);
  },
);

test.skipIf(process.platform === "win32")(
  "tracks the shared node_modules root only with package metadata",
  async () => {
    const modules = path.join(home, "node_modules");
    const packageRoot = path.join(modules, "@vendor", "cli");
    const command = path.join(packageRoot, "bin", "cli");
    await mkdir(path.dirname(command), { recursive: true });
    await writeFile(command, "", { mode: 0o700 });

    expect(await readInstallationActivityKeys(command)).not.toContain(`root:${modules}`);
    await writeFile(
      path.join(packageRoot, "package.json"),
      '{"name":"@vendor/cli","bin":{"cli":"bin/cli"}}',
    );
    expect(await readInstallationActivityKeys(command)).toContain(`root:${modules}`);
  },
);
