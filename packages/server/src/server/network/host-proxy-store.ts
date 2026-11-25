import { randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, mkdir, open, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { EncryptedProxyCredentialStore } from "./proxy-credential-store.js";
import {
  HostProxyRuntime,
  ProxyCommitUncertainError,
  type HostProxySettingsStore,
  type StoredHostProxySettings,
} from "./proxy-runtime.js";
import { parseHostProxySettings } from "./proxy-settings.js";

const row = z.object({ settings: z.unknown(), credentialId: z.uuid().optional() });
const record = z.object({
  revision: z.number().int().positive(),
  current: row,
  previous: row.optional(),
  retiredCredentialIds: z.array(z.uuid()).optional(),
});

function hasCode(error: unknown, code: string) {
  return (error as NodeJS.ErrnoException).code === code;
}

async function readPrivate(directory: string, filename: string, maxBytes: number) {
  const file = await open(join(directory, filename), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (
      !info.isFile() ||
      info.size > maxBytes ||
      (process.platform !== "win32" &&
        ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()))
    ) {
      throw new Error("Unsafe host proxy file");
    }
    return await file.readFile();
  } finally {
    await file.close();
  }
}

async function publishExclusive(
  directory: string,
  name: string,
  contents: Uint8Array | string,
  canCommit?: () => boolean,
) {
  const temporary = join(directory, `.pending-${randomUUID()}`);
  const file = await open(temporary, "wx", 0o600);
  try {
    try {
      await file.writeFile(contents);
      await file.sync();
    } finally {
      await file.close();
    }
    if (canCommit && !canCommit()) throw new Error("Proxy source no longer authorized");
    try {
      await link(temporary, join(directory, name));
    } catch (error) {
      if (hasCode(error, "EEXIST")) return false;
      throw error;
    }
    if (process.platform !== "win32") {
      try {
        const handle = await open(directory, "r");
        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
      } catch {
        throw new ProxyCommitUncertainError("Could not confirm host proxy publication");
      }
    }
    return true;
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

export class FileHostProxySettingsStore implements HostProxySettingsStore {
  constructor(private readonly directory: string) {}

  async load(): Promise<StoredHostProxySettings | undefined> {
    let latest = 0;
    for (const name of await readdir(this.directory)) {
      const match = /^revision-([1-9]\d*)\.json$/.exec(name);
      if (match) latest = Math.max(latest, Number(match[1]));
    }
    if (!latest) return undefined;
    if (!Number.isSafeInteger(latest)) throw new Error("Invalid stored host proxy revision");
    const bytes = await readPrivate(this.directory, `revision-${latest}.json`, 512_000);
    const stored = record.parse(JSON.parse(bytes.toString("utf8")));
    if (latest !== stored.revision) throw new Error("Invalid stored host proxy revision");
    const entry = (value: z.infer<typeof row>) => ({
      settings: parseHostProxySettings(value.settings),
      credentialId: value.credentialId,
    });
    return {
      ...stored,
      current: entry(stored.current),
      previous: stored.previous && entry(stored.previous),
    };
  }

  async compareAndSet(
    expectedRevision: number,
    next: StoredHostProxySettings,
    canCommit?: () => boolean,
  ): Promise<boolean> {
    if (next.revision !== expectedRevision + 1 || !Number.isSafeInteger(next.revision)) {
      throw new Error("Invalid host proxy revision");
    }
    if (((await this.load())?.revision ?? 0) === expectedRevision) {
      // The destination is unique for this revision. A competing publisher cannot replace it.
      return publishExclusive(
        this.directory,
        `revision-${next.revision}.json`,
        JSON.stringify(next),
        canCommit,
      );
    }
    return false;
  }
}

export async function openStoredHostProxy(
  home: string,
  trustedLanOrigins: () => readonly string[],
) {
  const directory = join(home, "outbound-proxy");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const handle = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW).catch(
    (error: unknown) => {
      if (process.platform === "win32" && hasCode(error, "EISDIR")) return undefined;
      throw error;
    },
  );
  if (handle) {
    try {
      const info = await handle.stat();
      if (
        !info.isDirectory() ||
        (process.platform !== "win32" &&
          ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()))
      ) {
        throw new Error("Unsafe outbound proxy directory");
      }
    } finally {
      await handle.close();
    }
  }
  const keyName = "credential.key";
  let key = await readPrivate(directory, keyName, 32).catch((error: unknown) => {
    if (hasCode(error, "ENOENT")) return undefined;
    throw error;
  });
  if (!key) {
    // A missing key with persisted settings must be recovered by the owner.
    const settings = await new FileHostProxySettingsStore(directory).load();
    if (settings?.current.credentialId || settings?.previous?.credentialId)
      throw new Error("Missing host proxy credential key");
    const generated = randomBytes(32);
    try {
      await publishExclusive(directory, keyName, generated);
    } finally {
      generated.fill(0);
    }
    key = await readPrivate(directory, keyName, 32);
  }
  if (key.length !== 32) throw new Error("Invalid host proxy credential key");
  const secret = key;
  try {
    const runtime = await HostProxyRuntime.open({
      settings: new FileHostProxySettingsStore(directory),
      credentials: new EncryptedProxyCredentialStore(
        join(directory, "credentials"),
        async () => secret,
      ),
      trustedLanOrigins,
    });
    return {
      runtime,
      close: async () => {
        try {
          await runtime.close();
        } finally {
          secret.fill(0);
        }
      },
    };
  } catch (error) {
    secret.fill(0);
    throw error;
  }
}
