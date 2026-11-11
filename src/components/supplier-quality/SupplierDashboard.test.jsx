import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const apiFetch = vi.fn();
vi.mock("../../lib/api-client", async (importOriginal) => ({ ...(await importOriginal()), apiFetch: (...a) => apiFetch(...a) }));
vi.mock("../../contexts/OrganisationProvider", () => ({ useOrganisation: () => ({ organisationId: "org-1" }) }));
// Charts measure their container; jsdom has no layout, so give them a size.
vi.mock("recharts", async (importOriginal) => {
  const mod = await importOriginal();
  const { cloneElement } = await import("react");
  return { ...mod, ResponsiveContainer: ({ children }) => cloneElement(children, { width: 600, height: 300 }) };
});

import SupplierDashboard from "./SupplierDashboard";

const S1 = { id: "s1", code: "ACME", name: "Acme Metals" };
const S2 = { id: "s2", code: "BOLT", name: "Bolt Co" };
const dashboard = (over = {}) => ({
  period: { from: "2026-08-14", to: "2026-11-11", bucket: "week" },
  kpis: { suppliers: 12, approved: 7, pendingApproval: 3, approvalsWaiting: 1, highRisk: 2, riskNotAssessed: 4, riskReviewsOverdue: 1, expired: 2, expiring: 3, openScars: 4, overdueScars: 1 },
  byStatus: [{ key: "pending_approval", count: 3 }, { key: "approved", count: 7 }, { key: "conditional", count: 1 }, { key: "suspended", count: 1 }, { key: "disqualified", count: 0 }, { key: "archived", count: 0 }],
  byRisk: [{ key: "low", count: 4 }, { key: "medium", count: 2 }, { key: "high", count: 1 }, { key: "critical", count: 1 }, { key: "none", count: 4 }],
  scarsByStatus: [{ key: "draft", count: 1 }, { key: "issued", count: 2 }, { key: "acknowledged", count: 0 }, { key: "response_received", count: 1 }, { key: "under_review", count: 0 }, { key: "revision_requested", count: 0 }, { key: "accepted", count: 0 }, { key: "verifying", count: 0 }],
  ncs: {
    available: true, open: 5, raised: 3,
    trend: [{ start: "2026-10-26", critical: 1, major: 0, minor: 1, unclassified: 0 }, { start: "2026-11-02", critical: 0, major: 1, minor: 0, unclassified: 0 }],
    bySupplier: [{ ...S1, count: 2, critical: 1 }, { ...S2, count: 1, critical: 0 }],
  },
  receiving: {
    available: true, lines: 40, rejectedLines: 2, lotRejectionPercent: 5, awaitingDecision: 3, lateOrderLines: 4, certificatesToReview: 1,
    trend: [{ start: "2026-10-26", accepted: 10, rejected: 1, undecided: 0 }, { start: "2026-11-02", accepted: 8, rejected: 1, undecided: 3 }],
  },
  performance: {
    available: true, scored: 12, truncated: false,
    bands: [{ key: "good", count: 6 }, { key: "watch", count: 2 }, { key: "poor", count: 1 }, { key: "insufficient", count: 3 }],
    otdPercent: 87.5, onTimeLines: 28, matchedLines: 32, ppm: 12500, rejectedUnits: 50, receivedUnits: 4000, inFullPercent: 90,
    attention: [{ ...S1, band: "poor", score: 41, warnings: 3, reason: "1 critical non-conformance(s) in the period" }, { ...S2, band: "watch", score: 68, warnings: 0, reason: null }],
  },
  overdueScarList: [{ id: "c1", reference: "SCAR-26-0004", title: "Bent brackets", severity: "major", supplier: S1, dueOn: "2026-11-08", daysOverdue: 3 }],
  approvalList: [{ id: "d1", supplier: S2, target: "conditional", proposedAt: "2026-11-09T10:00:00.000Z", proposedBy: "Ada Owner" }],
  expiryList: [
    { kind: "certification", id: "e1", supplier: S1, title: "ISO 9001 · OLD-1", expiresOn: "2026-11-06", days: -5 },
    { kind: "document", id: "e2", supplier: S2, title: "Insurance", expiresOn: "2026-12-01", days: 20 },
  ],
  riskReviewList: [{ supplier: S1, rating: "critical", reviewOn: "2026-11-09", daysOverdue: 2 }],
  ...over,
});

const show = (data) => {
  apiFetch.mockImplementation(async (path) => {
    if (path.startsWith("/supplier-quality/dashboard")) return data;
    throw new Error(`unexpected ${path}`);
  });
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={["/Supplier-Quality"]}>
        <Routes>
          <Route path="/Supplier-Quality" element={<SupplierDashboard />} />
        </Routes>
        <div id="modal-root" />
      </MemoryRouter>
    </QueryClientProvider>
  );
};
const kpi = (label) => screen.getAllByText(label).map((el) => el.closest("a.rounded-2xl, div.rounded-2xl")).find(Boolean);

beforeEach(() => {
  apiFetch.mockReset();
});

describe("supplier quality dashboard", () => {
  it("asks for the last 90 days and shows the supplier base with links to where each figure comes from", async () => {
    show(dashboard());
    expect(await screen.findByText("7 approved · 3 pending approval")).toBeInTheDocument();
    expect(apiFetch.mock.calls[0][0]).toMatch(/^\/supplier-quality\/dashboard\?from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}$/);
    expect(kpi("Suppliers")).toHaveTextContent("12");
    expect(kpi("High or critical risk")).toHaveAttribute("href", "/Suppliers?risk=high,critical");
    expect(kpi("High or critical risk")).toHaveTextContent("4 not assessed · 1 review overdue");
    expect(kpi("Expired records")).toHaveAttribute("href", "/Supplier-Quality/Expiry");
    expect(kpi("Open corrective actions")).toHaveAttribute("href", "/Supplier-Quality/SCARs?filter=overdue");
    expect(kpi("Open supplier NCs")).toHaveTextContent("5");
    expect(kpi("Open supplier NCs")).toHaveTextContent("3 raised in the period");
  });

  it("shows delivery and performance figures, keeping rejected lines apart from PPM", async () => {
    show(dashboard());
    expect(await screen.findByText("28 of 32 delivered lines against an order")).toBeInTheDocument();
    expect(kpi("On-time delivery")).toHaveTextContent("87.5%");
    expect(kpi("PPM (rejected)")).toHaveTextContent("12,500");
    expect(kpi("PPM (rejected)")).toHaveTextContent("50 of 4,000 units received");
    expect(kpi("Lines rejected")).toHaveTextContent("5%");
    expect(kpi("Lines rejected")).toHaveTextContent("2 of 40 delivered lines (not PPM)");
    expect(kpi("Late order lines")).toHaveAttribute("href", "/Supplier-Quality/Purchase-Orders?filter=late");
    expect(kpi("Waiting for a decision")).toHaveTextContent("1 certificate to review");
  });

  it("lists the suppliers needing attention, worst first, with why and a link to their performance", async () => {
    show(dashboard());
    const table = await screen.findByRole("table", { name: "Suppliers needing attention" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows[0]).toHaveTextContent("Acme Metals");
    expect(rows[0]).toHaveTextContent("Poor");
    expect(rows[0]).toHaveTextContent("1 critical non-conformance(s) in the period · and 2 more");
    expect(within(rows[0]).getByRole("link", { name: "Acme Metals" })).toHaveAttribute("href", "/Suppliers/s1?tab=performance");
    expect(rows[1]).toHaveTextContent("Watch");
  });

  it("lists what is overdue or waiting with links to each record", async () => {
    show(dashboard());
    const scars = await screen.findByRole("list", { name: "Corrective action requests overdue" });
    expect(within(scars).getByRole("link", { name: "SCAR-26-0004 · Bent brackets" })).toHaveAttribute("href", "/Supplier-Quality/SCARs/c1");
    expect(scars).toHaveTextContent("3 days overdue");
    const approvals = screen.getByRole("list", { name: "Approvals waiting" });
    expect(approvals).toHaveTextContent("Conditional approval proposed");
    expect(approvals).toHaveTextContent("by Ada Owner");
    expect(within(approvals).getByRole("link", { name: "Bolt Co" })).toHaveAttribute("href", "/Suppliers/s2?tab=qualification");
    const expiring = screen.getByRole("table", { name: "Records expiring" });
    expect(expiring).toHaveTextContent("5 days ago");
    expect(expiring).toHaveTextContent("in 20 days");
    expect(within(expiring).getByRole("link", { name: "Bolt Co" })).toHaveAttribute("href", "/Suppliers/s2?tab=documents");
    expect(screen.getByRole("list", { name: "Risk reviews overdue" })).toHaveTextContent("2 days ago");
    const byNc = screen.getByRole("table", { name: "Non-conformances by supplier" });
    expect(within(byNc).getAllByRole("link", { name: "In the register" })[0]).toHaveAttribute("href", "/Non-Conformance/Register?supplier=s1&supplierLabel=Acme%20Metals");
  });

  it("says so, instead of showing zeros, when deliveries or non-conformances may not be read", async () => {
    const d = dashboard();
    show(dashboard({
      ncs: { available: false, open: 0, raised: 0, trend: [], bySupplier: [] },
      receiving: { ...d.receiving, available: false },
      performance: { ...d.performance, available: false, attention: [] },
    }));
    expect(await screen.findByText("Deliveries and performance are not shown")).toBeInTheDocument();
    expect(screen.queryByText("On-time delivery")).not.toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "Suppliers needing attention" })).not.toBeInTheDocument();
    expect(kpi("Open supplier NCs")).toHaveTextContent("You may not read non-conformances");
    expect(screen.queryByRole("region", { name: "Supplier non-conformances" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Watchlist" })).not.toBeInTheDocument();
  });

  it("has plain words when there is nothing to show", async () => {
    const d = dashboard();
    show(dashboard({
      overdueScarList: [], approvalList: [], expiryList: [], riskReviewList: [],
      scarsByStatus: d.scarsByStatus.map((s) => ({ ...s, count: 0 })),
      ncs: { available: true, open: 0, raised: 0, trend: [], bySupplier: [] },
      receiving: { ...d.receiving, lines: 0, rejectedLines: 0, lotRejectionPercent: null, trend: [] },
      performance: { ...d.performance, otdPercent: null, ppm: null, inFullPercent: null, attention: [] },
    }));
    expect(await screen.findByText("No response is overdue.")).toBeInTheDocument();
    expect(screen.getByText("No approval is waiting for a decision.")).toBeInTheDocument();
    expect(screen.getByText("Nothing has expired or expires within 60 days.")).toBeInTheDocument();
    expect(screen.getByText("No risk review is overdue.")).toBeInTheDocument();
    expect(screen.getByText("Nothing was delivered in this period.")).toBeInTheDocument();
    expect(screen.getByText("No supplier is scored poor or watch, and none carries a warning.")).toBeInTheDocument();
    expect(kpi("On-time delivery")).toHaveTextContent("—");
  });
});
