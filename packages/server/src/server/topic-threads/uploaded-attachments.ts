import { constants, type Stats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { MessageImageAttachment } from "@getpaseo/protocol/agent-types";
import type { AgentAttachment, UploadedFileAttachment } from "@getpaseo/protocol/messages";
import { getImageDimensions } from "../../utils/project-icon.js";

// Match the app's FILE_UPLOAD_MAX_BYTES without importing app code into the daemon.
const MAX_TOPIC_IMAGE_BYTES = 50 * 1024 * 1024;
export const MESSAGE_IMAGE_PATH_PREFIX = "paseo-attachment:";
const UPLOAD_ID = /^upload_[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const PNG_HEADER = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"); // Signature and IHDR prefix.
const PNG_END = Buffer.from("0000000049454e44ae426082", "hex");
const READ_FLAGS =
  process.platform === "win32"
    ? constants.O_RDONLY
    : constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

/** The session binds lookup to the authenticated origin of the upload before passing this in. */
export interface TopicUploadAccess {
  uploadsRoot: string;
  lookup: (id: string) => Promise<UploadedFileAttachment | null>;
}

export const TOPIC_ATTACHMENTS_REUPLOAD_REQUIRED = "topic_attachments_reupload_required:";

export class TopicAttachmentsReuploadRequired extends Error {
  constructor(files: readonly UploadedFileAttachment[]) {
    super(TOPIC_ATTACHMENTS_REUPLOAD_REQUIRED + JSON.stringify(files.map((file) => file.fileName)));
  }
}

function imageMimeType(value: string) {
  switch (value.split(";", 1)[0]?.trim().toLowerCase()) {
    case "image/png":
      return "image/png";
    case "image/jpeg":
    case "image/jpg":
      return "image/jpeg";
    case "image/gif":
      return "image/gif";
    case "image/webp":
      return "image/webp";
    default:
      return null;
  }
}

function invalidImage() {
  return new Error("Invalid topic image contents.");
}

function* webpChunks(data: Buffer, offset: number, limit: number) {
  while (offset < limit) {
    if (limit - offset < 8) throw invalidImage();
    const type = data.toString("latin1", offset, offset + 4);
    const size = data.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    offset = end + (size & 1);
    if (offset > limit || (offset > end && data[end] !== 0)) throw invalidImage();
    yield { type, start, end };
  }
}

type WebpChunk = ReturnType<typeof webpChunks> extends Generator<infer Chunk> ? Chunk : never;

function webpDimensions(data: Buffer, { type, start, end }: WebpChunk) {
  const size = end - start;
  if (type === "VP8L") {
    if (size <= 5 || data[start] !== 0x2f) return;
    const header = data.readUInt32LE(start + 1);
    if (header >>> 29) return;
    return { width: (header & 0x3fff) + 1, height: ((header >>> 14) & 0x3fff) + 1 };
  }
  if (type !== "VP8 " || size <= 10 || data.readUIntBE(start + 3, 3) !== 0x9d012a) return;
  const tag = data.readUIntLE(start, 3);
  const partitionSize = tag >>> 5;
  if (tag & 1 || !partitionSize || partitionSize > size - 10) return;
  const width = data.readUInt16LE(start + 6) & 0x3fff;
  const height = data.readUInt16LE(start + 8) & 0x3fff;
  if (width && height) return { width, height };
}

function isWebpBitstream(type: string) {
  return type === "VP8 " || type === "VP8L";
}

function matchesWebpFrame(data: Buffer, { start, end }: WebpChunk, width: number, height: number) {
  if (end - start < 16) return false;
  const frameWidth = data.readUIntLE(start + 6, 3) + 1;
  const frameHeight = data.readUIntLE(start + 9, 3) + 1;
  if (
    2 * data.readUIntLE(start, 3) + frameWidth > width ||
    2 * data.readUIntLE(start + 3, 3) + frameHeight > height
  )
    return false;
  let foundImage = false;
  for (const chunk of webpChunks(data, start + 16, end)) {
    if (!isWebpBitstream(chunk.type)) continue;
    const dimensions = webpDimensions(data, chunk);
    if (foundImage || dimensions?.width !== frameWidth || dimensions.height !== frameHeight)
      return false;
    foundImage = true;
  }
  return foundImage;
}

function matchesExtendedWebp(data: Buffer, header: WebpChunk) {
  if (header.end - header.start !== 10) return false;
  const animated = !!(data[header.start] & 0x02);
  const width = data.readUIntLE(header.start + 4, 3) + 1;
  const height = data.readUIntLE(header.start + 7, 3) + 1;
  if (width * height > 0xffffffff) return false;
  let foundAnimation = false;
  let foundImage = false;
  for (const chunk of webpChunks(data, header.end, data.length)) {
    if (isWebpBitstream(chunk.type)) {
      const dimensions = webpDimensions(data, chunk);
      if (animated || foundImage || dimensions?.width !== width || dimensions.height !== height)
        return false;
      foundImage = true;
    } else if (chunk.type === "ANIM") {
      if (!animated || foundAnimation || chunk.end - chunk.start !== 6) return false;
      foundAnimation = true;
    } else if (chunk.type === "ANMF") {
      if (!foundAnimation || !matchesWebpFrame(data, chunk, width, height)) return false;
      foundImage = true;
    }
  }
  return foundImage;
}

function matchesWebp(data: Buffer) {
  if (
    data.length < 20 ||
    data.toString("latin1", 0, 4) !== "RIFF" ||
    data.toString("latin1", 8, 12) !== "WEBP" ||
    data.readUInt32LE(4) + 8 !== data.length
  )
    return false;
  const chunks = webpChunks(data, 12, data.length);
  const first = chunks.next().value;
  if (!first) return false;
  if (first.type === "VP8X") return matchesExtendedWebp(data, first);
  // A simple WebP has a single image chunk.
  return !!webpDimensions(data, first) && !!chunks.next().done;
}

function matchesImage(data: Buffer, mimeType: NonNullable<ReturnType<typeof imageMimeType>>) {
  if (mimeType === "image/png") {
    if (
      data.length < 45 ||
      !data.subarray(0, PNG_HEADER.length).equals(PNG_HEADER) ||
      !data.subarray(-12).equals(PNG_END)
    )
      return false;
  } else if (mimeType === "image/jpeg") {
    if (data[2] !== 0xff) return false;
  } else if (mimeType === "image/gif") {
    const header = data.toString("latin1", 0, 6);
    if ((header !== "GIF87a" && header !== "GIF89a") || data.at(-1) !== 0x3b) return false;
  } else if (mimeType === "image/webp") {
    return matchesWebp(data);
  }
  const dimensions = getImageDimensions(data, mimeType);
  return !!dimensions && dimensions.width > 0 && dimensions.height > 0;
}

function invalidUpload(): Error {
  return new Error("The topic attachment does not match an available upload.");
}

function normalizedMimeType(value: string) {
  return value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

async function findRetryUpload(attachment: UploadedFileAttachment, uploads: TopicUploadAccess) {
  if (!UPLOAD_ID.test(attachment.id)) throw invalidUpload();
  const registered = await uploads.lookup(attachment.id);
  if (registered) return registered;
  // A scoped lookup also returns null for another owner's upload. Only a missing
  // host receipt makes a stored attachment eligible for replacement. Never read it here.
  try {
    await lstat(resolve(uploads.uploadsRoot, "..", "upload-receipts", `${attachment.id}.json`));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
  throw invalidUpload();
}

export async function restoreTopicRetryAttachments(
  stored: AgentAttachment[] | undefined,
  replacements: AgentAttachment[] | undefined,
  uploads: TopicUploadAccess | undefined,
) {
  if (!stored?.some((file) => file.type === "uploaded_file")) return stored;
  if (!uploads) throw invalidUpload();
  const missing: UploadedFileAttachment[] = [];
  const keptIds = new Set<string>();
  for (const file of stored) {
    if (file.type !== "uploaded_file") continue;
    if (await findRetryUpload(file, uploads)) keptIds.add(file.id);
    else missing.push(file);
  }
  if (missing.length === 0) return stored;
  if (replacements?.length !== missing.length) throw new TopicAttachmentsReuploadRequired(missing);

  const unused = new Set(replacements);
  const byOriginal = new Map<UploadedFileAttachment, UploadedFileAttachment>();
  for (const original of missing) {
    const replacement = [...unused].find(
      (file): file is UploadedFileAttachment =>
        file.type === "uploaded_file" &&
        file.fileName === original.fileName &&
        file.size === original.size &&
        normalizedMimeType(file.mimeType) === normalizedMimeType(original.mimeType),
    );
    if (!replacement || keptIds.has(replacement.id))
      throw new TopicAttachmentsReuploadRequired(missing);
    await registeredUpload(replacement, uploads);
    keptIds.add(replacement.id);
    unused.delete(replacement);
    byOriginal.set(original, replacement);
  }
  return stored.map((file) =>
    file.type === "uploaded_file" ? (byOriginal.get(file) ?? file) : file,
  );
}

async function registeredUpload(
  attachment: UploadedFileAttachment,
  uploads: TopicUploadAccess | undefined,
) {
  if (!uploads || !UPLOAD_ID.test(attachment.id)) throw invalidUpload();
  const upload = await uploads.lookup(attachment.id);
  if (
    !upload ||
    upload.id !== attachment.id ||
    upload.path !== attachment.path ||
    upload.fileName !== attachment.fileName ||
    upload.mimeType !== attachment.mimeType ||
    upload.size !== attachment.size ||
    !upload.fileName ||
    upload.fileName === "." ||
    upload.fileName === ".." ||
    /[\\/]/u.test(upload.fileName) ||
    resolve(upload.path) !== resolve(uploads.uploadsRoot, upload.id, upload.fileName)
  )
    throw invalidUpload();
  return { upload, root: uploads.uploadsRoot };
}

async function verifiedPath(root: string, upload: UploadedFileAttachment) {
  // Resolve the host-configured parent first (e.g. /tmp on macOS). Reject links below it.
  const canonicalRoot = join(await realpath(resolve(root, "..")), basename(root));
  const dir = join(canonicalRoot, upload.id);
  if (!(await lstat(canonicalRoot)).isDirectory() || !(await lstat(dir)).isDirectory())
    throw invalidUpload();
  const path = join(dir, upload.fileName);
  const stat = await lstat(path);
  if (!stat.isFile() || stat.size !== upload.size) throw invalidUpload();
  return { path, stat };
}

async function readImage(path: string, expected: Stats) {
  const file = await open(path, READ_FLAGS);
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.dev !== expected.dev ||
      stat.ino !== expected.ino ||
      stat.size !== expected.size
    )
      throw invalidUpload();

    // Read at most the registered size plus one byte, even if the file grows after stat().
    const data = Buffer.allocUnsafe(stat.size + 1);
    let offset = 0;
    while (offset < data.length) {
      const { bytesRead } = await file.read(data, offset, data.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== stat.size) throw invalidUpload();
    return data.subarray(0, offset);
  } finally {
    await file.close();
  }
}

export async function resolveTopicPromptAttachments(
  attachments?: readonly AgentAttachment[],
  uploads?: TopicUploadAccess,
) {
  const files: AgentAttachment[] = [];
  const images: Array<{ data: string; mimeType: string }> = [];
  const imageAttachments: MessageImageAttachment[] = [];
  let imageBytes = 0;
  for (const attachment of attachments ?? []) {
    if (attachment.type !== "uploaded_file") {
      files.push(attachment);
      continue;
    }
    const { upload, root } = await registeredUpload(attachment, uploads);
    const mimeType = imageMimeType(upload.mimeType);
    const { path, stat } = await verifiedPath(root, upload);
    if (!mimeType) {
      files.push(upload);
      continue;
    }
    imageBytes += stat.size;
    if (stat.size === 0 || imageBytes > MAX_TOPIC_IMAGE_BYTES)
      throw new Error("Topic images exceed the upload limit or are empty.");
    const data = await readImage(path, stat);
    if (!matchesImage(data, mimeType)) throw invalidImage();
    images.push({ data: data.toString("base64"), mimeType });
    imageAttachments.push({ id: upload.id, fileName: upload.fileName, mimeType, size: stat.size });
  }
  return { files, images, imageAttachments };
}

export function decodeMessageImage(image: { data: string; mimeType: string }) {
  const mimeType = imageMimeType(image.mimeType);
  if (!mimeType || image.data.length > Math.ceil(MAX_TOPIC_IMAGE_BYTES / 3) * 4) return;
  const bytes = Buffer.from(image.data, "base64");
  if (!bytes.length || bytes.length > MAX_TOPIC_IMAGE_BYTES || !matchesImage(bytes, mimeType))
    return;
  return { bytes, mimeType };
}

export async function readMessageImage(uploads: TopicUploadAccess, id: string, maxBytes?: number) {
  const upload = await uploads.lookup(id);
  if (!upload) throw new Error("Image attachment is unavailable.");
  const mimeType = imageMimeType(upload.mimeType);
  if (!mimeType) throw new Error("Image attachment is unavailable.");
  const { root } = await registeredUpload(upload, uploads);
  const { path, stat } = await verifiedPath(root, upload);
  if (
    stat.size === 0 ||
    stat.size > Math.min(maxBytes ?? MAX_TOPIC_IMAGE_BYTES, MAX_TOPIC_IMAGE_BYTES)
  )
    throw new Error("Image attachment is too large to display or empty.");
  const bytes = await readImage(path, stat);
  if (!matchesImage(bytes, mimeType)) throw invalidImage();
  return { bytes, mimeType, modifiedAt: stat.mtime.toISOString() };
}
