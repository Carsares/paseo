import { Buffer } from "buffer";
import { useMemo } from "react";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { resolveRasterImageMimeType } from "@/attachments/file-types";
import type { MessageImageReader } from "@/components/read-only-message-images";
import { useWorkspaceDirectory } from "@/stores/session-store-hooks";

// The file API resolves this address against the authenticated upload owner.
const MESSAGE_IMAGE_PREFIX = "paseo-attachment:";
const MAX_MESSAGE_IMAGE_BYTES = 50 * 1024 * 1024;

export function useMessageImageReader(
  client: Pick<DaemonClient, "readFile"> | null | undefined,
  serverId: string | undefined,
  workspaceId: string | undefined,
): MessageImageReader | undefined {
  const workspaceDirectory = useWorkspaceDirectory(serverId ?? null, workspaceId ?? null);
  return useMemo(() => {
    if (!client || !serverId || !workspaceId || !workspaceDirectory) return undefined;
    return {
      serverId,
      workspaceId,
      read: async (image) => {
        const file = await client.readFile(
          workspaceDirectory,
          MESSAGE_IMAGE_PREFIX + image.id,
          undefined,
          Math.min(image.size, MAX_MESSAGE_IMAGE_BYTES),
        );
        const mime = resolveRasterImageMimeType({ mimeType: file.mime });
        if (!mime || mime !== image.mimeType || file.size !== image.size) {
          throw new Error("Image attachment is unavailable.");
        }
        return "data:" + mime + ";base64," + Buffer.from(file.bytes).toString("base64");
      },
    };
  }, [client, serverId, workspaceDirectory, workspaceId]);
}
