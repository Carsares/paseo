import { describe, expect, it } from "vitest";
import { getBuiltInLaunchOrder } from "./catalog";

describe("getBuiltInLaunchOrder", () => {
  it("leads with creating work in a primary pane", () => {
    expect(getBuiltInLaunchOrder("primary")).toEqual([
      "agent",
      "terminal",
      "changes",
      "diff",
      "files",
      "browser",
      "pullRequest",
    ]);
  });

  it("leads with companion tools in a supporting pane", () => {
    expect(getBuiltInLaunchOrder("supporting")).toEqual([
      "changes",
      "terminal",
      "diff",
      "files",
      "agent",
      "browser",
      "pullRequest",
    ]);
  });

  it("offers a standalone session directly after the default agent when a Main Tab exists", () => {
    expect(getBuiltInLaunchOrder("primary", true).slice(0, 3)).toEqual([
      "agent",
      "standalone-agent",
      "terminal",
    ]);
  });
});
