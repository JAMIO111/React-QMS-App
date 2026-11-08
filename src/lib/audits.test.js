import { describe, expect, it } from "vitest";
import { formatScore, monthBounds, monthLabel, monthWeeks, provisionalResult, shiftMonth, slotLabel, slotPill, SLOT_PILL, targetBody, targetKey } from "./audits";

describe("provisionalResult (what is shown while an answer is being saved)", () => {
  const yesNo = { answerType: "yes_no", passAnswer: "yes" };
  const noIsGood = { answerType: "yes_no", passAnswer: "no" };
  const num = { answerType: "number", lowerLimit: 6, upperLimit: 10 };
  it("follows the passing answer of a yes / no question", () => {
    expect(provisionalResult(yesNo, { answer: "yes" })).toBe("pass");
    expect(provisionalResult(yesNo, { answer: "no" })).toBe("fail");
    expect(provisionalResult(noIsGood, { answer: "no" })).toBe("pass");
    expect(provisionalResult(noIsGood, { answer: "yes" })).toBe("fail");
  });
  it("takes pass and fail as they are, and not applicable for any type", () => {
    expect(provisionalResult({ answerType: "pass_fail" }, { answer: "pass" })).toBe("pass");
    expect(provisionalResult({ answerType: "pass_fail" }, { answer: "fail" })).toBe("fail");
    expect(provisionalResult({ answerType: "pass_fail" }, { answer: "na" })).toBe("na");
    expect(provisionalResult(num, { answer: "na" })).toBe("na");
    expect(provisionalResult(yesNo, { answer: "na" })).toBe("na");
  });
  it("checks a number against its limits, both ends included, and either end may be open", () => {
    expect(provisionalResult(num, { value: 6 })).toBe("pass");
    expect(provisionalResult(num, { value: 10 })).toBe("pass");
    expect(provisionalResult(num, { value: 5.99 })).toBe("fail");
    expect(provisionalResult(num, { value: 10.01 })).toBe("fail");
    expect(provisionalResult({ answerType: "number", lowerLimit: 6, upperLimit: null }, { value: 1000 })).toBe("pass");
    expect(provisionalResult({ answerType: "number", lowerLimit: null, upperLimit: 10 }, { value: -5 })).toBe("pass");
    expect(provisionalResult(num, { value: null })).toBeNull();
    expect(provisionalResult(num, { value: 0 })).toBe("fail");
  });
  it("gives a note no result", () => {
    expect(provisionalResult({ answerType: "text" }, { note: "x" })).toBeNull();
    expect(provisionalResult({ answerType: "pass_fail" }, {})).toBeNull();
  });
});

describe("calendar helpers", () => {
  it("lays a month out in whole weeks starting on Monday, padded with the neighbouring days", () => {
    const weeks = monthWeeks("2026-11");
    expect(weeks.every((w) => w.length === 7)).toBe(true);
    expect(weeks[0][0]).toBe("2026-10-26");
    expect(weeks[0][6]).toBe("2026-11-01");
    expect(weeks.at(-1).at(-1)).toBe("2026-12-06");
    expect(weeks).toHaveLength(6);
    expect(weeks.flat().filter((d) => d.startsWith("2026-11"))).toHaveLength(30);
  });
  it("does not add a week a month does not need, and starts straight away when it begins on a Monday", () => {
    const feb = monthWeeks("2027-02");
    expect(feb).toHaveLength(4);
    expect(feb[0][0]).toBe("2027-02-01");
    expect(feb.at(-1).at(-1)).toBe("2027-02-28");
    expect(monthWeeks("2026-08")).toHaveLength(6);
  });
  it("moves between months across a year end", () => {
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(shiftMonth("2027-01", -1)).toBe("2026-12");
    expect(shiftMonth("2026-03", -14)).toBe("2025-01");
  });
  it("gives the first and last day of a month, leap years included", () => {
    expect(monthBounds("2026-11")).toEqual({ from: "2026-11-01", to: "2026-11-30" });
    expect(monthBounds("2028-02")).toEqual({ from: "2028-02-01", to: "2028-02-29" });
    expect(monthBounds("2026-12")).toEqual({ from: "2026-12-01", to: "2026-12-31" });
  });
  it("names the month", () => {
    expect(monthLabel("2026-11")).toBe("November 2026");
  });
});

describe("labels", () => {
  it("shows a score with at most one decimal", () => {
    expect(formatScore(66.67)).toBe("66.7%");
    expect(formatScore(100)).toBe("100%");
    expect(formatScore(0)).toBe("0%");
    expect(formatScore(null)).toBe("—");
  });
  it("colours a done slot by what the audit found, and words it", () => {
    const done = (result) => ({ state: "done", record: { result } });
    expect(slotPill(done("pass"))).toBe(SLOT_PILL.done);
    expect(slotPill(done("fail"))).toBe(SLOT_PILL.missed);
    expect(slotLabel(done("pass"))).toBe("Done · Pass");
    expect(slotLabel(done("fail"))).toBe("Done · Fail");
    expect(slotLabel({ state: "missed" })).toBe("Missed");
    expect(slotLabel({ state: "in_progress" })).toBe("In progress");
  });
  it("turns a choice into the body the API takes", () => {
    expect(targetBody({ kind: "machine", id: "m1" })).toEqual({ kind: "machine", machineId: "m1" });
    expect(targetBody({ kind: "operation", id: "OP-10" })).toEqual({ kind: "operation", operationCode: "OP-10" });
    expect(targetBody({ kind: "department", id: "d1" })).toEqual({ kind: "department", departmentId: "d1" });
    expect(targetKey({ kind: "machine", id: "m1" })).toBe("machine:m1");
  });
});
