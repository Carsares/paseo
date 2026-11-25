import { execFile } from "node:child_process";
// Agent admission is synchronous so callers can transfer the ticket directly to the child.
// oxlint-disable-next-line paseo/no-sync-io
import { spawnSync } from "node:child_process";
import { constants, type BigIntStats, type Stats } from "node:fs";
// Agent callers transfer admission directly to a child process or session lifetime.
// oxlint-disable-next-line paseo/no-sync-io
import { lstatSync, mkdirSync, mkdtempSync, rmdirSync } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rmdir,
  stat,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
export { findExecutableWithoutProbing as findInstallationLaunchPath } from "../../../executable-resolution/executable-resolution.js";

const RELEASE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const PROVIDER_UPDATE_LOCK = ".paseo-provider-update.lock";
const APPROVED_UPDATE_LOCK = ".paseo-provider-approved-update.lock";
const AGENT_TICKETS = ".paseo-provider-agents";
const SYSTEM_TOOL_OPTIONS = { encoding: "utf8", env: { LC_ALL: "C" }, timeout: 3_000 } as const;
const execFileAsync = promisify(execFile);
// macOS ls -e can silently omit an ACL when it fails to read it. Read the ACL through
// lstatx_np without following the last component, and distinguish absence from errors.
const MACOS_ACL_CHECK = `
ObjC.bindFunction("malloc", ["void *", ["size_t"]]);
ObjC.bindFunction("free", ["void", ["void *"]]);
ObjC.bindFunction("filesec_init", ["void *", []]);
ObjC.bindFunction("filesec_free", ["void", ["void *"]]);
ObjC.bindFunction("lstatx_np", ["int", ["char *", "void *", "void *"]]);
ObjC.bindFunction("filesec_query_property", ["int", ["void *", "int", "int *"]]);
ObjC.bindFunction("filesec_get_property", ["int", ["void *", "int", "void **"]]);
ObjC.bindFunction("acl_get_entry", ["int", ["void *", "int", "void **"]]);
ObjC.bindFunction("acl_get_tag_type", ["int", ["void *", "int *"]]);
ObjC.bindFunction("acl_valid", ["int", ["void *"]]);
ObjC.bindFunction("acl_free", ["int", ["void *"]]);
ObjC.bindFunction("__error", ["int *", []]);
const FILESEC_ACL = 5;
const ACL_FIRST_ENTRY = 0;
const ACL_NEXT_ENTRY = -1;
const ACL_EXTENDED_DENY = 2;
const EINVAL = 22;
function hasOnlyDenials(acl) {
  if ($.acl_valid(acl) !== 0) return false;
  const entry = Ref();
  const tag = Ref();
  let position = ACL_FIRST_ENTRY;
  while ($.acl_get_entry(acl, position, entry) === 0) {
    // Inherit-only grants can give access to a newly created child even when
    // they grant no access to this directory. Reject those grants as well.
    if ($.acl_get_tag_type(entry[0], tag) !== 0 || tag[0] !== ACL_EXTENDED_DENY) return false;
    position = ACL_NEXT_ENTRY;
  }
  // A valid ACL ends with EINVAL, including an empty ACL.
  return $.__error()[0] === EINVAL;
}
function check(path, stat) {
  const security = $.filesec_init();
  try {
    if ($.lstatx_np(path, stat, security) !== 0) return false;
    const present = Ref();
    if ($.filesec_query_property(security, FILESEC_ACL, present) !== 0) return false;
    if (present[0] === 0) return true;
    const acl = Ref();
    if ($.filesec_get_property(security, FILESEC_ACL, acl) !== 0) return false;
    try {
      return hasOnlyDenials(acl[0]);
    } finally {
      $.acl_free(acl[0]);
    }
  } finally {
    $.filesec_free(security);
  }
}
function run(paths) {
  // lstatx_np needs writable space for struct stat. Its fields are not used here.
  const stat = $.malloc(1024);
  try {
    return paths.every(path => check(path, stat)) ? "trusted" : "untrusted";
  } finally {
    $.free(stat);
  }
}
`;

function macOSAclsArgs(paths: readonly string[]): string[] {
  return ["-l", "JavaScript", "-e", MACOS_ACL_CHECK, "--", ...paths];
}

export async function hasTrustedMacOSAcls(
  paths: readonly string[],
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    const { stdout, stderr } = await execFileAsync("/usr/bin/osascript", macOSAclsArgs(paths), {
      ...SYSTEM_TOOL_OPTIONS,
      signal,
    });
    return stdout === "trusted\n" && stderr === "";
  } catch {
    signal?.throwIfAborted();
    return false;
  }
}

function assertTrustedMacOSAcls(paths: readonly string[], description: string): void {
  if (process.platform !== "darwin") return;
  const result = spawnSync("/usr/bin/osascript", macOSAclsArgs(paths), SYSTEM_TOOL_OPTIONS);
  if (
    result.error ||
    result.status !== 0 ||
    result.stdout !== "trusted\n" ||
    result.stderr !== ""
  ) {
    throw new Error(`Could not verify access controls for ${description}.`);
  }
}
interface UpdateAccount {
  uid: number;
  /** Explicit path under a trusted parent, e.g. an isolated test directory. */
  directory: string;
}
const PackageMetadata = z.object({
  name: z.string(),
  bin: z.union([z.string(), z.record(z.string(), z.string())]),
});

export function supportsHostApprovedProviderUpdates(): boolean {
  return (
    process.platform === "darwin" &&
    typeof process.getuid === "function" &&
    typeof process.geteuid === "function"
  );
}

export function hasMatchingUserIds(): boolean {
  const uid = process.getuid?.();
  return uid !== undefined && uid === process.geteuid?.();
}

/** Host approvals have no known write scope, so all updates share one lock for this OS account. */
export async function acquireProviderUpdateFileLock(
  account?: UpdateAccount,
): Promise<(() => Promise<void>) | null> {
  const { directory, uid } = resolveUpdateAccount(account);
  return acquireAccountLock(directory, uid, PROVIDER_UPDATE_LOCK);
}

function getCoordinationParents(parent: string): string[] {
  const paths = [];
  for (let current = parent; ; current = path.dirname(current)) {
    paths.unshift(current);
    if (current === "/") break;
  }
  return paths;
}

function verifyCoordinationParents(
  paths: readonly string[],
  uid: number,
  systemAccount: boolean,
): void {
  const accountParents = new Set(paths.slice(-2));
  for (const current of paths) {
    const info = lstatSync(current);
    const trustedOwner = systemAccount
      ? info.uid === (accountParents.has(current) ? uid : 0)
      : info.uid === 0 || info.uid === uid;
    // A test account may live under a root-owned sticky temporary directory.
    const stickyTestParent = !systemAccount && info.uid === 0 && (info.mode & 0o1000) !== 0;
    if (!info.isDirectory() || !trustedOwner || ((info.mode & 0o022) !== 0 && !stickyTestParent)) {
      throw new Error(`Could not trust the provider coordination directory at ${current}.`);
    }
  }
}

function defaultUpdateAccount(): UpdateAccount & { userDirectory: string } {
  if (!supportsHostApprovedProviderUpdates()) {
    throw new Error("Provider coordination is unavailable on this platform.");
  }
  const uid = process.geteuid!();
  const result = spawnSync("/usr/bin/getconf", ["DARWIN_USER_DIR"], SYSTEM_TOOL_OPTIONS);
  // The account-local 0 directory is outside both the account home and the T/C cleanup trees.
  const match = /^(?:\/private)?(\/var\/folders\/[a-z0-9_]{2}\/[a-z0-9_]+\/0)\/?\n$/u.exec(
    result.stdout ?? "",
  );
  if (result.error || result.status !== 0 || result.stderr !== "" || !match) {
    throw new Error("Could not locate the macOS provider coordination directory.");
  }
  const userDirectory = `/private${match[1]}`;
  return { uid, userDirectory, directory: path.join(userDirectory, "paseo-provider-coordination") };
}

function ensurePrivateCoordinationDirectory(
  directory: string,
  uid: number,
  existing?: Stats,
): Stats {
  try {
    if (!existing) mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const info = existing ?? lstatSync(directory);
  if (!info.isDirectory() || info.uid !== uid || (info.mode & 0o7777) !== 0o700) {
    throw new Error("Could not verify the private provider coordination directory.");
  }
  return info;
}

function resolveUpdateAccount(input?: UpdateAccount): UpdateAccount {
  // Keep the platform capability check separate so agent callers still try to
  // register a ticket and fail admission instead of running without coordination.
  if (process.platform === "darwin" && !hasMatchingUserIds()) {
    throw new Error("Provider coordination requires matching real and effective user IDs.");
  }
  const defaults = input ? undefined : defaultUpdateAccount();
  const account = input ?? defaults!;
  const { uid } = account;
  if (!path.isAbsolute(account.directory)) {
    throw new Error("The provider coordination directory must be an absolute path.");
  }
  if (process.platform !== "darwin") {
    ensurePrivateCoordinationDirectory(account.directory, uid);
    return account;
  }
  // Explicit test accounts can come from tmpdir(), which uses macOS system aliases.
  const directory = account.directory.replace(/^\/(?:var|tmp)(?=\/|$)/u, "/private$&");
  if (directory !== path.resolve(directory)) {
    throw new Error("The provider coordination directory must be normalized.");
  }
  const parents = getCoordinationParents(defaults?.userDirectory ?? path.dirname(directory));
  const verifyParents = () => verifyCoordinationParents(parents, process.geteuid!(), !!defaults);
  verifyParents();
  const existing = lstatSync(directory, { throwIfNoEntry: false });
  if (!existing) {
    assertTrustedMacOSAcls(parents, "the provider coordination parents");
    verifyParents();
  }
  const info = ensurePrivateCoordinationDirectory(directory, uid, existing);
  assertTrustedMacOSAcls(
    existing ? [...parents, directory] : [directory],
    "the provider coordination directory",
  );
  verifyParents();
  const after = ensurePrivateCoordinationDirectory(directory, uid, lstatSync(directory));
  if (after.dev !== info.dev || after.ino !== info.ino) {
    throw new Error("The provider coordination directory changed during verification.");
  }
  return { directory, uid };
}

async function acquireAccountLock(
  directory: string,
  uid: number,
  name: string,
): Promise<(() => Promise<void>) | null> {
  const lock = path.join(directory, name);
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
    throw error;
  }
  const owned = await lstat(lock, { bigint: true });
  if (!owned.isDirectory() || owned.uid !== BigInt(uid) || (owned.mode & 0o077n) !== 0n)
    throw new Error("The provider update lock could not be verified.");
  if (process.platform === "darwin" && !(await hasTrustedMacOSAcls([lock]))) {
    const current = await lstat(lock, { bigint: true });
    if (current.dev === owned.dev && current.ino === owned.ino) await rmdir(lock);
    throw new Error("Could not verify access controls for the provider update lock.");
  }

  const ownerPath = path.join(lock, "owner.json");
  const owner = await open(ownerPath, "wx", 0o600);
  let record: BigIntStats;
  try {
    const stamp = { version: 1, pid: process.pid, startedAt: new Date().toISOString() };
    await owner.writeFile(JSON.stringify(stamp) + "\n");
    record = await owner.stat({ bigint: true });
  } finally {
    await owner.close();
  }

  // A native updater may survive the daemon. Never steal a lock based on age or daemon PID.
  return async () => {
    const current = await lstat(lock, { bigint: true });
    if (!current.isDirectory() || current.dev !== owned.dev || current.ino !== owned.ino)
      throw new Error("The provider update lock changed.");
    const currentRecord = await lstat(ownerPath, { bigint: true });
    if (
      !currentRecord.isFile() ||
      currentRecord.dev !== record.dev ||
      currentRecord.ino !== record.ino
    )
      throw new Error("The provider update lock owner record changed.");
    await unlink(ownerPath);
    await rmdir(lock);
  };
}

function assertAgentTicketDirectory(info: Stats, uid: number): void {
  if (!info.isDirectory() || info.uid !== uid || (info.mode & 0o077) !== 0)
    throw new Error("Could not verify provider agent activity for this account.");
}

export function acquireProviderAgentFileTicket(account?: UpdateAccount): () => void {
  try {
    return registerProviderAgent(resolveUpdateAccount(account));
  } catch (error) {
    if (error instanceof ApprovedUpdateAdmissionError) throw error;
    // Skipping the ticket could let a later update run alongside this agent if coordination
    // becomes available again.
    throw new Error(
      "Could not record provider agent activity. Check that the provider coordination directory is accessible and private and the agent activity directory is writable.",
      { cause: error },
    );
  }
}

function registerProviderAgent({ directory, uid }: UpdateAccount): () => void {
  const lock = path.join(directory, APPROVED_UPDATE_LOCK);
  const assertNoApprovedUpdate = () => {
    if (lstatSync(lock, { throwIfNoEntry: false })) {
      throw new ApprovedUpdateAdmissionError(
        "An approved provider update is in progress for this account. Try opening the agent again after the update.",
      );
    }
  };
  assertNoApprovedUpdate();
  const tickets = path.join(directory, AGENT_TICKETS);
  mkdirSync(tickets, { mode: 0o700, recursive: true });
  assertAgentTicketDirectory(lstatSync(tickets), uid);
  assertTrustedMacOSAcls([tickets], "the provider agent activity directory");
  // Keep the ticket if the daemon dies: an agent child can still hold the installation.
  const ticket = mkdtempSync(path.join(tickets, `${process.pid}-`));
  const release = () => {
    try {
      rmdirSync(ticket);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        process.emitWarning("Could not release a provider agent activity ticket.");
    }
  };
  // The updater publishes its lock before looking for tickets. Checking again after publishing
  // ours prevents both sides from entering even if the first check raced with the updater.
  try {
    assertTrustedMacOSAcls([ticket], "the provider agent activity ticket");
    assertNoApprovedUpdate();
  } catch (error) {
    release();
    throw error;
  }
  return release;
}

export class ApprovedUpdateAdmissionError extends Error {}

/** Call under the common update lock. Approved updaters have an account-wide write scope. */
export async function acquireApprovedUpdateFileLock(
  account?: UpdateAccount,
): Promise<() => Promise<void>> {
  const { directory, uid } = resolveUpdateAccount(account);
  const release = await acquireAccountLock(directory, uid, APPROVED_UPDATE_LOCK);
  if (!release)
    throw new ApprovedUpdateAdmissionError(
      "Approved provider updates are locked for this account.",
    );
  try {
    const tickets = path.join(directory, AGENT_TICKETS);
    await mkdir(tickets, { mode: 0o700, recursive: true });
    assertAgentTicketDirectory(await lstat(tickets), uid);
    assertTrustedMacOSAcls([tickets], "the provider agent activity directory");
    if ((await readdir(tickets)).length > 0) {
      throw new ApprovedUpdateAdmissionError(
        "Paseo agent activity is recorded for this account. Close runtimes in all Paseo instances and check for leftover activity tickets before updating.",
      );
    }
    return release;
  } catch (error) {
    await release();
    throw error;
  }
}

async function packageOwnsCommand(
  owner: string,
  packageName: string,
  command: string,
): Promise<boolean> {
  try {
    const manifest = await open(
      path.join(owner, "package.json"),
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    );
    try {
      const info = await manifest.stat();
      if (!info.isFile() || info.size > 64 * 1024) return false;
      const data = Buffer.alloc(info.size + 1);
      const { bytesRead } = await manifest.read(data, 0, data.length, 0);
      if (bytesRead !== info.size) return false;
      const parsed = PackageMetadata.safeParse(JSON.parse(data.toString("utf8", 0, bytesRead)));
      if (!parsed.success || parsed.data.name !== packageName) return false;
      const { bin } = parsed.data;
      const entries = typeof bin === "string" ? [bin] : Object.values(bin);
      return entries.some((entry) => path.resolve(owner, entry) === command);
    } finally {
      await manifest.close();
    }
  } catch {
    return false;
  }
}

/** Activity keys describe possible overlap, not executable provenance. */
export async function readInstallationActivityKeys(launchPath: string): Promise<string[]> {
  if (!path.isAbsolute(launchPath)) return [];
  try {
    const realPath = await realpath(launchPath);
    await access(realPath, constants.X_OK);
    const file = await stat(realPath, { bigint: true });
    if (!file.isFile()) return [];
    const keys = [`file:${file.dev}:${file.ino}`, `path:${realPath}`];
    if (launchPath !== realPath) keys.push(`path:${launchPath}`);

    const parent = path.dirname(realPath);
    if (RELEASE.test(path.basename(realPath)) && path.basename(parent) === "versions") {
      const root = path.dirname(parent);
      const home = await realpath(homedir()).catch(() => homedir());
      const standardRoot = path.join(home, ".local/share/claude");
      if (root === standardRoot) keys.push(`root:${root}`);
    }

    const dirs = realPath.split(path.sep);
    const modules = dirs.lastIndexOf("node_modules");
    if (modules > 0) {
      const packageEnd = dirs[modules + 1]?.startsWith("@") ? modules + 3 : modules + 2;
      const root = dirs.slice(0, modules + 1).join(path.sep);
      const owner = dirs.slice(0, packageEnd).join(path.sep);
      const packageName = dirs.slice(modules + 1, packageEnd).join("/");
      if (packageEnd < dirs.length && (await packageOwnsCommand(owner, packageName, realPath))) {
        keys.push(`root:${root}`);
        if (dirs[modules - 1] === "lib" && modules > 2) {
          keys.push(`root:${dirs.slice(0, modules - 1).join(path.sep)}`);
        }
      }
    }
    return keys;
  } catch {
    return [];
  }
}
