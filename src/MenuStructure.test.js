import { describe, expect, it } from "vitest";
import { menuStructure } from "./MenuStructure";

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
});
