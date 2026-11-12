import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

let permissions;
let answers;
const apiFetch = vi.fn();
vi.mock("../../lib/api-client", async (importOriginal) => ({ ...(await importOriginal()), apiFetch: (...a) => apiFetch(...a) }));
vi.mock("../../contexts/OrganisationProvider", () => ({ useOrganisation: () => ({ organisationId: "org-1" }) }));
vi.mock("../../hooks/useQmsApi", () => ({ usePermissions: () => ({ can: (p) => permissions.includes(p), isLoading: false }) }));

import HomeAttention from "./HomeAttention";
import { homeModules, summarise } from "../../lib/homeDashboard";

const ALL = ["documentation.read", "capa.read"];
/** What GET /home-dashboard answers for someone who may read everything. */
const sample = () => ({
  "/home-dashboard": {
    asOf: "2026-11-12",
    nc: { open: 19, criticalOpen: 2, awaitingClosure: 4 },
    capa: { running: 6, overdue: 1, awaitingVerification: 0 },
    calibration: { inUse: 80, overdue: 5, quarantined: 0, dueNext30: 7 },
    processControl: { inProgress: 3, openFailures: 0, awaitingApproval: 2, openSpcAlerts: 4 },
    audits: { openFindings: 9, overdue: 0, overdueFindings: 0, missed: 0, days: 90 },
    documents: { inForce: 64, reviewsOverdue: 0, readersOverdue: 0, inReview: 0, awaitingApproval: 0, changeRequestsOpen: 0 },
    supplier: { suppliers: 23, overdueScars: 3, expired: 0, expiring: 0, approvalsWaiting: 1, riskReviewsOverdue: 0, receiving: { awaitingDecision: 2, lateOrderLines: 0 } },
    competence: { withGaps: 0, gaps: 0, expired: 0, expiring30: 0, neverAssessed: 0 },
    masterData: { checks: [{ key: "a", label: "Active parts with no released revision", kind: "parts", count: 7 }, { key: "b", label: "Active machines with no site", kind: "machines", count: 0 }] },
  },
  "/quality-alerts/mine/count": { unacknowledged: 2, overdue: 1 },
  "/my-documents/count": { toRead: 3, overdue: 0, reviews: 0, total: 3 },
  "/capa-actions/mine": { data: [], openCount: 5 },
});
const answer = (path) => {
  const key = path.split("?")[0];
  if (answers[key]) return answers[key];
  throw Object.assign(new Error(`unexpected ${path}`), { status: 500 });
};
const called = (start) => apiFetch.mock.calls.some(([path]) => path.startsWith(start));

const renderIt = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <HomeAttention />
      </MemoryRouter>
    </QueryClientProvider>,
  );

beforeEach(() => {
  permissions = [...ALL];
  answers = sample();
  apiFetch.mockReset();
  apiFetch.mockImplementation(async (path) => answer(path));
});

describe("what needs attention on the home page", () => {
  it("adds up what needs attention across the areas, critical and to watch", async () => {
    renderIt();
    const hero = await screen.findByRole("region", { name: "Needs attention" });
    // Critical: critical NCs, 8D overdue, gauges overdue, SPC alerts, SCAR responses. To watch: awaiting closure, due in 30 days, plan approval, approvals, deliveries, one master data check.
    await waitFor(() => expect(hero).toHaveTextContent("5 critical · 6 to watch · in 6 of 9 areas"));
    expect(hero).toHaveTextContent("11");
    const split = within(hero).getByRole("list", { name: "What needs attention" });
    expect(within(split).getAllByRole("listitem")[0]).toHaveTextContent(/Critical.*5/);
  });

  it("lists the critical things first, largest first, each a link to the records behind it", async () => {
    renderIt();
    const urgent = await screen.findByRole("list", { name: "Most urgent" });
    await waitFor(() => expect(within(urgent).getAllByRole("listitem")).toHaveLength(5));
    const items = within(urgent).getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("5");
    expect(items[0]).toHaveTextContent("Gauges overdue for calibration");
    expect(items[0]).toHaveTextContent("Calibration");
    expect(within(items[0]).getByRole("link")).toHaveAttribute("href", "/Calibration/Gauges?due=overdue");
    expect(within(urgent).getByRole("link", { name: /Corrective action responses overdue/ })).toHaveAttribute("href", "/Supplier-Quality/SCARs?filter=overdue");
    expect(within(urgent).getByRole("link", { name: /8D past its due date/ })).toHaveAttribute("href", "/CAPA?overdue=true");
    expect(within(urgent).getByRole("link", { name: /Critical non-conformances open/ })).toHaveAttribute("href", expect.stringContaining("severity=critical"));
  });

  it("shows a card per area with its headline figure and only the lines that have something to do", async () => {
    renderIt();
    const nc = await screen.findByRole("region", { name: "Non-conformance" });
    await waitFor(() => expect(nc).toHaveTextContent("19"));
    expect(nc).toHaveTextContent("open non-conformances");
    expect(nc).toHaveTextContent("1 critical");
    expect(nc).toHaveTextContent("1 to watch");
    expect(within(nc).getByRole("link", { name: "Non-conformance" })).toHaveAttribute("href", "/Non-Conformance");
    expect(within(nc).getByRole("link", { name: /Waiting to be closed/ })).toHaveAttribute("href", "/Non-Conformance/Register?stage=awaiting_closure");

    const competence = screen.getByRole("region", { name: "Competence" });
    await waitFor(() => expect(competence).toHaveTextContent("All clear"));
    expect(competence).toHaveTextContent("Nothing here needs attention.");
    expect(within(competence).queryByRole("list")).toBeNull();

    const master = screen.getByRole("region", { name: "Master data" });
    await waitFor(() => expect(master).toHaveTextContent("1 of 2"));
    expect(within(master).getByRole("link", { name: /Active parts with no released revision/ })).toHaveAttribute("href", "/Parts");
    expect(master).not.toHaveTextContent("Active machines with no site");
  });

  it("shows the person's own to-dos, in red when something is overdue", async () => {
    renderIt();
    const mine = await screen.findByRole("region", { name: "For you" });
    const alerts = within(mine).getByRole("link", { name: /Quality alerts to acknowledge/ });
    await waitFor(() => expect(alerts).toHaveTextContent("2"));
    expect(alerts).toHaveAttribute("href", "/Documentation/My-Alerts");
    expect(alerts).toHaveTextContent("1 overdue");
    expect(within(mine).getByRole("link", { name: /Documents to read/ })).toHaveTextContent("Waiting for you");
    expect(within(mine).getByRole("link", { name: /Documents waiting for your sign-off/ })).toHaveTextContent("Nothing waiting");
    expect(within(mine).getByRole("link", { name: /8D actions assigned to you/ })).toHaveAttribute("href", "/CAPA/My-Actions");
  });

  it("makes one request for every area, and none to the areas' own dashboards", async () => {
    renderIt();
    await screen.findByRole("region", { name: "Needs attention" });
    expect(apiFetch.mock.calls.filter(([path]) => path === "/home-dashboard")).toHaveLength(1);
    for (const path of ["/ncr-dashboard", "/capas", "/calibration-dashboard", "/process-control-dashboard", "/audits-dashboard", "/documents-dashboard", "/supplier-quality", "/competence-dashboard", "/master-data-dashboard", "/spc/alerts"]) {
      expect(called(path)).toBe(false);
    }
  });

  it("shows only the areas the server says the person may read", async () => {
    permissions = [];
    answers["/home-dashboard"] = { ...Object.fromEntries(Object.keys(sample()["/home-dashboard"]).map((k) => [k, null])), asOf: "2026-11-12", calibration: { inUse: 80, overdue: 5, quarantined: 0, dueNext30: 7 } };
    renderIt();
    expect(await screen.findByRole("region", { name: "Calibration" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Needs attention" })).toHaveTextContent("1 critical · 1 to watch · in 1 of 1 areas");
    expect(screen.queryByRole("region", { name: "Non-conformance" })).toBeNull();
    expect(screen.queryByRole("region", { name: "For you" })).toBeNull();
    for (const path of ["/quality-alerts", "/my-documents", "/capa-actions"]) expect(called(path)).toBe(false);
  });

  it("shows nothing at all to someone who may read none of it", async () => {
    permissions = [];
    answers["/home-dashboard"] = { ...Object.fromEntries(Object.keys(sample()["/home-dashboard"]).map((k) => [k, null])), asOf: "2026-11-12" };
    const { container } = renderIt();
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it("says so when everything is clear", async () => {
    const all = sample()["/home-dashboard"];
    answers["/home-dashboard"] = { ...Object.fromEntries(Object.keys(all).map((k) => [k, null])), asOf: all.asOf, competence: all.competence, audits: { ...all.audits, openFindings: 0 } };
    renderIt();
    expect(await screen.findByText("Nothing needs attention in the areas you can see.")).toBeInTheDocument();
    expect(screen.getByText("Nothing is late, failed or quarantined.")).toBeInTheDocument();
  });

  it("says why when the figures cannot be loaded, and still shows the person's own to-dos", async () => {
    delete answers["/home-dashboard"];
    renderIt();
    expect(await screen.findByRole("alert")).toHaveTextContent("What needs attention could not be loaded");
    expect(screen.getByRole("region", { name: "For you" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "By area" })).toBeNull();
  });

  it("leaves SPC alerts and deliveries out for someone who may not read them", async () => {
    const all = sample()["/home-dashboard"];
    answers["/home-dashboard"] = { ...all, processControl: { ...all.processControl, openSpcAlerts: null }, supplier: { ...all.supplier, receiving: null } };
    renderIt();
    const card = await screen.findByRole("region", { name: "Process control" });
    expect(card).toHaveTextContent("Plan revisions waiting for approval");
    expect(card).not.toHaveTextContent("SPC");
    expect(screen.getByRole("region", { name: "Supplier quality" })).not.toHaveTextContent("Delivered lines");
  });
});

describe("the attention rules", () => {
  it("has no cards before the answer arrives", () => {
    expect(homeModules(undefined)).toEqual([]);
    expect(summarise([])).toMatchObject({ total: 0, critical: 0, warning: 0, areas: 0, urgent: [] });
  });

  it("uses the singular for one, and keeps the areas in their fixed order", () => {
    const modules = homeModules({
      supplier: { suppliers: 1, overdueScars: 1, expired: 0, expiring: 0, approvalsWaiting: 0, riskReviewsOverdue: 0, receiving: null },
      nc: { open: 1, criticalOpen: 1, awaitingClosure: 0 },
      capa: null,
    });
    expect(modules.map((m) => m.key)).toEqual(["nc", "supplier"]);
    expect(modules[1].headline).toEqual({ value: 1, label: "supplier in use" });
    expect(modules[1].lines.map((l) => l.label)).toEqual(["Corrective action response overdue"]);
    expect(modules[0].lines.map((l) => l.label)).toEqual(["Critical non-conformance open"]);
  });
});
