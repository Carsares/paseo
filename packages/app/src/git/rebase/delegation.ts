import type { CheckoutGitConflictFile } from "@getpaseo/protocol/messages";

const MAX_HUNKS = 8;
const MAX_SIDE_LENGTH = 500;

function summarizeSide(text: string | null): string | null {
  if (text === null || text.length <= MAX_SIDE_LENGTH) return text;
  return text.slice(0, MAX_SIDE_LENGTH) + "…";
}

/** Send one inspected file at a time so a large merge cannot flood the recipient's context. */
export function buildConflictQuote(input: {
  targetRepoRoot: string;
  branch: string | null;
  rebaseId: string | null;
  backupRef: string | null;
  plannedSteps: number | null;
  file: CheckoutGitConflictFile;
}): string {
  const { file, ...context } = input;
  return JSON.stringify(
    {
      ...context,
      path: file.path,
      status: file.status,
      hunks: file.hunks.slice(0, MAX_HUNKS).map(({ index, base, ours, theirs }) => ({
        index,
        base: summarizeSide(base),
        ours: summarizeSide(ours),
        theirs: summarizeSide(theirs),
      })),
      omittedHunks: Math.max(0, file.hunks.length - MAX_HUNKS),
    },
    null,
    2,
  );
}
