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

const ALL = ["ncr.read", "capa.read", "calibration.read", "process_control.read", "spc.read", "audits.read", "documentation.read", "supplier_quality.read", "competence.read", "master_data.read"];
const sample = () => ({
  "/ncr-dashboard": { kpis: { open: 19, criticalOpen: 2 }, byStage: [{ key: "open", count: 9 }, { key: "awaiting_closure", count: 4 }] },
  "/capas?pageSize=1": { total: 6 },
  "/capas?overdue=true&pageSize=1": { total: 1 },
  "/capas?stage=awaiting_verification&pageSize=1": { total: 0 },
  "/calibration-dashboard": { kpis: { inUse: 80, overdue: 5, quarantined: 0, dueNext30: 7 } },
  "/process-control-dashboard": { kpis: { inProgress: 3, openFailures: 0, awaitingApproval: 2 } },
  "/spc/alerts": { data: [], openCount: 4 },
  "/audits-dashboard": { kpis: { openFindings: 9, overdue: 0, overdueFindings: 0, missed: 0 } },
  "/documents-dashboard": { kpis: { inForce: 64, reviewsOverdue: 0, readersOverdue: 0, inReview: 0, awaitingApproval: 0, changeRequestsOpen: 0 } },
  "/supplier-quality/dashboard": { kpis: { suppliers: 23, overdueScars: 3, expired: 0, approvalsWaiting: 1, expiring: 0, riskReviewsOverdue: 0 }, receiving: { available: true, awaitingDecision: 2, lateOrderLines: 0 } },
  "/competence-dashboard": { kpis: { withGaps: 0, gaps: 0, expired: 0, expiring30: 0, neverAssessed: 0 } },
  "/master-data-dashboard": { attention: [{ key: "a", label: "Active parts with no released revision", kind: "parts", count: 7 }, { key: "b", label: "Active machines with no site", kind: "machines", count: 0 }] },
  "/quality-alerts/mine/count": { unacknowledged: 2, overdue: 1 },
  "/my-documents/count": { toRead: 3, overdue: 0, reviews: 0, total: 3 },
  "/capa-actions/mine": { data: [], openCount: 5 },
});
const answer = (path) => {
  const exact = answers[path];
  if (exact) return exact;
  const key = Object.keys(answers).find((k) => !k.includes("?") && path.split("?")[0] === k);
  if (key) return answers[key];
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

  it("asks only for the areas the person may read, and shows only those", async () => {
    permissions = ["calibration.read"];
    renderIt();
    expect(await screen.findByRole("region", { name: "Calibration" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("region", { name: "Needs attention" })).toHaveTextContent("1 critical · 1 to watch · in 1 of 1 areas"));
    expect(screen.queryByRole("region", { name: "Non-conformance" })).toBeNull();
    expect(screen.queryByRole("region", { name: "For you" })).toBeNull();
    expect(called("/calibration-dashboard")).toBe(true);
    for (const path of ["/ncr-dashboard", "/capas", "/audits-dashboard", "/supplier-quality", "/master-data-dashboard", "/spc/alerts", "/quality-alerts", "/my-documents", "/capa-actions"]) {
      expect(called(path)).toBe(false);
    }
  });

  it("shows nothing at all to someone who may read none of it", () => {
    permissions = ["inspection.record"];
    const { container } = renderIt();
    expect(container).toBeEmptyDOMElement();
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("says so when everything is clear", async () => {
    permissions = ["competence.read", "audits.read"];
    answers["/audits-dashboard"] = { kpis: { openFindings: 0, overdue: 0, overdueFindings: 0, missed: 0 } };
    renderIt();
    expect(await screen.findByText("Nothing needs attention in the areas you can see.")).toBeInTheDocument();
    expect(screen.getByText("Nothing is late, failed or quarantined.")).toBeInTheDocument();
  });

  it("keeps the other areas when one cannot be loaded", async () => {
    permissions = ["calibration.read", "audits.read"];
    delete answers["/audits-dashboard"];
    renderIt();
    const audits = await screen.findByRole("region", { name: "Audits" });
    await waitFor(() => expect(audits).toHaveTextContent("These figures could not be loaded."));
    expect(screen.getByRole("region", { name: "Calibration" })).toHaveTextContent("80");
  });

  it("leaves SPC alerts out for someone who may not read SPC", async () => {
    permissions = ["process_control.read"];
    renderIt();
    const card = await screen.findByRole("region", { name: "Process control" });
    await waitFor(() => expect(card).toHaveTextContent("Plan revisions waiting for approval"));
    expect(card).not.toHaveTextContent("SPC");
    expect(called("/spc/alerts")).toBe(false);
  });
});

describe("the attention rules", () => {
  const can = () => true;
  it("waits for an area's answer, and reports an area that failed", () => {
    const modules = homeModules({ nc: { error: new Error("no") } }, can);
    expect(modules.find((m) => m.key === "nc").state).toBe("error");
    expect(modules.find((m) => m.key === "audits").state).toBe("loading");
    expect(summarise(modules)).toMatchObject({ total: 0, loading: true, clear: 0 });
  });

  it("uses the singular for one, and leaves receiving out when the person may not read it", () => {
    const supplier = { data: { kpis: { suppliers: 1, overdueScars: 1, expired: 0, approvalsWaiting: 0, expiring: 0, riskReviewsOverdue: 0 }, receiving: { available: false, awaitingDecision: 9, lateOrderLines: 9 } } };
    const [m] = homeModules({ supplier }, (p) => p === "supplier_quality.read");
    expect(m.headline).toEqual({ value: 1, label: "supplier in use" });
    expect(m.lines.map((l) => l.label)).toEqual(["Corrective action response overdue"]);
  });
});
