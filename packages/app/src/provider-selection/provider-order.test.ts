import { expect, it } from "vitest";
import { orderProviders } from "./provider-order";

it("keeps the existing order within each group and puts every error last", () => {
  const providers = Object.freeze([
    { id: "error-on", enabled: true, hasError: true },
    { id: "disabled-first", enabled: false, hasError: false },
    { id: "enabled-first", enabled: true, hasError: false },
    { id: "error-off", enabled: false, hasError: true },
    { id: "enabled-second", enabled: true, hasError: false },
    { id: "disabled-second", enabled: false, hasError: false },
  ]);

  expect(orderProviders(providers, (provider) => provider).map(({ id }) => id)).toEqual([
    "enabled-first",
    "enabled-second",
    "disabled-first",
    "disabled-second",
    "error-on",
    "error-off",
  ]);
});
