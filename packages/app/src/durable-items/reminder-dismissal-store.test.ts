import { expect, it } from "vitest";
import { durableItemKey } from "./model";
import { createReminderDismissalStore } from "./reminder-dismissal-store";

it("restores the highest dismissed revision independently for each reminder address", async () => {
  let stored: string | null = null;
  const backingStorage = {
    getItem: async () => stored,
    setItem: async (_key: string, value: string) => {
      stored = value;
    },
    removeItem: async () => {
      stored = null;
    },
  };
  const address = { serverId: "host-a", workspaceId: "workspace-a", requestId: "request-a" };
  const key = durableItemKey(address);
  const otherWorkspace = durableItemKey({ ...address, workspaceId: "workspace-b" });
  const first = createReminderDismissalStore(backingStorage);
  expect(first.getState().revisions).toBeNull();
  await first.persist.rehydrate();
  first.getState().dismiss(key, 3);
  first.getState().dismiss(key, 2);
  first.getState().dismiss(otherWorkspace, 0);
  expect(first.getState().revisions).toEqual({ [key]: 3, [otherWorkspace]: 0 });

  const restarted = createReminderDismissalStore(backingStorage);
  await restarted.persist.rehydrate();
  expect(restarted.getState().revisions).toEqual({ [key]: 3, [otherWorkspace]: 0 });
  expect(
    restarted.getState().revisions?.[durableItemKey({ ...address, serverId: "host-b" })],
  ).toBeUndefined();
  expect(
    restarted.getState().revisions?.[durableItemKey({ ...address, requestId: "request-b" })],
  ).toBeUndefined();
});
