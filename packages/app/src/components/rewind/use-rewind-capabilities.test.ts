import { describe, expect, test } from "vitest";

import { resolveRewindMenuItems } from "./use-rewind-capabilities";

describe("resolveRewindMenuItems", () => {
  test("returns no items when the provider declares no rewind capability", () => {
    expect(
      resolveRewindMenuItems({
        supportsRewindConversation: false,
        supportsRewindFiles: false,
        supportsRewindBoth: false,
      }),
    ).toEqual([]);
  });

  test("provider file capabilities cannot open a file rewind", () => {
    expect(
      resolveRewindMenuItems({
        supportsRewindConversation: true,
        supportsRewindFiles: true,
        supportsRewindBoth: true,
      }),
    ).toEqual([
      {
        mode: "conversation",
        label: "Rewind conversation",
        testID: "rewind-menu-conversation",
      },
    ]);
  });

  test("offers file and combined actions for an eligible checkpoint and a chat-capable provider", () => {
    expect(
      resolveRewindMenuItems(
        {
          supportsRewindConversation: true,
          supportsRewindFiles: false,
          supportsRewindBoth: false,
        },
        { canRewindFiles: true, canRewindBoth: true },
        {
          conversation: "Conversation label",
          files: "Files label",
          both: "Both label",
        },
      ).map((item) => item.label),
    ).toEqual(["Conversation label", "Files label", "Both label"]);
  });

  test("offers file-only rewind when the provider cannot rewind chat", () => {
    expect(
      resolveRewindMenuItems(
        { supportsRewindBoth: true },
        { canRewindFiles: true, canRewindBoth: true },
      ).map((item) => item.mode),
    ).toEqual(["files"]);
  });

  test("file eligibility does not imply combined eligibility", () => {
    expect(
      resolveRewindMenuItems(
        { supportsRewindConversation: true },
        { canRewindFiles: true, canRewindBoth: false },
      ).map((item) => item.mode),
    ).toEqual(["conversation", "files"]);
  });
});
