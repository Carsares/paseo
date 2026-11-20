import { createContext } from "react";

export const ExpandedQuoteCountContext = createContext<((delta: number) => void) | null>(null);
