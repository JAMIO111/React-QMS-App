import { describe, expect, it } from "vitest";
import { cellKey, cellMap, designProblem, fmt, fmtPct, fmtRate, isFilled, isNumberText, progressPct, runSheet, toNumberText, type1Readings, validityWords } from "./msa";
import { withReadings } from "../hooks/useMsa";

describe("reading text", () => {
  it("accepts numbers with a point or a comma and an optional exponent, and nothing else", () => {
    ["10", "-0.25", "10,25", "1e-3", "10.250"].forEach((t) => expect(isNumberText(t), t).toBe(true));
    ["", "abc", "1.2.3", "10 mm", "--1", ".5"].forEach((t) => expect(isNumberText(t), t).toBe(false));
  });
  it("keeps the digits as typed and only turns a decimal comma into a point", () => {
    expect(toNumberText(" 10,250 ")).toBe("10.250");
    expect(toNumberText("10.250")).toBe("10.250");
  });
});

describe("figures in words", () => {
  it("rounds without noise and says when there is no figure", () => {
    expect(fmt(0.123456, 3)).toBe("0.123");
    expect(fmt(10, 3)).toBe("10");
    expect(fmt(0)).toBe("0");
    expect(fmt(null)).toBe("—");
    expect(fmtPct(13.246)).toBe("13.2%");
    expect(fmtPct(null)).toBe("—");
    expect(fmtRate(0.9, 0)).toBe("90%");
  });
  it("describes how long a study stays valid", () => {
    expect(validityWords({ state: "valid", daysLeft: 200 }, "1 Jan 2027")).toBe("Valid until 1 Jan 2027");
    expect(validityWords({ state: "expiring", daysLeft: 1 }, null)).toBe("Valid for 1 more day");
    expect(validityWords({ state: "expiring", daysLeft: 12 }, null)).toBe("Valid for 12 more days");
    expect(validityWords({ state: "expired", daysLeft: 0 }, "1 Jan 2026")).toBe("Expired on 1 Jan 2026");
    expect(validityWords(null)).toBe("");
  });
  it("shows progress as a whole percentage", () => {
    expect(progressPct({ filled: 1, total: 3 })).toBe(33);
    expect(progressPct({ filled: 0, total: 0 })).toBe(0);
  });
});

const cells = [
  { appraiser: 1, part: 1, trial: 1, runOrder: 2, value: "10.1", decision: null },
  { appraiser: 1, part: 2, trial: 1, runOrder: 1, value: null, decision: null },
  { appraiser: 1, part: 1, trial: 2, runOrder: 1, value: null, decision: null },
  { appraiser: 2, part: 1, trial: 1, runOrder: 1, value: null, decision: null },
];

describe("the run sheet", () => {
  it("groups one appraiser's cells by trial in the order they are to be measured", () => {
    const sheet = runSheet(cells, 1);
    expect(sheet.map((t) => t.trial)).toEqual([1, 2]);
    expect(sheet[0].cells.map((c) => c.part)).toEqual([2, 1]);
  });
  it("finds a cell by its place and says whether it holds a reading or a decision", () => {
    const map = cellMap(cells);
    expect(map[cellKey(1, 1, 1)].value).toBe("10.1");
    expect(isFilled(map[cellKey(1, 1, 1)])).toBe(true);
    expect(isFilled(map[cellKey(1, 2, 1)])).toBe(false);
    expect(isFilled({ value: null, decision: false })).toBe(true);
    expect(isFilled(undefined)).toBe(false);
  });
  it("lists the readings of a Type 1 study in the order taken", () => {
    expect(type1Readings({ cells: [{ trial: 2, value: "10.2" }, { trial: 1, value: "10.1" }, { trial: 3, value: null }] })).toEqual([10.1, 10.2]);
  });
});

describe("withReadings (the guess made while a reading saves)", () => {
  const study = { id: "s1", cells, progress: { filled: 1, total: 4 } };
  it("puts the reading in its cell and counts the filled cells", () => {
    const next = withReadings(study, [{ appraiser: 1, part: 2, trial: 1, value: "9,9" }]);
    expect(next.cells.find((c) => c.part === 2 && c.appraiser === 1 && c.trial === 1).value).toBe("9.9");
    expect(next.progress).toEqual({ filled: 2, total: 4 });
    expect(study.progress.filled).toBe(1);
  });
  it("takes a decision, and leaves anything that is not a study with cells alone", () => {
    expect(withReadings(study, [{ appraiser: 2, part: 1, trial: 1, decision: true }]).cells.at(-1).decision).toBe(true);
    const other = { analysis: true };
    expect(withReadings(other, [{ appraiser: 1, part: 1, trial: 1, value: "1" }])).toBe(other);
    expect(withReadings(study, [{ appraiser: 9, part: 9, trial: 9, value: "1" }])).toBe(study);
  });
});

describe("design problems shown before saving", () => {
  const ok = { characteristicName: "OD", lowerLimit: "", upperLimit: "", partCount: 10, appraiserCount: 3, trialCount: 3, referenceValue: "" };
  it("accepts the usual designs", () => {
    expect(designProblem("grr_crossed", ok)).toBe("");
    expect(designProblem("type1", { ...ok, partCount: 1, appraiserCount: 1, trialCount: 25, referenceValue: "10" })).toBe("");
    expect(designProblem("attribute", { ...ok, partCount: 30 })).toBe("");
  });
  it("says what is wrong in words", () => {
    expect(designProblem("grr_crossed", { ...ok, characteristicName: " " })).toBe("Say what is measured.");
    expect(designProblem("grr_crossed", { ...ok, lowerLimit: "5", upperLimit: "4" })).toBe("The upper limit must be above the lower limit.");
    expect(designProblem("grr_crossed", { ...ok, appraiserCount: 1 })).toMatch(/at least 2 appraisers/);
    expect(designProblem("type1", { ...ok, trialCount: 25 })).toMatch(/reference value/);
    expect(designProblem("type1", { ...ok, referenceValue: "10", trialCount: 5 })).toMatch(/at least 10 readings/);
    expect(designProblem("attribute", { ...ok, partCount: 5 })).toMatch(/at least 10 samples/);
  });
});

describe("coverage words", () => {
  it("orders the states worst first and picks the worst of several gauges", async () => {
    const { COVERAGE_STATES, worstCoverage, coverageOf } = await import("./msa");
    expect(COVERAGE_STATES.map((s) => s.value)).toEqual(["not_accepted", "expired", "no_study", "not_judged", "marginal", "no_readings", "acceptable"]);
    expect(worstCoverage(["acceptable", "expired", "marginal"])).toBe("expired");
    expect(worstCoverage([])).toBeNull();
    expect(coverageOf("no_study").label).toBe("No study");
  });

  it("starts a study from a row: variable data is a crossed study, pass / fail an attribute one", async () => {
    const { studyDefaultsFor } = await import("./msa");
    const row = (dataType) => ({ characteristic: { key: "OD", name: "Outer diameter", dataType }, gauge: { id: "g1", assetNumber: "CAL-1", description: "Mic" }, part: { id: "p1", partNumber: "P-1", name: "Rod" } });
    expect(studyDefaultsFor(row("variable"))).toMatchObject({ studyType: "grr_crossed", characteristicKey: "OD", gauge: { id: "g1" }, part: { id: "p1" } });
    expect(studyDefaultsFor(row("attribute")).studyType).toBe("attribute");
    expect(studyDefaultsFor({ ...row("variable"), part: null }).part).toBeNull();
  });
});
