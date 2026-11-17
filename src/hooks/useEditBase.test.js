import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import { useEditBase } from "./useEditBase";

describe("useEditBase", () => {
  it("follows the record until the person starts changing something, then keeps the version they were looking at", () => {
    const { result, rerender } = renderHook(({ record, dirty }) => useEditBase(record, dirty), { initialProps: { record: { id: "a", rowVersion: "1" }, dirty: false } });
    expect(result.current({ t: 1 })).toEqual({ t: 1, rowVersion: "1" });
    rerender({ record: { id: "a", rowVersion: "2" }, dirty: false });
    expect(result.current({})).toEqual({ rowVersion: "2" });
    rerender({ record: { id: "a", rowVersion: "2" }, dirty: true });
    rerender({ record: { id: "a", rowVersion: "3" }, dirty: true }); // someone else's save came in underneath
    expect(result.current({})).toEqual({ rowVersion: "2" });
    rerender({ record: { id: "a", rowVersion: "4" }, dirty: false });
    expect(result.current({})).toEqual({ rowVersion: "4" });
  });
});
