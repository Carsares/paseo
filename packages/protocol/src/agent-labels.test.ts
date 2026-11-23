import { describe, expect, test } from "vitest";
import {
  AGENT_PROFILE_ID_LABEL,
  getAgentProfileIdFromLabels,
  getParentAgentIdFromLabels,
  getOpenAgentTabLabel,
  getResidentRoleFromLabels,
  getResidentRoleSlugFromLabels,
  hasOpenAgentTab,
  hasResidentInboxBypass,
  hasResidentKeepAlive,
  isDelegatedAgent,
  isExplicitParentReportingLabels,
  isOpenAgentTabLabel,
  isResidentAgent,
  PARENT_AGENT_ID_LABEL,
  RESIDENT_AGENT_LABEL,
  RESIDENT_INBOX_BYPASS_LABEL,
  RESIDENT_KEEPALIVE_LABEL,
  RESIDENT_ROLE_LABEL,
  RESIDENT_SLUG_LABEL,
} from "./agent-labels.js";

describe("agent label policy", () => {
  test("treats a non-empty parent agent label as delegation", () => {
    const labels = { [PARENT_AGENT_ID_LABEL]: " parent-agent \n" };

    expect(getParentAgentIdFromLabels(labels)).toBe("parent-agent");
    expect(isDelegatedAgent({ labels })).toBe(true);
  });

  test("ignores missing, empty, and non-string parent agent labels", () => {
    expect(isDelegatedAgent({ labels: {} })).toBe(false);
    expect(isDelegatedAgent({ labels: { [PARENT_AGENT_ID_LABEL]: "   " } })).toBe(false);
    expect(isDelegatedAgent({ labels: { [PARENT_AGENT_ID_LABEL]: 42 } })).toBe(false);
  });

  test("treats any true client-scoped open-tab label as open", () => {
    const desktopLabel = getOpenAgentTabLabel("desktop-client");
    const mobileLabel = getOpenAgentTabLabel("mobile-client");

    expect(hasOpenAgentTab({ [desktopLabel]: "false", [mobileLabel]: "true" })).toBe(true);
    expect(hasOpenAgentTab({ [desktopLabel]: "false", [mobileLabel]: "false" })).toBe(false);
    expect(hasOpenAgentTab({})).toBe(false);
  });

  test("recognizes only client-scoped open-tab labels", () => {
    expect(isOpenAgentTabLabel(getOpenAgentTabLabel("client-a"))).toBe(true);
    expect(isOpenAgentTabLabel("paseo.open-agent-tab")).toBe(false);
    expect(isOpenAgentTabLabel("custom.open-agent-tab.client-a")).toBe(false);
  });
});

test("reads resident flags only when their stored values are the string true", () => {
  for (const value of ["true", true, " true ", "false", undefined]) {
    const labels = {
      [RESIDENT_AGENT_LABEL]: value,
      [RESIDENT_INBOX_BYPASS_LABEL]: value,
      [RESIDENT_KEEPALIVE_LABEL]: value,
    };
    expect(isResidentAgent({ labels })).toBe(value === "true");
    expect(hasResidentInboxBypass(labels)).toBe(value === "true");
    expect(hasResidentKeepAlive(labels)).toBe(value === "true");
  }
});

test("trims resident roles and rejects malformed role slugs and profile IDs", () => {
  const role = "r".repeat(500);
  expect(getResidentRoleFromLabels({ [RESIDENT_ROLE_LABEL]: " " + role + "\n" })).toBe(role);
  for (const invalid of [" ", role + "r", 1]) {
    expect(getResidentRoleFromLabels({ [RESIDENT_ROLE_LABEL]: invalid })).toBeNull();
  }

  for (const slug of ["a", "review_ops-2", "a".repeat(64)]) {
    expect(getResidentRoleSlugFromLabels({ [RESIDENT_SLUG_LABEL]: slug })).toBe(slug);
  }
  for (const invalid of [" A ", "Review", "-review", "review_", "a".repeat(65)]) {
    expect(getResidentRoleSlugFromLabels({ [RESIDENT_SLUG_LABEL]: invalid })).toBeNull();
  }

  const id = "id".repeat(64);
  expect(getAgentProfileIdFromLabels({ [AGENT_PROFILE_ID_LABEL]: id })).toBe(id);
  expect(getAgentProfileIdFromLabels({ [AGENT_PROFILE_ID_LABEL]: id + "1" })).toBeNull();
  expect(getAgentProfileIdFromLabels({ [AGENT_PROFILE_ID_LABEL]: " " })).toBeNull();
});

test("only the reserved explicit label opts an agent out of automatic parent reporting", () => {
  expect(isExplicitParentReportingLabels({ "paseo.parent-reporting": "explicit" })).toBe(true);
  for (const labels of [
    null,
    undefined,
    {},
    { "paseo.parent-reporting": true },
    { "paseo.parent-reporting": "auto" },
  ]) {
    expect(isExplicitParentReportingLabels(labels)).toBe(false);
  }
});
