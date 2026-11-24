import type { CheckoutGitConflictFile } from "@getpaseo/protocol/messages";

export type MergeContents = NonNullable<CheckoutGitConflictFile["contents"]>;

export interface MergeEditorProps {
  contents: MergeContents;
  labels: Record<keyof MergeContents, string>;
  missingVersionLabel: string;
  foreground?: string;
  editing?: boolean;
  onChangeResult?: (value: string) => void;
}

export function MergeEditor(_props: MergeEditorProps) {
  // Native continues to use the existing conflict controls.
  return null;
}
