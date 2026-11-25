import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { parseProxyCredentials, type ProxyCredentials } from "./proxy-settings.js";

export interface ProxyCredentialStore {
  read(id: string): Promise<ProxyCredentials>;
  /** Write a durable, immutable record under an ID unique across all writers. */
  write(credentials: ProxyCredentials): Promise<string>;
  /** Remove only explicitly named retired or abandoned IDs. Missing IDs are success. */
  remove(id: string): Promise<void>;
}

/** A failed write left a record exclusively owned by this unpublished attempt. */
export class UnpublishedProxyCredentialError extends Error {
  constructor(readonly credentialId: string) {
    super("Could not store encrypted proxy credentials");
  }
}

export class EncryptedProxyCredentialStore implements ProxyCredentialStore {
  constructor(
    private readonly directory: string,
    private readonly getKey: () => Promise<Uint8Array>,
  ) {}

  #path(id: string) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) {
      throw new Error("Invalid proxy credential reference");
    }
    return join(this.directory, `${id}.enc`);
  }

  async read(id: string): Promise<ProxyCredentials> {
    try {
      const bytes = await readFile(this.#path(id));
      if (bytes.length < 30 || bytes.length > 40_000 || bytes[0] !== 1) throw new Error();
      const decipher = createDecipheriv("aes-256-gcm", await this.getKey(), bytes.subarray(1, 13));
      decipher.setAAD(Buffer.from(`paseo.proxy.credentials.v1:${id}`));
      decipher.setAuthTag(bytes.subarray(13, 29));
      const plaintext = Buffer.concat([decipher.update(bytes.subarray(29)), decipher.final()]);
      try {
        return parseProxyCredentials(JSON.parse(plaintext.toString("utf8")));
      } finally {
        plaintext.fill(0);
      }
    } catch {
      throw new Error("Could not read encrypted proxy credentials");
    }
  }

  async write(credentials: ProxyCredentials): Promise<string> {
    const id = randomUUID();
    const pathname = this.#path(id);
    let created = false;
    try {
      const plaintext = Buffer.from(JSON.stringify(parseProxyCredentials(credentials)));
      const iv = randomBytes(12);
      let ciphertext: Buffer;
      try {
        const cipher = createCipheriv("aes-256-gcm", await this.getKey(), iv);
        cipher.setAAD(Buffer.from(`paseo.proxy.credentials.v1:${id}`));
        const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
        ciphertext = Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), data]);
      } finally {
        plaintext.fill(0);
      }
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const file = await open(pathname, "wx", 0o600);
      created = true;
      try {
        await file.writeFile(ciphertext);
        await file.sync();
      } finally {
        await file.close();
      }
      if (process.platform !== "win32") {
        const directory = await open(this.directory, "r");
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      }
      return id;
    } catch {
      if (created) {
        await this.remove(id).catch(() => {
          throw new UnpublishedProxyCredentialError(id);
        });
      }
      throw new Error("Could not store encrypted proxy credentials");
    }
  }

  async remove(id: string): Promise<void> {
    await unlink(this.#path(id)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw new Error("Could not remove encrypted proxy credentials");
    });
  }
}
