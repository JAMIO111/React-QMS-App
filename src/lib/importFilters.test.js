import { describe, expect, it } from "vitest";
import { cleanFilter, filterWords, keepsLittle, leftOutShare, newFilter, ruleComplete, withRule } from "./importFilters";
import { templateChanged, templateSettings } from "./importTemplates";

describe("record filters", () => {
  it("a filter with no complete rule does nothing: it is not saved and says every record is read", () => {
    expect(cleanFilter(undefined)).toBeUndefined();
    expect(cleanFilter(newFilter())).toBeUndefined();
    expect(cleanFilter({ mode: "keep", match: "all", rules: [{ column: "Status", test: "equals", value: "  " }] })).toBeUndefined();
    expect(filterWords(newFilter())).toBe("Every record is read.");
  });

  it("only complete rules are kept, tidied to what their test needs", () => {
    const f = cleanFilter({
      mode: "leave_out", match: "any",
      rules: [
        { column: "Status", test: "equals", value: " Cancelled ", values: ["x"], as: "number" },
        { column: "Name", test: "is_empty", value: "left over" },
        { column: "Type", test: "in", values: ["A", " ", "B"] },
        { column: "Qty", test: "between", value: "1", valueTo: "9", as: "number", decimal: "," },
        { column: "", test: "equals", value: "no column" },
        { column: "Half", test: "between", value: "1" },
      ],
    });
    expect(f).toEqual({
      mode: "leave_out", match: "any",
      rules: [
        { column: "Status", test: "equals", value: "Cancelled" },
        { column: "Name", test: "is_empty" },
        { column: "Type", test: "in", values: ["A", "B"] },
        { column: "Qty", test: "between", value: "1", valueTo: "9", as: "number", decimal: "," },
      ],
    });
  });

  it("a formula replaces the rules", () => {
    expect(cleanFilter({ mode: "keep", match: "all", rules: [{ column: "A", test: "equals", value: "1" }], formula: ' [Qty]>0 ' })).toEqual({ mode: "keep", match: "all", rules: [], formula: "[Qty]>0" });
  });

  it("is put in words the way the server puts it", () => {
    expect(filterWords({ mode: "keep", match: "all", rules: [{ column: "Status", test: "equals", value: "Active" }, { column: "Type", test: "in", values: ["A", "B"] }] })).toBe('Read only the records where Status is "Active" and Type is one of "A", "B".');
    expect(filterWords({ mode: "leave_out", match: "any", rules: [{ column: "Qty", test: "gt", value: "5" }, { column: "Name", test: "is_empty" }] })).toBe("Skip the records where Qty is more than 5 or Name is empty.");
  });

  it("rules are complete only with a column and the value their test needs", () => {
    expect(ruleComplete({ column: "A", test: "is_empty" })).toBe(true);
    expect(ruleComplete({ column: "A", test: "equals" })).toBe(false);
    expect(ruleComplete({ column: "A", test: "in", values: [] })).toBe(false);
    expect(withRule(newFilter(), 0, { column: "A" }).rules[0].column).toBe("A");
  });

  it("a half-typed rule never makes a template look changed, and a finished one does", () => {
    const version = { keyField: "id", fields: [], settings: { writeMode: "add_only", matchExisting: false } };
    const draft = { writeMode: "add_only", matchExisting: false, filters: newFilter() };
    expect(templateSettings("supplier", draft)).toEqual(version.settings);
    expect(templateChanged(version, { keyField: "id", fields: [], settings: templateSettings("supplier", draft) })).toBe(false);
    const done = { ...draft, filters: { mode: "keep", match: "all", rules: [{ column: "A", test: "equals", value: "1" }] } };
    expect(templateChanged(version, { keyField: "id", fields: [], settings: templateSettings("supplier", done) })).toBe(true);
  });

  it("works out when a filter keeps too little to be what was meant", () => {
    expect(keepsLittle(0, 25)).toBe("none");
    expect(keepsLittle(0, 1)).toBe("none");
    expect(keepsLittle(4, 100)).toBe("little");
    expect(keepsLittle(1, 10)).toBeNull(); // exactly a tenth is fine
    expect(keepsLittle(0, 0)).toBeNull(); // nothing read, nothing to say
    expect(keepsLittle(1, 9)).toBeNull(); // too few records to call it
    expect(keepsLittle(60, 100)).toBeNull();
    expect(leftOutShare(96, 100)).toBe(96);
    expect(leftOutShare(0, 0)).toBe(0);
  });
});
