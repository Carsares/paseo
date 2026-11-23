import { expect, it, vi } from "vitest";
import { openResidentForm } from "./resident-form-model";

it("keeps the visible timeline and does not interrupt work by default", async () => {
  const submit = vi.fn(async () => {});
  await openResidentForm("reset").submit(submit);
  expect(submit).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ reset: { interrupt: false, clearVisibleTimeline: false } }),
  );

  const form = openResidentForm("reset");
  form.setInterrupt(true);
  form.setClearVisibleTimeline(true);
  await form.submit(submit);
  expect(submit).toHaveBeenLastCalledWith(
    expect.objectContaining({ reset: { interrupt: true, clearVisibleTimeline: true } }),
  );
});

it("preserves explicit overrides on failure and rejects a duplicate submission while pending", async () => {
  const form = openResidentForm("create");
  const submit = vi.fn(async () => {
    throw new Error("Permission refused");
  });
  expect(await form.submit(submit)).toBe(false);
  form.selectPreset({ id: "review", name: "Review", residentUrgentReport: true });
  expect(form.getState().urgentReport).toBe(true);
  form.setUrgentReport(false);
  form.setRole("   Reviewer   ");
  form.setRoleSlug("bad slug");
  expect(await form.submit(submit)).toBe(false);
  form.setRoleSlug("review");
  const pending = form.submit(submit);
  expect(form.getState().phase).toBe("pending");
  expect(await form.submit(submit)).toBe(false);
  await pending;
  expect(submit).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      profileId: "review",
      overrides: {
        role: "Reviewer",
        roleSlug: "review",
        urgentReport: false,
        keepAlive: undefined,
      },
    }),
  );
  expect(form.getState()).toMatchObject({
    phase: "idle",
    canSubmit: true,
    error: "Permission refused",
    roleSlug: "review",
  });
});
