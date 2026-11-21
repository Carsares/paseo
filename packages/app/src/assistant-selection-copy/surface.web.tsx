import { useCallback, useRef, type ClipboardEvent, type CSSProperties } from "react";
import { View } from "react-native";
import { usePluginSelectionButtons } from "@/plugins/buttons/view";
import { createAssistantSelectionClipboardContent } from "./content.web";
import { useComposerQuote } from "./composer-quote";
import { AssistantSelectionQuote } from "./quote.web";
import type { AssistantSelectionCopySurfaceProps } from "./surface";

const DISPLAY_CONTENTS: CSSProperties = { display: "contents" };

export function AssistantSelectionCopySurface({
  children,
  style,
  serverId,
  workspaceId,
  agentId,
  canSubmitSelection,
  subagentSpawnMode,
  onSpawnSubagentFromSelection,
}: AssistantSelectionCopySurfaceProps) {
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const composerQuote = useComposerQuote();
  const selectionButtons = usePluginSelectionButtons(
    serverId,
    workspaceId ?? undefined,
    agentId,
    !!agentId && !!workspaceId && canSubmitSelection?.(agentId, workspaceId) === true,
  );
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
      {composerQuote || onSpawnSubagentFromSelection || selectionButtons.length > 0 ? (
        <AssistantSelectionQuote
          key={JSON.stringify([serverId, workspaceId, agentId])}
          streamRef={surfaceRef}
          workspaceId={workspaceId ?? undefined}
          agentId={agentId}
          selectionButtons={selectionButtons}
          canSubmitSelection={canSubmitSelection}
          onQuote={composerQuote?.addQuote}
          subagentSpawnMode={subagentSpawnMode}
          onSpawnSubagentFromSelection={onSpawnSubagentFromSelection}
        />
      ) : null}
    </div>
  );
}
