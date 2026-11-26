import { createContext, useContext, useMemo, type ReactNode } from "react";
import { normalizeQuoteTopicMetadata } from "@/attachments/quote";
import type { QuoteTopicSourceMetadata } from "@/attachments/types";
import { useKeyboardActionDispatcher } from "@/keyboard/keyboard-action-dispatcher-context";
import type { StreamItem } from "@/types/stream";

export interface ComposerQuote extends QuoteTopicSourceMetadata {
  quote: string;
  /** Card title in the composer; the numbered default when omitted. */
  label?: string;
}

/** The composer draft a quote goes into. */
export interface ComposerQuoteTarget {
  addQuoteAttachment: (
    quoteText: string,
    label?: string,
    metadata?: QuoteTopicSourceMetadata,
  ) => void;
}

interface ComposerQuoteContextValue {
  addQuote: (input: ComposerQuote, options?: { useAmbientTopic: false }) => void;
}

type QuoteTopicByRow = (rowId: string) => QuoteTopicSourceMetadata | undefined;
const ComposerQuoteContext = createContext<ComposerQuoteContextValue | null>(null);
const QuoteTopicContext = createContext<QuoteTopicSourceMetadata | null>(null);
const QuoteTopicByRowContext = createContext<QuoteTopicByRow | undefined>(undefined);

export function getAssistantQuoteTopic(
  item: StreamItem | undefined,
): QuoteTopicSourceMetadata | undefined {
  if (item?.kind !== "assistant_message") return undefined;
  const { taskId, rootMessageId, messageId } = item;
  let topicKey = item.topicKey;
  if (!topicKey && taskId) topicKey = `task:${taskId}`;
  if (!topicKey && rootMessageId) topicKey = `msg:${rootMessageId}`;
  if (!topicKey) return undefined;
  return normalizeQuoteTopicMetadata({
    topicKey,
    taskId,
    rootMessageId,
    sourceMessageId: messageId ?? item.id,
  });
}

/**
 * The draft with a quoted passage and the note written under it appended after a blank line.
 *
 * Without a note the draft ends on an empty paragraph: a line typed straight under a quote
 * would continue it.
 */
export function appendQuoteToDraft(input: { draft: string; quote: string; note: string }): string {
  const quote = input.quote
    .split("\n")
    .map((line) => (line ? `> ${line}` : ">"))
    .join("\n");
  const note = input.note.trim();
  const block = `${quote}\n\n${note}`;
  const draft = input.draft.trimEnd();
  return draft ? `${draft}\n\n${block}` : block;
}

/**
 * Lets a selection in the agent's messages be quoted into the same agent's composer.
 */
export function ComposerQuoteProvider({
  target,
  children,
}: {
  target: ComposerQuoteTarget | null;
  children?: ReactNode;
}) {
  const keyboardActionDispatcher = useKeyboardActionDispatcher();
  const value = useMemo<ComposerQuoteContextValue | null>(
    () =>
      target && {
        addQuote: (input) => {
          const metadata = normalizeQuoteTopicMetadata(input);
          if (Object.keys(metadata).length > 0) {
            target.addQuoteAttachment(input.quote, input.label, metadata);
          } else {
            target.addQuoteAttachment(input.quote, input.label);
          }
          keyboardActionDispatcher.dispatch({ id: "message-input.focus", scope: "message-input" });
        },
      },
    [keyboardActionDispatcher, target],
  );

  return <ComposerQuoteContext.Provider value={value}>{children}</ComposerQuoteContext.Provider>;
}

/**
 * Attaches ambient topic source metadata to quotes created inside a topic card or turn subtree.
 */
export function QuoteTopicProvider({
  topic,
  resolveQuoteTopicByRowId,
  children,
}: {
  topic: QuoteTopicSourceMetadata | null;
  resolveQuoteTopicByRowId?: QuoteTopicByRow;
  children?: ReactNode;
}) {
  const topicKey = topic?.topicKey;
  const rootMessageId = topic?.rootMessageId;
  const taskId = topic?.taskId;
  const sourceMessageId = topic?.sourceMessageId;
  const value = useMemo<QuoteTopicSourceMetadata | null>(() => {
    const normalized = normalizeQuoteTopicMetadata({
      topicKey,
      rootMessageId,
      taskId,
      sourceMessageId,
    });
    return Object.keys(normalized).length > 0 ? normalized : null;
  }, [rootMessageId, sourceMessageId, taskId, topicKey]);

  return (
    <QuoteTopicContext.Provider value={value}>
      <QuoteTopicByRowContext.Provider value={resolveQuoteTopicByRowId}>
        {children}
      </QuoteTopicByRowContext.Provider>
    </QuoteTopicContext.Provider>
  );
}

export function useQuoteTopicByRow(): QuoteTopicByRow | undefined {
  return useContext(QuoteTopicByRowContext);
}

export function useQuoteTopicContext(): QuoteTopicSourceMetadata | null {
  return useContext(QuoteTopicContext);
}

export function useComposerQuote(): ComposerQuoteContextValue | null {
  const composerQuote = useContext(ComposerQuoteContext);
  const topicContext = useContext(QuoteTopicContext);
  return useMemo(() => {
    if (!composerQuote) return null;
    if (!topicContext) return composerQuote;
    return {
      addQuote: (input, options) =>
        composerQuote.addQuote(
          options?.useAmbientTopic === false
            ? input
            : {
                ...topicContext,
                ...input,
              },
        ),
    };
  }, [composerQuote, topicContext]);
}
