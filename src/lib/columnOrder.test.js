import { describe, expect, it } from "vitest";
import { applyOrder, moveColumn, shiftColumn } from "./columnOrder";

describe("column order helpers", () => {
  it("applies a saved order, dropping unknown ids and appending new columns", () => {
    expect(applyOrder(["a", "b", "c", "d"], ["c", "gone", "a"])).toEqual(["c", "a", "b", "d"]);
    expect(applyOrder(["a", "b"], undefined)).toEqual(["a", "b"]);
  });
  it("moves a column before or after another", () => {
    expect(moveColumn(["a", "b", "c", "d"], "d", "b")).toEqual(["a", "d", "b", "c"]);
    expect(moveColumn(["a", "b", "c", "d"], "a", "c", true)).toEqual(["b", "c", "a", "d"]);
    expect(moveColumn(["a", "b"], "a", "a")).toEqual(["a", "b"]);
    expect(moveColumn(["a", "b"], "x", "a")).toEqual(["a", "b"]);
  });
  it("shifts within the listed columns, skipping unlisted ones", () => {
    expect(shiftColumn(["sel", "a", "b", "c"], "b", -1, ["a", "b", "c"])).toEqual(["sel", "b", "a", "c"]);
    expect(shiftColumn(["sel", "a", "b"], "a", -1, ["a", "b"])).toEqual(["sel", "a", "b"]);
    expect(shiftColumn(["a", "b", "c"], "a", 1)).toEqual(["b", "a", "c"]);
  });
});
