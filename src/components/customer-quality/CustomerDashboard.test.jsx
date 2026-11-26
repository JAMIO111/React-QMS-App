import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const apiFetch = vi.fn();
vi.mock("../../lib/api-client", async (importOriginal) => ({ ...(await importOriginal()), apiFetch: (...a) => apiFetch(...a) }));
vi.mock("../../contexts/OrganisationProvider", () => ({ useOrganisation: () => ({ organisationId: "org-1" }) }));
vi.mock("recharts", async (importOriginal) => {
  const mod = await importOriginal();
  const { cloneElement } = await import("react");
  return { ...mod, ResponsiveContainer: ({ children }) => cloneElement(children, { width: 600, height: 300 }) };
});

import CustomerDashboard from "./CustomerDashboard";

const ACME = { id: "c1", code: "ACME", name: "Acme Motors" };
const dashboard = (over = {}) => ({
  available: true,
  reason: null,
  period: { from: "2026-08-14", to: "2026-11-11", bucket: "week", policy: "requested", graceDaysAfter: 0 },
  totals: {
    customers: 2, shipments: 14, shippedUnits: 12000, matchedLines: 30, onTimeLines: 27, onTimePercent: 90, inFullJudged: 20, inFullLines: 16, inFullPercent: 80, ncsRaised: 3, ncUnits: 24,
    ppm: 2000, ppmLot: 1500, tracedPercent: 75, returnedUnits: 6, returnedPercent: 0.05, openNcs: 2, openLateLines: 4, cost: 1250, costCurrency: "GBP", shippedWithoutOrder: 3, shippedWithoutLot: 5,
  },
  bySeverity: [{ key: "critical", count: 1 }, { key: "major", count: 1 }, { key: "minor", count: 1 }, { key: "unrated", count: 0 }],
  trend: [{ start: "2026-10-26", shippedUnits: 5000, ncUnits: 10, ncs: 2, critical: 1, major: 0, minor: 1, ppm: 2000 }, { start: "2026-11-02", shippedUnits: 7000, ncUnits: 14, ncs: 1, critical: 0, major: 1, minor: 0, ppm: 2000 }],
  customers: [{ ...ACME, shippedUnits: 8000, shipments: 9, onTimePercent: 85, matchedLines: 20, inFullPercent: 70, ncs: 3, critical: 1, ncUnits: 24, ppm: 3000, ppmLot: 2000, returnedUnits: 6, openNcs: 2, openLateLines: 4 },
    { id: "c2", code: "BOLT", name: "Bolt Autos", shippedUnits: 4000, shipments: 5, onTimePercent: null, matchedLines: 0, inFullPercent: null, ncs: 0, critical: 0, ncUnits: 0, ppm: 0, ppmLot: null, returnedUnits: 0, openNcs: 0, openLateLines: 0 }],
  attention: [{ ...ACME, reasons: ["A critical complaint in the period", "On time 85% (aim 90%)"] }],
  lateOrderLines: [{ orderId: "o1", orderNumber: "SO-1", lineNumber: 2, customer: ACME, partNumber: "P-1", outstanding: 50, dueOn: "2026-10-10", daysLate: 30 }],
  ...over,
});

const show = (data) => {
  apiFetch.mockImplementation(async (path) => {
    if (path.startsWith("/customer-quality/dashboard")) return data;
    throw new Error(`unexpected ${path}`);
  });
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={["/Shipping"]}>
        <Routes>
          <Route path="/Shipping" element={<CustomerDashboard />} />
        </Routes>
        <div id="modal-root" />
      </MemoryRouter>
    </QueryClientProvider>
  );
};
const kpi = (label) => document.querySelector(`[data-tile="${label}"]`);

beforeEach(() => {
  apiFetch.mockReset();
});

describe("customer quality dashboard", () => {
  it("asks for the last 90 days and shows shipped units, delivery and PPM with their words", async () => {
    show(dashboard());
    expect(await screen.findByText("14 shipments to 2 customers")).toBeInTheDocument();
    expect(apiFetch.mock.calls[0][0]).toMatch(/^\/customer-quality\/dashboard\?from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}&policy=requested&grace=0$/);
    expect(kpi("Units shipped")).toHaveTextContent("12,000");
    expect(kpi("PPM (reported)")).toHaveTextContent("2,000");
    expect(kpi("PPM (reported)")).toHaveTextContent("24 reported of 12,000 shipped");
    expect(kpi("PPM (by lot)")).toHaveTextContent("Units traced to a lot: 75% of those shipped");
    expect(screen.getByText(/so it lags/i)).toBeInTheDocument();
    expect(kpi("Order lines past their date")).toHaveAttribute("href", "/Shipping/Orders");
    expect(kpi("Returned under RMA")).toHaveTextContent("kept apart from PPM");
  });

  it("lists who needs attention with the reasons, the late lines and every customer; no PPM for a customer with nothing shipped", async () => {
    show(dashboard({ customers: [{ ...dashboard().customers[0] }, { ...dashboard().customers[1], shippedUnits: 0, ppm: null }] }));
    expect(await screen.findByText("A critical complaint in the period")).toBeInTheDocument();
    expect(screen.getByText("On time 85% (aim 90%)")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "SO-1 / 2" })).toHaveAttribute("href", "/Shipping/Orders/o1");
    expect(screen.getByText("30 days")).toBeInTheDocument();
    expect(screen.getByText("No shipments")).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: /Acme Motors/ })[0]).toHaveAttribute("href", "/Non-Conformance/Register?customer=c1&source=customer");
  });

  it("says why there are no figures instead of showing zeros", async () => {
    show(dashboard({ available: false, reason: "Customer figures need permission to read both shipping and non-conformances." }));
    expect(await screen.findByText("Customer figures are not shown")).toBeInTheDocument();
    expect(screen.getByText(/need permission to read both shipping/)).toBeInTheDocument();
    expect(screen.queryByText("PPM (reported)")).not.toBeInTheDocument();
  });

  it("says so when nothing was shipped or complained about", async () => {
    show(dashboard({ customers: [], attention: [], lateOrderLines: [], trend: [], totals: { ...dashboard().totals, ncsRaised: 0, ppm: null, ppmLot: null, shippedUnits: 0, shipments: 0, customers: 0 } }));
    expect(await screen.findByText("Nothing was shipped to a customer, and no customer complained, in this period.")).toBeInTheDocument();
    expect(screen.getByText("No customer needs a look.")).toBeInTheDocument();
  });
});
