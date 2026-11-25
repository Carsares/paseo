import { constants } from "node:fs";
import type { BigIntStats } from "node:fs";
import { access, lstat, open, readlink } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { AgentProvider } from "../agent-sdk-types.js";
import {
  hasMatchingUserIds,
  hasTrustedMacOSAcls,
  supportsHostApprovedProviderUpdates,
} from "./installation-target.js";

export const LOCAL_UPDATER_PLANS_FILENAME = "provider-update-plans.json";
export const MAX_LOCAL_UPDATER_PLANS_FILE_BYTES = 256 * 1024;

const MAX_PATH_LENGTH = 4096;
const MAX_SYMBOLIC_LINKS = 40;
const MAX_PLAN_ID_LENGTH = 128;
const MAX_PROVIDER_ID_LENGTH = 128;
const MAX_ARGUMENTS = 128;
const MAX_ARGUMENT_LENGTH = 4096;
const MAX_EVIDENCE_FILES = 64;
const MAX_PLANS = 256;
const SHELL_INTERPRETERS = new Set([
  "ash",
  "bash",
  "busybox",
  "cmd",
  "csh",
  "dash",
  "fish",
  "ksh",
  "powershell",
  "pwsh",
  "sh",
  "tcsh",
  "wsl",
  "zsh",
]);

const AbsolutePathSchema = z
  .string()
  .min(1)
  .max(MAX_PATH_LENGTH)
  .refine(
    (value) => path.isAbsolute(value) && path.normalize(value) === value && !value.includes("\0"),
  );

function isShellInterpreterPath(value: string): boolean {
  const name = path
    .basename(value)
    .toLowerCase()
    .replace(/\.exe$/u, "");
  return SHELL_INTERPRETERS.has(name);
}

export interface LocalFileIdentity {
  dev: string;
  ino: string;
  mode: number;
  uid: number;
  gid: number;
  size: string;
  mtimeNs: string;
  ctimeNs: string;
}

export interface ApprovedProviderUpdaterEvidence {
  path: string;
  identity: LocalFileIdentity;
}

export interface ApprovedProviderUpdater {
  planId: string;
  provider: AgentProvider;
  completion: "foreground";
  approvalFileIdentity: LocalFileIdentity;
  launchPath: string;
  launchIdentity: LocalFileIdentity;
  updater: {
    command: string;
    /** Launch this checked path. The configured command may contain symbolic links. */
    resolvedCommand: string;
    identity: LocalFileIdentity;
    args: readonly string[];
  };
  evidence: readonly ApprovedProviderUpdaterEvidence[];
}

export type ApprovedProviderUpdaterConfig = Omit<
  ApprovedProviderUpdater,
  "approvalFileIdentity" | "updater"
> & { updater: Omit<ApprovedProviderUpdater["updater"], "resolvedCommand"> };

export interface ApprovedProviderUpdaterSummary {
  planId: string;
  provider: AgentProvider;
  launchPath: string;
}

export interface ReadApprovedProviderUpdaterInput {
  paseoHome: string;
  provider: AgentProvider;
  planId?: string;
  launchPath: string;
  signal: AbortSignal;
}

const FileIdentitySchema = z
  .object({
    dev: z.string().regex(/^\d+$/u),
    ino: z.string().regex(/^\d+$/u),
    mode: z.number().int().min(0).max(0o7777),
    uid: z.number().int().nonnegative(),
    gid: z.number().int().nonnegative(),
    size: z.string().regex(/^\d+$/u),
    mtimeNs: z.string().regex(/^\d+$/u),
    ctimeNs: z.string().regex(/^\d+$/u),
  })
  .strict();

const EvidenceSchema = z
  .object({
    path: AbsolutePathSchema,
    identity: FileIdentitySchema,
  })
  .strict();

const StoredPlanSchema = z
  .object({
    planId: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u)
      .max(MAX_PLAN_ID_LENGTH),
    provider: z.string().min(1).max(MAX_PROVIDER_ID_LENGTH),
    completion: z.literal("foreground"),
    launchPath: AbsolutePathSchema,
    launchIdentity: FileIdentitySchema,
    updater: z
      .object({
        command: AbsolutePathSchema.refine((value) => !isShellInterpreterPath(value)),
        identity: FileIdentitySchema,
        args: z
          .array(z.string().max(MAX_ARGUMENT_LENGTH))
          .max(MAX_ARGUMENTS)
          .refine((args) => args.every((arg) => !arg.includes("\0"))),
      })
      .strict(),
    evidence: z.array(EvidenceSchema).max(MAX_EVIDENCE_FILES),
  })
  .strict();

const PlanFileSchema = z
  .object({
    version: z.literal(1),
    plans: z.array(StoredPlanSchema).max(MAX_PLANS),
  })
  .strict()
  .superRefine((value, context) => {
    const planIds = new Set<string>();
    for (const plan of value.plans) {
      if (planIds.has(plan.planId)) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "Duplicate planId" });
        return;
      }
      planIds.add(plan.planId);
    }
  });

type StoredPlan = z.infer<typeof StoredPlanSchema>;

interface TrustedFile {
  path: string;
  resolvedPath: string;
  identity: LocalFileIdentity;
}

interface TrustedPath {
  path: string;
  stats: BigIntStats;
}

class PathChangedDuringAclCheck extends Error {}

interface ReadPlanFileResult {
  plans: readonly StoredPlan[];
  identity: LocalFileIdentity;
}

function isAbortError(signal: AbortSignal, error: unknown): boolean {
  return signal.aborted && error === signal.reason;
}

function throwIfAborted(signal: AbortSignal): void {
  signal.throwIfAborted();
}

function normalizeAbsolutePath(value: string): string | null {
  if (!path.isAbsolute(value) || value.includes("\0") || value.length > MAX_PATH_LENGTH) {
    return null;
  }
  return path.resolve(value);
}

function identityFromStats(value: BigIntStats): LocalFileIdentity {
  return {
    dev: value.dev.toString(),
    ino: value.ino.toString(),
    mode: Number(value.mode & 0o7777n),
    uid: Number(value.uid),
    gid: Number(value.gid),
    size: value.size.toString(),
    mtimeNs: value.mtimeNs.toString(),
    ctimeNs: value.ctimeNs.toString(),
  };
}

function sameIdentity(left: LocalFileIdentity, right: LocalFileIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function isSecureMode(mode: number): boolean {
  return (mode & 0o022) === 0 && (mode & 0o600) !== 0 && (mode & 0o6000) === 0;
}

function isPrivateFile(identity: LocalFileIdentity): boolean {
  return isOwnedByCurrentUser(identity) && (identity.mode & 0o077) === 0;
}

function currentUid(): number {
  return process.getuid!();
}

function isOwnedByCurrentUser(identity: LocalFileIdentity): boolean {
  return identity.uid === currentUid();
}

function isSecureFile(identity: LocalFileIdentity, executable: boolean): boolean {
  if (!isOwnedByCurrentUser(identity) || !isSecureMode(identity.mode)) return false;
  return !executable || (identity.mode & 0o111) !== 0;
}

function isTrustedOwner(stats: BigIntStats): boolean {
  return stats.uid === 0n || stats.uid === BigInt(currentUid());
}

function isTrustedDirectory(stats: BigIntStats): boolean {
  if (!stats.isDirectory() || !isTrustedOwner(stats)) return false;
  // In a root-owned sticky directory, only trusted owners' entries may be used.
  // The walk checks the owner of each entry before following it.
  return (stats.mode & 0o6022n) === 0n || (stats.uid === 0n && (stats.mode & 0o1000n) !== 0n);
}

async function verifyPathAcls(
  leaf: TrustedPath,
  visited: ReadonlyMap<string, BigIntStats>,
  signal: AbortSignal,
): Promise<TrustedPath | null> {
  if (!(await hasTrustedMacOSAcls([...visited.keys()], signal))) return null;
  for (const [entryPath, before] of visited) {
    throwIfAborted(signal);
    const after = await lstat(entryPath, { bigint: true });
    if (after.dev !== before.dev || after.ino !== before.ino || after.ctimeNs !== before.ctimeNs) {
      throw new PathChangedDuringAclCheck();
    }
  }
  return leaf;
}

async function resolveTrustedPath(
  absolutePath: string,
  signal: AbortSignal,
): Promise<TrustedPath | null> {
  // A directory's ctime can change when unrelated entries are added or removed.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await walkTrustedPath(absolutePath, signal);
    } catch (error) {
      if (isAbortError(signal, error)) throw error;
      if (!(error instanceof PathChangedDuringAclCheck)) return null;
    }
  }
  return null;
}

async function walkTrustedPath(
  absolutePath: string,
  signal: AbortSignal,
): Promise<TrustedPath | null> {
  throwIfAborted(signal);
  const root = { path: "/", stats: await lstat("/", { bigint: true }) };
  if (!isTrustedDirectory(root.stats)) return null;
  let directories = [root];
  const visited = new Map([[root.path, root.stats]]);
  let pending = absolutePath.slice(root.path.length).split(path.sep).toReversed();
  let links = 0;

  // Walk from the verified parent. lstat inspects only the final component of its argument.
  while (pending.length > 0) {
    throwIfAborted(signal);
    const component = pending.pop()!;
    if (component === "" || component === ".") continue;
    if (component === "..") {
      if (directories.length > 1) directories.pop();
      continue;
    }
    const entryPath = path.join(directories.at(-1)!.path, component);
    if (entryPath.length > MAX_PATH_LENGTH) return null;
    const stats = await lstat(entryPath, { bigint: true });
    if (!isTrustedOwner(stats)) return null;
    visited.set(entryPath, visited.get(entryPath) ?? stats);
    if (stats.isSymbolicLink()) {
      if (++links > MAX_SYMBOLIC_LINKS) return null;
      const targetBytes = await readlink(entryPath, { encoding: "buffer" });
      const target = targetBytes.toString("utf8");
      if (!Buffer.from(target).equals(targetBytes)) return null;
      if (path.isAbsolute(target)) directories = [root];
      // Resolve each component before interpreting '..', as the filesystem does.
      pending = pending.concat(target.split(path.sep).toReversed());
      continue;
    }

    const entry = { path: entryPath, stats };
    if (!stats.isDirectory()) {
      return pending.length === 0 ? await verifyPathAcls(entry, visited, signal) : null;
    }
    if (!isTrustedDirectory(stats)) return null;
    directories.push(entry);
  }
  return await verifyPathAcls(directories.at(-1)!, visited, signal);
}

async function readTrustedFile(
  filePath: string,
  options: { executable: boolean; signal: AbortSignal },
): Promise<TrustedFile | null> {
  const normalized = normalizeAbsolutePath(filePath);
  if (!normalized) return null;
  const { executable, signal } = options;
  throwIfAborted(signal);
  try {
    const resolved = await resolveTrustedPath(normalized, signal);
    if (!resolved?.stats.isFile()) return null;
    const identity = identityFromStats(resolved.stats);
    if (!isSecureFile(identity, executable)) return null;
    if (executable) await access(resolved.path, constants.X_OK);
    return { path: normalized, resolvedPath: resolved.path, identity };
  } catch (error) {
    if (isAbortError(signal, error)) throw error;
    return null;
  }
}

async function readPlanFile(
  paseoHome: string,
  signal: AbortSignal,
): Promise<ReadPlanFileResult | null> {
  const home = normalizeAbsolutePath(paseoHome);
  if (!home) return null;
  const resolvedHome = await resolveTrustedPath(home, signal);
  if (!resolvedHome?.stats.isDirectory()) return null;
  const filePath = path.join(resolvedHome.path, LOCAL_UPDATER_PLANS_FILENAME);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    throwIfAborted(signal);
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = (await handle.stat({ bigint: true })) as BigIntStats;
    if (!before.isFile()) return null;
    const beforeIdentity = identityFromStats(before);
    if (!isPrivateFile(beforeIdentity)) return null;
    if (!(await hasTrustedMacOSAcls([filePath], signal))) return null;
    if (!sameIdentity(beforeIdentity, identityFromStats(await lstat(filePath, { bigint: true })))) {
      return null;
    }
    const size = Number(before.size);
    if (!Number.isSafeInteger(size) || size > MAX_LOCAL_UPDATER_PLANS_FILE_BYTES) return null;
    const data = Buffer.alloc(MAX_LOCAL_UPDATER_PLANS_FILE_BYTES + 1);
    let offset = 0;
    while (offset < data.length) {
      throwIfAborted(signal);
      const result = await handle.read(data, offset, data.length - offset, offset);
      offset += result.bytesRead;
      if (result.bytesRead === 0) break;
    }
    const after = (await handle.stat({ bigint: true })) as BigIntStats;
    if (!sameIdentity(beforeIdentity, identityFromStats(after)) || offset !== size) return null;
    const parsed = PlanFileSchema.safeParse(JSON.parse(data.toString("utf8", 0, offset)));
    return parsed.success ? { plans: parsed.data.plans, identity: beforeIdentity } : null;
  } catch (error) {
    if (isAbortError(signal, error)) throw error;
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function matchesCurrentFile(
  expectedPath: string,
  expectedIdentity: LocalFileIdentity,
  executable: boolean,
  signal: AbortSignal,
): Promise<boolean> {
  const current = await readTrustedFile(expectedPath, { executable, signal });
  return (
    current !== null &&
    current.path === expectedPath &&
    sameIdentity(current.identity, expectedIdentity)
  );
}

async function resolveCurrentUpdater(
  plan: StoredPlan,
  launch: TrustedFile,
  signal: AbortSignal,
): Promise<string | null> {
  if (normalizeAbsolutePath(plan.launchPath) !== launch.path) return null;
  if (!sameIdentity(plan.launchIdentity, launch.identity)) return null;
  const updater = await readTrustedFile(plan.updater.command, { executable: true, signal });
  if (
    !updater ||
    isShellInterpreterPath(updater.path) ||
    isShellInterpreterPath(updater.resolvedPath) ||
    !sameIdentity(updater.identity, plan.updater.identity)
  ) {
    return null;
  }
  for (const evidence of plan.evidence) {
    if (!(await matchesCurrentFile(evidence.path, evidence.identity, false, signal))) return null;
  }
  return updater.resolvedPath;
}

function freezePlan(
  plan: StoredPlan,
  approvalFileIdentity: LocalFileIdentity,
  resolvedCommand: string,
): ApprovedProviderUpdater {
  const evidence = plan.evidence.map((entry) =>
    Object.freeze({
      path: entry.path,
      identity: Object.freeze({ ...entry.identity }),
    }),
  );
  const updater = Object.freeze({
    command: plan.updater.command,
    resolvedCommand,
    identity: Object.freeze({ ...plan.updater.identity }),
    args: Object.freeze([...plan.updater.args]),
  });
  return Object.freeze({
    planId: plan.planId,
    provider: plan.provider,
    completion: plan.completion,
    approvalFileIdentity: Object.freeze({ ...approvalFileIdentity }),
    launchPath: plan.launchPath,
    launchIdentity: Object.freeze({ ...plan.launchIdentity }),
    updater,
    evidence: Object.freeze(evidence),
  });
}

/** Serializes locally approved plans without writing them or consulting remote state. */
export function formatApprovedProviderUpdaterPlansJson(
  plans: readonly ApprovedProviderUpdaterConfig[],
): string {
  const value = PlanFileSchema.parse({ version: 1, plans });
  return `${JSON.stringify(value, null, 2)}\n`;
}

export async function readApprovedProviderUpdater(
  input: ReadApprovedProviderUpdaterInput & { planId: string },
): Promise<ApprovedProviderUpdater | null>;
export async function readApprovedProviderUpdater(
  input: Omit<ReadApprovedProviderUpdaterInput, "planId"> & { planId?: undefined },
): Promise<readonly ApprovedProviderUpdaterSummary[]>;
export async function readApprovedProviderUpdater(
  input: ReadApprovedProviderUpdaterInput,
): Promise<ApprovedProviderUpdater | readonly ApprovedProviderUpdaterSummary[] | null> {
  const { paseoHome, provider, planId, launchPath, signal } = input;
  signal.throwIfAborted();
  if (!supportsHostApprovedProviderUpdates() || !hasMatchingUserIds()) {
    return planId !== undefined ? null : [];
  }
  const launch = await readTrustedFile(launchPath, { executable: true, signal });
  if (!launch) return planId !== undefined ? null : [];
  const stored = await readPlanFile(paseoHome, signal);
  if (!stored) return planId !== undefined ? null : [];
  const candidates = stored.plans.filter(
    (plan) => plan.provider === provider && normalizeAbsolutePath(plan.launchPath) === launch.path,
  );
  if (planId !== undefined) {
    const plan = candidates.find((candidate) => candidate.planId === planId);
    if (!plan) return null;
    const resolvedCommand = await resolveCurrentUpdater(plan, launch, signal);
    return resolvedCommand ? freezePlan(plan, stored.identity, resolvedCommand) : null;
  }
  const summaries: ApprovedProviderUpdaterSummary[] = [];
  for (const plan of candidates) {
    if (await resolveCurrentUpdater(plan, launch, signal)) {
      summaries.push({ planId: plan.planId, provider: plan.provider, launchPath: plan.launchPath });
    }
  }
  return Object.freeze(summaries.map((summary) => Object.freeze(summary)));
}
