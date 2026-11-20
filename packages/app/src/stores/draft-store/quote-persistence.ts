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
type QuoteSnapshot = z.infer<typeof QuoteSnapshotSchema>;
type QuoteState = z.infer<typeof QuoteStateSchema>;

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
  const quoteStorage = createValidatedPersistStorage(backing, QuoteStateSchema);
  const reading = new Set<string>();
  const quoteKey = (name: string) => `${name}-quotes`;

  async function write(
    name: string,
    value: StorageValue<PersistedDraftStore>,
    migratingInlineQuotes = false,
  ): Promise<void> {
    const drafts = new Map<string, QuoteSnapshot>();
    let createModalDraft: QuoteSnapshot | null = null;
    const state = mapDraftRecords(value.state, (record, key) => {
      const attachments = getDraftInput(record).attachments ?? [];
      const entries = attachments.flatMap((attachment, position) =>
        attachment.kind === "quote" ? [{ position, attachment }] : [],
      );
      if (!entries.length) return record;
      const snapshot = { updatedAt: record.updatedAt, version: record.version, entries };
      if (key === null) createModalDraft = snapshot;
      else drafts.set(key, snapshot);
      return withAttachments(
        record,
        attachments.filter((attachment) => attachment.kind !== "quote"),
      );
    });
    const quotes: QuoteState = { drafts: Object.fromEntries(drafts), createModalDraft };
    try {
      if (drafts.size || createModalDraft) {
        await quoteStorage.setItem(quoteKey(name), { state: quotes });
      } else {
        await quoteStorage.removeItem(quoteKey(name));
      }
    } catch (error) {
      // During migration the base key still holds the only saved copy of the quotes.
      if (migratingInlineQuotes) throw error;
      console.warn("[DraftStore] Failed to persist draft quotes", error);
    }
    await baseStorage.setItem(name, { ...value, state });
  }

  return {
    getItem: async (name) => {
      reading.add(name);
      try {
        const base = await baseStorage.getItem(name);
        if (!base) return null;
        let quotes: StorageValue<QuoteState> | null = null;
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
          const snapshot =
            key === null ? quotes?.state.createModalDraft : quotes?.state.drafts[key];
          // An older app can edit or clear this draft while the quotes key is still present.
          if (
            !snapshot ||
            snapshot.version !== record.version ||
            snapshot.updatedAt !== record.updatedAt
          ) {
            return record;
          }
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
