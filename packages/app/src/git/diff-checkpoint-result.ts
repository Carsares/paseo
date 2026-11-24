import type { AgentRewindCheckpointDiffResponse } from "@getpaseo/protocol/messages";

export type CheckpointDiffResult = NonNullable<AgentRewindCheckpointDiffResponse["result"]>;

export function resolveCheckpointDiffView({
  available,
  result,
  error,
  copy,
}: {
  available: boolean;
  result?: CheckpointDiffResult;
  error: Error | null;
  copy: { unavailable: string; checkpointMissing: string; externalWrites: string };
}) {
  if (available && !error && result?.kind === "ready") {
    return {
      files: result.files,
      stagedFiles: result.stagedFiles,
      diffTooLarge: result.diffTooLarge,
      attributionNotice: result.attribution === "unknown" ? copy.externalWrites : null,
      errorMessage: null,
      isLoading: false,
    };
  }
  let errorMessage = error?.message ?? null;
  if (!available) errorMessage = copy.unavailable;
  if (available && !error && result?.kind === "unavailable") {
    errorMessage = result.reason === "missing" ? copy.checkpointMissing : copy.unavailable;
  }
  return {
    files: undefined,
    stagedFiles: undefined,
    diffTooLarge: false,
    attributionNotice: null,
    errorMessage,
    isLoading: errorMessage === null,
  };
}

export function readCheckpointDiffResult(
  response: AgentRewindCheckpointDiffResponse,
  loadFailed: string,
): CheckpointDiffResult {
  if (response.ok && response.result) return response.result;
  throw new Error(response.error ?? loadFailed);
}
