import { create } from "zustand";
import { reviewVersionKey, type ReviewFailure, type ReviewStop, type ReviewVersion } from "./port";

interface ReviewDraft {
  stop: ReviewStop;
  version: ReviewVersion;
  body: string;
  attempt?: {
    operationId: string;
    failure?: ReviewFailure;
  };
}

interface ReviewDraftStore {
  scopes: Record<string, Record<string, ReviewDraft>>;
  edit: (scope: string, version: ReviewVersion, stop: ReviewStop, body: string) => void;
  begin: (scope: string, version: ReviewVersion, stopId: string) => ReviewDraft | undefined;
  finish: (
    scope: string,
    version: ReviewVersion,
    stopId: string,
    operationId: string,
    failure?: ReviewFailure,
  ) => void;
}

export const emptyDrafts: Record<string, ReviewDraft> = {};

export function reviewDraftKey(version: ReviewVersion, stopId: string): string {
  return JSON.stringify([reviewVersionKey(version), stopId]);
}

function locked(draft: ReviewDraft | undefined): boolean {
  return (
    !!draft?.attempt && (!draft.attempt.failure || draft.attempt.failure.code === "unknown_outcome")
  );
}

export const useReviewDrafts = create<ReviewDraftStore>((set, get) => {
  function replace(scope: string, key: string, draft: ReviewDraft | undefined) {
    set((state) => {
      const drafts = { ...state.scopes[scope] };
      if (draft) drafts[key] = draft;
      else delete drafts[key];
      const scopes = { ...state.scopes };
      if (Object.keys(drafts).length > 0) scopes[scope] = drafts;
      else delete scopes[scope];
      return { scopes };
    });
  }

  return {
    scopes: {},
    edit(scope, version, stop, body) {
      const key = reviewDraftKey(version, stop.id);
      if (locked(get().scopes[scope]?.[key])) return;
      replace(scope, key, body ? { stop, version, body } : undefined);
    },
    begin(scope, version, stopId) {
      const key = reviewDraftKey(version, stopId);
      const draft = get().scopes[scope]?.[key];
      if (!draft?.body.trim() || locked(draft)) return undefined;
      const next = { ...draft, attempt: { operationId: crypto.randomUUID() } };
      replace(scope, key, next);
      return next;
    },
    finish(scope, version, stopId, operationId, failure) {
      const key = reviewDraftKey(version, stopId);
      const draft = get().scopes[scope]?.[key];
      if (draft?.attempt?.operationId !== operationId) return;
      replace(scope, key, failure ? { ...draft, attempt: { operationId, failure } } : undefined);
    },
  };
});
