import { createContext } from "react";

export interface FindUserMessageExpansion {
  rowId: string;
  quoteIndex: number | null;
}

export const FindUserMessageExpansionContext = createContext<FindUserMessageExpansion | null>(null);
export const FindQuoteIndexContext = createContext<number | null>(null);

export const UserMessageQuoteExpansionContext = createContext<{
  expandedQuotes: ReadonlySet<number>;
  toggleQuote(quoteIndex: number): void;
} | null>(null);
