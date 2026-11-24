import { describe, expect, test } from "vitest";
import { InstallationActivity } from "./installation-activity.js";

describe("installation activity", () => {
  const claude = { family: "claude", keys: ["file:1", "root:claude"] };
  const alias = { family: "alias", keys: ["file:1"] };
  const sibling = { family: "sibling", keys: ["file:2", "root:claude"] };
  const unrelated = { family: "other", keys: ["file:3", "root:other"] };

  test("aliases and a shared installation root block updates until the agent closes", () => {
    const activity = new InstallationActivity();
    const close = activity.acquireAgent(alias);

    expect(() => activity.acquireUpdate(claude)).toThrow("in use");
    close();

    const update = activity.acquireUpdate(claude);
    expect(() => activity.acquireAgent(alias)).toThrow("being updated");
    expect(() => activity.acquireAgent(sibling)).toThrow("being updated");
    expect(() => activity.acquireUpdate(sibling)).toThrow("already in progress");
    activity.acquireAgent(unrelated)();
    update.release();

    expect(() => activity.acquireAgent(alias)()).not.toThrow();
  });

  test("two acquisitions of the same scope each need their own release", () => {
    const activity = new InstallationActivity();
    const closeFirst = activity.acquireAgent(claude);
    const closeSecond = activity.acquireAgent(claude);
    closeFirst();
    closeFirst();
    expect(() => activity.acquireUpdate(claude)).toThrow("in use");
    closeSecond();
    activity.acquireUpdate(claude).release();
  });

  test("a repeated release does not drop a subsequent update of the same scope", () => {
    const activity = new InstallationActivity();
    const first = activity.acquireUpdate(claude);
    first.release();
    const second = activity.acquireUpdate(claude);
    first.release();
    expect(() => activity.acquireAgent(claude)).toThrow("being updated");
    second.release();
  });

  test("an opaque custom command conflicts even across provider families", () => {
    const activity = new InstallationActivity();
    const custom = { family: "custom", keys: [], opaque: true };
    const close = activity.acquireAgent(custom);
    expect(() => activity.acquireUpdate(claude)).toThrow("in use");
    close();
    const update = activity.acquireUpdate(claude);
    expect(() => activity.acquireAgent(custom)).toThrow("being updated");
    update.release();
  });

  test("retains a scope when the updater tree could not be confirmed stopped", () => {
    const activity = new InstallationActivity();
    const update = activity.acquireUpdate(claude);
    update.quarantine();
    update.release();

    expect(() => activity.acquireAgent(alias)).toThrow("being updated");
    expect(() => activity.acquireUpdate(sibling)).toThrow("already in progress");
  });

  test("uses family admission for providers without a declared installation identity", () => {
    const activity = new InstallationActivity();
    const update = activity.acquireUpdate({ family: "claude", keys: [] });
    expect(() => activity.acquireAgent(claude)).toThrow("being updated");
    expect(() => activity.acquireAgent(unrelated)()).not.toThrow();
    update.release();
  });
});
