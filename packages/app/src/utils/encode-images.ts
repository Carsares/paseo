import type { AttachmentMetadata } from "@/attachments/types";
import { encodeAttachmentsForSend } from "@/attachments/service";

type ImageInput = AttachmentMetadata;

export async function encodeImages(
  images?: ImageInput[],
  requiredMessage?: string,
): Promise<Array<{ data: string; mimeType: string }> | undefined> {
  const encoded = await encodeAttachmentsForSend(images);
  if (requiredMessage && images?.length && encoded?.length !== images.length) {
    throw new Error(requiredMessage);
  }
  return encoded;
}
