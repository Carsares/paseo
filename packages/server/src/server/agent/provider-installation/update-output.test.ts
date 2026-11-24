import { expect, test } from "vitest";
import type { AgentClientUpdateContext } from "../agent-sdk-types.js";
import { createUpdateOutput } from "./update-output.js";

test("reports fixed phases and never emits raw output, even for split and oversized lines", () => {
  const events: Parameters<AgentClientUpdateContext["report"]>[0][] = [];
  const output = createUpdateOutput((event) => events.push(event));
  output.write("down");
  output.write("loading https://test.invalid/private?token=secret\n");
  output.write(`installing ${"x".repeat(7000)}\n`);
  output.write("checking bearer abc\nchecking bearer xyz\n");
  output.write("permission denied at /some/private/path\n");
  output.write("Claude Code is up to date (1.2.3)\n");
  output.end();
  expect(output.currentVersion).toBe("1.2.3");

  expect(events).toEqual([
    { type: "message", text: "Updater is downloading files.\n" },
    { type: "message", text: "Updater is checking for a release.\n" },
    { type: "message", text: "Updater encountered a permission error.\n" },
  ]);
});
