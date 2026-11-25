import { describe, expect, it } from "vitest";
import { cleanModel, methodWords, modelProblems, priorityLabel, ruleWords } from "./fmeaModel";

const scale = () => Array.from({ length: 10 }, (_, i) => ({ label: `Level ${i + 1}` }));
const config = (over = {}) => ({
  method: "rpn",
  rpnHighFrom: 200,
  rpnMediumFrom: 100,
  severityFloor: 9,
  reviewMonths: 12,
  scales: { design: { severity: scale(), occurrence: scale(), detection: scale() }, process: { severity: scale(), occurrence: scale(), detection: scale() } },
  apRules: [],
  ...over,
});

describe("the FMEA rating model words and checks", () => {
  it("accepts the default shape", () => {
    expect(modelProblems(config())).toEqual([]);
  });

  it("says what is missing", () => {
    expect(modelProblems(config({ method: "ap" }))).toEqual(["The action priority method needs an action priority grid: import one, or choose RPN"]);
    expect(modelProblems(config({ rpnMediumFrom: 200 }))).toContain("Medium priority starts at a lower RPN than high");
    expect(modelProblems(config({ rpnHighFrom: "" }))).toContain("High priority starts at an RPN of 2 to 1,000");
    expect(modelProblems(config({ severityFloor: 11 }))).toContain("The severity that always needs attention is 1 to 10");
    expect(modelProblems(config({ reviewMonths: 0 }))).toContain("The review interval is 1 to 120 months");
    const blank = config();
    blank.scales.design.severity[2].label = "  ";
    expect(modelProblems(blank)).toContain("Every level of severity (design) needs a label");
    const twice = config();
    twice.scales.process.detection[4].label = "level 1";
    expect(modelProblems(twice)).toContain("The levels of detection (process) need different labels");
  });

  it("tidies a model for the server", () => {
    const c = config({ rpnHighFrom: "250", rpnMediumFrom: "120", severityFloor: "8", reviewMonths: "6" });
    c.scales.design.severity[0] = { label: "  Trivial ", criteria: "   " };
    c.scales.design.severity[1] = { label: "Slight", criteria: " Our words " };
    const clean = cleanModel(c);
    expect(clean).toMatchObject({ rpnHighFrom: 250, rpnMediumFrom: 120, severityFloor: 8, reviewMonths: 6 });
    expect(clean.scales.design.severity[0]).toEqual({ label: "Trivial" });
    expect(clean.scales.design.severity[1]).toEqual({ label: "Slight", criteria: "Our words" });
  });

  it("describes the method and the ranges of a grid", () => {
    expect(methodWords(config())).toBe("Priority comes from the RPN: high from 200, medium from 100.");
    expect(methodWords(config({ method: "ap", apRules: [{}, {}] }))).toBe("Priority comes from your action priority grid (2 ranges).");
    expect(ruleWords({ sFrom: 9, sTo: 10, oFrom: 1, oTo: 10, dFrom: 4, dTo: 4, priority: "high" })).toBe("S 9–10 · O any · D 4 → High");
    expect(priorityLabel("medium")).toBe("Medium");
    expect(priorityLabel(undefined)).toBe("—");
  });
});
