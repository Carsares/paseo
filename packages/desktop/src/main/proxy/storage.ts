import { randomUUID } from "node:crypto";
import { open, readFile, rename, unlink } from "node:fs/promises";
import type { SafeStorage } from "electron";
import { z } from "zod";
import { desktopProxyPolicy, desktopProxyScope, proxyUrl } from "./policy.js";

const credentials = z.strictObject({
  username: z.string().min(1).max(4096),
  password: z.string().max(4096),
});

const credentialInput = z
  .strictObject({
    username: z
      .string()
      .max(1024)
      .refine((value) => !/[:\p{Cc}]/u.test(value)),
    password: z
      .string()
      .max(1024)
      .refine((value) => !/\p{Cc}/u.test(value)),
  })
  .refine(({ username, password }) => Boolean(username || password));
const readableCredentials = z.union([credentialInput, credentials]);

const legacyChange = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("keep") }),
  z.strictObject({ action: z.literal("clear"), proxyUrl }),
  z.strictObject({ action: z.literal("replace"), proxyUrl, credentials: credentialInput }),
]);

const slotChange = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("keep") }),
  z.strictObject({ action: z.literal("clear") }),
  z.strictObject({ action: z.literal("replace"), credential: credentialInput }),
]);

export const desktopSlotChanges = z.strictObject({
  unified: slotChange.optional(),
  http: slotChange.optional(),
  https: slotChange.optional(),
});
export const desktopCredentialChanges = z.union([desktopSlotChanges, legacyChange]);
export type ProxyCredentialChange = z.infer<typeof slotChange>;

const storedScope = z.strictObject({
  policy: desktopProxyPolicy,
  credentials: z.array(
    z.strictObject({
      proxyUrl,
      encrypted: z
        .string()
        .min(1)
        .max(100_000)
        .regex(/^[A-Za-z0-9+/]+={0,2}$/),
    }),
  ),
});

export const proxyRevision = z.number().int().nonnegative();

const storedSettings = z.strictObject({
  version: z.literal(1),
  revision: proxyRevision.optional(),
  scopes: z.partialRecord(desktopProxyScope, storedScope),
});

export type StoredProxyScope = z.infer<typeof storedScope>;
export type StoredProxySettings = z.infer<typeof storedSettings>;

export interface DesktopProxyStore {
  load(): Promise<StoredProxySettings>;
  save(settings: StoredProxySettings): Promise<void>;
}

export function proxyStore(filePath: string): DesktopProxyStore {
  return {
    async load() {
      try {
        const raw = await readFile(filePath, "utf8");
        const parsed = storedSettings.safeParse(JSON.parse(raw));
        if (parsed.success) return parsed.data;
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
          return { version: 1, scopes: {} };
        }
      }
      throw new Error("Could not read desktop proxy settings.");
    },
    async save(settings) {
      const temporary = `${filePath}.${randomUUID()}.tmp`;
      let created = false;
      try {
        const file = await open(temporary, "wx", 0o600);
        created = true;
        try {
          await file.writeFile(JSON.stringify(settings));
          await file.sync();
        } finally {
          await file.close();
        }
        await rename(temporary, filePath);
      } catch {
        if (created) await unlink(temporary).catch(() => undefined);
        throw new Error("Could not save desktop proxy settings.");
      }
    },
  };
}

export interface ProxyVault {
  seal(value: z.infer<typeof credentialInput>): string;
  open(value: string): z.infer<typeof readableCredentials>;
}

type KeyStore = Pick<
  SafeStorage,
  "isEncryptionAvailable" | "getSelectedStorageBackend" | "encryptString" | "decryptString"
>;

export function proxyVault(storage: KeyStore, platform: NodeJS.Platform): ProxyVault {
  function requireEncryption() {
    const available = storage.isEncryptionAvailable();
    if (available && platform !== "linux") return;
    if (available && platform === "linux") {
      const backend = storage.getSelectedStorageBackend();
      if (backend !== "basic_text" && backend !== "unknown") return;
    }
    throw new Error("Secure proxy credential storage is unavailable.");
  }

  return {
    seal(value) {
      requireEncryption();
      const plaintext = JSON.stringify(value);
      try {
        const encrypted = storage.encryptString(plaintext);
        if (encrypted.length > 0 && storage.decryptString(encrypted) === plaintext) {
          return encrypted.toString("base64");
        }
      } catch {
        // Native key store errors may contain the rejected input.
      }
      throw new Error("Could not verify secure proxy credential storage.");
    },
    open(value) {
      requireEncryption();
      try {
        const plaintext = storage.decryptString(Buffer.from(value, "base64"));
        const parsed = readableCredentials.safeParse(JSON.parse(plaintext));
        if (parsed.success) return parsed.data;
      } catch {
        // The stored payload and decryption errors must stay in the main process.
      }
      throw new Error("Could not open stored proxy credentials.");
    },
  };
}
