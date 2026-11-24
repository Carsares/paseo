import { expect, test } from "vitest";
import { SessionAuthorization } from "./index.js";

test("a read-only connection can load review data and cannot write to the forge", () => {
  const reader = new SessionAuthorization(["workspace.read"]);
  expect(reader.allowsInbound({ type: "checkout.forge.get_review_guide.request" })).toBe(true);
  expect(reader.allowsInbound({ type: "checkout.forge.get_review_viewed.request" })).toBe(true);
  expect(reader.allowsInbound({ type: "checkout.forge.publish_review_comment.request" })).toBe(
    false,
  );
  expect(reader.allowsInbound({ type: "checkout.forge.set_review_viewed.request" })).toBe(false);

  const writer = new SessionAuthorization(["workspace.read", "workspace.write"]);
  expect(writer.allowsInbound({ type: "checkout.forge.publish_review_comment.request" })).toBe(
    true,
  );
  expect(writer.allowsInbound({ type: "checkout.forge.set_review_viewed.request" })).toBe(true);
});
