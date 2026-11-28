import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

let permissions = [];
vi.mock("../../hooks/useQmsApi", () => ({ usePermissions: () => ({ can: (p) => permissions.includes(p) }) }));
vi.mock("./SettingsNonConformance", () => ({ default: () => <p>NC lists</p> }));
vi.mock("./SettingsCalibration", () => ({ default: () => <p>Gauge types</p> }));
vi.mock("./SettingsProcessControl", () => ({ default: () => <p>Characteristic templates</p> }));
vi.mock("./SettingsAudits", () => ({ default: () => <p>Finding classifications</p> }));
vi.mock("./SettingsSupplierQuality", () => ({ default: () => <p>Supplier classifications</p> }));
vi.mock("./SettingsCompetence", () => ({ default: () => <p>Skills and positions</p> }));
vi.mock("../custom-fields/CustomFieldsSettings", () => ({ default: () => <p>Custom field list</p> }));

import SettingsDataManagement from "./SettingsDataManagement";

const renderAt = (at) =>
  render(
    <MemoryRouter initialEntries={[at]}>
      <Routes>
        <Route path="/Settings/Data-Management" element={<SettingsDataManagement />} />
      </Routes>
    </MemoryRouter>,
  );

// The module menu is the settings pane's nested "Data" level (see Settings.test.jsx); this page shows only the chosen module.
describe("Settings → Data Management", () => {
  it("opens the first module the person may read, with no header or tab bar of its own", async () => {
    permissions = ["ncr.read", "calibration.read", "supplier_quality.read"];
    renderAt("/Settings/Data-Management");
    expect(await screen.findByText("NC lists")).toBeInTheDocument();
    expect(screen.queryByRole("tab")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Data Management" })).toBeNull();
    expect(screen.getByText(/You can view these/)).toBeInTheDocument();
  });

  it("opens the module named in the address", async () => {
    permissions = ["ncr.read", "calibration.read", "calibration.manage", "audits.read"];
    renderAt("/Settings/Data-Management?tab=calibration");
    expect(await screen.findByText("Gauge types")).toBeInTheDocument();
    expect(screen.queryByText(/You can view these/)).toBeNull();
  });

  it("falls back to the first module for one the person cannot see, and explains when there is none", async () => {
    permissions = ["process_control.read"];
    const { unmount } = renderAt("/Settings/Data-Management?tab=calibration");
    expect(await screen.findByText("Characteristic templates")).toBeInTheDocument();
    unmount();
    permissions = [];
    renderAt("/Settings/Data-Management");
    expect(screen.getByText(/no access to any module/)).toBeInTheDocument();
  });

  it("shows Competence to people who may read it", async () => {
    permissions = ["competence.read", "competence.manage"];
    renderAt("/Settings/Data-Management?tab=competence");
    expect(await screen.findByText("Skills and positions")).toBeInTheDocument();
    expect(screen.queryByText(/You can view these/)).toBeNull();
  });

  it("shows Custom fields only to people who may manage them", async () => {
    permissions = ["ncr.read"];
    const { unmount } = renderAt("/Settings/Data-Management?tab=custom-fields");
    expect(await screen.findByText("NC lists")).toBeInTheDocument();
    unmount();
    permissions = ["custom_fields.manage"];
    renderAt("/Settings/Data-Management?tab=custom-fields");
    expect(await screen.findByText("Custom field list")).toBeInTheDocument();
  });
});
