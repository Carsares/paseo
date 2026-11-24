import { expect, test } from "vitest";
import { SessionAuthorization } from "./index.js";

test("workspace deferral and delayed agent messages require their host write permissions", () => {
  const deferral = { type: "workspace.deferral.set.request" } as const;
  const recovery = { type: "agent.limit.recovery.request" } as const;
  const readOnly = new SessionAuthorization(["workspace.read"]);
  const manage = new SessionAuthorization(["workspace.manage"]);
  const write = new SessionAuthorization(["workspace.write"]);
  const hub = new SessionAuthorization(["hub.execute"]);
  expect(readOnly.allowsInbound(deferral)).toBe(false);
  expect(readOnly.allowsInbound(recovery)).toBe(false);
  expect(manage.allowsInbound(deferral)).toBe(true);
  expect(manage.allowsInbound(recovery)).toBe(false);
  expect(write.allowsInbound(recovery)).toBe(true);
  expect(write.allowsInbound(deferral)).toBe(false);
  expect(hub.allowsInbound(recovery)).toBe(false);
});
