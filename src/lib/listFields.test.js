import { describe, expect, it } from "vitest";
import { filterListValues, isListField, listCheck, listValueOk, listValues } from "./listFields";

const severity = { key: "severity", label: "Severity", type: "enum", options: [{ value: "critical", label: "Critical" }, { value: "major", label: "Major" }, { value: "minor", label: "Minor" }] };
const source = { key: "source", label: "Source", type: "enum", options: [{ value: "production_inspection", label: "Production inspection" }] };
const shifts = { key: "cf_shifts", label: "Shifts", type: "text", multiple: true, options: [{ value: "days", label: "Days" }, { value: "nights", label: "Nights" }] };

describe("list fields", () => {
  it("knows which fields take a value from a list", () => {
    expect(isListField(severity)).toBe(true);
    expect(isListField(shifts)).toBe(true);
    expect(isListField({ type: "country" })).toBe(true);
    expect(isListField({ type: "currency" })).toBe(true);
    expect(isListField({ type: "text" })).toBe(false);
    expect(isListField({ type: "text", ref: { kind: "site" } })).toBe(false);
    expect(isListField({ type: "text", multiple: true, options: [] })).toBe(false);
  });

  it("accepts a value as the import does: by words or code, capitals and spaces not mattering", () => {
    expect(listValueOk(severity, "Major")).toBe(true);
    expect(listValueOk(severity, "MINOR")).toBe(true);
    expect(listValueOk(severity, "Big")).toBe(false);
    expect(listValueOk(source, "production inspection")).toBe(true);
    expect(listValueOk(source, "Production-Inspection")).toBe(true);
    expect(listValueOk(severity, "  ")).toBe(true);
    expect(listValueOk(shifts, "Days, nights")).toBe(true);
    expect(listValueOk(shifts, "days;weekends")).toBe(false);
    expect(listValueOk({ type: "country" }, "gb")).toBe(true);
    expect(listValueOk({ type: "country" }, "GBR")).toBe(false);
    expect(listValueOk({ type: "currency" }, "eur")).toBe(true);
    expect(listValueOk({ type: "currency" }, "Euro")).toBe(false);
  });

  it("checks the preview rows after their steps, counting rows per value not on the list", () => {
    const rows = [
      { row: 2, fields: [{ target: "severity", taken: "Big", steps: [] }] },
      { row: 3, fields: [{ target: "severity", taken: "big", steps: ["Big"] }] },
      { row: 4, fields: [{ target: "severity", taken: "Major", steps: [] }] },
      { row: 5, fields: [{ target: "severity", taken: "", steps: [] }] },
      { row: 6, fields: [{ target: "severity", taken: "x", steps: ["Huge"] }] },
    ];
    expect(listCheck(severity, rows)).toEqual({ checked: 4, badRows: 3, examples: [{ value: "Big", rows: 2 }, { value: "Huge", rows: 1 }] });
    expect(listCheck(severity, [{ row: 2, fields: [] }])).toBeNull();
  });

  it("lists countries and currencies by code, and searches by words or code", () => {
    expect(listValues({ type: "country" }).find((c) => c.value === "GB")?.label).toMatch(/United Kingdom/);
    expect(listValues({ type: "currency" }).find((c) => c.value === "GBP")?.label).toMatch(/Pound/);
    expect(filterListValues(severity.options, "maj").map((o) => o.value)).toEqual(["major"]);
    expect(filterListValues(listValues({ type: "currency" }), "gbp").map((o) => o.value)).toContain("GBP");
  });
});
