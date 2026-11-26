import { describe, expect, it } from "vitest";
import { ELEMENTS, describePpapFilter, fileSizeLabel, levelSummary, matrixRows, progressPercent, progressWords, statusLabel } from "./ppap";

describe("ppap helpers", () => {
  it("lists the eighteen elements in order", () => {
    expect(ELEMENTS).toHaveLength(18);
    expect(ELEMENTS[0].key).toBe("design_records");
    expect(ELEMENTS.at(-1).key).toBe("part_submission_warrant");
  });

  it("says how far a submission is in words and as a percentage", () => {
    expect(progressWords({ required: 12, done: 5 })).toBe("5 of 12 required elements");
    expect(progressWords({ required: 0, done: 0 })).toBe("Nothing required");
    expect(progressPercent({ required: 12, done: 6 })).toBe(50);
    expect(progressPercent({ required: 0, done: 0 })).toBe(100);
  });

  it("writes file sizes plainly", () => {
    expect(fileSizeLabel(500)).toBe("500 B");
    expect(fileSizeLabel(2048)).toBe("2 KB");
    expect(fileSizeLabel(3 * 1048576)).toBe("3.0 MB");
  });

  it("reads the matrix as rows and counts what each level sends", () => {
    const config = { rows: Object.fromEntries(ELEMENTS.map((e) => [e.key, { 1: "none", 2: "submit", 3: "submit", 4: "retain", 5: "submit" }])) };
    expect(matrixRows(config)[0].levels).toEqual(["none", "submit", "submit", "retain", "submit"]);
    expect(levelSummary(config).map((s) => s.send)).toEqual([0, 18, 18, 0, 18]);
  });

  it("describes filters as chips, naming the customer and part rather than the id", () => {
    const chips = describePpapFilter({ status: "draft,ready", level: "3", customer: "c1", customerLabel: "Acme", owner: "me" });
    expect(chips.map((c) => `${c.title}: ${c.value}`)).toEqual(["Status: Draft, Ready to send", "Level: Level 3", "Owner: Mine", "Customer: Acme"]);
    expect(statusLabel("in_preparation")).toBe("In preparation");
  });
});
