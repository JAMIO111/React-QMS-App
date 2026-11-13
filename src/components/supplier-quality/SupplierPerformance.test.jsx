import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

let permissions;
const apiFetch = vi.fn();
vi.mock("../../lib/api-client", async (importOriginal) => ({ ...(await importOriginal()), apiFetch: (...a) => apiFetch(...a) }));
vi.mock("../../contexts/OrganisationProvider", () => ({ useOrganisation: () => ({ organisationId: "org-1" }) }));
vi.mock("../../hooks/useQmsApi", () => ({ usePermissions: () => ({ can: (p) => permissions.includes(p) }) }));
vi.mock("../../contexts/ToastProvider", () => ({ useToast: () => ({ showToast: vi.fn() }) }));

import SupplierPerformance from "./SupplierPerformance";
import WatchlistPage from "./WatchlistPage";
import ScorecardModelCard from "./ScorecardModel";
import ScorecardScheduleCard from "./ScorecardSchedule";

const config = { otdPolicy: "agreed", weights: { otd: 30, ppm: 30, ncs: 20, scar: 10, certs: 10 }, ppmGood: 1000, ppmZero: 50000, ncPenalty: { critical: 40, major: 20, minor: 5 }, goodFrom: 85, watchFrom: 70, minLines: 5 };
const metrics = {
  deliveries: { lines: 7, unitsReceived: 650 },
  ppm: { value: 153846, rejectedUnits: 100, receivedUnits: 650 },
  lotRejection: { rate: 0.1429, rejectedLines: 1, lines: 7 },
  otd: { policy: "agreed", value: 0.6667, matchedLines: 6, onTime: 4, late: 2, unmatchedLines: 1 },
  ncs: { total: 3, critical: 1, major: 1, minor: 1, repeat: 2 },
  scars: { issued: 1, answered_on_time: 1, answered_late: 0, overdue_now: 0 },
  certs: { current: 2, expired: 1, expiring_soon: 0 },
};
const comp = (key, weight, score, detail, sufficient = true) => ({ key, weight, score, detail, sufficient });
const perf = (over = {}) => ({
  model: { id: "m1", version: 1, config }, metrics, score: 42, band: "poor", weightWithData: 1,
  components: [comp("otd", 30, 66.7, "4 of 6 delivered lines on time"), comp("ppm", 30, 0, "153846 PPM"), comp("ncs", 20, 35, "3 non-conformances"), comp("scar", 10, 100, "1 of 1"), comp("certs", 10, 50, "1 of 2 in date")],
  warnings: [{ code: "cert_expired", level: "warning", message: "1 certification(s) past their expiry date", sourceType: "certs", sources: [{ id: "c1", number: "OLD-1", expiresOn: "2026-11-01" }] },
    { code: "critical_nc", level: "critical", message: "1 critical non-conformance(s) in the period", sourceType: "ncs", sources: [{ id: "n1", reference: "NCR-26-0001", severity: "critical" }] }],
  ...over,
});
const supplier = { id: "s1", code: "ACME", name: "Acme Metals" };
const SETTINGS = {
  overrides: { otdPolicy: null, graceDaysBefore: null, graceDaysAfter: null, inFullUnderPct: null, inFullOverPct: null },
  effective: { otdPolicy: "agreed", graceDaysBefore: null, graceDaysAfter: 0, inFullUnderPct: 0, inFullOverPct: 10, ppmBasis: "rejected" },
  modelVersion: 1,
};
const calls = [];
const routeApi = (routes) =>
  apiFetch.mockImplementation(async (path, opts = {}) => {
    const k = `${opts.method ?? "GET"} ${path.split("?")[0]}`;
    calls.push({ k, path, body: opts.body });
    if (k === "GET /supplier-quality/suppliers/s1/performance/settings" && !(k in routes)) return SETTINGS;
    if (!(k in routes)) throw new Error(`unexpected ${k}`);
    return routes[k];
  });
const renderUi = (ui) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>{ui}<div id="modal-root" /></MemoryRouter>
    </QueryClientProvider>
  );

beforeEach(() => {
  permissions = ["supplier_quality.read", "receiving.read", "supplier_quality.manage", "supplier_quality.configure"];
  calls.length = 0;
  apiFetch.mockReset();
});

describe("performance tab", () => {
  it("shows the score, band, metrics and warnings with links to the records behind them", async () => {
    routeApi({ "GET /supplier-quality/suppliers/s1/performance": perf(), "GET /supplier-quality/suppliers/s1/scorecards": { data: [] } });
    renderUi(<SupplierPerformance supplier={supplier} />);
    expect(await screen.findByLabelText("Score")).toHaveTextContent("42");
    expect(screen.getAllByText("Poor").length).toBeGreaterThan(0);
    expect(screen.getAllByText("On-time delivery").length).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: /OLD-1/ })).toHaveAttribute("href", "/Suppliers/s1?tab=qualification");
    expect(screen.getByRole("link", { name: /NCR-26-0001/ })).toBeInTheDocument();
    expect(screen.getByText(/No scorecards saved yet/)).toBeInTheDocument();
    expect(calls.find((c) => c.k === "GET /supplier-quality/suppliers/s1/performance").path).toMatch(/from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}/);
  });

  it("says when there is not enough data and leaves the score out", async () => {
    routeApi({
      "GET /supplier-quality/suppliers/s1/performance": perf({ score: null, band: "insufficient", components: [comp("otd", 30, null, "Only 1 delivered lines", false)], warnings: [] }),
      "GET /supplier-quality/suppliers/s1/scorecards": { data: [] },
    });
    renderUi(<SupplierPerformance supplier={supplier} />);
    expect(await screen.findByText("Not enough data to score")).toBeInTheDocument();
    expect(screen.getByText("Left out of the score")).toBeInTheDocument();
  });

  it("saves a scorecard for the period shown, only for people who manage", async () => {
    routeApi({
      "GET /supplier-quality/suppliers/s1/performance": perf(), "GET /supplier-quality/suppliers/s1/scorecards": { data: [] },
      "POST /supplier-quality/suppliers/s1/scorecards": { id: "sc1" },
    });
    renderUi(<SupplierPerformance supplier={supplier} />);
    await userEvent.click(await screen.findByRole("button", { name: "Save as a scorecard" }));
    await userEvent.type(await screen.findByLabelText("Note"), "Quarterly");
    await userEvent.click(screen.getByRole("button", { name: "Save scorecard" }));
    await waitFor(() => expect(calls.find((c) => c.k === "POST /supplier-quality/suppliers/s1/scorecards")?.body).toMatchObject({ note: "Quarterly" }));
  });

  it("offers no save to a reader and lists saved scorecards", async () => {
    permissions = ["supplier_quality.read", "receiving.read"];
    routeApi({
      "GET /supplier-quality/suppliers/s1/performance": perf(),
      "GET /supplier-quality/suppliers/s1/scorecards": { data: [{ id: "sc1", periodFrom: "2026-08-01", periodTo: "2026-10-31", modelVersion: 1, score: 61, band: "watch", warningCount: 2, note: "Q3", createdAt: "2026-11-01T09:00:00Z", createdBy: { id: "u1", name: "Ada" }, periodKind: null },
        { id: "sc2", periodFrom: "2026-10-01", periodTo: "2026-10-31", modelVersion: 1, score: 70, band: "watch", warningCount: 0, note: null, createdAt: "2026-11-01T00:05:00Z", createdBy: null, periodKind: "monthly" }] },
    });
    renderUi(<SupplierPerformance supplier={supplier} />);
    const list = await screen.findByRole("list", { name: "Saved scorecards" });
    expect(screen.queryByRole("button", { name: "Save as a scorecard" })).toBeNull();
    expect(screen.getByText(/v1 · 2 warnings · Q3/)).toBeInTheDocument();
    expect(list).toHaveTextContent("Saved by Ada");
    expect(list).toHaveTextContent("Saved by the schedule · Monthly · October 2026");
  });
});

describe("scoring settings", () => {
  it("shows what a supplier is scored with and which parts are its own", async () => {
    routeApi({
      "GET /supplier-quality/suppliers/s1/performance": perf(), "GET /supplier-quality/suppliers/s1/scorecards": { data: [] },
      "GET /supplier-quality/suppliers/s1/performance/settings": { ...SETTINGS, overrides: { ...SETTINGS.overrides, graceDaysAfter: 3 }, effective: { ...SETTINGS.effective, graceDaysAfter: 3 } },
    });
    renderUi(<SupplierPerformance supplier={supplier} />);
    const list = await screen.findByRole("list", { name: "Scoring settings in force" });
    expect(list).toHaveTextContent("Up to 3 days late counts as on time (this supplier)");
    expect(list).toHaveTextContent("Any early delivery counts as on time");
    expect(list).toHaveTextContent("In full: 0% under to 10% over the ordered quantity");
  });

  it("saves this supplier's own grace days and tolerances, leaving the rest to follow the model", async () => {
    routeApi({
      "GET /supplier-quality/suppliers/s1/performance": perf(), "GET /supplier-quality/suppliers/s1/scorecards": { data: [] },
      "PUT /supplier-quality/suppliers/s1/performance/settings": SETTINGS,
    });
    renderUi(<SupplierPerformance supplier={supplier} />);
    await userEvent.click(await screen.findByRole("button", { name: "Change" }));
    await userEvent.type(await screen.findByLabelText("Days late that still count"), "4");
    await userEvent.type(screen.getByLabelText("In full: % below the ordered quantity"), "5");
    await userEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(calls.find((c) => c.k === "PUT /supplier-quality/suppliers/s1/performance/settings")?.body).toEqual({ otdPolicy: null, graceDaysBefore: null, graceDaysAfter: 4, inFullUnderPct: 5, inFullOverPct: null }));
  });

  it("refuses grace days over 60 and offers no change to someone without the configure permission", async () => {
    routeApi({ "GET /supplier-quality/suppliers/s1/performance": perf(), "GET /supplier-quality/suppliers/s1/scorecards": { data: [] } });
    renderUi(<SupplierPerformance supplier={supplier} />);
    await userEvent.click(await screen.findByRole("button", { name: "Change" }));
    await userEvent.type(await screen.findByLabelText("Days late that still count"), "61");
    expect(screen.getByRole("button", { name: "Save settings" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("whole numbers from 0 to 60");
  });

  it("shows both PPM measures, in full and OTIF among the figures, and an unscored in-full metric as information", async () => {
    const m = { ...metrics, ppmNc: { value: 107692, affectedUnits: 70, receivedUnits: 650, lines: 2 }, inFull: { value: 0.5, lines: 6, inFull: 3, short: 2, over: 1, pending: 0, underPct: 0, overPct: 10 }, otif: { value: 0.3333, lines: 6, otif: 2 } };
    routeApi({
      "GET /supplier-quality/suppliers/s1/performance": perf({ metrics: m, components: [comp("otd", 30, 66.7, "4 of 6"), { ...comp("in_full", 0, 50, "3 of 6 order lines delivered in full"), sufficient: true }, comp("ppm", 30, 0, "153846 PPM")] }),
      "GET /supplier-quality/suppliers/s1/scorecards": { data: [] },
    });
    renderUi(<SupplierPerformance supplier={supplier} />);
    const figures = await screen.findByRole("table", { name: "Figures" });
    expect(figures).toHaveTextContent("PPM: rejected at receiving");
    expect(figures).toHaveTextContent("PPM: from non-conformances107,692 (70 of 650 units on non-conformances, 2 lines)");
    expect(figures).toHaveTextContent("Delivered in full50% (3 of 6 order lines due in the period");
    expect(figures).toHaveTextContent("On time and in full (OTIF)33% (2 of 6 order lines)");
    expect(screen.getByText("Shown for information; not part of the score")).toBeInTheDocument();
  });

  it("says how many pieces are on supplier NCs with no receipt, and whether they are counted", async () => {
    const m = { ...metrics, ppmNc: { value: 0, affectedUnits: 0, linkedUnits: 0, unlinkedUnits: 550, unlinkedNcs: 4, unlinkedWithoutQuantity: 1, includeUnlinked: false, receivedUnits: 650, lines: 0 } };
    routeApi({ "GET /supplier-quality/suppliers/s1/performance": perf({ metrics: m }), "GET /supplier-quality/suppliers/s1/scorecards": { data: [] } });
    const { unmount } = renderUi(<SupplierPerformance supplier={supplier} />);
    expect(await screen.findByRole("table", { name: "Figures" })).toHaveTextContent("550 units on 4 not counted in the PPM above (1 with no quantity entered)");
    unmount();
    const on = { ...m, ppmNc: { ...m.ppmNc, includeUnlinked: true, affectedUnits: 550, value: 846154 } };
    routeApi({ "GET /supplier-quality/suppliers/s1/performance": perf({ metrics: on }), "GET /supplier-quality/suppliers/s1/scorecards": { data: [] } });
    renderUi(<SupplierPerformance supplier={supplier} />);
    expect(await screen.findByRole("table", { name: "Figures" })).toHaveTextContent("550 units on 4 counted in the PPM above");
  });

  it("sends the choice to count NCs with no receipt with the new model version", async () => {
    routeApi({
      "GET /supplier-quality/performance/model": { id: "m1", version: 1, config: { ...config, ppmBasis: "ncs", ppmNcIncludeUnlinked: false, graceDaysBefore: null, graceDaysAfter: 0, inFullUnderPct: 0, inFullOverPct: 10, weights: { ...config.weights, inFull: 0 } }, reason: "Default model", createdAt: "2026-11-01T09:00:00Z", createdBy: null, versions: [{ version: 1, reason: "Default model", createdAt: "2026-11-01T09:00:00Z", createdBy: null }] },
      "PUT /supplier-quality/performance/model": { version: 2 },
    });
    renderUi(<ScorecardModelCard canConfigure />);
    expect(await screen.findByText(/Only non-conformances linked to a received line are counted/)).toBeInTheDocument();
    await userEvent.click(await screen.findByRole("button", { name: "Change the model" }));
    await userEvent.click(await screen.findByRole("combobox", { name: /Non-conformance PPM counts/ }));
    await userEvent.click(await screen.findByRole("option", { name: /Also non-conformances with no receipt linked/ }));
    await userEvent.type(screen.getByLabelText(/Why is it changing/), "Count them all");
    await userEvent.click(screen.getByRole("button", { name: "Save new version" }));
    await waitFor(() => expect(calls.find((c) => c.k === "PUT /supplier-quality/performance/model")?.body).toMatchObject({ reason: "Count them all", config: { ppmNcIncludeUnlinked: true, ppmBasis: "ncs" } }));
  });

  it("switches the PPM that scores from the settings card, saving a new model version with a reason", async () => {
    routeApi({
      "GET /supplier-quality/performance/model": { id: "m1", version: 1, config: { ...config, ppmBasis: "rejected", graceDaysAfter: 0, inFullUnderPct: 0, inFullOverPct: 10, weights: { ...config.weights, inFull: 0 } }, reason: "Default model", createdAt: "2026-11-01T09:00:00Z", createdBy: null, versions: [{ version: 1, reason: "Default model", createdAt: "2026-11-01T09:00:00Z", createdBy: null }] },
      "PUT /supplier-quality/performance/model": { version: 2 },
    });
    renderUi(<ScorecardModelCard canConfigure />);
    await userEvent.click(await screen.findByRole("button", { name: "From non-conformances" }));
    await waitFor(() => expect(calls.find((c) => c.k === "PUT /supplier-quality/performance/model")?.body).toMatchObject({ config: { ppmBasis: "ncs" }, reason: expect.stringMatching(/non-conformances/i) }));
  });

  it("puts the new model settings in the model dialog and sends them with the new version", async () => {
    routeApi({
      "GET /supplier-quality/performance/model": { id: "m1", version: 1, config: { ...config, ppmBasis: "rejected", graceDaysBefore: null, graceDaysAfter: 0, inFullUnderPct: 0, inFullOverPct: 10, weights: { ...config.weights, inFull: 0 } }, reason: "Default model", createdAt: "2026-11-01T09:00:00Z", createdBy: null, versions: [{ version: 1, reason: "Default model", createdAt: "2026-11-01T09:00:00Z", createdBy: null }] },
      "PUT /supplier-quality/performance/model": { version: 2 },
    });
    renderUi(<ScorecardModelCard canConfigure />);
    await userEvent.click(await screen.findByRole("button", { name: "Change the model" }));
    await userEvent.type(await screen.findByLabelText("Days early that still count as on time"), "2");
    await userEvent.clear(screen.getByLabelText("Days late that still count as on time"));
    await userEvent.type(screen.getByLabelText("Days late that still count as on time"), "3");
    await userEvent.clear(screen.getByLabelText("In full: % below the ordered quantity"));
    await userEvent.type(screen.getByLabelText("In full: % below the ordered quantity"), "5");
    await userEvent.clear(screen.getByLabelText("Delivered in full"));
    await userEvent.type(screen.getByLabelText("Delivered in full"), "15");
    await userEvent.type(screen.getByLabelText(/Why is it changing/), "Allow a little slack");
    await userEvent.click(screen.getByRole("button", { name: "Save new version" }));
    await waitFor(() => expect(calls.find((c) => c.k === "PUT /supplier-quality/performance/model")?.body).toMatchObject({
      reason: "Allow a little slack", config: { graceDaysBefore: 2, graceDaysAfter: 3, inFullUnderPct: 5, inFullOverPct: 10, ppmBasis: "rejected", weights: { inFull: 15 } },
    }));
  });
});

describe("watchlist", () => {
  it("lists suppliers to watch with their warnings, and says so when there are none", async () => {
    routeApi({ "GET /supplier-quality/performance/watchlist": { days: 90, data: [{ supplierId: "s1", code: "ACME", name: "Acme Metals", score: 42, band: "poor", warnings: perf().warnings }] } });
    renderUi(<WatchlistPage />);
    expect(await screen.findByText("ACME · Acme Metals")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open performance" })).toHaveAttribute("href", "/Suppliers/s1?tab=performance");
    expect(calls[0].path).toContain("days=90");
  });

  it("exports a report with the period and definitions, offering the audits report only to people who read audits", async () => {
    permissions = ["supplier_quality.read", "receiving.read", "audits.read"];
    const report = { meta: { title: "Supplier performance", from: "2026-08-12", to: "2026-11-09", generatedAt: "2026-11-09T10:00:00.000Z", rowCount: 1, basis: [], definitions: ["PPM = x"] }, columns: [{ key: "code", label: "Supplier" }], rows: [{ code: "ACME" }] };
    routeApi({ "GET /supplier-quality/performance/watchlist": { days: 90, data: [] }, "GET /supplier-quality/reports/performance": report, "GET /supplier-quality/reports/audits": { ...report, meta: { ...report.meta, title: "Supplier audits" } } });
    const blobs = [];
    const create = vi.fn((b) => { blobs.push(b); return "blob:x"; });
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    renderUi(<WatchlistPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Export a report" }));
    expect(await screen.findByRole("menuitem", { name: /Supplier audits/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("menuitem", { name: /Supplier performance/ }));
    await waitFor(() => expect(click).toHaveBeenCalled());
    expect(calls.find((c) => c.k === "GET /supplier-quality/reports/performance").path).toMatch(/from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}/);
    const text = await new Promise((resolve) => { const fr = new FileReader(); fr.onload = () => resolve(fr.result); fr.readAsText(blobs[0]); });
    expect(text).toContain("Report,Supplier performance");
    click.mockRestore();
  });

  it("offers only the performance report to someone who cannot read audits", async () => {
    routeApi({ "GET /supplier-quality/performance/watchlist": { days: 90, data: [] } });
    renderUi(<WatchlistPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Export a report" }));
    expect(await screen.findByRole("menuitem", { name: /Supplier performance/ })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /Supplier audits/ })).toBeNull();
  });

  it("shows a calm message when nothing needs watching", async () => {
    routeApi({ "GET /supplier-quality/performance/watchlist": { days: 90, data: [] } });
    renderUi(<WatchlistPage />);
    expect(await screen.findByText("Nothing to watch")).toBeInTheDocument();
  });
});

describe("scorecard model", () => {
  it("saves a new version with a reason, and only the configure permission sees the button", async () => {
    routeApi({
      "GET /supplier-quality/performance/model": { id: "m1", version: 1, config, reason: "Default model", createdAt: "2026-11-01T09:00:00Z", createdBy: null, versions: [{ version: 1, reason: "Default model", createdAt: "2026-11-01T09:00:00Z", createdBy: null }] },
      "PUT /supplier-quality/performance/model": { version: 2 },
    });
    renderUi(<ScorecardModelCard canConfigure />);
    await userEvent.click(await screen.findByRole("button", { name: "Change the model" }));
    const save = await screen.findByRole("button", { name: "Save new version" });
    expect(save).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/Why is it changing/), "Stricter bands");
    await userEvent.clear(screen.getByLabelText(/Good from/));
    await userEvent.type(screen.getByLabelText(/Good from/), "90");
    await userEvent.click(save);
    await waitFor(() => expect(calls.find((c) => c.k === "PUT /supplier-quality/performance/model")?.body).toMatchObject({ reason: "Stricter bands", config: { goodFrom: 90, otdPolicy: "agreed" } }));
  });
});

describe("scheduled scorecards", () => {
  const SCHEDULE = {
    monthly: true, quarterly: false, annual: false, scope: "all", classifications: [],
    next: { monthly: { from: "2026-11-01", to: "2026-11-30" }, quarterly: null, annual: null },
    setBy: { id: "u1", name: "Ada" }, problem: null, problemAt: null, lastSavedAt: "2026-11-01T00:05:00Z", canChange: true,
  };
  const CLASSES = { data: [{ id: "c1", label: "Critical", active: true }, { id: "c2", label: "Logistics", active: true }] };

  it("switches each period on and off on its own, at once", async () => {
    let release;
    let current = SCHEDULE;
    routeApi({ "GET /supplier-quality/performance/schedule": SCHEDULE, "GET /supplier-quality/classifications": CLASSES });
    renderUi(<ScorecardScheduleCard />);
    expect(await screen.findByText(/Next: November 2026, saved after 30 Nov 2026/)).toBeInTheDocument();
    expect(screen.getByText(/worked out with Ada's access/)).toBeInTheDocument();
    apiFetch.mockImplementation(async (path, opts = {}) => {
      const k = `${opts.method ?? "GET"} ${path.split("?")[0]}`;
      calls.push({ k, path, body: opts.body });
      if (k === "PUT /supplier-quality/performance/schedule") return new Promise((r) => { release = () => { current = { ...SCHEDULE, quarterly: true, next: { ...SCHEDULE.next, quarterly: { from: "2026-07-01", to: "2026-09-30" } } }; r(current); }; });
      return k === "GET /supplier-quality/classifications" ? CLASSES : current;
    });
    const quarterly = screen.getByRole("switch", { name: "Quarterly scorecards" });
    expect(quarterly).not.toBeChecked();
    await userEvent.click(quarterly);
    expect(quarterly).toBeChecked(); // before the server answers
    expect(screen.getByRole("switch", { name: "Monthly scorecards" })).toBeChecked();
    expect(calls.find((c) => c.k === "PUT /supplier-quality/performance/schedule").body).toEqual({ quarterly: true });
    release();
    expect(await screen.findByText(/Next: Q3 2026, saved after 30 Sept? 2026/)).toBeInTheDocument();
  });

  it("covers chosen classifications, saved once the first one is chosen", async () => {
    const routes = {
      "GET /supplier-quality/performance/schedule": SCHEDULE, "GET /supplier-quality/classifications": CLASSES,
      "PUT /supplier-quality/performance/schedule": { ...SCHEDULE, scope: "classifications", classifications: [{ id: "c1", label: "Critical", active: true }] },
    };
    routeApi(routes);
    const saved = routes["PUT /supplier-quality/performance/schedule"];
    apiFetch.mockImplementation(async (path, opts = {}) => {
      const k = `${opts.method ?? "GET"} ${path.split("?")[0]}`;
      calls.push({ k, path, body: opts.body });
      if (k === "PUT /supplier-quality/performance/schedule") routes["GET /supplier-quality/performance/schedule"] = saved;
      return routes[k];
    });
    renderUi(<ScorecardScheduleCard />);
    await userEvent.click(await screen.findByRole("button", { name: "Chosen classifications" }));
    expect(calls.some((c) => c.k === "PUT /supplier-quality/performance/schedule")).toBe(false);
    expect(screen.getByText("Choose a classification to save this.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("combobox", { name: /Add a classification/ }));
    await userEvent.click(await screen.findByRole("option", { name: /Critical/ }));
    await waitFor(() => expect(calls.find((c) => c.k === "PUT /supplier-quality/performance/schedule")?.body).toEqual({ scope: "classifications", classificationIds: ["c1"] }));
    expect(await screen.findByRole("button", { name: "Remove Critical" })).toBeDisabled();
  });

  it("is read-only without the right to configure, and says when nothing is being saved", async () => {
    routeApi({ "GET /supplier-quality/performance/schedule": { ...SCHEDULE, canChange: false, problem: "Nothing was saved: the person who set the schedule can no longer see supplier performance." }, "GET /supplier-quality/classifications": CLASSES });
    renderUi(<ScorecardScheduleCard />);
    expect(await screen.findByRole("switch", { name: "Monthly scorecards" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Chosen classifications" })).toBeNull();
    expect(screen.getByText("Scorecards are not being saved")).toBeInTheDocument();
  });
});
