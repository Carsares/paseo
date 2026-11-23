import { useCallback, type ReactNode } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { WorkspaceFileComposerAttachment } from "@/attachments/types";
import { getWorkspaceFileAttachmentSubtitle } from "@/attachments/workspace-file";
import { AttachmentLabel, AttachmentPill } from "@/components/attachment-pill";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { isWeb } from "@/constants/platform";

interface WorkspaceFileAttachmentPillProps {
  attachment: WorkspaceFileComposerAttachment;
  index: number;
  disabled: boolean;
  onRemove: (index: number) => void;
  removeLabel: string;
  icon: ReactNode;
}

function noop() {}

export function WorkspaceFileAttachmentPill({
  attachment,
  index,
  disabled,
  onRemove,
  removeLabel,
  icon,
}: WorkspaceFileAttachmentPillProps) {
  const handleRemove = useCallback(() => {
    onRemove(index);
  }, [index, onRemove]);
  const { path, selection } = attachment;
  const fileName = path.split("/").pop() ?? path;
  let tooltipPath = path;
  if (selection.kind === "line_range") {
    tooltipPath += `:${selection.startLine}`;
    if (selection.endLine !== selection.startLine) {
      tooltipPath += `-${selection.endLine}`;
    }
  }
  const pill = (
    <AttachmentPill
      testID="composer-workspace-file-attachment-pill"
      onOpen={noop}
      onRemove={handleRemove}
      openAccessibilityLabel={isWeb ? tooltipPath : fileName}
      removeAccessibilityLabel={removeLabel}
      disabled={disabled}
    >
      <AttachmentLabel
        icon={icon}
        title={fileName}
        subtitle={getWorkspaceFileAttachmentSubtitle(attachment)}
      />
    </AttachmentPill>
  );

  if (!isWeb) return pill;

  return (
    <Tooltip enabledOnCompactWeb>
      <TooltipTrigger asChild disabled={disabled}>
        <View>{pill}</View>
      </TooltipTrigger>
      <TooltipContent>
        <Text style={styles.tooltipText}>{tooltipPath}</Text>
      </TooltipContent>
    </Tooltip>
  );
}

const styles = StyleSheet.create((theme) => ({
  tooltipText: {
    fontSize: theme.fontSize.base,
    color: theme.colors.popoverForeground,
    ...(isWeb ? { overflowWrap: "anywhere" as const } : {}),
  },
}));
