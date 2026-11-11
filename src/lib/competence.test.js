import { describe, expect, it } from "vitest";
import { matrixReport, attendeeStatusLabel, kindLabel, providerLine, sessionDates, sessionNextStep, describeCell, groupByCategory, levelLabel, LEVELS, refreshLabel, requirementSummary, statusClass, statusLabel } from "./competence";

describe("competence helpers", () => {
  it("has the five levels, 0 to 4", () => {
    expect(LEVELS.map((l) => l.value)).toEqual([0, 1, 2, 3, 4]);
    expect(levelLabel(3)).toBe("Competent");
    expect(levelLabel(4)).toBe("Can train others");
    expect(levelLabel(null)).toBe("—");
  });
  it("words a refresh interval", () => {
    expect(refreshLabel(null)).toBe("No refresh");
    expect(refreshLabel(1)).toBe("Every month");
    expect(refreshLabel(6)).toBe("Every 6 months");
    expect(refreshLabel(12)).toBe("Every year");
    expect(refreshLabel(24)).toBe("Every 2 years");
  });
  it("groups skills by category, keeping the order", () => {
    const g = groupByCategory([
      { name: "A", category: { label: "Inspection" } },
      { name: "B", category: { label: "Safety" } },
      { name: "C", category: { label: "Inspection" } },
    ]);
    expect(g.map((x) => [x.label, x.items.map((i) => i.name)])).toEqual([["Inspection", ["A", "C"]], ["Safety", ["B"]]]);
  });
  it("summarises what a position requires", () => {
    expect(requirementSummary({ skills: [] })).toBe("Requires no skills yet");
    expect(requirementSummary({ skills: [{ name: "CMM", requiredLevel: 3 }, { name: "Visual", requiredLevel: 2 }] })).toBe("CMM 3, Visual 2");
  });

  it("describes a status and a cell in words", () => {
    expect(statusLabel("gap")).toBe("Below required");
    expect(statusLabel("nonsense")).toBe("—");
    expect(statusClass("expired")).toContain("error-color");
    expect(statusClass("extra")).toContain("secondary-text");
    expect(describeCell({ level: 3, required: 3, expiresOn: "2027-01-05", expiry: "valid" })).toBe("Competent (3) · needs 3 · expires 2027-01-05");
    expect(describeCell({ level: null, required: 2, expiresOn: null, expiry: "none" })).toBe("Not assessed · needs 2");
    expect(describeCell({ level: 2, required: null, expiresOn: "2026-01-01", expiry: "expired" })).toBe("Supervised (2) · expired 2026-01-01");
  });

  it("describes training sessions in words", () => {
    expect(kindLabel("on_the_job")).toBe("On the job");
    expect(attendeeStatusLabel("absent")).toBe("Did not attend");
    expect(providerLine({ providerType: "internal", trainer: { name: "Tina" } })).toBe("Tina");
    expect(providerLine({ providerType: "external", providerName: "Acme", providerContact: "info@acme.test" })).toBe("Acme · info@acme.test");
    expect(sessionDates({ startsOn: "2026-01-05", endsOn: null })).toBe("2026-01-05");
    expect(sessionDates({ startsOn: "2026-01-05", endsOn: "2026-01-07" })).toBe("2026-01-05 to 2026-01-07");
    expect(sessionNextStep({ status: "open", enrolledCount: 2, attendeeCount: 3 })).toMatch(/2 people are still enrolled/);
    expect(sessionNextStep({ status: "open", enrolledCount: 0, attendeeCount: 0 })).toMatch(/No one is on this session/);
    expect(sessionNextStep({ status: "open", enrolledCount: 0, attendeeCount: 3 })).toMatch(/Close the session/);
    expect(sessionNextStep({ status: "cancelled" })).toBeNull();
  });

  it("builds the matrix as a report with what it means in its first lines", () => {
    const result = {
      today: "2026-11-11",
      skills: [{ id: "s1", name: "CMM operation" }],
      data: [{ employee: { id: "e1", name: "Xavier Xu", employeeNumber: "E-1", department: { name: "Quality" } }, positions: [{ name: "Inspector" }, { name: "Setter" }],
        cells: { s1: { level: 2, required: 3, status: "gap", expiresOn: "2027-01-05" } } },
        { employee: { id: "e2", name: "Yara Yu", employeeNumber: null, department: null }, positions: [], cells: { s1: { level: null, required: null, status: "not_assessed", expiresOn: null } } }],
    };
    const report = matrixReport(result, { statusFilter: "gap" });
    expect(report.meta).toMatchObject({ title: "Skills matrix", from: "2026-11-11", to: "2026-11-11", rowCount: 2 });
    expect(report.meta.basis[1].value).toBe("Only those with: Gaps");
    expect(report.meta.definitions.some((d) => /never lowers a level|Expiry never lowers/.test(d))).toBe(true);
    expect(report.columns.map((c) => c.label)).toEqual(["Person", "Employee number", "Department", "Positions", "CMM operation — level", "CMM operation — needs", "CMM operation — standing", "CMM operation — expires"]);
    expect(report.rows[0]).toMatchObject({ name: "Xavier Xu", number: "E-1", department: "Quality", positions: "Inspector; Setter", l_s1: 2, r_s1: 3, s_s1: "Below required", e_s1: "2027-01-05" });
    expect(report.rows[1]).toMatchObject({ number: "", department: "", l_s1: "", r_s1: "", s_s1: "Not assessed" });
  });
});
