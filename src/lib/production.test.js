import { describe, expect, it } from "vitest";
import { LOT_MOVES, ORDER_MOVES, SERIAL_MOVES, lotEditable, orderEditable, orderOperationsEditable, parseSerialList, partLabel, rangeNumbers, serialEditable } from "./production";

describe("rangeNumbers", () => {
  it("pads, prefixes and includes both ends", () => {
    expect(rangeNumbers({ prefix: "SN-", from: 8, to: 11, pad: 4 })).toEqual(["SN-0008", "SN-0009", "SN-0010", "SN-0011"]);
    expect(rangeNumbers({ from: "1", to: "3" })).toEqual(["1", "2", "3"]);
  });
  it("gives nothing for a backwards, fractional or negative range", () => {
    expect(rangeNumbers({ from: 5, to: 1 })).toEqual([]);
    expect(rangeNumbers({ from: 1.5, to: 3 })).toEqual([]);
    expect(rangeNumbers({ from: -1, to: 3 })).toEqual([]);
    expect(rangeNumbers({ from: "", to: "" })).toEqual([]);
  });
});

describe("parseSerialList", () => {
  it("splits on new lines, commas, semicolons, tabs and spaces and drops blanks", () => {
    expect(parseSerialList("A1\nA2, A3;A4\tA5   A6\n\n")).toEqual(["A1", "A2", "A3", "A4", "A5", "A6"]);
    expect(parseSerialList("")).toEqual([]);
    expect(parseSerialList(null)).toEqual([]);
  });
});

describe("status moves", () => {
  it("asks for a reason on every move the database asks one for, and only those", () => {
    const needs = { ORDER_MOVES: "cancelled", LOT_MOVES: "on_hold", SERIAL_MOVES: "scrapped" };
    const maps = { ORDER_MOVES, LOT_MOVES, SERIAL_MOVES };
    for (const [name, moves] of Object.entries(maps)) {
      for (const [from, list] of Object.entries(moves)) {
        for (const m of list) expect({ name, from, to: m.to, asks: !!m.reason }).toEqual({ name, from, to: m.to, asks: m.to === needs[name] });
      }
    }
  });
  it("offers nothing from a final status", () => {
    expect(ORDER_MOVES.closed).toEqual([]);
    expect(ORDER_MOVES.cancelled).toEqual([]);
    expect(LOT_MOVES.closed).toEqual([]);
    expect(SERIAL_MOVES.scrapped).toEqual([]);
  });
  it("never offers a move to the same status", () => {
    for (const moves of [ORDER_MOVES, LOT_MOVES, SERIAL_MOVES]) for (const [from, list] of Object.entries(moves)) expect(list.map((m) => m.to)).not.toContain(from);
  });
});

describe("what can still be edited", () => {
  it("freezes closed and cancelled orders, closed lots and scrapped serials", () => {
    expect(orderEditable({ status: "released" })).toBe(true);
    expect(orderEditable({ status: "closed" })).toBe(false);
    expect(orderEditable({ status: "cancelled" })).toBe(false);
    expect(orderOperationsEditable({ status: "in_progress" })).toBe(true);
    expect(orderOperationsEditable({ status: "completed" })).toBe(false);
    expect(lotEditable({ status: "on_hold" })).toBe(true);
    expect(lotEditable({ status: "closed" })).toBe(false);
    expect(serialEditable({ status: "completed" })).toBe(true);
    expect(serialEditable({ status: "scrapped" })).toBe(false);
  });
});

describe("partLabel", () => {
  it("joins number and name, and copes with a missing part or a name equal to the number", () => {
    expect(partLabel({ partNumber: "ROD-100", name: "Rod" })).toBe("ROD-100 · Rod");
    expect(partLabel({ partNumber: "ROD-100", name: "ROD-100" })).toBe("ROD-100");
    expect(partLabel(null)).toBe("");
  });
});
