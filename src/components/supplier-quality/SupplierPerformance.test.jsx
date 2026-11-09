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
const calls = [];
const routeApi = (routes) =>
  apiFetch.mockImplementation(async (path, opts = {}) => {
    const k = `${opts.method ?? "GET"} ${path.split("?")[0]}`;
    calls.push({ k, path, body: opts.body });
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
    expect(calls[0].path).toMatch(/from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}/);
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
      "GET /supplier-quality/suppliers/s1/scorecards": { data: [{ id: "sc1", periodFrom: "2026-08-01", periodTo: "2026-10-31", modelVersion: 1, score: 61, band: "watch", warningCount: 2, note: "Q3", createdAt: "2026-11-01T09:00:00Z", createdBy: { id: "u1", name: "Ada" } }] },
    });
    renderUi(<SupplierPerformance supplier={supplier} />);
    expect(await screen.findByRole("list", { name: "Saved scorecards" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save as a scorecard" })).toBeNull();
    expect(screen.getByText(/v1 · 2 warnings · Q3/)).toBeInTheDocument();
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
