import { describe, expect, it } from "vitest";
import { menuStructure } from "./MenuStructure";
import { ChartNoAxesCombinedIcon, ClipboardCheckIcon, ClipboardListIcon, GaugeIcon, GraduationCapIcon, ScanSearchIcon, TruckIcon } from "@/components/icons";

describe("menuStructure", () => {
  it("opens the NC dashboard and exposes the one non-conformance register", () => {
    const nc = menuStructure.find((m) => m.name === "Non-Conformance");
    expect(nc.path).toBe("/Non-Conformance");
    expect(nc.subMenu[0]).toMatchObject({ name: "Dashboard", path: "/Non-Conformance", end: true });
    expect(nc.subMenu.map((s) => s.path)).toEqual([
      "/Non-Conformance",
      "/Non-Conformance/Register",
    ]);
  });

  it("has Audits as its own module, opening on the dashboard, for people who may read audits", () => {
    const audits = menuStructure.find((m) => m.name === "Audits");
    expect(audits).toMatchObject({ path: "/Audits", permission: "audits.read" });
    expect(audits.subMenu[0]).toMatchObject({ name: "Dashboard", path: "/Audits", end: true });
    expect(audits.subMenu.map((s) => [s.name, s.path])).toEqual([
      ["Dashboard", "/Audits"],
      ["Audit schedule", "/Audits/Schedule"],
      ["Audit templates", "/Audits/Templates"],
      ["Audit records", "/Audits/Records"],
      ["Audit findings", "/Audits/Findings"],
    ]);
  });

  it("keeps documents and alerts under Documentation", () => {
    const docs = menuStructure.find((m) => m.name === "Documentation");
    expect(docs.subMenu.map((s) => s.name)).toEqual(["Documents", "My alerts", "Quality alerts"]);
    expect(JSON.stringify(docs)).not.toMatch(/Audit/);
  });

  it("no longer links to removed holiday-let areas", () => {
    const paths = menuStructure.flatMap((m) => [m.path, ...(m.subMenu ?? []).map((s) => s.path)]);
    for (const removed of ["/Bookings", "/Client-Management", "/Calendar"]) {
      expect(paths.some((p) => p.startsWith(removed))).toBe(false);
    }
  });

  it("has no Human Resources area: employees are part of Master Data", () => {
    expect(menuStructure.some((m) => m.name === "Human Resources" || m.path === "/Human-Resources")).toBe(false);
    const master = menuStructure.find((m) => m.name === "Master Data");
    expect(master.subMenu.map((s) => s.path)).toContain("/Employees");
    expect(master.permission).toBe("master_data.read");
  });

  it("uses the agreed icon for each module", () => {
    const icon = (name) => menuStructure.find((m) => m.name === name)?.icon;
    expect(icon("Corrective Actions (8D)")).toBe(ClipboardListIcon);
    expect(icon("Process Control")).toBe(ChartNoAxesCombinedIcon);
    expect(icon("In-Process Inspection")).toBe(ScanSearchIcon);
    expect(icon("Calibration")).toBe(GaugeIcon);
    expect(icon("Audits")).toBe(ClipboardCheckIcon);
    expect(icon("Supplier Quality")).toBe(TruckIcon);
    expect(icon("Competence")).toBe(GraduationCapIcon);
  });

  it("opens Competence on its dashboard and shows an own-record member only their own pages", () => {
    const comp = menuStructure.find((m) => m.name === "Competence");
    expect(comp.permission).toEqual(["competence.read", "competence.own"]);
    expect(comp.subMenu.map((s) => [s.name, s.path, s.permission])).toEqual([
      ["Dashboard", "/Competence", "competence.read"],
      ["Skills matrix", "/Competence/Matrix", "competence.read"],
      ["Training sessions", "/Competence/Training", ["competence.read", "competence.own"]],
      ["My competence", "/Competence/Mine", "competence.own"],
      ["Skills and positions", "/Competence/Skills", "competence.read"],
    ]);
  });
});
