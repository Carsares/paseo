import { useCallback, useRef, type ClipboardEvent, type CSSProperties } from "react";
import { View } from "react-native";
import { createAssistantSelectionClipboardContent } from "./content.web";
import { useComposerQuote } from "./composer-quote";
import { AssistantSelectionQuote } from "./quote.web";
import type { AssistantSelectionCopySurfaceProps } from "./surface";

const DISPLAY_CONTENTS: CSSProperties = { display: "contents" };

export function AssistantSelectionCopySurface({
  children,
  style,
  onSpawnSubagentFromSelection,
}: AssistantSelectionCopySurfaceProps) {
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const composerQuote = useComposerQuote();
  const handleCopy = useCallback((event: ClipboardEvent<HTMLDivElement>) => {
    const content = createAssistantSelectionClipboardContent(window.getSelection());
    if (!content) {
      return;
    }

    event.preventDefault();
    event.clipboardData.setData("text/plain", content.plainText);
    event.clipboardData.setData("text/html", content.html);
  }, []);

  return (
    <div ref={surfaceRef} onCopy={handleCopy} style={DISPLAY_CONTENTS}>
      <View style={style}>{children}</View>
      {composerQuote || onSpawnSubagentFromSelection ? (
        <AssistantSelectionQuote
          streamRef={surfaceRef}
          onQuote={composerQuote?.addQuote}
          onSpawnSubagentFromSelection={onSpawnSubagentFromSelection}
        />
      ) : null}
    </div>
  );
}
