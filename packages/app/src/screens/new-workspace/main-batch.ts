import type { CreateWorkspaceRequestOptions } from "@getpaseo/client/internal/daemon-client";
import { MAX_SLUG_LENGTH, slugify } from "@getpaseo/protocol/branch-slug";
import type { AgentMode, AgentModelDefinition } from "@getpaseo/protocol/agent-types";
import {
  MAX_WORKSPACE_BATCH_MODELS,
  sameWorkspaceBatchModel,
  type WorkspaceBatchModel,
} from "@/composer/agent-controls/model-sheet-flow";
import { createOrRetryWorkspaceMain, type FixedMainInput } from "./create-explicit-main";
import type { MainDraftAttempt, MainDraftBatch, MainDraftBatchItem } from "./main-draft";

type WorktreeSource = Extract<CreateWorkspaceRequestOptions["source"], { kind: "worktree" }>;
type AgentConfig = NonNullable<NonNullable<CreateWorkspaceRequestOptions["agent"]>["config"]>;

export type WorkspaceBatchBlock =
  | "worktreeRequired"
  | "branchOffRequired"
  | "unsupported"
  | "browserUnsupported"
  | "empty"
  | "disconnected";

export function workspaceBatchBlock(input: {
  isolation: "worktree" | "existing" | "local";
  isBranchOff: boolean;
  hasContent: boolean;
  connected: boolean;
  supported: boolean;
  canCoordinateWindows: boolean;
}): WorkspaceBatchBlock | undefined {
  if (input.isolation !== "worktree") return "worktreeRequired";
  if (!input.isBranchOff) return "branchOffRequired";
  if (!input.connected) return "disconnected";
  if (!input.supported) return "unsupported";
  if (!input.canCoordinateWindows) return "browserUnsupported";
  if (!input.hasContent) return "empty";
}

function isFixedWorktreeSource(
  source: CreateWorkspaceRequestOptions["source"],
): source is WorktreeSource & { action: "branch-off" } {
  return (
    source.kind === "worktree" &&
    source.action === "branch-off" &&
    !source.checkoutSource &&
    source.githubPrNumber === undefined &&
    source.baseBranch === undefined
  );
}

export function resolveBatchModelConfig(input: {
  cwd: string;
  model: WorkspaceBatchModel;
  current: AgentConfig | null;
  availableModels: readonly AgentModelDefinition[];
  modes: readonly AgentMode[];
  defaultModeId?: string;
}): AgentConfig {
  const { cwd, model, current, availableModels, modes, defaultModeId } = input;
  if (current?.provider === model.provider && (current.model ?? "") === model.modelId) {
    return { ...current, cwd };
  }
  const selectedModel = availableModels.find((candidate) => candidate.id === model.modelId);
  const thinkingOptions = selectedModel?.thinkingOptions ?? [];
  const defaultThinking = thinkingOptions.find(
    (candidate) => candidate.id === selectedModel?.defaultThinkingOptionId,
  );
  return {
    cwd,
    provider: model.provider,
    model: model.modelId || undefined,
    modeId: modes.find((mode) => mode.id === defaultModeId)?.id ?? modes[0]?.id,
    thinkingOptionId: defaultThinking?.id ?? thinkingOptions.find((option) => option.isDefault)?.id,
  };
}

export async function prepareWorkspaceMainBatch(input: {
  placement: MainDraftAttempt["placement"];
  models: readonly WorkspaceBatchModel[];
  message: MainDraftBatch["message"];
  resolveConfig: (model: WorkspaceBatchModel) => AgentConfig;
  resolveStartPoint: (input: {
    cwd?: string;
    projectId?: string;
    refName?: string;
  }) => Promise<{ commitSha: string; refName: string }>;
  invalidSourceMessage: string;
  invalidSelectionMessage: string;
  createId?: () => string;
}): Promise<MainDraftBatch> {
  const { placement, models, message, resolveConfig, resolveStartPoint } = input;
  const { source } = placement;
  if (!isFixedWorktreeSource(source)) throw new Error(input.invalidSourceMessage);
  if (
    models.length < 2 ||
    models.length > MAX_WORKSPACE_BATCH_MODELS ||
    models.some((model, index) =>
      models.slice(0, index).some((previous) => sameWorkspaceBatchModel(previous, model)),
    )
  ) {
    throw new Error(input.invalidSelectionMessage);
  }
  const configs = models.map(resolveConfig);
  const { cwd, projectId } = source;
  const { commitSha, refName } = await resolveStartPoint({
    cwd,
    projectId,
    refName: source.refName,
  });
  const createId = input.createId ?? (() => crypto.randomUUID());
  const baseSlug = slugify(source.worktreeSlug ?? "") || "workspace";
  const branchPrefix = source.branchName?.split("/").map(slugify).filter(Boolean).join("/");
  const items = models.map((model, index): MainDraftBatchItem => {
    const id = createId().replaceAll("-", "").slice(0, 16);
    // The daemon normalizes the worktree slug. Reserve space so it never trims the unique suffix.
    const slugPrefix = baseSlug.slice(0, MAX_SLUG_LENGTH - id.length - 1).replace(/-+$/, "");
    const worktreeSlug = `${slugPrefix}-${id}`;
    return {
      model,
      config: configs[index]!,
      workspaceId: `wks_${id}`,
      agentId: createId(),
      recoveryAgentId: createId(),
      clientMessageId: createId(),
      placement: {
        ...placement,
        source: {
          kind: "worktree",
          action: "branch-off",
          cwd,
          projectId,
          refName,
          startPoint: commitSha,
          branchName: branchPrefix ? `${branchPrefix}-${id}` : worktreeSlug,
          worktreeSlug,
        },
      },
      attemptKind: "workspace",
      stage: "queued",
    };
  });
  return { items, message };
}

export async function runWorkspaceMainBatch(input: {
  batch: MainDraftBatch;
  action: { kind: "resume" } | { kind: "check" | "retry"; workspaceId: string };
  client: FixedMainInput["client"];
  save: (batch: MainDraftBatch) => Promise<void>;
  acceptSnapshots: FixedMainInput["acceptSnapshots"];
  assertSupported: () => void;
  failedMessage: string;
}): Promise<void> {
  const { action, client, save, acceptSnapshots, assertSupported, failedMessage } = input;
  let batch = input.batch;
  const failures: unknown[] = [];
  for (const item of batch.items) {
    if (item.stage === "succeeded") continue;
    if (action.kind !== "resume" && action.workspaceId !== item.workspaceId) continue;
    // A failed item needs an explicit retry. Reconnect only reads its latest receipt.
    try {
      await createOrRetryWorkspaceMain({
        client,
        fixedAttempt: item,
        agent: { ...batch.message, config: item.config, clientMessageId: item.clientMessageId },
        action: action.kind,
        saveItem: async (next) => {
          const updated = {
            ...batch,
            items: batch.items.map((entry) =>
              entry.workspaceId === next.workspaceId ? next : entry,
            ),
          };
          await save(updated);
          batch = updated;
        },
        acceptSnapshots,
        assertSupported,
        failedMessage,
      });
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw failures[0];
}

export function workspaceMainBatchAgentTarget(serverId: string, item: MainDraftBatchItem) {
  if (item.stage !== "succeeded" && !item.agentReady) return null;
  return {
    serverId,
    workspaceId: item.workspaceId,
    target: {
      kind: "agent" as const,
      agentId: item.attemptKind === "agent" ? item.recoveryAgentId : item.agentId,
    },
  };
}
