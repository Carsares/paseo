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
  latestRequest: z.number().int().nonnegative().default(0),
  confirmedRequest: z.number().int().nonnegative().default(0),
});

type LocalViewedRecord = z.infer<typeof LocalViewedRecord>;
type ReviewTransaction = <T>(
  key: string,
  operation: (record: LocalViewedRecord | null, save: (record: LocalViewedRecord) => void) => T,
) => Promise<T>;

export interface LocalReviewRequest {
  identity: ReviewIdentity;
  sequence: number;
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
          const saved = request.result ?? window.localStorage.getItem(key);
          const result = operation(parseRecord(saved), (record) => {
            store.put(JSON.stringify(record), key);
          });
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
  return {
    begin(identity: ReviewIdentity): Promise<LocalReviewRequest> {
      return transaction(reviewKey(identity), (stored, save) => {
        const record = stored ?? {
          headSha: "",
          paths: [],
          revision: 0,
          latestRequest: 0,
          confirmedRequest: 0,
        };
        const sequence = Math.max(record.latestRequest, record.revision) + 1;
        save({ ...record, latestRequest: sequence });
        return { identity, sequence };
      });
    },
    load(head: LocalReviewHead, signal: AbortSignal): Promise<ReviewViewed> {
      return transaction(reviewKey(head.request.identity), (record) => {
        signal.throwIfAborted();
        if (record?.headSha !== head.headSha || record.revision !== head.revision) {
          throw { code: "stale" };
        }
        return viewedEntries(record);
      });
    },
    confirmHead(
      request: LocalReviewRequest,
      headSha: string,
      signal: AbortSignal,
    ): Promise<{ head: LocalReviewHead; viewed: ReviewViewed }> {
      return transaction(reviewKey(request.identity), (stored, save) => {
        signal.throwIfAborted();
        // An older reply may share the current head, but cannot change it or cross a head rotation.
        if (
          !stored ||
          request.sequence < stored.revision ||
          (stored.headSha !== headSha && request.sequence < stored.confirmedRequest)
        ) {
          throw { code: "stale" };
        }
        const confirmedRequest = Math.max(stored.confirmedRequest, request.sequence);
        const record =
          stored.headSha === headSha
            ? { ...stored, confirmedRequest }
            : { ...stored, headSha, paths: [], revision: request.sequence, confirmedRequest };
        if (record.revision !== stored.revision || confirmedRequest !== stored.confirmedRequest) {
          save(record);
        }
        return {
          head: { request, headSha, revision: record.revision },
          viewed: viewedEntries(record),
        };
      });
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
