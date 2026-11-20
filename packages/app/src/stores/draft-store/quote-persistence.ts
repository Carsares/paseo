import { z } from "zod";
import type { PersistStorage, StateStorage, StorageValue } from "zustand/middleware";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";
import {
  PersistedDraftStoreSchema,
  type PersistedDraftRecord,
  type PersistedDraftStore,
} from "./migration";
import { QuoteComposerAttachmentSchema } from "./state";

const QuoteSnapshotSchema = z.strictObject({
  updatedAt: z.number().optional(),
  version: z.number().int().positive().optional(),
  entries: z.array(
    z.strictObject({
      position: z.number().int().nonnegative(),
      attachment: QuoteComposerAttachmentSchema,
    }),
  ),
});
const QuoteStateSchema = z.strictObject({
  drafts: z.record(z.string(), QuoteSnapshotSchema),
  createModalDraft: QuoteSnapshotSchema.nullable(),
});
// The original single-snapshot shape is also the steady state after a commit.
const QuoteJournalSchema = QuoteStateSchema.extend({ pending: QuoteStateSchema.optional() });

type QuoteSnapshot = z.infer<typeof QuoteSnapshotSchema>;
type QuoteState = z.infer<typeof QuoteStateSchema>;
type QuoteJournal = z.infer<typeof QuoteJournalSchema>;

function matchesRecord(snapshot: QuoteSnapshot | undefined, record: PersistedDraftRecord) {
  return snapshot?.version === record.version && snapshot?.updatedAt === record.updatedAt;
}

function findQuoteSnapshot(
  quotes: QuoteJournal | undefined,
  record: PersistedDraftRecord,
  key: string | null,
): QuoteSnapshot | undefined {
  const lookup = (state: QuoteState | undefined) =>
    key === null ? (state?.createModalDraft ?? undefined) : state?.drafts[key];
  const pending = lookup(quotes?.pending);
  if (pending && matchesRecord(pending, record)) return pending;
  const previous = lookup(quotes);
  return previous && matchesRecord(previous, record) ? previous : undefined;
}

function getDraftInput(record: PersistedDraftRecord) {
  return "input" in record ? record.input : record;
}

function withAttachments(
  record: PersistedDraftRecord,
  attachments: NonNullable<ReturnType<typeof getDraftInput>["attachments"]>,
): PersistedDraftRecord {
  return "input" in record
    ? { ...record, input: { ...record.input, attachments } }
    : { ...record, attachments };
}

function mapDraftRecords(
  state: PersistedDraftStore,
  map: (record: PersistedDraftRecord, key: string | null) => PersistedDraftRecord,
): PersistedDraftStore {
  return {
    ...(state.drafts && {
      drafts: Object.fromEntries(
        Object.entries(state.drafts).map(([key, record]) => [key, map(record, key)]),
      ),
    }),
    ...(state.createModalDraft !== undefined && {
      createModalDraft: state.createModalDraft ? map(state.createModalDraft, null) : null,
    }),
  };
}

/** Keep the legacy key readable by versions that reject an unknown attachment kind. */
export function createQuoteAwareDraftStorage(
  backing: StateStorage,
): PersistStorage<PersistedDraftStore> {
  const baseStorage = createValidatedPersistStorage(backing, PersistedDraftStoreSchema);
  const quoteStorage = createValidatedPersistStorage(backing, QuoteJournalSchema);
  const reading = new Set<string>();
  const quoteKey = (name: string) => `${name}-quotes`;

  async function write(
    name: string,
    value: StorageValue<PersistedDraftStore>,
    migratingInlineQuotes = false,
  ): Promise<void> {
    // A failed read cannot tell us which quotes the current body still needs.
    const oldQuotes = await quoteStorage.getItem(quoteKey(name));
    const hasQuotes = [
      ...Object.values(value.state.drafts ?? {}),
      value.state.createModalDraft,
    ].some(
      (record) =>
        record && getDraftInput(record).attachments?.some((item) => item.kind === "quote"),
    );
    const previousBase =
      oldQuotes || hasQuotes ? (await baseStorage.getItem(name))?.state : undefined;
    const previous: QuoteState = { drafts: Object.create(null), createModalDraft: null };
    const next: QuoteState = { drafts: Object.create(null), createModalDraft: null };
    if (previousBase) {
      mapDraftRecords(previousBase, (record, key) => {
        const snapshot = findQuoteSnapshot(oldQuotes?.state, record, key);
        if (snapshot) {
          if (key === null) previous.createModalDraft = snapshot;
          else previous.drafts[key] = snapshot;
        }
        return record;
      });
    }
    const state = mapDraftRecords(value.state, (record, key) => {
      const attachments = getDraftInput(record).attachments ?? [];
      const entries = attachments.flatMap((attachment, position) =>
        attachment.kind === "quote" ? [{ position, attachment }] : [],
      );
      const oldRecord = key === null ? previousBase?.createModalDraft : previousBase?.drafts?.[key];
      // A deleted and recreated draft can reuse its version in the same millisecond.
      // Give those records distinct identities so a failed write can't attach the new quotes to the old body.
      if (
        oldRecord &&
        oldRecord.version === record.version &&
        oldRecord.updatedAt === record.updatedAt &&
        !getDraftInput(oldRecord).attachments?.some((attachment) => attachment.kind === "quote") &&
        JSON.stringify(findQuoteSnapshot(oldQuotes?.state, oldRecord, key)?.entries ?? []) !==
          JSON.stringify(entries)
      ) {
        record = { ...record, version: (record.version ?? 0) + 1 };
      }
      if (!entries.length) return record;
      const snapshot = { updatedAt: record.updatedAt, version: record.version, entries };
      if (key === null) next.createModalDraft = snapshot;
      else next.drafts[key] = snapshot;
      return withAttachments(
        record,
        attachments.filter((attachment) => attachment.kind !== "quote"),
      );
    });
    let journalWritten = false;
    try {
      if (hasQuotes) {
        await quoteStorage.setItem(quoteKey(name), { state: { ...previous, pending: next } });
        journalWritten = true;
      }
    } catch (error) {
      // During migration the base key still holds the only saved copy of the quotes.
      if (migratingInlineQuotes) throw error;
      console.warn("[DraftStore] Failed to persist draft quotes", error);
    }
    await baseStorage.setItem(name, { ...value, state });
    try {
      if (journalWritten) {
        await quoteStorage.setItem(quoteKey(name), { state: next });
      } else if (!hasQuotes && oldQuotes) {
        await quoteStorage.removeItem(quoteKey(name));
      }
    } catch (error) {
      // Both versions are still readable if cleanup fails after committing the body.
      console.warn("[DraftStore] Failed to clean up draft quotes after checkpoint", error);
    }
  }

  return {
    getItem: async (name) => {
      reading.add(name);
      try {
        const base = await baseStorage.getItem(name);
        if (!base) return null;
        let quotes: StorageValue<QuoteJournal> | null = null;
        let couldReadQuotes = true;
        try {
          quotes = await quoteStorage.getItem(quoteKey(name));
        } catch (error) {
          couldReadQuotes = false;
          console.warn("[DraftStore] Failed to read stored quotes", error);
        }
        let hasInlineQuotes = false;
        const state = mapDraftRecords(base.state, (record, key) => {
          const attachments = getDraftInput(record).attachments ?? [];
          // COMPAT(inlineDraftQuotes): added in v0.16.0 for builds that wrote quotes inline.
          // Remove after 2027-05-20 once those development builds are out of use.
          if (attachments.some((attachment) => attachment.kind === "quote")) {
            hasInlineQuotes = true;
            return record;
          }
          // An older app can edit or clear this draft while the quotes key is still present.
          const snapshot = findQuoteSnapshot(quotes?.state, record, key);
          if (!snapshot) return record;
          const restored = [...attachments];
          for (const { position, attachment } of snapshot.entries)
            restored.splice(position, 0, attachment);
          return withAttachments(record, restored);
        });
        const restored = { ...base, state };
        if (hasInlineQuotes && couldReadQuotes) {
          try {
            await write(name, restored, true);
          } catch (error) {
            console.warn("[DraftStore] Failed to move stored quotes to their own key", error);
          }
        }
        return restored;
      } finally {
        reading.delete(name);
      }
    },
    setItem: (name, value) => (reading.has(name) ? undefined : write(name, value)),
    removeItem: async (name) => {
      await baseStorage.removeItem(name);
      await quoteStorage.removeItem(quoteKey(name));
    },
  };
}
