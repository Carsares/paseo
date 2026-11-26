import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { FILE_UPLOAD_MAX_BYTES } from "@/attachments/upload-limit";
import type { AttachmentMetadata } from "@/attachments/types";
import type { EditingTextInputHandle } from "@/components/ui/text-input";
import { isWeb } from "@/constants/platform";
import {
  collectImageFilesFromClipboardData,
  filesToImageAttachments,
} from "@/utils/image-attachments-from-files";

export function getWebPasteEditor(input: EditingTextInputHandle | null): HTMLElement | null {
  if (!isWeb || typeof HTMLElement === "undefined") return null;
  const element = input?.getNativeRef();
  return element instanceof HTMLElement ? element : null;
}

interface WebImagePasteOptions {
  editor: HTMLElement | null;
  /** A new scope invalidates unfinished conversions, even if the editor is reused. */
  scope: string | number | object;
  enabled: boolean;
  onImages?: (images: AttachmentMetadata[]) => void;
  onError: () => void;
  onTextPaste?: (editor: HTMLElement, data: DataTransfer | null) => boolean;
}

export function useWebImagePaste({
  editor,
  scope,
  enabled,
  onImages,
  onError,
  onTextPaste,
}: WebImagePasteOptions) {
  const [isPasting, setIsPasting] = useState(false);
  const pendingCount = useRef(0);
  // A paste and a submit can reach the editor before React commits the disabled button.
  const hasPendingPaste = useCallback(() => pendingCount.current > 0, []);

  useLayoutEffect(() => {
    if (!isWeb) return;
    setIsPasting(false);
    if (!editor || !enabled) return;

    let active = true;
    const handlePaste = (event: ClipboardEvent) => {
      if (event.defaultPrevented || event.target !== editor) return;
      const files = collectImageFilesFromClipboardData(event.clipboardData);
      if (files.length === 0) {
        if (onTextPaste?.(editor, event.clipboardData)) event.preventDefault();
        return;
      }
      if (!onImages) return;

      const validFiles = files.filter(
        ({ file }) => file.size > 0 && file.size <= FILE_UPLOAD_MAX_BYTES,
      );
      if (!event.clipboardData?.getData("text/plain")) event.preventDefault();
      if (validFiles.length === 0) {
        onError();
        return;
      }

      pendingCount.current++;
      setIsPasting(true);
      const processImages = async () => {
        try {
          const images = await filesToImageAttachments(validFiles);
          if (!active) return;
          if (images.length > 0) onImages(images);
          if (images.length < files.length) onError();
        } catch {
          if (active) onError();
        } finally {
          if (active) {
            pendingCount.current--;
            setIsPasting(pendingCount.current > 0);
          }
        }
      };
      void processImages();
    };

    editor.addEventListener("paste", handlePaste);
    return () => {
      active = false;
      pendingCount.current = 0;
      editor.removeEventListener("paste", handlePaste);
    };
  }, [editor, scope, enabled, onImages, onError, onTextPaste]);

  return { isPasting, hasPendingPaste };
}
