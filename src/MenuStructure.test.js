import { describe, expect, it } from "vitest";
import { menuStructure } from "./MenuStructure";

describe("menuStructure", () => {
  it("exposes the three non-conformance registers", () => {
    const nc = menuStructure.find((m) => m.name === "Non-Conformance");
    expect(nc.subMenu.map((s) => s.path)).toEqual([
      "/Non-Conformance/Internal",
      "/Non-Conformance/Customer",
      "/Non-Conformance/Supplier",
    ]);
  });

  it("no longer links to removed holiday-let areas", () => {
    const paths = menuStructure.flatMap((m) => [m.path, ...(m.subMenu ?? []).map((s) => s.path)]);
    for (const removed of ["/Bookings", "/Client-Management", "/Calendar"]) {
      expect(paths.some((p) => p.startsWith(removed))).toBe(false);
    }
  });
});
