import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useKeyboardActionDispatcher } from "@/keyboard/keyboard-action-dispatcher-context";

export interface ComposerQuote {
  quote: string;
}

/** The composer draft a quote goes into. */
export interface ComposerQuoteTarget {
  addQuoteAttachment: (quoteText: string) => void;
}

interface ComposerQuoteContextValue {
  addQuote: (input: ComposerQuote) => void;
}

const ComposerQuoteContext = createContext<ComposerQuoteContextValue | null>(null);

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
          target.addQuoteAttachment(input.quote);
          keyboardActionDispatcher.dispatch({ id: "message-input.focus", scope: "message-input" });
        },
      },
    [keyboardActionDispatcher, target],
  );

  return <ComposerQuoteContext.Provider value={value}>{children}</ComposerQuoteContext.Provider>;
}

export function useComposerQuote(): ComposerQuoteContextValue | null {
  return useContext(ComposerQuoteContext);
}
