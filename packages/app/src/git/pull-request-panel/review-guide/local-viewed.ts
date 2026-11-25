import AsyncStorage from "@react-native-async-storage/async-storage";
import { z } from "zod";
import { isWeb } from "@/constants/platform";
import {
  reviewIdentityKey,
  type ReviewIdentity,
  type ReviewViewed,
  type ReviewViewedEntry,
} from "./port";

const LocalViewedRecord = z.object({
  headSha: z.string(),
  paths: z.array(z.string()),
  revision: z.number().int().nonnegative().default(0),
});

type LocalViewedRecord = z.infer<typeof LocalViewedRecord>;
type ReviewTransaction = <T>(
  key: string,
  operation: (record: LocalViewedRecord | null, save: (record: LocalViewedRecord) => void) => T,
) => Promise<T>;

export interface LocalReviewRequest {
  identity: ReviewIdentity;
  revision: number;
}

export interface LocalReviewHead {
  request: LocalReviewRequest;
  headSha: string;
  revision: number;
}

function parseRecord(value: string | null): LocalViewedRecord | null {
  return value === null ? null : LocalViewedRecord.parse(JSON.parse(value));
}

function createNativeReviewTransaction(
  storage: Pick<typeof AsyncStorage, "getItem" | "setItem">,
): ReviewTransaction {
  const pending = new Map<string, Promise<unknown>>();
  return (key, operation) => {
    const result = (pending.get(key) ?? Promise.resolve()).then(async () => {
      const record = parseRecord(await storage.getItem(key));
      let updatedRecord: LocalViewedRecord | undefined;
      const value = operation(record, (updated) => {
        updatedRecord = updated;
      });
      if (updatedRecord) await storage.setItem(key, JSON.stringify(updatedRecord));
      return value;
    });
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    pending.set(key, settled);
    void settled.then(() => {
      if (pending.get(key) === settled) pending.delete(key);
      return undefined;
    });
    return result;
  };
}

function createBrowserReviewTransaction(): ReviewTransaction {
  const storeName = "viewed";
  let database: Promise<IDBDatabase> | undefined;
  const open = () => {
    database ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("paseo-review-progress", 1);
      request.addEventListener("upgradeneeded", () => request.result.createObjectStore(storeName));
      request.addEventListener("error", () => reject(request.error));
      request.addEventListener("success", () => resolve(request.result));
    }).catch((error) => {
      database = undefined;
      throw error;
    });
    return database;
  };

  return async (key, operation) => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, "readwrite");
      const store = transaction.objectStore(storeName);
      const request = store.get(key);
      transaction.addEventListener("abort", () => reject(transaction.error));
      request.addEventListener("success", () => {
        try {
          // Older web clients kept progress in AsyncStorage (localStorage).
          const legacy = request.result === undefined ? window.localStorage.getItem(key) : null;
          let updated: LocalViewedRecord | undefined;
          const result = operation(parseRecord(request.result ?? legacy), (record) => {
            updated = record;
          });
          if (updated) store.put(JSON.stringify(updated), key);
          else if (legacy !== null) store.put(legacy, key);
          transaction.addEventListener("complete", () => resolve(result));
        } catch (error) {
          reject(error);
          transaction.abort();
        }
      });
    });
  };
}

function viewedEntries(record: LocalViewedRecord): ReviewViewed {
  return { entries: record.paths.map((path) => ({ path, state: "viewed" })) };
}

function reviewKey(identity: ReviewIdentity): string {
  return `paseo:review-viewed:${reviewIdentityKey(identity)}`;
}

function createReviewViewed(transaction: ReviewTransaction) {
  function begin(identity: ReviewIdentity): Promise<LocalReviewRequest> {
    return transaction(reviewKey(identity), (record) => ({
      identity,
      revision: record?.revision ?? 0,
    }));
  }

  function confirm(
    request: LocalReviewRequest,
    headSha: string,
    signal: AbortSignal,
    verified = false,
  ) {
    type Result = { head: LocalReviewHead; viewed: ReviewViewed } | { retryRevision: number };
    return transaction<Result>(reviewKey(request.identity), (stored, save) => {
      signal.throwIfAborted();
      const revision = stored?.revision ?? 0;
      if (revision !== request.revision) {
        if (verified) throw { code: "stale" };
        return { retryRevision: revision };
      }
      if (!verified && stored?.headSha && stored.headSha !== headSha) {
        return { retryRevision: revision };
      }
      const record =
        stored?.headSha === headSha ? stored : { headSha, paths: [], revision: revision + 1 };
      if (record !== stored) save(record);
      return {
        head: { request, headSha, revision: record.revision },
        viewed: viewedEntries(record),
      };
    });
  }

  return {
    begin,
    load(head: LocalReviewHead, signal: AbortSignal): Promise<ReviewViewed> {
      return transaction(reviewKey(head.request.identity), (record) => {
        signal.throwIfAborted();
        if (record?.headSha !== head.headSha || record.revision !== head.revision) {
          throw { code: "stale" };
        }
        return viewedEntries(record);
      });
    },
    async confirmHead(
      request: LocalReviewRequest,
      headSha: string,
      signal: AbortSignal,
      verifyCurrent: () => Promise<void>,
    ): Promise<{ head: LocalReviewHead; viewed: ReviewViewed }> {
      const first = await confirm(request, headSha, signal);
      if ("head" in first) return first;

      // The guide may have read an older host version even when the local head
      // did not change while it loaded. Confirm it again before any replacement.
      signal.throwIfAborted();
      await verifyCurrent();
      const checked = await confirm(
        { identity: request.identity, revision: first.retryRevision },
        headSha,
        signal,
        true,
      );
      if (!("head" in checked)) throw { code: "stale" };
      return checked;
    },

    set(head: LocalReviewHead, path: string, viewed: boolean): Promise<ReviewViewedEntry> {
      return transaction(reviewKey(head.request.identity), (record, save) => {
        if (record?.headSha !== head.headSha || record.revision !== head.revision) {
          throw { code: "stale" };
        }
        const paths = new Set(record.paths);
        if (viewed) paths.add(path);
        else paths.delete(path);
        save({ ...record, paths: [...paths] });
        return { path, state: viewed ? "viewed" : "unviewed" };
      });
    },
  };
}

export function createLocalReviewViewed(storage: Pick<typeof AsyncStorage, "getItem" | "setItem">) {
  return createReviewViewed(createNativeReviewTransaction(storage));
}

export function createBrowserReviewViewed() {
  return createReviewViewed(createBrowserReviewTransaction());
}

export const localReviewViewed = isWeb
  ? createBrowserReviewViewed()
  : createLocalReviewViewed(AsyncStorage);
