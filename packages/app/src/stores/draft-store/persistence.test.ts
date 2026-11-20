import { describe, expect, it } from "vitest";
import type { PersistStorage, StorageValue } from "zustand/middleware";
import {
  createDraftPersistStorage,
  DRAFT_PERSIST_INTERVAL_MS,
  type PersistenceScheduler,
} from "./persistence";
import { createQuoteAwareDraftStorage } from "./quote-persistence";

const key = "paseo-drafts";
const quotesKey = "paseo-drafts-quotes";
const quote = { kind: "quote", id: "q1", text: "Selected text" } as const;
const file = {
  kind: "workspace_file",
  path: "README.md",
  selection: { kind: "whole_file" },
} as const;
const draft = {
  input: { text: "Keep this", attachments: [quote, file] },
  lifecycle: "active",
  updatedAt: 100,
  version: 3,
} as const;
const storedDraft = { ...draft, input: { ...draft.input, attachments: [quote, file] } };
const other = { ...draft, input: { text: "Other draft", attachments: [] } };
const snapshot = {
  state: { drafts: { selected: storedDraft, other }, createModalDraft: storedDraft },
  version: 5,
};
const baseDraft = { ...draft, input: { ...draft.input, attachments: [file] } };
const baseSnapshot = {
  state: { drafts: { selected: baseDraft, other }, createModalDraft: baseDraft },
  version: 5,
};

function quoteStorageFixture() {
  const entries = new Map<string, string>();
  const backing = {
    getItem: (name: string) => entries.get(name) ?? null,
    setItem: (name: string, value: string) => void entries.set(name, value),
    removeItem: (name: string) => void entries.delete(name),
  };
  return { backing, storage: createQuoteAwareDraftStorage(backing) };
}

describe("draft quote persistence", () => {
  it("keeps the original storage key in the old shape and restores attachment order in both drafts", async () => {
    const { backing, storage } = quoteStorageFixture();
    await storage.setItem(key, snapshot);
    expect(JSON.parse(backing.getItem(key)!)).toEqual(baseSnapshot);
    expect(await storage.getItem(key)).toEqual(snapshot);
  });

  it("reads the baseline without quote data and repairs drafts from builds that saved quotes inline", async () => {
    const { backing, storage } = quoteStorageFixture();
    backing.setItem(key, JSON.stringify(baseSnapshot));
    expect(await storage.getItem(key)).toEqual(baseSnapshot);
    backing.setItem(key, JSON.stringify(snapshot));
    expect(await storage.getItem(key)).toEqual(snapshot);
    expect(JSON.parse(backing.getItem(key)!)).toEqual(baseSnapshot);
    expect(await storage.getItem(key)).toEqual(snapshot);
  });

  it("does not restore stale quotes after an older app edits the draft or drop drafts if quote data is corrupt", async () => {
    const { backing, storage } = quoteStorageFixture();
    await storage.setItem(key, snapshot);
    const edited = {
      ...baseDraft,
      version: 4,
      input: { ...baseDraft.input, text: "Old app edit" },
    };
    const editedBase = {
      ...baseSnapshot,
      state: { ...baseSnapshot.state, drafts: { selected: edited, other } },
    };
    backing.setItem(key, JSON.stringify(editedBase));
    expect(await storage.getItem(key)).toEqual({
      ...editedBase,
      state: { ...editedBase.state, createModalDraft: storedDraft },
    });
    backing.setItem(quotesKey, "invalid JSON");
    expect(await storage.getItem(key)).toEqual(editedBase);
  });

  it.each([true, false])(
    "restores the last committed quotes when the body write fails (new quotes: %s)",
    async (hasNewQuote) => {
      const { backing, storage } = quoteStorageFixture();
      await storage.setItem(key, snapshot);
      let failBody = true;
      const interrupted = createQuoteAwareDraftStorage({
        ...backing,
        setItem: (name, value) => {
          if (name === key && failBody) throw new Error("body write interrupted");
          backing.setItem(name, value);
        },
      });
      const nextQuote = { ...quote, id: "q2", text: "New selection" };
      const next = {
        ...snapshot,
        state: {
          drafts: {
            selected: {
              ...storedDraft,
              version: 4,
              updatedAt: 200,
              input: { text: "New body", attachments: hasNewQuote ? [file, nextQuote] : [file] },
            },
            other,
          },
          createModalDraft: null,
        },
      };

      await expect(interrupted.setItem(key, next)).rejects.toThrow("body write interrupted");
      expect(await createQuoteAwareDraftStorage(backing).getItem(key)).toEqual(snapshot);

      // Simulate another interrupted write after restart, then a successful retry.
      await expect(
        createQuoteAwareDraftStorage({
          ...backing,
          setItem: (name, value) => {
            if (name === key) throw new Error("second body write interrupted");
            backing.setItem(name, value);
          },
        }).setItem(key, next),
      ).rejects.toThrow("second body write interrupted");
      expect(await createQuoteAwareDraftStorage(backing).getItem(key)).toEqual(snapshot);
      failBody = false;
      await interrupted.setItem(key, next);
      expect(await createQuoteAwareDraftStorage(backing).getItem(key)).toEqual(next);
    },
  );

  it("does not apply pending quotes to a quote-less body that reused the same revision", async () => {
    const { backing } = quoteStorageFixture();
    const previous = {
      ...baseSnapshot,
      state: { drafts: { selected: baseDraft }, createModalDraft: null },
    };
    backing.setItem(key, JSON.stringify(previous));
    const interrupted = createQuoteAwareDraftStorage({
      ...backing,
      setItem: (name, value) => {
        if (name === key) throw new Error("body write interrupted");
        backing.setItem(name, value);
      },
    });
    await expect(interrupted.setItem(key, snapshot)).rejects.toThrow("body write interrupted");
    expect(await createQuoteAwareDraftStorage(backing).getItem(key)).toEqual(previous);
  });

  it("keeps the committed snapshot if the old quote journal cannot be read", async () => {
    const { backing, storage } = quoteStorageFixture();
    await storage.setItem(key, snapshot);
    const unreadable = createQuoteAwareDraftStorage({
      ...backing,
      getItem: (name) => {
        if (name === quotesKey) throw new Error("Quote read interrupted");
        return backing.getItem(name);
      },
    });

    await expect(unreadable.setItem(key, baseSnapshot)).rejects.toThrow("Quote read interrupted");
    expect(await createQuoteAwareDraftStorage(backing).getItem(key)).toEqual(snapshot);
  });

  it("loads the new quote version when the body committed but journal cleanup failed", async () => {
    const { backing, storage } = quoteStorageFixture();
    await storage.setItem(key, snapshot);
    let quoteWrites = 0;
    const interrupted = createQuoteAwareDraftStorage({
      ...backing,
      setItem: (name, value) => {
        if (name === quotesKey && ++quoteWrites === 2) throw new Error("cleanup interrupted");
        backing.setItem(name, value);
      },
    });
    const nextRecord = {
      ...storedDraft,
      version: 4,
      input: { text: "New body", attachments: [{ ...quote, text: "New selection" }] },
    };
    const next = {
      ...snapshot,
      state: { drafts: { selected: nextRecord, other }, createModalDraft: null },
    };
    await interrupted.setItem(key, next);
    expect(await storage.getItem(key)).toEqual(next);
    expect(quoteWrites).toBe(2);
  });

  it("still saves draft text and other attachments when the quote key cannot be written", async () => {
    const { backing } = quoteStorageFixture();
    const storage = createQuoteAwareDraftStorage({
      ...backing,
      setItem: (name, value) => {
        if (name === quotesKey) throw new Error("quote storage quota exceeded");
        backing.setItem(name, value);
      },
    });

    await storage.setItem(key, snapshot);
    expect(await storage.getItem(key)).toEqual(baseSnapshot);

    backing.setItem(key, JSON.stringify(snapshot));
    expect(await storage.getItem(key)).toEqual(snapshot);
    expect(JSON.parse(backing.getItem(key)!)).toEqual(snapshot);
  });

  it("still saves draft text when removal of the previous quote key fails", async () => {
    const { backing, storage } = quoteStorageFixture();
    await storage.setItem(key, snapshot);
    const unableToRemoveQuotes = createQuoteAwareDraftStorage({
      ...backing,
      removeItem: (name) => {
        if (name === quotesKey) throw new Error("quote storage unavailable");
        backing.removeItem(name);
      },
    });
    const edited = { ...baseDraft, version: 4, input: { ...baseDraft.input, text: "After quote" } };
    const editedBase = {
      ...baseSnapshot,
      state: { drafts: { selected: edited, other }, createModalDraft: null },
    };

    await unableToRemoveQuotes.setItem(key, editedBase);
    expect(await storage.getItem(key)).toEqual(editedBase);
  });
});

interface DraftState {
  text: string;
}

function createDraftPersistence() {
  let nowMs = 0;
  let saved: StorageValue<DraftState> | null = null;
  let scheduled: { callback: () => void; dueAt: number } | null = null;
  const storage: PersistStorage<DraftState> = {
    getItem: () => saved,
    setItem: (_name, value) => {
      saved = value;
    },
    removeItem: () => {
      saved = null;
    },
  };
  const scheduler: PersistenceScheduler = {
    now: () => nowMs,
    schedule: (callback, delayMs) => (scheduled = { callback, dueAt: nowMs + delayMs }),
    cancel: () => {
      scheduled = null;
    },
  };
  const drafts = createDraftPersistStorage(storage, scheduler);

  return {
    save(text: string) {
      drafts.setItem("drafts", { state: { text } });
    },
    remove() {
      drafts.removeItem("drafts");
    },
    flush() {
      return drafts.flush();
    },
    advance(ms: number) {
      nowMs += ms;
      if (scheduled && scheduled.dueAt <= nowMs) {
        const { callback } = scheduled;
        scheduled = null;
        callback();
      }
    },
    text() {
      return saved?.state.text ?? null;
    },
  };
}

describe("draft persistence", () => {
  it("checkpoints the first change and the latest change in each interval", () => {
    const drafts = createDraftPersistence();

    drafts.save("a");
    drafts.save("ab");
    drafts.save("abc");
    expect(drafts.text()).toBe("a");

    drafts.advance(DRAFT_PERSIST_INTERVAL_MS - 1);
    expect(drafts.text()).toBe("a");

    drafts.advance(1);
    expect(drafts.text()).toBe("abc");
  });

  it("does not restore a pending draft after storage is cleared", () => {
    const drafts = createDraftPersistence();

    drafts.save("first checkpoint");
    drafts.save("pending checkpoint");
    drafts.remove();
    drafts.advance(DRAFT_PERSIST_INTERVAL_MS);

    expect(drafts.text()).toBeNull();
  });

  it("continues checkpointing the latest change across consecutive intervals", () => {
    const drafts = createDraftPersistence();

    drafts.save("first");
    drafts.save("first interval");
    drafts.advance(DRAFT_PERSIST_INTERVAL_MS);
    expect(drafts.text()).toBe("first interval");

    drafts.save("second");
    drafts.save("second interval");
    drafts.advance(DRAFT_PERSIST_INTERVAL_MS);
    expect(drafts.text()).toBe("second interval");
  });

  it("flushes the latest pending change before the interval ends", async () => {
    const drafts = createDraftPersistence();

    drafts.save("first checkpoint");
    drafts.save("pending checkpoint");
    await drafts.flush();

    expect(drafts.text()).toBe("pending checkpoint");
  });

  it("waits for an in-progress checkpoint and drains changes queued during flush", async () => {
    const writes: string[] = [];
    const writeStarts = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    const writeFinishes = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    const storage = createDraftPersistStorage<DraftState>({
      getItem: () => null,
      setItem: (_name, { state }) => {
        const position = writes.length;
        writes.push(state.text);
        writeStarts[position]?.resolve();
        return writeFinishes[position]?.promise;
      },
      removeItem: () => {},
    });
    storage.setItem("drafts", { state: { text: "first" } });
    let flushed = false;
    const flush = storage.flush().then(() => (flushed = true));
    await Promise.resolve();
    expect(flushed).toBe(false);

    storage.setItem("drafts", { state: { text: "pending" } });
    storage.setItem("drafts", { state: { text: "latest" } });
    expect(writes).toEqual(["first"]);
    writeFinishes[0]?.resolve();
    await writeStarts[1]?.promise;
    expect(writes).toEqual(["first", "latest"]);
    expect(flushed).toBe(false);

    writeFinishes[1]?.resolve();
    await flush;
    expect(flushed).toBe(true);
  });
});
