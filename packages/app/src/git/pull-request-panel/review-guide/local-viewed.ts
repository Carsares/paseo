import AsyncStorage from "@react-native-async-storage/async-storage";
import { z } from "zod";
import {
  reviewIdentityKey,
  type ReviewIdentity,
  type ReviewViewed,
  type ReviewViewedEntry,
} from "./port";

const LocalViewedRecord = z.object({ headSha: z.string(), paths: z.array(z.string()) });

export function createLocalReviewViewed(storage: Pick<typeof AsyncStorage, "getItem" | "setItem">) {
  const pending = new Map<string, Promise<unknown>>();

  function forReview<T>(
    identity: ReviewIdentity,
    operation: (key: string) => Promise<T>,
  ): Promise<T> {
    const key = `paseo:review-viewed:${reviewIdentityKey(identity)}`;
    const result = (pending.get(key) ?? Promise.resolve()).then(() => operation(key));
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
  }

  async function read(key: string) {
    const stored = await storage.getItem(key);
    return stored ? LocalViewedRecord.parse(JSON.parse(stored)) : null;
  }

  return {
    load(identity: ReviewIdentity, headSha: string, signal: AbortSignal): Promise<ReviewViewed> {
      return forReview(identity, async (key) => {
        signal.throwIfAborted();
        const record = await read(key);
        signal.throwIfAborted();
        if (record?.headSha !== headSha) {
          await storage.setItem(key, JSON.stringify({ headSha, paths: [] }));
          return { entries: [] };
        }
        return { entries: record.paths.map((path) => ({ path, state: "viewed" })) };
      });
    },
    set(
      identity: ReviewIdentity,
      headSha: string,
      path: string,
      viewed: boolean,
    ): Promise<ReviewViewedEntry> {
      return forReview(identity, async (key) => {
        const record = await read(key);
        if (record?.headSha !== headSha) throw { code: "stale" };
        const paths = new Set(record.paths);
        if (viewed) paths.add(path);
        else paths.delete(path);
        await storage.setItem(key, JSON.stringify({ headSha, paths: [...paths] }));
        return { path, state: viewed ? "viewed" : "unviewed" };
      });
    },
  };
}

export const localReviewViewed = createLocalReviewViewed(AsyncStorage);
