import { describe, expect, it } from "vitest";
import { NC_SOURCES, NC_TABS, SOURCE_OPTIONS, ncrPath, sourceLabel } from "./ncr";

describe("non-conformance sources", () => {
  it("are the eleven fixed ones, each with a label and a hint", () => {
    expect(NC_SOURCES.map((s) => s.key)).toEqual([
      "internal", "customer", "supplier", "internal_audit", "external_audit", "production_inspection", "final_inspection", "calibration", "goods_receiving", "engineering", "management_review",
    ]);
    expect(NC_SOURCES.every((s) => s.label && s.hint)).toBe(true);
    expect(SOURCE_OPTIONS).toHaveLength(11);
    expect(sourceLabel("production_inspection")).toBe("Production inspection");
    expect(sourceLabel("something_new")).toBe("something_new");
    expect(sourceLabel(null)).toBe("—");
  });

  it("say which party they need", () => {
    const need = Object.fromEntries(NC_SOURCES.filter((s) => s.party).map((s) => [s.key, s.party]));
    expect(need).toEqual({ customer: "customer", supplier: "supplier", goods_receiving: "supplier?" });
  });

  it("have quick tabs: All, Customer, and Supplier which includes goods receiving", () => {
    expect(NC_TABS.map((t) => [t.key, t.source])).toEqual([["all", ""], ["customer", "customer"], ["supplier", "supplier,goods_receiving"]]);
  });
});

describe("ncrPath", () => {
  it("addresses a record in the one register", () => {
    expect(ncrPath("n1")).toBe("/Non-Conformance/Register/n1");
  });
  it("carries the chosen source only for a new one", () => {
    expect(ncrPath("new", "calibration")).toBe("/Non-Conformance/Register/new?source=calibration");
    expect(ncrPath("new")).toBe("/Non-Conformance/Register/new");
    expect(ncrPath("n1", "calibration")).toBe("/Non-Conformance/Register/n1");
  });
});
