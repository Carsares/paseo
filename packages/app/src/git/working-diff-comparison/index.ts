import { useCallback } from "react";
import { create } from "zustand";
import {
  resolveWorkingDiffComparisonFromState,
  selectCheckpointDiffInState,
  selectWorkingDiffComparisonInState,
  type CheckpointDiffSelection,
  type WorkingDiffCheckoutIdentity,
  type WorkingDiffComparison,
  type WorkingDiffComparisonState,
  workingDiffComparisonKey,
} from "./state";

interface WorkingDiffComparisonStore extends WorkingDiffComparisonState {
  select: (
    input: WorkingDiffCheckoutIdentity & {
      comparison: WorkingDiffComparison;
    },
  ) => void;
  selectCheckpoint: (
    input: WorkingDiffCheckoutIdentity & { selection: CheckpointDiffSelection },
  ) => void;
}

const useWorkingDiffComparisonStore = create<WorkingDiffComparisonStore>((set) => ({
  overrides: {},
  select: (input) => set((state) => selectWorkingDiffComparisonInState(state, input)),
  selectCheckpoint: (input) => set((state) => selectCheckpointDiffInState(state, input)),
}));

export function useCheckpointDiffSelection(input: WorkingDiffCheckoutIdentity) {
  const key = workingDiffComparisonKey(input);
  return useWorkingDiffComparisonStore((state) => state.overrides[key]?.checkpoint);
}

export function selectCheckpointDiff(
  input: WorkingDiffCheckoutIdentity & { selection: CheckpointDiffSelection },
): void {
  useWorkingDiffComparisonStore.getState().selectCheckpoint(input);
}

export function useWorkingDiffComparison(input: WorkingDiffCheckoutIdentity): {
  comparison: WorkingDiffComparison;
  selectComparison: (comparison: WorkingDiffComparison) => void;
} {
  const { serverId, workspaceId, cwd } = input;
  const comparison = useWorkingDiffComparisonStore((state) =>
    resolveWorkingDiffComparisonFromState(state, { serverId, workspaceId, cwd }),
  );
  const select = useWorkingDiffComparisonStore((state) => state.select);
  const selectComparison = useCallback(
    (next: WorkingDiffComparison) => select({ serverId, workspaceId, cwd, comparison: next }),
    [cwd, select, serverId, workspaceId],
  );
  return { comparison, selectComparison };
}

export function selectWorkingDiffComparison(
  input: WorkingDiffCheckoutIdentity & {
    comparison: WorkingDiffComparison;
  },
): void {
  useWorkingDiffComparisonStore.getState().select(input);
}

export function resolveWorkingDiffComparison(
  input: WorkingDiffCheckoutIdentity,
): WorkingDiffComparison {
  return resolveWorkingDiffComparisonFromState(useWorkingDiffComparisonStore.getState(), input);
}

export function resetWorkingDiffComparisons(): void {
  useWorkingDiffComparisonStore.setState({ overrides: {} });
}
