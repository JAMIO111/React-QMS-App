import { describe, expect, it } from "vitest";
import { BoxesIcon, ClipboardCheckIcon, FolderOpenIcon, GaugeIcon, ScanSearchIcon, SettingsIcon, TriangleAlertIcon, TruckIcon } from "@/components/icons";
import { breadcrumbIcon } from "./breadcrumbs";

describe("breadcrumbIcon", () => {
  it("uses the icon of the menu module the address belongs to", () => {
    expect(breadcrumbIcon("/Non-Conformance")).toBe(TriangleAlertIcon);
    expect(breadcrumbIcon("/Non-Conformance/Register/abc")).toBe(TriangleAlertIcon);
    expect(breadcrumbIcon("/Calibration/Gauges")).toBe(GaugeIcon);
    expect(breadcrumbIcon("/Audits/Templates/new")).toBe(ClipboardCheckIcon);
    expect(breadcrumbIcon("/Parts")).toBe(BoxesIcon);
    expect(breadcrumbIcon("/Suppliers/123")).toBe(TruckIcon);
    expect(breadcrumbIcon("/Inspections/1")).toBe(ScanSearchIcon);
    expect(breadcrumbIcon("/Jobs/1")).toBe(ScanSearchIcon);
    expect(breadcrumbIcon("/Settings/Integrations")).toBe(SettingsIcon);
  });
  it("matches whole segments only and falls back to a folder", () => {
    expect(breadcrumbIcon("/Partsbin")).toBe(FolderOpenIcon);
    expect(breadcrumbIcon("/platform")).toBe(FolderOpenIcon);
  });
});
