import { deriveIdentityColorName, identityColor } from "@/styles/identity-colors";

export function repoColor(repoRoot: string): string {
  return identityColor(deriveIdentityColorName(repoRoot));
}

export interface StripeSegment {
  repoRoot: string;
  start: number;
  end: number;
  color: string;
}

/** End is exclusive, so adjacent runs share a boundary without a gap. */
export function stripeSegments(rows: readonly { repoRoot: string }[]): StripeSegment[] {
  const segments: StripeSegment[] = [];
  for (const [index, { repoRoot }] of rows.entries()) {
    const current = segments.at(-1);
    if (current?.repoRoot === repoRoot) {
      current.end = index + 1;
    } else {
      segments.push({ repoRoot, start: index, end: index + 1, color: repoColor(repoRoot) });
    }
  }
  return segments;
}
