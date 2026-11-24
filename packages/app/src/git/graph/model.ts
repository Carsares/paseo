export function graphLayout(width: number): "wide" | "medium" | "narrow" {
  if (width >= 1040) return "wide";
  return width >= 720 ? "medium" : "narrow";
}

export const emptyFilters = {
  branchFilter: "",
  authorFilter: "",
  textQuery: "",
  regex: false,
  matchCase: false,
  since: "",
  until: "",
};

export type GraphFilters = typeof emptyFilters;

function validDate(value: string): boolean {
  if (!value) return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function compileFilters(input: GraphFilters) {
  const { branchFilter, authorFilter, textQuery, regex, matchCase } = input;
  const since = input.since.trim();
  const until = input.until.trim();
  if (!validDate(since) || !validDate(until) || (since && until && since > until)) return null;
  return {
    branchFilter: branchFilter.trim() || undefined,
    authorFilter: authorFilter.trim() || undefined,
    textQuery: textQuery || undefined,
    regex,
    matchCase,
    since: since ? `${since}T00:00:00.000Z` : undefined,
    until: until ? `${until}T23:59:59.999Z` : undefined,
  };
}
