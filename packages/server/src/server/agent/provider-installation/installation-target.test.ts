import { execFile } from "node:child_process";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  acquireApprovedUpdateFileLock,
  acquireProviderAgentFileTicket,
  acquireProviderUpdateFileLock,
  findInstallationLaunchPath,
  readInstallationActivityKeys,
  supportsHostApprovedProviderUpdates,
} from "./installation-target.js";

let home: string;
let versions: string;
let entry: string;
const execFileAsync = promisify(execFile);

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

test.each([
  { platform: "darwin", getuid: true, geteuid: true, supported: true },
  { platform: "darwin", getuid: false, geteuid: true, supported: false },
  { platform: "darwin", getuid: true, geteuid: false, supported: false },
  { platform: "linux", getuid: true, geteuid: true, supported: false },
  { platform: "win32", getuid: false, geteuid: false, supported: false },
])(
  "reports host approval support for $platform with getuid=$getuid and geteuid=$geteuid",
  (input) => {
    const original = Object.getOwnPropertyDescriptors(process);
    const identity = () => 501;
    try {
      Object.defineProperties(process, {
        platform: { value: input.platform },
        getuid: { configurable: true, value: input.getuid ? identity : undefined },
        geteuid: { configurable: true, value: input.geteuid ? identity : undefined },
      });
      expect(supportsHostApprovedProviderUpdates()).toBe(input.supported);
    } finally {
      Object.defineProperty(process, "platform", original.platform!);
      if (original.getuid) Object.defineProperty(process, "getuid", original.getuid);
      else Reflect.deleteProperty(process, "getuid");
      if (original.geteuid) Object.defineProperty(process, "geteuid", original.geteuid);
      else Reflect.deleteProperty(process, "geteuid");
    }
  },
);

// Explicit accounts let the low-level POSIX lock tests run on macOS and Linux in temporary directories.
test.skipIf(!["linux", "darwin"].includes(process.platform))(
  "excludes another process and retains an abandoned updater lock",
  async () => {
    const directory = path.join(home, "coordination");
    const account = { directory, uid: process.geteuid!() };
    const ownerPath = path.join(directory, ".paseo-provider-update.lock/owner.json");
    const module = new URL("./installation-target.ts", import.meta.url).href;
    const child = () =>
      promisify(execFile)(
        process.execPath,
        [
          "--import",
          "tsx",
          "--input-type=module",
          "--eval",
          `import { acquireProviderUpdateFileLock } from ${JSON.stringify(module)};
          const release = await acquireProviderUpdateFileLock({
            directory: process.argv[1],
            uid: process.geteuid()
          });
          process.stdout.write(release ? String(process.pid) : "blocked");`,
          directory,
        ],
        { timeout: 5_000 },
      );
    const release = await acquireProviderUpdateFileLock(account);
    if (!release) throw new Error("Missing initial provider update lock");
    try {
      await expect(child()).resolves.toMatchObject({ stdout: "blocked" });
      expect((await stat(directory)).mode & 0o7777).toBe(0o700);
      expect(JSON.parse(await readFile(ownerPath, "utf8"))).toEqual({
        version: 1,
        pid: process.pid,
        startedAt: expect.any(String),
      });
      expect((await stat(ownerPath)).mode & 0o777).toBe(0o600);
    } finally {
      await release();
    }
    await expect(stat(ownerPath)).rejects.toHaveProperty("code", "ENOENT");
    const { stdout } = await child();
    expect(stdout).toMatch(/^\d+$/u);
    const abandoned = JSON.parse(await readFile(ownerPath, "utf8"));
    expect(abandoned).toEqual({ version: 1, pid: Number(stdout), startedAt: expect.any(String) });
    expect(new Date(abandoned.startedAt).toISOString()).toBe(abandoned.startedAt);
    await expect(acquireProviderUpdateFileLock(account)).resolves.toBeNull();
  },
  15_000,
);

test.skipIf(!["linux", "darwin"].includes(process.platform))(
  "refuses admission when the coordination directory cannot be created",
  async () => {
    const account = {
      directory: path.join(home, "missing", "coordination"),
      uid: process.geteuid!(),
    };
    expect(() => acquireProviderAgentFileTicket(account)).toThrow(
      "Could not record provider agent activity.",
    );
    await expect(acquireProviderUpdateFileLock(account)).rejects.toHaveProperty("code", "ENOENT");
    await expect(acquireApprovedUpdateFileLock(account)).rejects.toHaveProperty("code", "ENOENT");
  },
);

test
  .skipIf(!["linux", "darwin"].includes(process.platform))
  .each(["wrong owner", "public mode", "symbolic link"] as const)(
  "refuses all three admissions for a coordination directory with %s",
  async (unsafe) => {
    const backing = path.join(home, "backing");
    await mkdir(backing, { mode: 0o700 });
    let directory = backing;
    if (unsafe === "symbolic link") {
      directory = path.join(home, "link");
      await symlink(backing, directory);
    } else if (unsafe === "public mode") {
      await chmod(backing, 0o755);
    }
    const account = { directory, uid: process.geteuid!() + Number(unsafe === "wrong owner") };
    expect(() => acquireProviderAgentFileTicket(account)).toThrow(
      "Could not record provider agent activity.",
    );
    await expect(acquireProviderUpdateFileLock(account)).rejects.toThrow(
      "Could not verify the private provider coordination directory.",
    );
    await expect(acquireApprovedUpdateFileLock(account)).rejects.toThrow(
      "Could not verify the private provider coordination directory.",
    );
    expect(await readdir(backing)).toEqual([]);
  },
);

test.skipIf(!supportsHostApprovedProviderUpdates())(
  "keeps default coordination across a replaced OS account home and an exited agent process",
  async () => {
    const directory = path.join(home, "coordination");
    const account = { directory, uid: process.geteuid!() };
    const module = new URL("./installation-target.ts", import.meta.url).href;
    await promisify(execFile)(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        `import assert from "node:assert/strict";
        import cp from "node:child_process";
        import fs from "node:fs";
        import path from "node:path";
        import { syncBuiltinESMExports } from "node:module";
        const [root, directory] = process.argv.slice(1);
        const accountHome = path.join(root, "account-home");
        const join = path.join;
        const getconfPath = "/usr/bin/getconf";
        const { spawnSync } = cp;
        const result = spawnSync(getconfPath, ["DARWIN_USER_DIR"], { encoding: "utf8", env: {} });
        assert.equal(result.status, 0);
        const userDirectory = result.stdout.trim().replace(/^\\/var\\//, "/private/var/").replace(/\\/$/, "");
        assert.match(userDirectory, /^\\/private\\/var\\/folders\\/[^/]+\\/[^/]+\\/0$/);
        const expected = join(userDirectory, "paseo-provider-coordination");
        const { lstatSync, mkdirSync } = fs;
        mkdirSync(accountHome, { mode: 0o700 });
        const originalInfo = lstatSync(accountHome);
        let badPath, badStat, directoryOutput;
        cp.spawnSync = (command, args, options) => {
          if (command === getconfPath) {
            assert.deepEqual(args, ["DARWIN_USER_DIR"]);
            assert.deepEqual(options.env, { LC_ALL: "C" });
            if (directoryOutput !== undefined) return { ...result, stdout: directoryOutput };
          }
          return spawnSync(command, args, options);
        };
        fs.lstatSync = (target, ...args) => {
          const stat = lstatSync(target, ...args);
          return target === badPath ? Object.assign(stat, badStat) : stat;
        };
        path.join = (...args) => {
          const result = join(...args);
          return result === expected ? directory : result;
        };
        fs.mkdirSync = (target, ...args) => {
          assert.ok(target.startsWith(root + path.sep), "mkdir outside the test directory");
          return mkdirSync(target, ...args);
        };
        syncBuiltinESMExports();
        Object.assign(process.env, {
          HOME: accountHome, PASEO_HOME: accountHome, TMPDIR: accountHome,
          DIRHELPER_USER_DIR_SUFFIX: "invalid",
        });
        const { acquireProviderAgentFileTicket, acquireApprovedUpdateFileLock,
          acquireProviderUpdateFileLock } = await import(${JSON.stringify(module)});
        const getuid = process.getuid;
        process.getuid = () => process.geteuid() + 1;
        directoryOutput = "must not reach getconf";
        const uidError = /matching real and effective user IDs/;
        assert.throws(() => acquireProviderAgentFileTicket(), error => uidError.test(error.cause?.message));
        await assert.rejects(acquireProviderUpdateFileLock(), uidError);
        await assert.rejects(acquireApprovedUpdateFileLock(), uidError);
        assert.equal(fs.existsSync(directory), false);
        process.getuid = getuid;
        directoryOutput = undefined;
        for (const [invalidPath, invalidStat] of [
          ["/private/var/folders", { mode: 0o41777 }],
          [path.dirname(userDirectory), { uid: process.geteuid() + 1 }],
          [userDirectory, { isDirectory: () => false }],
        ]) {
          [badPath, badStat] = [invalidPath, invalidStat];
          assert.throws(() => acquireProviderAgentFileTicket(), /Could not record provider agent activity/);
          await assert.rejects(acquireProviderUpdateFileLock(), /Could not trust the provider coordination directory/);
          await assert.rejects(acquireApprovedUpdateFileLock(), /Could not trust the provider coordination directory/);
          assert.equal(fs.existsSync(directory), false);
        }
        badPath = undefined;
        for (const suffix of ["C", "T", "0/unexpected"]) {
          directoryOutput = userDirectory.slice(0, -1) + suffix + "/\\n";
          await assert.rejects(acquireProviderUpdateFileLock(), /Could not locate the macOS provider coordination directory/);
          assert.equal(fs.existsSync(directory), false);
        }
        directoryOutput = userDirectory + "/\\n";
        acquireProviderAgentFileTicket();
        fs.renameSync(accountHome, accountHome + "-detached");
        mkdirSync(accountHome, { mode: 0o700 });
        const replacement = lstatSync(accountHome);
        assert.equal(replacement.uid, originalInfo.uid);
        assert.equal(replacement.mode, originalInfo.mode);
        assert.deepEqual(fs.readdirSync(accountHome), []);
        Object.assign(process.env, {
          HOME: accountHome + "-detached",
          PASEO_HOME: directory + "-other-paseo",
          TMPDIR: directory + "-other-tmp"
        });
        const releaseUpdate = await acquireProviderUpdateFileLock();
        assert.ok(releaseUpdate);
        assert.equal(fs.existsSync(join(directory, ".paseo-provider-update.lock", "owner.json")), true);
        await assert.rejects(acquireApprovedUpdateFileLock(), /Paseo agent activity is recorded for this account/);
        await releaseUpdate();`,
        home,
        directory,
      ],
      { timeout: 5_000 },
    );
    // The exited process left its ticket and a refused approval released its lock.
    await expect(acquireApprovedUpdateFileLock(account)).rejects.toThrow(
      "Paseo agent activity is recorded for this account",
    );
  },
);

test.skipIf(process.platform !== "darwin").each(["parent", "coordination directory"])(
  "rejects a macOS ACL granting write access to the %s",
  async (role) => {
    const directory = path.join(home, "coordination");
    if (role !== "parent") await mkdir(directory, { mode: 0o700 });
    const target = role === "parent" ? home : directory;
    await execFileAsync("/bin/chmod", ["+a", "everyone allow writesecurity", target]);
    try {
      const account = { directory, uid: process.geteuid!() };
      expect(() => acquireProviderAgentFileTicket(account)).toThrow(
        expect.objectContaining({
          cause: expect.objectContaining({ message: expect.stringContaining("access controls") }),
        }),
      );
      await expect(acquireProviderUpdateFileLock(account)).rejects.toThrow("access controls");
      await expect(acquireApprovedUpdateFileLock(account)).rejects.toThrow("access controls");
      if (role === "parent") await expect(stat(directory)).rejects.toHaveProperty("code", "ENOENT");
      else expect(await readdir(directory)).toEqual([]);
    } finally {
      await execFileAsync("/bin/chmod", ["-N", target]);
    }
  },
);

test.skipIf(process.platform !== "darwin").each(["parent", "coordination", "ticket directory"])(
  "refuses to create coordination children when the %s grants inheritable access",
  async (role) => {
    const directory = path.join(home, "coordination");
    const tickets = path.join(directory, ".paseo-provider-agents");
    if (role === "coordination") await mkdir(directory, { mode: 0o700 });
    if (role === "ticket directory") await mkdir(tickets, { recursive: true, mode: 0o700 });
    const parent = { parent: home, coordination: directory, "ticket directory": tickets }[role];
    await execFileAsync("/bin/chmod", [
      "+a",
      "everyone allow writesecurity,file_inherit,directory_inherit,only_inherit",
      parent,
    ]);
    try {
      const account = { directory, uid: process.geteuid!() };
      expect(() => acquireProviderAgentFileTicket(account)).toThrow(
        expect.objectContaining({
          cause: expect.objectContaining({ message: expect.stringContaining("access controls") }),
        }),
      );
      if (role !== "ticket directory") {
        await expect(acquireProviderUpdateFileLock(account)).rejects.toThrow("access controls");
      }
      await expect(acquireApprovedUpdateFileLock(account)).rejects.toThrow("access controls");
      if (role === "parent") await expect(stat(directory)).rejects.toHaveProperty("code", "ENOENT");
      if (role === "coordination") expect(await readdir(directory)).toEqual([]);
      if (role === "ticket directory") {
        expect(await readdir(directory)).toEqual([".paseo-provider-agents"]);
        expect(await readdir(tickets)).toEqual([]);
      }
    } finally {
      await execFileAsync("/bin/chmod", ["-N", parent]);
    }
  },
);

test.skipIf(process.platform !== "darwin")(
  "rejects an explicitly injected coordination directory with mismatched user IDs",
  async () => {
    const directory = path.join(home, "coordination");
    const uid = process.geteuid!();
    const getuid = vi.spyOn(process, "getuid").mockReturnValue(uid + 1);
    try {
      const account = { directory, uid };
      expect(() => acquireProviderAgentFileTicket(account)).toThrow(
        expect.objectContaining({
          cause: expect.objectContaining({
            message: expect.stringContaining("matching real and effective user IDs"),
          }),
        }),
      );
      await expect(acquireProviderUpdateFileLock(account)).rejects.toThrow(
        "matching real and effective user IDs",
      );
      await expect(acquireApprovedUpdateFileLock(account)).rejects.toThrow(
        "matching real and effective user IDs",
      );
      await expect(stat(directory)).rejects.toHaveProperty("code", "ENOENT");
    } finally {
      getuid.mockRestore();
    }
  },
);

test
  .skipIf(process.platform !== "darwin")
  .each(["delete", "chown,file_inherit,directory_inherit,only_inherit"])(
  "admits agents and updates through a macOS deny-only ACL for %s",
  async (rights) => {
    const directory = path.join(home, "coordination");
    await mkdir(directory, { mode: 0o700 });
    await execFileAsync("/bin/chmod", ["+a", `everyone deny ${rights}`, directory]);
    try {
      const account = { directory, uid: process.geteuid!() };
      const releaseTicket = acquireProviderAgentFileTicket(account);
      releaseTicket();
      const releaseUpdate = await acquireProviderUpdateFileLock(account);
      const releaseApproval = await acquireApprovedUpdateFileLock(account);
      await releaseApproval();
      await releaseUpdate?.();
      expect(await readdir(directory)).toEqual([".paseo-provider-agents"]);
    } finally {
      await execFileAsync("/bin/chmod", ["-N", directory]);
    }
  },
);

test.skipIf(!["linux", "darwin"].includes(process.platform))(
  "refuses agent admission when another process takes the approval lock during registration",
  async () => {
    const account = { directory: home, uid: process.geteuid!() };
    const ready = path.join(home, "registration-ready");
    const proceed = path.join(home, "continue-registration");
    const module = new URL("./installation-target.ts", import.meta.url).href;
    const child = promisify(execFile)(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        `import fs from "node:fs";
        import { syncBuiltinESMExports } from "node:module";
        const [directory, ready, proceed] = process.argv.slice(1);
        const mkdtempSync = fs.mkdtempSync;
        fs.mkdtempSync = (...args) => {
          fs.writeFileSync(ready, "");
          const wait = new Int32Array(new SharedArrayBuffer(4));
          while (!fs.existsSync(proceed)) Atomics.wait(wait, 0, 0, 10);
          return mkdtempSync(...args);
        };
        syncBuiltinESMExports();
        const { acquireProviderAgentFileTicket } = await import(${JSON.stringify(module)});
        try {
          const release = acquireProviderAgentFileTicket({ directory, uid: process.geteuid() });
          release();
          process.stdout.write("admitted");
        } catch (error) {
          process.stdout.write(error.message);
        }`,
        home,
        ready,
        proceed,
      ],
      { timeout: 10_000 },
    );
    void child.catch(() => undefined);
    let release: (() => Promise<void>) | undefined;
    try {
      await vi.waitFor(() => stat(ready), { timeout: 5000 });
      release = await acquireApprovedUpdateFileLock(account);
      await writeFile(proceed, "");
      await expect(child).resolves.toMatchObject({
        stdout: expect.stringContaining("An approved provider update is in progress"),
      });
    } finally {
      await writeFile(proceed, "");
      await child.catch(() => undefined);
      await release?.();
    }
    // The refused child removed the ticket it briefly published.
    const retry = await acquireApprovedUpdateFileLock(account);
    await retry();
  },
);

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
