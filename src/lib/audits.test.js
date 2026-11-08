import { describe, expect, it } from "vitest";
import { ANSWER_TYPES, emptyQuestion, formatScore, isScoredType, measurementLimits, monthBounds, monthLabel, monthWeeks, provisionalResult, questionProblems, questionRule, questionsBody, questionToForm, shiftMonth, slotLabel, slotPill, SLOT_PILL, targetBody, targetKey } from "./audits";

describe("provisionalResult (what is shown while an answer is being saved)", () => {
  const yesNo = { answerType: "yes_no", passAnswer: "yes" };
  const noIsGood = { answerType: "yes_no", passAnswer: "no" };
  const num = { answerType: "numeric", lowerLimit: 6, upperLimit: 10 };
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
    expect(provisionalResult({ answerType: "numeric", lowerLimit: 6, upperLimit: null }, { value: 1000 })).toBe("pass");
    expect(provisionalResult({ answerType: "numeric", lowerLimit: null, upperLimit: 10 }, { value: -5 })).toBe("pass");
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

describe("provisionalResult for the other types", () => {
  it("takes compliant and non-compliant as pass and fail", () => {
    expect(provisionalResult({ answerType: "compliant" }, { answer: "compliant" })).toBe("pass");
    expect(provisionalResult({ answerType: "compliant" }, { answer: "non_compliant" })).toBe("fail");
  });
  it("leaves a numeric question with no limit unscored, and scores a measurement against its limits", () => {
    expect(provisionalResult({ answerType: "numeric", lowerLimit: null, upperLimit: null }, { value: 5 })).toBeNull();
    const m = { answerType: "measurement", lowerLimit: 9.95, upperLimit: 10.05 };
    expect(provisionalResult(m, { value: 10.05 })).toBe("pass");
    expect(provisionalResult(m, { value: 10.06 })).toBe("fail");
  });
  it("scores a choice by its option, whatever the case, and nothing for an unknown one", () => {
    const q = { answerType: "multiple_choice", options: [{ label: "Clean", passes: true }, { label: "Oily", passes: false }] };
    expect(provisionalResult(q, { choice: " clean " })).toBe("pass");
    expect(provisionalResult(q, { choice: "OILY" })).toBe("fail");
    expect(provisionalResult(q, { choice: "Wet" })).toBeNull();
  });
  it("scores a rating only against a lowest acceptable rating, at it and above", () => {
    expect(provisionalResult({ answerType: "rating", passRating: 3 }, { value: 3 })).toBe("pass");
    expect(provisionalResult({ answerType: "rating", passRating: 3 }, { value: 2 })).toBe("fail");
    expect(provisionalResult({ answerType: "rating", passRating: null }, { value: 5 })).toBeNull();
  });
  it("has nothing to say for text and evidence", () => {
    expect(provisionalResult({ answerType: "text" }, { note: "x" })).toBeNull();
    expect(provisionalResult({ answerType: "evidence" }, { note: "x" })).toBeNull();
  });
});

describe("the question types", () => {
  it("lists the ten types the quality team can choose from", () => {
    expect(ANSWER_TYPES.map((t) => t.value)).toEqual(["yes_no", "compliant", "pass_fail", "yes_no_na", "numeric", "text", "multiple_choice", "measurement", "evidence", "rating"]);
    expect(ANSWER_TYPES.every((t) => t.label && t.hint)).toBe(true);
  });
  it("counts a question as scored only when it can fail", () => {
    for (const t of ["yes_no", "compliant", "pass_fail", "yes_no_na", "multiple_choice", "measurement"]) expect(isScoredType({ answerType: t })).toBe(true);
    for (const t of ["text", "evidence"]) expect(isScoredType({ answerType: t })).toBe(false);
    expect(isScoredType({ answerType: "numeric", lowerLimit: "", upperLimit: "" })).toBe(false);
    expect(isScoredType({ answerType: "numeric", lowerLimit: "", upperLimit: "5" })).toBe(true);
    expect(isScoredType({ answerType: "numeric", lowerLimit: 0, upperLimit: "" })).toBe(true);
    expect(isScoredType({ answerType: "rating", passRating: "" })).toBe(false);
    expect(isScoredType({ answerType: "rating", passRating: "3" })).toBe(true);
  });
  it("works a measurement's limits out from its nominal and tolerance, without floating point noise", () => {
    expect(measurementLimits({ nominal: "10", tolMinus: "0.05", tolPlus: "0.1" })).toEqual({ lower: 9.95, upper: 10.1 });
    expect(measurementLimits({ nominal: "0.3", tolMinus: "0.1", tolPlus: "0.1" })).toEqual({ lower: 0.2, upper: 0.4 });
    expect(measurementLimits({ nominal: "10", tolMinus: "", tolPlus: "0.1" })).toBeNull();
  });
  it("sends only what belongs to the type, and no critical flag for a question that cannot fail", () => {
    const base = { ...emptyQuestion(), question: " Q " };
    expect(questionsBody([{ ...base, answerType: "yes_no", passAnswer: "no", critical: true }])).toEqual([{ question: "Q", guidance: null, answerType: "yes_no", passAnswer: "no", critical: true }]);
    expect(questionsBody([{ ...base, answerType: "text", critical: true }])).toEqual([{ question: "Q", guidance: null, answerType: "text", critical: false }]);
    expect(questionsBody([{ ...base, answerType: "evidence", critical: true }])[0].critical).toBe(false);
    expect(questionsBody([{ ...base, answerType: "numeric", unit: " C ", upperLimit: "80", critical: true }])).toEqual([{ question: "Q", guidance: null, answerType: "numeric", unit: "C", lowerLimit: null, upperLimit: 80, critical: true }]);
    expect(questionsBody([{ ...base, answerType: "numeric", unit: "C", critical: true }])[0].critical).toBe(false);
    expect(questionsBody([{ ...base, answerType: "measurement", nominal: "10", tolMinus: "0.05", tolPlus: "0.05", unit: "mm" }])).toEqual([
      { question: "Q", guidance: null, answerType: "measurement", unit: "mm", nominal: 10, lowerLimit: 9.95, upperLimit: 10.05, critical: false },
    ]);
    expect(questionsBody([{ ...base, answerType: "multiple_choice", options: [{ key: "a", label: " A ", passes: true }, { key: "b", label: "B", passes: false }] }])[0].options).toEqual([{ label: "A", passes: true }, { label: "B", passes: false }]);
    expect(questionsBody([{ ...base, answerType: "rating", ratingMax: "7", passRating: "3" }])[0]).toMatchObject({ ratingMax: 7, passRating: 3 });
    expect(questionsBody([{ ...base, answerType: "rating", ratingMax: "", passRating: "" }])[0]).toMatchObject({ ratingMax: 5, passRating: null });
  });
  it("turns a saved question back into what the form edits", () => {
    const f = questionToForm({ id: "q", question: "Diameter", guidance: null, answerType: "measurement", passAnswer: null, unit: "mm", lowerLimit: 9.95, upperLimit: 10.1, nominal: 10, options: null, ratingMax: null, passRating: null, critical: true });
    expect(f).toMatchObject({ key: "q", nominal: 10, tolMinus: 0.05, tolPlus: 0.1, unit: "mm", critical: true, ratingMax: "5", passRating: "" });
    expect(f.options).toHaveLength(2);
    const r = questionToForm({ id: "r", question: "R", guidance: "g", answerType: "rating", passAnswer: null, unit: null, lowerLimit: null, upperLimit: null, nominal: null, options: null, ratingMax: 7, passRating: 3, critical: false });
    expect(r).toMatchObject({ ratingMax: "7", passRating: "3", guidance: "g" });
    const c = questionToForm({ id: "c", question: "C", guidance: null, answerType: "multiple_choice", passAnswer: null, unit: null, lowerLimit: null, upperLimit: null, nominal: null, options: [{ label: "A", passes: false }], ratingMax: null, passRating: null, critical: false });
    expect(c.options).toEqual([expect.objectContaining({ label: "A", passes: false })]);
  });
  it("says what is wrong with a question", () => {
    const q = (over) => ({ ...emptyQuestion(), question: "Q", ...over });
    expect(questionProblems(q({ question: " " }), 1)).toEqual(["Every question needs its words"]);
    expect(questionProblems(q({ answerType: "numeric", lowerLimit: "9", upperLimit: "1" }), 2)).toEqual(["Question 2: the lower limit is above the upper limit"]);
    expect(questionProblems(q({ answerType: "numeric", lowerLimit: "1", upperLimit: "1" }), 2)).toEqual([]);
    expect(questionProblems(q({ answerType: "measurement", nominal: "10" }), 3)).toEqual(["Question 3: a measurement needs a nominal value, its tolerance (− and +) and a unit"]);
    expect(questionProblems(q({ answerType: "measurement", nominal: "10", tolMinus: "-1", tolPlus: "1", unit: "mm" }), 3)).toEqual(["Question 3: a tolerance cannot be negative"]);
    expect(questionProblems(q({ answerType: "measurement", nominal: "10", tolMinus: "0", tolPlus: "0", unit: "mm" }), 3)).toEqual([]);
    const opts = (...labels) => labels.map((label, i) => ({ key: String(i), label, passes: true }));
    expect(questionProblems(q({ answerType: "multiple_choice", options: opts("A", "") }), 4)).toEqual(["Question 4: give at least two options, each with its words"]);
    expect(questionProblems(q({ answerType: "multiple_choice", options: opts("A", " a ") }), 4)).toEqual(["Question 4: an option is listed twice"]);
    expect(questionProblems(q({ answerType: "multiple_choice", options: [{ key: "a", label: "A", passes: false }, { key: "b", label: "B", passes: false }] }), 4)).toEqual(["Question 4: at least one option must be acceptable"]);
    expect(questionProblems(q({ answerType: "multiple_choice", options: opts("A", "B") }), 4)).toEqual([]);
  });
  it("describes what the template says in words", () => {
    expect(questionRule({ answerType: "yes_no", passAnswer: "no" })).toBe('"no" passes');
    expect(questionRule({ answerType: "numeric", lowerLimit: null, upperLimit: null })).toBe("recorded, not scored");
    expect(questionRule({ answerType: "numeric", unit: "%", lowerLimit: 6, upperLimit: 9 })).toBe("passes 6 to 9 %");
    expect(questionRule({ answerType: "numeric", unit: "C", lowerLimit: null, upperLimit: 80 })).toBe("passes at most 80 C");
    expect(questionRule({ answerType: "measurement", unit: "mm", nominal: 10, lowerLimit: 9.95, upperLimit: 10.05 })).toBe("nominal 10 mm; passes 9.95 to 10.05 mm");
    expect(questionRule({ answerType: "multiple_choice", options: [{ label: "A", passes: true }, { label: "B", passes: false }, { label: "C", passes: true }] })).toBe("acceptable: A, C");
    expect(questionRule({ answerType: "rating", ratingMax: 5, passRating: 3 })).toBe("1 to 5; 3 or more passes");
    expect(questionRule({ answerType: "rating", ratingMax: 5, passRating: null })).toBe("1 to 5; not scored");
    expect(questionRule({ answerType: "evidence" })).toBe("at least one photograph or document is needed");
    expect(questionRule({ answerType: "text" })).toBe("a note, not scored");
  });
});
