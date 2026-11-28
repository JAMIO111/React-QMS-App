import { describe, expect, it } from "vitest";
import { EMPTY_CHECK, checkBody, checkProblem, checkToForm, checkWords, evenPoints, isPercentCheck, needsRange, toleranceExample } from "./rangeChecks";

const form = (over) => ({ ...EMPTY_CHECK, name: "Pt", nominal: "50", toleranceMinus: "0.1", tolerancePlus: "0.1", ...over });

describe("range checks: what the form allows", () => {
  it("accepts a fixed check as before", () => {
    expect(checkProblem(form({}))).toBeNull();
    expect(checkBody(form({ toleranceMinus: "0.1", tolerancePlus: "0.3" }))).toMatchObject({ nominalBasis: "value", toleranceBasis: "value", toleranceMinus: 0.1, tolerancePlus: 0.3, unitCode: "mm", toleranceReadingPercent: null });
  });
  it("says what is wrong with a percentage point", () => {
    expect(checkProblem(form({ nominalBasis: "span_percent", nominal: "120" }))).toMatch(/between 0 and 100/);
    expect(checkProblem(form({ nominalBasis: "span_percent", nominal: "50.0001" }))).toMatch(/three decimals/);
    expect(checkProblem(form({ nominalBasis: "span_percent", nominal: "" }))).toMatch(/percentage of the range/);
    expect(checkProblem(form({ nominalBasis: "span_percent", nominal: "12.5" }))).toBeNull();
  });
  it("sends no unit for a percentage point and the same number on both sides for a percentage tolerance", () => {
    const body = checkBody(form({ nominalBasis: "span_percent", toleranceBasis: "span_percent", toleranceMinus: "1", tolerancePlus: "7" }));
    expect(body).toMatchObject({ nominalBasis: "span_percent", unitCode: null, toleranceBasis: "span_percent", toleranceMinus: 1, tolerancePlus: 1, toleranceReadingPercent: null });
  });
  it("needs the reading percentage for the combined tolerance", () => {
    expect(checkProblem(form({ toleranceBasis: "value_plus_reading_percent" }))).toMatch(/percentage of the reading/);
    const f = form({ toleranceBasis: "value_plus_reading_percent", toleranceMinus: "0.003", toleranceReadingPercent: "0.01" });
    expect(checkProblem(f)).toBeNull();
    expect(checkBody(f)).toMatchObject({ toleranceMinus: 0.003, tolerancePlus: 0.003, toleranceReadingPercent: 0.01 });
  });
  it("refuses a percentage tolerance of nothing or over 100", () => {
    expect(checkProblem(form({ toleranceBasis: "reading_percent", toleranceMinus: "0" }))).toMatch(/more than 0/);
    expect(checkProblem(form({ toleranceBasis: "span_percent", toleranceMinus: "101" }))).toMatch(/at most 100/);
  });
  it("reads a saved check back into the form and words it", () => {
    const c = { kind: "variable", name: "Mid", nominalBasis: "span_percent", nominal: 50, unitCode: null, toleranceBasis: "value_plus_reading_percent", toleranceMinus: 0.003, tolerancePlus: 0.003, toleranceReadingPercent: 0.01, toleranceSource: "ISO 3611", method: null };
    expect(checkToForm(c)).toMatchObject({ nominalBasis: "span_percent", nominal: "50", toleranceReadingPercent: "0.01", toleranceSource: "ISO 3611" });
    expect(checkWords(c)).toBe("50 % of range, ±(0.003 + 0.01 % of reading)");
    expect(isPercentCheck(c)).toBe(true);
    expect(needsRange(c)).toBe(true);
    expect(needsRange({ ...c, nominalBasis: "value", toleranceBasis: "reading_percent" })).toBe(false);
    expect(checkWords({ kind: "variable", nominal: 25, unitCode: "mm", toleranceMinus: 0.004, tolerancePlus: 0.004 })).toBe("25 mm, ±0.004 mm");
    expect(checkWords({ kind: "attribute" })).toBe("Pass / fail");
  });
  it("gives an example sentence in the person's own numbers", () => {
    expect(toleranceExample(form({ toleranceBasis: "reading_percent", toleranceMinus: "1" }))).toMatch(/±1 % of the reading/);
    expect(toleranceExample(form({ toleranceBasis: "value_plus_reading_percent", toleranceMinus: "0.003", toleranceReadingPercent: "0.01" }))).toMatch(/±\(0\.003 mm \+ 0\.01 % of the reading\)/);
  });
  it("spaces points evenly and rounds to three decimals", () => {
    expect(evenPoints(5, 0, 100)).toEqual([0, 25, 50, 75, 100]);
    expect(evenPoints(4, 0, 100)).toEqual([0, 33.333, 66.667, 100]);
    expect(evenPoints(1, 0, 100)).toEqual([0, 100]);
  });
});
