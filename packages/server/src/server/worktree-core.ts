import type {
  PluginWorktreeCreateInput,
  PluginWorktreeCreateRequest,
} from "@getpaseo/plugin/server";
import type { PluginLifecycle } from "./plugins/lifecycle/index.js";
import type { PluginWorktreeManagerRuntime } from "./plugins/runtime.js";
import { createNameId } from "mnemonic-id";

import type { ForgeService } from "../services/forge-service.js";
import {
  createWorktree,
  fetchFirstAvailableRef,
  prepareWorktreeBranchOff,
  type PreparedWorktreeBranchOff,
  resolveDefaultWorktreePath,
  runPluginWorktreeManagerCheckout,
  slugify,
  validateBranchSlug,
  type CreatedWorktree,
} from "../utils/worktree.js";
import {
  assertFixedStartPointSource,
  resolveWorktreeCreationIntent,
  type ResolveWorktreeCreationIntentInput,
  UnsupportedForgeCheckoutTargetError,
  type WorktreeCreationIntent,
  worktreeUntrustedSource,
} from "./resolve-worktree-creation-intent.js";
import type { ChangeRequestCheckoutSource, FirstAgentContext } from "@getpaseo/protocol/messages";
import type { WorkspaceGitService } from "./workspace-git-service.js";
import { runWithRepositoryRoot } from "../utils/git-repository-discovery.js";
import { runGitCommand, runWithGitCommandPriority } from "../utils/run-git-command.js";
import { setPaseoWorktreeUntrustedSource } from "../utils/worktree-metadata.js";

import type { UntrustedWorkspaceSource } from "./workspace-automation-gate.js";

export interface CreateWorktreeCoreInput {
  cwd: string;
  worktreeSlug?: string;
  branchName?: string;
  refName?: string;
  action?: "branch-off" | "checkout";
  startPoint?: string;
  checkoutSource?: ChangeRequestCheckoutSource;
  githubPrNumber?: number;
  firstAgentContext?: FirstAgentContext;
  paseoHome?: string;
  worktreesRoot?: string;
}

export interface CreateWorktreeCoreDeps {
  lifecycle?: Pick<PluginLifecycle, "before">;
  worktreeManagers?: Pick<
    PluginWorktreeManagerRuntime,
    "hasWorktreeManager" | "createWorktree" | "removeWorktree"
  >;
  github: ForgeService;
  workspaceGitService?: Pick<
    WorkspaceGitService,
    "resolveRepoRoot" | "resolveDefaultBranch" | "resolveForge"
  >;
  resolveDefaultBranch?: (repoRoot: string) => Promise<string>;
}

export interface CreateWorktreeCoreResult {
  worktree: CreatedWorktree;
  intent: WorktreeCreationIntent;
  untrustedSource?: UntrustedWorkspaceSource;
  repoRoot: string;
  created: boolean;
}

export async function createWorktreeCore(
  input: CreateWorktreeCoreInput,
  deps: CreateWorktreeCoreDeps,
): Promise<CreateWorktreeCoreResult> {
  return runWithGitCommandPriority("high", () => createWorktreeCoreWithPriority(input, deps));
}

function resolveIntentInput(
  input: CreateWorktreeCoreInput,
  worktreeSlug: string | undefined,
): ResolveWorktreeCreationIntentInput {
  const source = {
    refName: input.refName,
    checkoutSource: input.checkoutSource,
    githubPrNumber: input.githubPrNumber,
  };
  if (input.action === "checkout") return { ...source, action: "checkout", worktreeSlug };
  // A change request with no action is checked out, as clients did before `action` existed.
  if (input.action !== "branch-off" && (input.checkoutSource || input.githubPrNumber !== undefined))
    return { ...source, worktreeSlug };
  return {
    ...source,
    action: "branch-off",
    startPoint: input.startPoint,
    branchName: input.branchName?.trim(),
    worktreeSlug: worktreeSlug ?? normalizeWorktreeSlug(createNameId()),
  };
}

async function createWorktreeCoreWithPriority(
  input: CreateWorktreeCoreInput,
  deps: CreateWorktreeCoreDeps,
): Promise<CreateWorktreeCoreResult> {
  assertFixedStartPointSource(input);
  const repoRoot = await resolveWorktreeRepoRoot(input, deps.workspaceGitService);
  return runWithRepositoryRoot(repoRoot, () =>
    createWorktreeAtRepositoryRoot(input, deps, repoRoot),
  );
}

async function createWorktreeAtRepositoryRoot(
  input: CreateWorktreeCoreInput,
  deps: CreateWorktreeCoreDeps,
  repoRoot: string,
): Promise<CreateWorktreeCoreResult> {
  const requestedWorktreeSlug = input.worktreeSlug
    ? normalizeWorktreeSlug(input.worktreeSlug)
    : undefined;
  const intentInput = resolveIntentInput(input, requestedWorktreeSlug);
  const forge = await resolveForge(repoRoot, deps, intentInput);
  let intent = await resolveWorktreeCreationIntent(intentInput, repoRoot, {
    forge: forge.forge,
    forgeService: forge.service,
    resolveDefaultBranch: (root) => resolveDefaultBranch(root, deps),
    fetchRef: ({ repoRoot: cwd, sources, destination }) =>
      fetchFirstAvailableRef({ cwd, sources, destination }),
  });
  let normalizedSlug: string;

  switch (intent.kind) {
    case "branch-off": {
      normalizedSlug = requestedWorktreeSlug ?? normalizeWorktreeSlug(intent.branchName);
      break;
    }
    case "checkout-branch": {
      normalizedSlug = requestedWorktreeSlug ?? normalizeWorktreeSlug(intent.branchName);
      break;
    }
    case "checkout-change-request":
    case "checkout-github-pr": {
      normalizedSlug =
        requestedWorktreeSlug ?? normalizeWorktreeSlug(intent.localBranchName ?? intent.headRef);
      break;
    }
  }

  const defaultPath = await resolveDefaultWorktreePath({
    cwd: repoRoot,
    paseoHome: input.paseoHome,
    worktreesRoot: input.worktreesRoot,
    worktreeSlug: normalizedSlug,
  });
  const { stdout: sourceRoot } = await runGitCommand(["rev-parse", "--show-toplevel"], {
    cwd: input.cwd,
  });
  const sourceCheckout = sourceRoot.trim();
  const request = describeCreationRequest(intent, {
    repoRoot,
    sourceCheckout,
    slug: normalizedSlug,
    path: defaultPath,
  });
  const transformed = deps.lifecycle
    ? await deps.lifecycle.before("worktree.create.before", request)
    : request;
  if (intent.kind === "branch-off" && intent.fixedStartPoint !== undefined) {
    if (
      transformed.kind !== "branch-off" ||
      transformed.baseRef !== intent.baseBranch ||
      (transformed.startPoint !== undefined && transformed.startPoint !== intent.fixedStartPoint)
    ) {
      throw new Error("worktree.create.before hooks cannot change a fixed worktree source");
    }
  }
  const originalUntrustedSource = worktreeUntrustedSource(intent);
  normalizedSlug = validateWorktreeSlug(transformed.slug);
  intent = creationIntentFromRequest(transformed, intent);
  const untrustedSource = originalUntrustedSource ?? worktreeUntrustedSource(intent);

  const { worktree: managedWorktree, preparedBranchOff } = await tryCreateWithWorktreeManager({
    repoRoot,
    transformed,
    intent,
    untrusted: Boolean(untrustedSource),
    input,
    deps,
  });
  const createdWorktree =
    managedWorktree ??
    (await createWorktree({
      cwd: repoRoot,
      worktreeSlug: normalizedSlug,
      worktreePath: transformed.path,
      source: intent,
      preparedBranchOff,
      paseoHome: input.paseoHome,
      worktreesRoot: input.worktreesRoot,
    }));
  if (untrustedSource) {
    await setPaseoWorktreeUntrustedSource(createdWorktree.worktreePath, untrustedSource);
  }
  return {
    worktree: createdWorktree,
    intent,
    untrustedSource,
    repoRoot,
    created: true,
  };
}

async function tryCreateWithWorktreeManager(options: {
  repoRoot: string;
  transformed: PluginWorktreeCreateRequest;
  intent: WorktreeCreationIntent;
  untrusted: boolean;
  input: Pick<CreateWorktreeCoreInput, "paseoHome" | "worktreesRoot">;
  deps: Pick<CreateWorktreeCoreDeps, "worktreeManagers">;
}): Promise<{ worktree: CreatedWorktree | null; preparedBranchOff?: PreparedWorktreeBranchOff }> {
  const { repoRoot, transformed, intent, untrusted, input, deps } = options;
  let preparedBranchOff: PreparedWorktreeBranchOff | undefined;
  const worktree = await runPluginWorktreeManagerCheckout({
    cwd: repoRoot,
    source: intent,
    operation: "create",
    untrusted,
    paseoHome: input.paseoHome,
    worktreesBaseRoot: input.worktreesRoot,
    worktreeManagers: deps.worktreeManagers,
    run: async ({ changeRequestHeadSha }) => {
      let request: PluginWorktreeCreateInput = {
        ...transformed,
        untrusted,
        ...(changeRequestHeadSha ? { headSha: changeRequestHeadSha } : {}),
      };
      if (request.kind === "branch-off" && intent.kind === "branch-off") {
        preparedBranchOff = await prepareWorktreeBranchOff(repoRoot, intent);
        request = {
          ...request,
          baseRef: preparedBranchOff.baseRef,
          ...(intent.fixedStartPoint !== undefined
            ? { startPoint: preparedBranchOff.checkoutRef }
            : {}),
        };
      }
      return deps.worktreeManagers!.createWorktree(request);
    },
  });
  return { worktree, preparedBranchOff };
}

function describeCreationRequest(
  intent: WorktreeCreationIntent,
  placement: Pick<PluginWorktreeCreateRequest, "repoRoot" | "sourceCheckout" | "slug" | "path">,
): PluginWorktreeCreateRequest {
  if (intent.kind === "branch-off") {
    const startPoint = intent.fixedStartPoint ?? intent.startPoint;
    return {
      ...placement,
      kind: intent.kind,
      branch: intent.branchName,
      baseRef: intent.baseBranch,
      ...(startPoint !== undefined ? { startPoint } : {}),
    };
  }
  if (intent.kind === "checkout-branch")
    return { ...placement, kind: intent.kind, branch: intent.branchName };
  const { localBranchName, baseRefName, ...facts } = intent;
  return {
    ...placement,
    ...facts,
    branch: localBranchName ?? intent.headRef,
    baseRef: baseRefName,
  };
}

function creationIntentFromRequest(
  request: PluginWorktreeCreateRequest,
  original: WorktreeCreationIntent,
): WorktreeCreationIntent {
  if (request.kind === "branch-off") {
    // The base and checkout point are separate. Preserve the original checkout point.
    const startPoint = original.kind === "branch-off" ? original.startPoint : undefined;
    const fixedStartPoint = original.kind === "branch-off" ? original.fixedStartPoint : undefined;
    return {
      kind: request.kind,
      branchName: request.branch,
      baseBranch: request.baseRef,
      ...(startPoint ? { startPoint } : {}),
      ...(fixedStartPoint !== undefined ? { fixedStartPoint } : {}),
    };
  }
  if (request.kind === "checkout-branch") {
    return {
      kind: request.kind,
      branchName: request.branch,
    };
  }
  const {
    repoRoot: _repoRoot,
    sourceCheckout: _checkout,
    slug: _slug,
    path: _path,
    branch,
    baseRef,
    ...facts
  } = request;
  const keepLocalBranchName =
    branch !== request.headRef ||
    ((original.kind === "checkout-change-request" || original.kind === "checkout-github-pr") &&
      original.localBranchName !== undefined);
  return {
    ...facts,
    ...(keepLocalBranchName ? { localBranchName: branch } : {}),
    baseRefName: baseRef,
  };
}

async function resolveForge(
  repoRoot: string,
  deps: CreateWorktreeCoreDeps,
  intentInput: ResolveWorktreeCreationIntentInput,
): Promise<{ forge: string; service: ForgeService }> {
  const resolution = await deps.workspaceGitService?.resolveForge(repoRoot);
  if (!resolution) {
    if (intentInput.checkoutSource?.forge && intentInput.checkoutSource.forge !== "github") {
      throw new UnsupportedForgeCheckoutTargetError(intentInput.checkoutSource.forge);
    }
    // No recognized remote: fall back to GitHub, the wire-default forge.
    return { forge: "github", service: deps.github };
  }
  return { forge: resolution.forge, service: resolution.service };
}

async function resolveDefaultBranch(
  repoRoot: string,
  deps: CreateWorktreeCoreDeps,
): Promise<string> {
  const baseBranch = deps.resolveDefaultBranch
    ? await deps.resolveDefaultBranch(repoRoot)
    : await deps.workspaceGitService?.resolveDefaultBranch(repoRoot);
  if (!baseBranch) {
    throw new Error("Unable to resolve repository default branch");
  }
  return baseBranch;
}

export async function resolveWorktreeRepoRoot(
  input: Pick<CreateWorktreeCoreInput, "cwd" | "paseoHome">,
  workspaceGitService?: Pick<WorkspaceGitService, "resolveRepoRoot">,
): Promise<string> {
  if (!workspaceGitService) {
    throw new Error("Create worktree requires WorkspaceGitService");
  }

  return workspaceGitService.resolveRepoRoot(input.cwd);
}

function validateWorktreeSlug(slug: string): string {
  const validation = validateBranchSlug(slug);
  if (!validation.valid) {
    throw new Error(`Invalid worktree name: ${validation.error}`);
  }
  return slug;
}

function normalizeWorktreeSlug(value: string): string {
  return validateWorktreeSlug(slugify(value));
}
