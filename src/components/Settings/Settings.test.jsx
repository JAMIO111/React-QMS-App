import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";

let permissions = [];
vi.mock("../../hooks/useQmsApi", () => ({
  usePermissions: () => ({ can: (p) => permissions.includes(p) }),
  useCanSee: () => (p) => !p || (Array.isArray(p) ? p.some((x) => permissions.includes(x)) : permissions.includes(p)),
}));
vi.mock("./SettingsNonConformance", () => ({ default: () => <p>NC lists</p> }));
vi.mock("./SettingsCalibration", () => ({ default: () => <p>Gauge types</p> }));
vi.mock("./SettingsAudits", () => ({ default: () => <p>Finding classifications</p> }));
vi.mock("../custom-fields/CustomFieldsSettings", () => ({ default: () => <p>Custom field list</p> }));

import Settings from "./Settings";
import SettingsDataManagement from "./SettingsDataManagement";

const Where = () => {
  const l = useLocation();
  return <span data-testid="where">{l.pathname + l.search}</span>;
};
const renderAt = (at) =>
  render(
    <MemoryRouter initialEntries={[at]}>
      <Routes>
        <Route path="/Settings" element={<Settings />}>
          <Route index element={<Navigate to="Organisation" replace />} />
          <Route path="Organisation" element={<p>Organisation page</p>} />
          <Route path="Data-Management" element={<SettingsDataManagement />} />
        </Route>
      </Routes>
      <Where />
    </MemoryRouter>,
  );

describe("the settings pane", () => {
  it("opens as the Settings menu, without the back button", () => {
    permissions = ["ncr.read", "calibration.read"];
    renderAt("/Settings/Organisation");
    expect(screen.getByRole("heading", { name: "Settings" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Data" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Back to Settings" })).toBeNull();
    expect(within(screen.getByRole("navigation", { name: "Settings" })).getByRole("link", { name: "Data Management" })).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Data" })).toBeNull();
  });

  it("changes to a Data menu with a back button when Data Management is chosen, listing the modules as its items", async () => {
    permissions = ["ncr.read", "calibration.read", "audits.read", "custom_fields.manage"];
    renderAt("/Settings/Organisation");
    await userEvent.click(screen.getByRole("link", { name: "Data Management" }));
    expect(screen.getByRole("heading", { name: "Data" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Settings" })).toBeNull();
    const data = screen.getByRole("navigation", { name: "Data" });
    expect(within(data).getAllByRole("link").map((l) => l.textContent)).toEqual(["Non-conformance", "Calibration", "Audits", "Custom fields"]);
    expect(screen.queryByRole("navigation", { name: "Settings" })).toBeNull();
    expect(await screen.findByText("NC lists")).toBeInTheDocument();
    expect(within(data).getByRole("link", { name: "Non-conformance" })).toHaveAttribute("aria-current", "page");
    // The page has no tab bar or heading of its own any more.
    expect(screen.queryByRole("tab")).toBeNull();
  });

  it("switches the module from the nested menu and keeps the choice in the address", async () => {
    permissions = ["ncr.read", "calibration.read", "audits.read"];
    renderAt("/Settings/Data-Management");
    await userEvent.click(screen.getByRole("link", { name: "Audits" }));
    expect(await screen.findByText("Finding classifications")).toBeInTheDocument();
    expect(screen.getByTestId("where")).toHaveTextContent("/Settings/Data-Management?tab=audits");
    expect(screen.getByRole("link", { name: "Audits" })).toHaveAttribute("aria-current", "page");
  });

  it("opens straight on the nested menu for a link to a module", () => {
    permissions = ["ncr.read", "calibration.read"];
    renderAt("/Settings/Data-Management?tab=calibration");
    expect(screen.getByRole("heading", { name: "Data" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Calibration" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: "Back to Settings" })).toBeInTheDocument();
  });

  it("goes back to the Settings menu with the back button", async () => {
    permissions = ["ncr.read", "calibration.read"];
    renderAt("/Settings/Data-Management?tab=calibration");
    await userEvent.click(screen.getByRole("button", { name: "Back to Settings" }));
    expect(await screen.findByRole("heading", { name: "Settings" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Data" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Back to Settings" })).toBeNull();
    expect(screen.getByTestId("where")).toHaveTextContent("/Settings/Organisation");
    expect(screen.getByText("Organisation page")).toBeInTheDocument();
  });

  // Below the md width the menu and the page are one pane at a time; the markup always has both, the classes decide which shows.
  describe("on a phone (one pane at a time)", () => {
    it("shows the menu alone at /Settings and the page alone with a back bar once a page is chosen", () => {
      permissions = ["ncr.read"];
      const { container, unmount } = renderAt("/Settings/Organisation");
      const menu = container.querySelector("nav[aria-label='Settings']").closest("div.border-r");
      const page = screen.getByText("Organisation page").parentElement;
      expect(menu.className).toMatch(/\bhidden\b/);
      expect(menu.className).toMatch(/md:flex/);
      expect(page.className).toMatch(/\bflex\b/);
      expect(page.className).not.toMatch(/\bhidden\b/);
      expect(screen.getByRole("button", { name: "Settings" })).toBeInTheDocument();
      unmount();
    });

    it("the back bar goes to the menu: Settings from a page, the Data menu from a module", async () => {
      permissions = ["ncr.read", "calibration.read"];
      renderAt("/Settings/Data-Management?tab=calibration");
      const back = screen.getAllByRole("button").find((b) => b.textContent === "Data");
      await userEvent.click(back);
      expect(screen.getByTestId("where")).toHaveTextContent("/Settings/Data-Management");
      expect(screen.getByTestId("where")).not.toHaveTextContent("tab=");
    });
  });
});
