import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { UploadedFileAttachment } from "@getpaseo/protocol/messages";
import { afterEach, beforeEach, expect, test } from "vitest";
import { resolveTopicPromptAttachments } from "./uploaded-attachments.js";

// A 2×2 red image encoded by cwebp. The RIFF prefix is omitted here.
const losslessImage = Buffer.from("VlA4TA8AAAAvAUAAAAcQ/Y/+ByKi/wEA", "base64");
const lossyImage = Buffer.from(
  "VlA4IDAAAADQAQCdASoCAAIAAgA0JaACdLoB+AADsAD+8MQL/yC5YXXI1/8gP+QH/ID/+PIAAAA=",
  "base64",
);
const canvas = Buffer.from([0, 0, 0, 0, 1, 0, 0, 1, 0, 0]);

function chunk(type: string, data: Buffer) {
  const header = Buffer.alloc(8);
  header.write(type);
  header.writeUInt32LE(data.length, 4);
  return Buffer.concat([header, data, Buffer.alloc(data.length % 2)]);
}

function extendedImage(...chunks: Buffer[]) {
  const contents = Buffer.concat([Buffer.from("WEBP"), ...chunks]);
  const riff = Buffer.from("RIFF    ");
  riff.writeUInt32LE(contents.length, 4);
  return Buffer.concat([riff, contents]);
}

function animatedWebp(frameData: Buffer) {
  const animatedCanvas = Buffer.from(canvas);
  animatedCanvas[0] = 2;
  const frame = Buffer.alloc(16);
  frame[6] = 1;
  frame[9] = 1;
  return extendedImage(
    chunk("VP8X", animatedCanvas),
    chunk("ANIM", Buffer.alloc(6)),
    chunk("ANMF", Buffer.concat([frame, frameData])),
  );
}

let uploadsRoot: string;
beforeEach(async () => {
  uploadsRoot = await mkdtemp(join(tmpdir(), "paseo-topic-webp-"));
});

afterEach(async () => {
  await rm(uploadsRoot, { recursive: true, force: true });
});

async function resolveWebp(contents: Buffer) {
  const id = "upload_7ac0d4c3-a4ff-4481-8d57-2d8d897a2f3a";
  const fileName = "test.webp";
  const path = join(uploadsRoot, id, fileName);
  await mkdir(dirname(path));
  await writeFile(path, contents);
  const file: UploadedFileAttachment = {
    type: "uploaded_file",
    mimeType: "image/webp",
    size: contents.length,
    id,
    fileName,
    path,
  };
  return resolveTopicPromptAttachments([file], { uploadsRoot, lookup: async () => file });
}

test.each([
  ["lossless", extendedImage(chunk("VP8X", canvas), losslessImage)],
  ["lossy", extendedImage(chunk("VP8X", canvas), lossyImage)],
  ["animated", animatedWebp(losslessImage)],
] as const)("emits the bytes of an extended %s WebP", async (_kind, bytes) => {
  await expect(resolveWebp(bytes)).resolves.toEqual({
    files: [],
    images: [{ mimeType: "image/webp", data: bytes.toString("base64") }],
    imageAttachments: [
      {
        id: "upload_7ac0d4c3-a4ff-4481-8d57-2d8d897a2f3a",
        fileName: "test.webp",
        mimeType: "image/webp",
        size: bytes.length,
      },
    ],
  });
});

test.each([
  ["metadata only", extendedImage(chunk("VP8X", canvas), chunk("JUNK", Buffer.alloc(0)))],
  ["missing padding", extendedImage(chunk("VP8X", canvas), losslessImage.subarray(0, -1))],
  ["truncated bitstream", extendedImage(chunk("VP8X", canvas), losslessImage.subarray(0, -4))],
  [
    "header masquerading as data",
    extendedImage(chunk("VP8X", canvas), chunk("VP8L", losslessImage.subarray(8, 13))),
  ],
  ["frame metadata only", animatedWebp(chunk("JUNK", Buffer.alloc(0)))],
  ["frame with truncated image", animatedWebp(losslessImage.subarray(0, -4))],
] as const)("rejects an extended WebP with %s", async (_kind, bytes) => {
  await expect(resolveWebp(bytes)).rejects.toThrow("Invalid topic image contents.");
});
