import { describe, expect, it } from "vitest";
import { reportFilename, reportToCsv } from "./reportCsv";

const report = {
  meta: { title: "Supplier performance", from: "2026-08-12", to: "2026-11-09", generatedAt: "2026-11-09T10:00:00.000Z", rowCount: 2, basis: [{ label: "Scoring model version", value: "2" }], definitions: ["PPM = units rejected ÷ units received × 1,000,000."] },
  columns: [{ key: "code", label: "Supplier" }, { key: "name", label: "Name" }, { key: "score", label: "Score" }, { key: "warnings", label: "Warnings" }],
  rows: [{ code: "ACME", name: 'Acme, "Metals"', score: 42, warnings: "=HYPERLINK(\"x\")" }, { code: "BOLT", name: "Bolt Co", score: null, warnings: null }],
};

describe("report CSV", () => {
  const lines = reportToCsv(report).split("\r\n");

  it("starts with what the report is, the period, when it was made, what it used and the definitions", () => {
    expect(lines.slice(0, 7)).toEqual([
      "Report,Supplier performance",
      "Period,2026-08-12 to 2026-11-09",
      "Generated (UTC),2026-11-09T10:00:00.000Z",
      "Rows,2",
      "Scoring model version,2",
      'Definition,"PPM = units rejected ÷ units received × 1,000,000."',
      "",
    ]);
  });

  it("then the table with its labels, quoting commas and quotes and leaving empty cells empty", () => {
    expect(lines[7]).toBe("Supplier,Name,Score,Warnings");
    expect(lines[8]).toBe('ACME,"Acme, ""Metals""",42,"\'=HYPERLINK(""x"")"');
    expect(lines[9]).toBe("BOLT,Bolt Co,,");
  });

  it("does not let a cell run as a spreadsheet formula, but keeps negative numbers", () => {
    expect(reportToCsv({ ...report, rows: [{ code: "-5", name: "@home", score: -3, warnings: "+1 (x)" }] })).toContain("-5,'@home,-3,'+1 (x)");
  });

  it("names the file after the period", () => {
    expect(reportFilename(report.meta, "supplier-performance")).toBe("supplier-performance-2026-08-12-to-2026-11-09.csv");
  });
});
