import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

let permissions;
const apiFetch = vi.fn();
vi.mock("../../lib/api-client", async (importOriginal) => ({ ...(await importOriginal()), apiFetch: (...a) => apiFetch(...a) }));
vi.mock("../../contexts/OrganisationProvider", () => ({ useOrganisation: () => ({ organisationId: "org-1" }) }));
vi.mock("../../hooks/useQmsApi", () => ({
  usePermissions: () => ({ can: (p) => permissions.includes(p) }),
  useSites: () => ({ data: { data: [{ id: "s1", code: "MAIN", name: "Main site" }] } }),
  useDepartments: () => ({ data: { data: [] } }),
  useMe: () => ({ data: { profile: { id: "u1", firstName: "Ada", surname: "Owner", email: "ada@example.test" } } }),
  useMembers: () => ({ data: { data: [] } }),
}));
vi.mock("@/api/supabaseApi", () => ({ uploadFileToSupabase: vi.fn(), generateSignedUrl: vi.fn() }));
vi.mock("../../contexts/ToastProvider", () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock("../../contexts/SearchProvider", () => ({ useGlobalSearch: () => ({ debouncedSearchTerm: "" }) }));
vi.mock("recharts", async (importOriginal) => {
  const mod = await importOriginal();
  const { cloneElement } = await import("react");
  return { ...mod, ResponsiveContainer: ({ children }) => cloneElement(children, { width: 600, height: 300 }) };
});

import CalibrationDashboard from "./CalibrationDashboard";
import CalibrationRecordPage from "./CalibrationRecordPage";
import GaugePage from "./GaugePage";
import GaugeRegister from "./GaugeRegister";
import { shouldPromptForStatus, statusAfterCalibration } from "../../lib/calibration";
import SettingsCalibration from "../Settings/SettingsCalibration";

const ALL = ["calibration.read", "calibration.manage", "calibration.record", "ncr.create"];

const gauge = (over = {}) => ({
  id: "g1", assetNumber: "G-001", description: "Caliper 150 mm", type: { id: "t1", name: "Digital caliper" }, manufacturer: "Mitutoyo", model: null,
  serialNumber: "SN1", site: { id: "s1", code: "MAIN", name: "Main site" }, department: null, location: "Lab", custodian: null, rangeMin: 0, rangeMax: 150,
  unitCode: "mm", resolution: 0.01, calibrationSource: "internal", supplier: null, intervalValue: 6, intervalUnit: "months", status: "active",
  statusReason: null, lastCalibratedOn: "2026-05-01", nextDueOn: "2026-11-01", daysUntilDue: -3, dueState: "overdue", lastOutcome: "pass",
  calibrationCount: 1, deletedAt: null, createdAt: "2026-01-01T09:00:00Z", commissionedOn: null, notes: null, statusChangedAt: null,
  createdBy: { id: "u1", name: "Ada Owner" }, deletedBy: null, deleteReason: null, updatedAt: "2026-01-01T09:00:00Z", ...over,
});
const characteristics = [
  { id: "k1", sortOrder: 1, name: "25 mm block", nominal: 25, toleranceMinus: 0.02, tolerancePlus: 0.02, lower: 24.98, upper: 25.02, unitCode: "mm", method: null, active: true, templateId: "tk1" },
  { id: "k2", sortOrder: 2, name: "100 mm block", nominal: 100, toleranceMinus: 0.03, tolerancePlus: 0.03, lower: 99.97, upper: 100.03, unitCode: "mm", method: null, active: true, templateId: "tk2" },
];
const record = (over = {}) => ({
  id: "c1", reference: "CAL-26-001", gaugeId: "g1", calibratedOn: "2026-11-02", performedBy: "internal", technician: { id: "u1", name: "Ada Owner" },
  supplier: null, certificateNumber: null, outcome: "fail", nextDueOn: "2027-05-02", readingCount: 2, failedCount: 1, attachmentCount: 0,
  nonconformance: null, createdBy: { id: "u1", name: "Ada Owner" }, createdAt: "2026-11-02T10:00:00Z", deletedAt: null,
  gauge: { id: "g1", assetNumber: "G-001", description: "Caliper 150 mm", status: "quarantined", deleted: false }, procedureRef: null,
  referenceStandards: null, temperatureC: null, humidityPct: null, notes: null, deletedBy: null, deleteReason: null, updatedAt: "2026-11-02T10:00:00Z",
  readings: [
    { id: "r1", characteristicId: "k1", sortOrder: 1, name: "25 mm block", nominal: 25, toleranceMinus: 0.02, tolerancePlus: 0.02, lower: 24.98, upper: 25.02, unitCode: "mm", asFound: 25.05, asLeft: null, asFoundOk: false, asLeftOk: null, notes: null },
    { id: "r2", characteristicId: "k2", sortOrder: 2, name: "100 mm block", nominal: 100, toleranceMinus: 0.03, tolerancePlus: 0.03, lower: 99.97, upper: 100.03, unitCode: "mm", asFound: 100, asLeft: null, asFoundOk: true, asLeftOk: null, notes: null },
  ],
  ...over,
});
const dashboard = {
  period: { from: "2025-11-05", to: "2026-11-04", previousFrom: "2024-11-05", previousTo: "2025-11-04", bucket: "month" },
  today: "2026-11-04",
  kpis: { gauges: 12, inUse: 10, overdue: 2, dueNext30: 3, quarantined: 1, calibrated: 20, calibratedPrevious: 16, failed: 2, firstTimePassRate: 85, compliance: 80 },
  dueSchedule: Array.from({ length: 12 }, (_, i) => ({ start: `2027-${String((i % 12) + 1).padStart(2, "0")}-01`, count: i })),
  outcomes: [{ start: "2026-10-01", pass: 5, adjusted: 1, fail: 1 }],
  byStatus: [{ key: "active", label: "Active", count: 10 }, { key: "quarantined", label: "Quarantined", count: 1 }],
  byType: [{ key: "t1", label: "Digital caliper", count: 7 }],
  attention: [{ id: "g1", assetNumber: "G-001", description: "Caliper 150 mm", status: "active", nextDueOn: "2026-11-01", daysUntilDue: -3, site: "Main site" }],
};

const calls = [];
const routeApi = (routes) =>
  apiFetch.mockImplementation(async (path, opts = {}) => {
    const k = `${opts.method ?? "GET"} ${path.split("?")[0]}`;
    calls.push({ k, path, body: opts.body });
    const all = {
      "GET /units": { data: [{ code: "mm", name: "Millimetre" }, { code: "µm", name: "Micrometre" }] },
      "GET /gauge-types": { data: [{ id: "t1", name: "Digital caliper", description: null, intervalValue: 6, intervalUnit: "months", active: true, characteristicCount: 2, gaugeCount: 1 }] },
      "GET /gauges/g1": gauge(),
      "GET /gauges/g1/characteristics": { data: characteristics },
      "GET /gauges/g1/calibrations": { data: [] },
      "GET /gauges/g1/history": { data: [] },
      "GET /calibrations/c1/attachments": { data: [] },
      ...routes,
    };
    if (!(k in all)) throw new Error(`unexpected ${k}`);
    return typeof all[k] === "function" ? all[k](path, opts) : all[k];
  });

const Where = () => {
  const l = useLocation();
  return <p data-testid="where">{l.pathname + l.search}</p>;
};
const renderAt = (url) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="/Calibration" element={<><CalibrationDashboard /><Where /></>} />
          <Route path="/Calibration/Gauges" element={<><GaugeRegister /><Where /></>} />
          <Route path="/Calibration/Gauges/:id" element={<><GaugePage /><Where /></>} />
          <Route path="/Calibration/Gauges/:gaugeId/calibrations/:calibrationId" element={<><CalibrationRecordPage /><Where /></>} />
          <Route path="/Non-Conformance/:type/:id" element={<Where />} />
          <Route path="/Settings/Calibration" element={<SettingsCalibration />} />
        </Routes>
        <div id="modal-root" />
      </MemoryRouter>
    </QueryClientProvider>
  );
const lastCall = (k) => calls.filter((c) => c.k === k).at(-1);

beforeEach(() => {
  permissions = ALL;
  calls.length = 0;
  apiFetch.mockReset();
});

describe("calibration dashboard", () => {
  it("shows gauge KPIs and links to the filtered register", async () => {
    routeApi({ "GET /calibration-dashboard": dashboard });
    renderAt("/Calibration");
    const overdue = await screen.findByRole("link", { name: /Overdue/ });
    expect(overdue).toHaveTextContent("2");
    expect(screen.getByRole("link", { name: /Quarantined/ })).toHaveTextContent("1");
    expect(screen.getByText("85%")).toBeInTheDocument();
    expect(screen.getByText("Up 25% on previous period")).toBeInTheDocument();
    expect(within(screen.getByRole("table", { name: "Gauges needing attention" })).getByText("3 days overdue")).toBeInTheDocument();
    await userEvent.click(overdue);
    expect(screen.getByTestId("where").textContent).toBe("/Calibration/Gauges?due=overdue");
  });
});

describe("gauge register", () => {
  it("lists gauges, filters from the drawer and offers row actions", async () => {
    routeApi({ "GET /gauges": { data: [gauge()], page: 1, pageSize: 25, total: 1 } });
    renderAt("/Calibration/Gauges");
    const table = await screen.findByRole("region", { name: "Gauges" });
    expect(await within(table).findByText("G-001")).toBeInTheDocument();
    expect(within(table).getByText("Overdue")).toBeInTheDocument();
    expect(lastCall("GET /gauges").path).toContain("sort=nextDueOn&order=asc");

    await userEvent.click(screen.getByRole("button", { name: "Filter" }));
    const pane = await screen.findByRole("dialog", { name: "Filter gauges" });
    await userEvent.click(within(pane).getByText("Overdue"));
    await userEvent.click(within(pane).getByText("Quarantined"));
    await userEvent.click(within(pane).getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(lastCall("GET /gauges").path).toContain("status=quarantined&due=overdue"));
    expect(screen.getByRole("button", { name: /Remove filter Due: Overdue/ })).toBeInTheDocument();

    await userEvent.click(within(table).getByRole("button", { name: "Actions" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Record calibration" }));
    expect(screen.getByTestId("where").textContent).toBe("/Calibration/Gauges/g1/calibrations/new");
  });
});

describe("gauge page", () => {
  it("adds a gauge of a type", async () => {
    routeApi({ "POST /gauges": (path, { body }) => gauge({ id: "g9", assetNumber: body.assetNumber }) , "GET /gauges/g9": gauge({ id: "g9" }), "GET /gauges/g9/characteristics": { data: [] }, "GET /gauges/g9/calibrations": { data: [] }, "GET /gauges/g9/history": { data: [] } });
    renderAt("/Calibration/Gauges/new");
    await userEvent.type(await screen.findByLabelText(/Asset number/), "G-009");
    await userEvent.type(screen.getByLabelText(/^Description/), "Bore gauge");
    await userEvent.click(screen.getByRole("combobox", { name: "Gauge type" }));
    await userEvent.click(await screen.findByRole("option", { name: /Digital caliper/ }));
    await userEvent.click(screen.getByRole("button", { name: "Add gauge" }));
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/Calibration/Gauges/g9"));
    expect(lastCall("POST /gauges").body).toMatchObject({ assetNumber: "G-009", description: "Bore gauge", gaugeTypeId: "t1", calibrationSource: "internal", status: "active" });
    expect(lastCall("POST /gauges").body).not.toHaveProperty("intervalValue");
  });

  it("shows characteristics and the calibration history of a gauge", async () => {
    routeApi({ "GET /gauges/g1/calibrations": { data: [{ ...record(), nonconformance: { id: "n1", reference: "NCM-26-004", source: "internal" } }] } });
    renderAt("/Calibration/Gauges/g1");
    expect(await screen.findByRole("heading", { name: "G-001 · Caliper 150 mm" })).toBeInTheDocument();
    const chars = await screen.findByRole("table", { name: "Calibration characteristics" });
    expect(within(chars).getByText("24.98 to 25.02 mm")).toBeInTheDocument();
    const history = await screen.findByRole("table", { name: "Calibration history" });
    expect(within(history).getByRole("link", { name: "CAL-26-001" })).toHaveAttribute("href", "/Calibration/Gauges/g1/calibrations/c1");
    expect(within(history).getByRole("link", { name: "NCM-26-004" })).toBeInTheDocument();
  });
});

describe("gauge status after a calibration", () => {
  it("offers to update the status after a fail and applies the choice", async () => {
    routeApi({
      "GET /gauges/g1": gauge({ status: "active" }),
      "POST /gauges/g1/calibrations": () => record({ id: "c9", outcome: "fail" }),
      "PATCH /gauges/g1": (_p, o) => ({ ...gauge({ status: "active" }), ...o.body }),
      "GET /calibrations/c9": record({ id: "c9", outcome: "fail" }),
      "GET /calibrations/c9/attachments": { data: [] },
    });
    renderAt("/Calibration/Gauges/g1/calibrations/new");
    await userEvent.type(await screen.findByRole("textbox", { name: "25 mm block as found" }), "26");
    await userEvent.type(screen.getByRole("textbox", { name: "100 mm block as found" }), "100");
    await userEvent.click(screen.getByRole("button", { name: "Save calibration" }));
    const dialog = await screen.findByRole("dialog", { name: "Update gauge status?" });
    await userEvent.click(within(dialog).getByRole("radio", { name: /Out of service/ }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Update status" }));
    await waitFor(() => expect(lastCall("PATCH /gauges/g1").body).toEqual({ status: "out_of_service", statusReason: null }));
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/Calibration/Gauges/g1/calibrations/c9"));
  });

  it("does not ask when a pass leaves an active gauge active", () => {
    expect(shouldPromptForStatus("active", "pass")).toBe(false);
    expect(shouldPromptForStatus("quarantined", "pass")).toBe(false);
    expect(shouldPromptForStatus("lost", "pass")).toBe(true);
    expect(shouldPromptForStatus("active", "fail")).toBe(true);
    expect(statusAfterCalibration("active", "fail")).toBe("quarantined");
  });
});

describe("calibration record", () => {
  it("judges readings as they are typed and saves them", async () => {
    routeApi({ "POST /gauges/g1/calibrations": () => record({ id: "c9", outcome: "adjusted" }), "GET /calibrations/c9": record({ id: "c9", outcome: "adjusted" }), "GET /calibrations/c9/attachments": { data: [] } });
    renderAt("/Calibration/Gauges/g1/calibrations/new");
    const found25 = await screen.findByRole("textbox", { name: "25 mm block as found" });
    await userEvent.type(found25, "25.01");
    await userEvent.type(screen.getByRole("textbox", { name: "100 mm block as found" }), "100.05");
    const readings = screen.getByRole("table", { name: "Readings" });
    expect(within(readings).getAllByText("In")).toHaveLength(1);
    expect(within(readings).getAllByText("Out")).toHaveLength(1);
    expect(screen.getByText("Saving quarantines G-001.")).toBeInTheDocument();
    // Adjusted back into tolerance: outcome "Adjusted".
    await userEvent.type(screen.getByRole("textbox", { name: "100 mm block as left" }), "100.01");
    expect(screen.queryByText("Saving quarantines G-001.")).not.toBeInTheDocument();
    expect(screen.getAllByText("Adjusted").length).toBeGreaterThan(0);

    await userEvent.click(screen.getByRole("button", { name: "Save calibration" }));
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/Calibration/Gauges/g1/calibrations/c9"));
    expect(lastCall("POST /gauges/g1/calibrations").body).toMatchObject({
      performedBy: "internal",
      technicianId: "u1",
      readings: [
        { characteristicId: "k1", asFound: 25.01, asLeft: null },
        { characteristicId: "k2", asFound: 100.05, asLeft: 100.01 },
      ],
    });
  });

  it("needs an outcome when there are no readings", async () => {
    routeApi({ "GET /gauges/g1/characteristics": { data: [] }, "POST /gauges/g1/calibrations": () => record({ id: "c9", readings: [], outcome: "pass" }), "GET /calibrations/c9": record({ id: "c9", readings: [], outcome: "pass" }), "GET /calibrations/c9/attachments": { data: [] } });
    renderAt("/Calibration/Gauges/g1/calibrations/new");
    const save = await screen.findByRole("button", { name: "Save calibration" });
    expect(save).toBeDisabled();
    await userEvent.click(screen.getByRole("radio", { name: "Pass" }));
    expect(save).toBeEnabled();
    await userEvent.click(save);
    await waitFor(() => expect(lastCall("POST /gauges/g1/calibrations").body).toMatchObject({ outcome: "pass" }));
    expect(lastCall("POST /gauges/g1/calibrations").body).not.toHaveProperty("readings");
  });

  it("raises an NC for a failed calibration", async () => {
    routeApi({ "GET /calibrations/c1": record(), "POST /calibrations/c1/raise-ncr": { id: "n7", reference: "NCM-26-007", source: "internal" } });
    renderAt("/Calibration/Gauges/g1/calibrations/c1");
    expect(await screen.findByRole("heading", { name: "Calibration CAL-26-001" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "25 mm block as found" })).toHaveValue("25.05");
    await userEvent.click(screen.getByRole("button", { name: "Raise NC" }));
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/Non-Conformance/Internal/n7"));
  });

  it("does not offer Raise NC without permission or when already raised", async () => {
    permissions = ["calibration.read", "calibration.record"];
    routeApi({ "GET /calibrations/c1": record() });
    renderAt("/Calibration/Gauges/g1/calibrations/c1");
    await screen.findByRole("heading", { name: "Calibration CAL-26-001" });
    expect(screen.queryByRole("button", { name: "Raise NC" })).not.toBeInTheDocument();
  });
});

describe("settings", () => {
  it("adds a gauge type", async () => {
    routeApi({ "POST /gauge-types": (path, { body }) => ({ id: "t2", ...body, active: true, characteristicCount: 0, gaugeCount: 0 }) });
    renderAt("/Settings/Calibration");
    expect(await screen.findByText("Digital caliper")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Add gauge type" }));
    await userEvent.type(screen.getByPlaceholderText(/e.g. Digital caliper/), "Micrometer 0-25");
    await userEvent.clear(screen.getByRole("textbox", { name: "Interval" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Interval" }), "1");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Interval unit" }), "years");
    await userEvent.click(screen.getByRole("button", { name: "Add type" }));
    await waitFor(() => expect(lastCall("POST /gauge-types").body).toEqual({ name: "Micrometer 0-25", description: null, intervalValue: 1, intervalUnit: "years" }));
  });
});

describe("pass/fail checks", () => {
  const check = { id: "k9", sortOrder: 3, kind: "attribute", name: "Free from damage", nominal: null, toleranceMinus: null, tolerancePlus: null, lower: null, upper: null, unitCode: null, method: null, active: true, templateId: null };

  it("adds a pass/fail characteristic without limits", async () => {
    routeApi({ "POST /gauges/g1/characteristics": (path, { body }) => ({ ...check, ...body }), "GET /gauges/g1/calibrations": { data: [] } });
    renderAt("/Calibration/Gauges/g1");
    await userEvent.click(await screen.findByRole("button", { name: "Add characteristic" }));
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Type of check" }), "attribute");
    expect(screen.queryByRole("textbox", { name: "Nominal" })).not.toBeInTheDocument();
    await userEvent.type(screen.getByRole("textbox", { name: "Characteristic" }), "Valid certificate");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(lastCall("POST /gauges/g1/characteristics").body).toEqual({ kind: "attribute", name: "Valid certificate", method: null }));
  });

  it("records a check as pass or fail", async () => {
    routeApi({
      "GET /gauges/g1/characteristics": { data: [...characteristics, check] },
      "POST /gauges/g1/calibrations": () => record({ id: "c9" }),
      "GET /calibrations/c9": record({ id: "c9" }),
      "GET /calibrations/c9/attachments": { data: [] },
    });
    renderAt("/Calibration/Gauges/g1/calibrations/new");
    await userEvent.type(await screen.findByRole("textbox", { name: "25 mm block as found" }), "25");
    await userEvent.type(screen.getByRole("textbox", { name: "100 mm block as found" }), "100");
    const asFound = screen.getByRole("radiogroup", { name: "Free from damage as found" });
    await userEvent.click(within(asFound).getByRole("radio", { name: "Fail" }));
    expect(screen.getByText("Saving quarantines G-001.")).toBeInTheDocument();
    // Reworked: pass as left → adjusted.
    await userEvent.click(within(screen.getByRole("radiogroup", { name: "Free from damage as left" })).getByRole("radio", { name: "Pass" }));
    expect(screen.queryByText("Saving quarantines G-001.")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Save calibration" }));
    await waitFor(() => expect(lastCall("POST /gauges/g1/calibrations").body.readings).toEqual([
      { characteristicId: "k1", asFound: 25, asLeft: null, notes: null },
      { characteristicId: "k2", asFound: 100, asLeft: null, notes: null },
      { characteristicId: "k9", asFoundPass: false, asLeftPass: true, notes: null },
    ]));
  });
});
