import { describe, expect, it } from "vitest";
import { cleanFilters, hasFilters, sameFilters, toFilterValues } from "./savedFilters";

const KEYS = ["search", "source", "stage", "severity", "part", "partLabel"];

describe("saved filters helpers", () => {
  it("keep only the filters that are set, as text", () => {
    expect(cleanFilters({ search: "", source: "customer", stage: "open,closed", severity: undefined, part: null, partLabel: "BRK" }, KEYS)).toEqual({ source: "customer", stage: "open,closed", partLabel: "BRK" });
  });

  it("say whether any filter is set, ignoring the label keys that only name a chosen record", () => {
    expect(hasFilters({ search: "", stage: "" }, KEYS)).toBe(false);
    expect(hasFilters({ stage: "open" }, KEYS)).toBe(true);
    expect(hasFilters({ partLabel: "BRK" }, KEYS)).toBe(false);
  });

  it("compare filters by what they show: the same list in another order is the same filter, and labels do not count", () => {
    expect(sameFilters({ stage: "closed,open" }, { stage: "open,closed" }, KEYS)).toBe(true);
    expect(sameFilters({ part: "p1", partLabel: "BRK-100" }, { part: "p1" }, KEYS)).toBe(true);
    expect(sameFilters({ stage: "open" }, { stage: "closed" }, KEYS)).toBe(false);
    expect(sameFilters({ stage: "open", severity: "major" }, { stage: "open" }, KEYS)).toBe(false);
    expect(sameFilters({}, {}, KEYS)).toBe(true);
  });

  it("set every key when applying one, so what was chosen before is cleared", () => {
    expect(toFilterValues({ filters: { stage: "open" } }, KEYS)).toEqual({ search: "", source: "", stage: "open", severity: "", part: "", partLabel: "" });
    expect(toFilterValues(undefined, ["a", "b"])).toEqual({ a: "", b: "" });
  });
});

import { describeFilter } from "./savedFilters";
describe("describeFilter", () => {
  it("names what a saved filter contains, using saved record names and labels", () => {
    const rows = describeFilter({ source: "customer,supplier", part: "p1", partLabel: "Bracket", costMin: "100", empty: "x" }, (k, v) => (k === "source" ? v.toUpperCase() : null));
    expect(rows).toEqual([
      { key: "source", title: "Source", value: "CUSTOMER, SUPPLIER" },
      { key: "part", title: "Part", value: "Bracket" },
      { key: "costMin", title: "Cost from", value: "100" },
    ]);
  });
});
