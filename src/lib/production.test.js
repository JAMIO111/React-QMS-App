import { describe, expect, it } from "vitest";
import { LOT_MOVES, ORDER_MOVES, SERIAL_MOVES, canCreateOrder, linkNotices, lotEditable, orderEditable, orderOperationsEditable, parseSerialList, partLabel, rangeNumbers, serialEditable, subMenuVisible } from "./production";
import { menuStructure } from "../MenuStructure";

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

describe("canCreateOrder", () => {
  const can = (...p) => (x) => p.includes(x);
  it("is for people who manage production, or for people who record inspections when the organisation allows it", () => {
    expect(canCreateOrder(can("production.manage"), {})).toBe(true);
    expect(canCreateOrder(can("inspection.record"), { allowInlineOrders: true })).toBe(true);
    expect(canCreateOrder(can("inspection.record"), { allowInlineOrders: false })).toBe(false);
    expect(canCreateOrder(can("inspection.record"), undefined)).toBe(false);
    expect(canCreateOrder(can("production.read"), { allowInlineOrders: true })).toBe(false);
  });
});

describe("linkNotices", () => {
  it("says in words when a lot is on hold or closed, an order is closed or cancelled, or a serial number was scrapped", () => {
    const text = (links) => linkNotices(links).map((n) => n.text);
    expect(text({ lot: { lotNumber: "L1", status: "on_hold", statusReason: "Suspect" } })).toEqual(["Lot L1 is on hold: Suspect."]);
    expect(text({ lot: { lotNumber: "L1", status: "on_hold", statusReason: null } })).toEqual(["Lot L1 is on hold."]);
    expect(text({ lot: { lotNumber: "L1", status: "closed" } })).toEqual(["Lot L1 is closed."]);
    expect(text({ productionOrder: { orderNumber: "WO-1", status: "cancelled" } })).toEqual(["Order WO-1 is cancelled."]);
    expect(text({ serial: { serialNumber: "S1", status: "scrapped" } })).toEqual(["Serial number S1 was scrapped."]);
  });
  it("says nothing about records in good standing, or when nothing is linked", () => {
    expect(linkNotices({ lot: { lotNumber: "L1", status: "released" }, productionOrder: { orderNumber: "WO-1", status: "in_progress" }, serial: { serialNumber: "S1", status: "completed" } })).toEqual([]);
    expect(linkNotices(null)).toEqual([]);
    expect(linkNotices({ productionOrder: null, lot: null, serial: null })).toEqual([]);
  });
});

describe("the Production menu", () => {
  const production = menuStructure.find((m) => m.name === "Production");
  const names = (settings, canSee = () => true) => production.subMenu.filter((i) => subMenuVisible(i, canSee, settings)).map((i) => i.name);
  it("shows Orders, Lots, Serial numbers and Traceability by default, and no Lots or Serial numbers to a shop that does not use them", () => {
    expect(names({})).toEqual(["Orders", "Lots", "Serial numbers", "Traceability"]);
    expect(names(undefined)).toEqual(["Orders", "Lots", "Serial numbers", "Traceability"]);
    expect(names({ useLotsAndSerials: true })).toEqual(["Orders", "Lots", "Serial numbers", "Traceability"]);
    expect(names({ useLotsAndSerials: false })).toEqual(["Orders", "Traceability"]);
  });
  it("still follows what the person may see", () => {
    expect(names({}, () => false)).toEqual([]);
  });
});
