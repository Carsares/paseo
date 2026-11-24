import { useEffect, useRef, useState } from "react";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { AgentSnapshotPayload, CreationSnapshot } from "@getpaseo/protocol/messages";
import { useStableEvent } from "@/hooks/use-stable-event";
import { flushDraftPersistStorage } from "@/stores/draft-store";
import {
  clearTopicQuestion,
  freezeTopicQuestion,
  readTopicQuestion,
  runTopicQuestionAction,
  submitFrozenTopicQuestion,
  withTopicQuestionOperation,
  writeTopicQuestion,
  type SavedTopicQuestion,
  type TopicQuestionOutcome,
} from "./topic-first-question";
import { watchTopicCreation } from "./topic-receipts";

export function useTopicFirstQuestion(input: {
  draftId: string;
  enabled: boolean;
  client: DaemonClient | null;
  isConnected: boolean;
  isFocused: boolean;
  isDraftHydrated: boolean;
  unconfirmedMessage: string;
  assertAvailable: () => void;
  onConfirmed: (agent: AgentSnapshotPayload) => Promise<void>;
}) {
  const { client } = input;
  const draftId = input.enabled ? input.draftId : null;
  const [loaded, setLoaded] = useState<{ id: string; item: SavedTopicQuestion | null }>();
  const [outcome, setOutcome] = useState<TopicQuestionOutcome>();
  const [error, setError] = useState<string>();
  const [isChecking, setChecking] = useState(false);
  const submitting = useRef(false);
  const saved = loaded?.id === draftId ? loaded.item : undefined;
  const saveLocally = (id: string, item: SavedTopicQuestion | null) => setLoaded({ id, item });

  useEffect(() => {
    if (!draftId) return;
    let disposed = false;
    void readTopicQuestion(draftId).then(
      (item) => {
        if (disposed) return;
        return setLoaded({ id: draftId, item });
      },
      (cause: unknown) => {
        if (disposed) return;
        return setError(String(cause));
      },
    );
    return () => {
      disposed = true;
    };
  }, [draftId]);

  const clear = useStableEvent(async () => {
    if (!draftId) return;
    try {
      await flushDraftPersistStorage();
      await clearTopicQuestion(draftId);
      saveLocally(draftId, null);
    } finally {
      submitting.current = false;
    }
  });

  const check = useStableEvent(
    async (action: "check" | "retry", update?: CreationSnapshot, background = false) => {
      if (!draftId || !client || !input.isConnected || !input.isDraftHydrated || submitting.current)
        return false;
      if (!background) setChecking(true);
      try {
        return await withTopicQuestionOperation(draftId, async () => {
          const item = await readTopicQuestion(draftId);
          if (!item) return true;
          const result = await runTopicQuestionAction(client, item, action, {
            update,
            assertAvailable: input.assertAvailable,
          });
          setError(undefined);
          setOutcome(result);
          if (result.stage === "confirmed") await input.onConfirmed(result.agent);
          return result.stage === "confirmed";
        });
      } catch (cause) {
        if (!background) setError(String(cause));
        return false;
      } finally {
        if (!background) setChecking(false);
      }
    },
  );

  const receiptKey = saved?.request.idempotencyKey;
  const canWatch = input.isConnected && input.isFocused && input.isDraftHydrated;
  useEffect(() => {
    if (!client || !receiptKey || !canWatch) return;
    return watchTopicCreation(client, { kind: "agent", idempotencyKey: receiptKey }, (update) =>
      check("check", update, true),
    );
  }, [canWatch, check, client, receiptKey]);

  const submit = useStableEvent(async (request: Parameters<typeof freezeTopicQuestion>[0]) => {
    if (!draftId || !client || saved !== null || submitting.current) {
      throw new Error(input.unconfirmedMessage);
    }
    input.assertAvailable();
    submitting.current = true;
    try {
      const item = await withTopicQuestionOperation(draftId, async () => {
        const previous = await readTopicQuestion(draftId);
        if (previous) {
          saveLocally(draftId, previous);
          return null;
        }
        const next = freezeTopicQuestion(request);
        await flushDraftPersistStorage();
        await writeTopicQuestion(draftId, next);
        saveLocally(draftId, next);
        return next;
      });
      if (!item) throw new Error(input.unconfirmedMessage);
      const result = await submitFrozenTopicQuestion(client, item);
      setOutcome(result);
      if (result.stage !== "confirmed") throw new Error(input.unconfirmedMessage);
      return result.agent;
    } catch (cause) {
      submitting.current = false;
      throw cause;
    }
  });

  return {
    clear,
    check,
    submit,
    outcome,
    error,
    isChecking,
    isLocked: Boolean(draftId) && saved !== null,
    hasSavedQuestion: Boolean(saved),
  };
}
