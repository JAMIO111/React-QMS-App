import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

let permissions = [];
vi.mock("../../hooks/useQmsApi", () => ({ usePermissions: () => ({ can: (p) => permissions.includes(p) }) }));
vi.mock("./SettingsNonConformance", () => ({ default: () => <p>NC lists</p> }));
vi.mock("./SettingsCalibration", () => ({ default: () => <p>Gauge types</p> }));
vi.mock("./SettingsProcessControl", () => ({ default: () => <p>Characteristic templates</p> }));
vi.mock("./SettingsAudits", () => ({ default: () => <p>Finding classifications</p> }));
vi.mock("./SettingsSupplierQuality", () => ({ default: () => <p>Supplier classifications</p> }));

import SettingsDataManagement from "./SettingsDataManagement";

const Where = () => <span data-testid="where">{useLocation().search}</span>;
const renderAt = (at) =>
  render(
    <MemoryRouter initialEntries={[at]}>
      <Routes>
        <Route path="/Settings/Data-Management" element={<><SettingsDataManagement /><Where /></>} />
      </Routes>
    </MemoryRouter>,
  );

describe("Settings → Data Management", () => {
  it("shows a tab for each module the person may read, opening the first", async () => {
    permissions = ["ncr.read", "calibration.read", "supplier_quality.read"];
    renderAt("/Settings/Data-Management");
    const tabs = screen.getAllByRole("tab").map((t) => t.textContent);
    expect(tabs).toEqual(["Non-conformance", "Calibration", "Supplier quality"]);
    expect(screen.getByRole("tab", { name: "Non-conformance" })).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByText("NC lists")).toBeInTheDocument();
    expect(screen.getByText(/You can view these/)).toBeInTheDocument();
  });

  it("opens the tab named in the address and keeps the choice there", async () => {
    permissions = ["ncr.read", "calibration.read", "calibration.manage", "audits.read"];
    renderAt("/Settings/Data-Management?tab=calibration");
    expect(await screen.findByText("Gauge types")).toBeInTheDocument();
    expect(screen.queryByText(/You can view these/)).toBeNull();
    await userEvent.click(screen.getByRole("tab", { name: "Audits" }));
    expect(await screen.findByText("Finding classifications")).toBeInTheDocument();
    expect(screen.getByTestId("where")).toHaveTextContent("?tab=audits");
  });

  it("falls back to the first tab for a tab the person cannot see, and explains when there is none", async () => {
    permissions = ["process_control.read"];
    const { unmount } = renderAt("/Settings/Data-Management?tab=calibration");
    expect(await screen.findByText("Characteristic templates")).toBeInTheDocument();
    unmount();
    permissions = [];
    renderAt("/Settings/Data-Management");
    expect(screen.getByText(/no access to any module/)).toBeInTheDocument();
  });
});
