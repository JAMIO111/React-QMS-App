import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { format, subDays } from "date-fns";

const apiFetch = vi.fn();
vi.mock("../../lib/api-client", async (importOriginal) => ({ ...(await importOriginal()), apiFetch: (...a) => apiFetch(...a) }));
vi.mock("../../contexts/OrganisationProvider", () => ({ useOrganisation: () => ({ organisationId: "org-1" }) }));
// Charts measure their container; jsdom has no layout, so give them a size.
vi.mock("recharts", async (importOriginal) => {
  const mod = await importOriginal();
  const { cloneElement } = await import("react");
  return { ...mod, ResponsiveContainer: ({ children }) => cloneElement(children, { width: 600, height: 300 }) };
});

import NcDashboard from "./NcDashboard";

const dashboard = {
  period: { from: "2025-11-05", to: "2026-11-04", previousFrom: "2024-11-05", previousTo: "2025-11-04", bucket: "month" },
  baseCurrency: "GBP",
  kpis: { raised: 24, raisedPrevious: 20, open: 9, criticalOpen: 2, closed: 15, avgDaysToClose: 12.5, cost: 18450.5, costPrevious: 20500, quantity: 310 },
  trend: [
    { start: "2026-09-01", total: 4, bySource: { internal: 3, customer: 1 }, cost: 1200 },
    { start: "2026-10-01", total: 8, bySource: { internal: 5, customer: 2, supplier: 1 }, cost: 4300.5 },
  ],
  bySource: [
    { key: "internal", label: "Internal", count: 8 }, { key: "customer", label: "Customer", count: 3 }, { key: "supplier", label: "Supplier", count: 1 },
    { key: "calibration", label: "Calibration", count: 2 },
  ],
  byCategory: [{ key: "c1", label: "Process", count: 9 }, { key: "none", label: "Uncategorised", count: 5 }],
  byFailureMode: [{ key: "fm1", label: "Dimensional", count: 11 }, { key: "none", label: "Not classified", count: 4 }],
  byStage: [{ key: "open", label: "Open", count: 6 }, { key: "investigating", label: "Investigating", count: 3 }],
  bySeverity: [{ key: "critical", label: "Critical", count: 2 }, { key: "major", label: "Major", count: 10 }, { key: "minor", label: "Minor", count: 12 }, { key: "unset", label: "Not set", count: 0 }],
  topParts: [{ id: "p1", partNumber: "BRK-100", name: "Bracket", count: 7, cost: 5200 }],
};

const Where = () => {
  const l = useLocation();
  return <p data-testid="where">{l.pathname + l.search}</p>;
};
const renderAt = (url) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="/Non-Conformance" element={<><NcDashboard /><Where /></>} />
          <Route path="/Non-Conformance/Register" element={<Where />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );

beforeEach(() => {
  apiFetch.mockReset();
  apiFetch.mockResolvedValue(dashboard);
});

describe("NC dashboard", () => {
  it("shows the KPI tiles for the last 12 months of every source", async () => {
    renderAt("/Non-Conformance");
    expect(await screen.findByRole("heading", { name: "Non-conformance dashboard" })).toBeInTheDocument();
    const [path] = apiFetch.mock.calls[0];
    const today = new Date();
    expect(path).toBe(`/ncr-dashboard?from=${format(subDays(new Date(today.getFullYear() - 1, today.getMonth(), today.getDate()), -1), "yyyy-MM-dd")}&to=${format(today, "yyyy-MM-dd")}`);
    const raised = await screen.findByRole("link", { name: /NCs raised/ });
    expect(raised).toHaveTextContent("24");
    expect(raised).toHaveTextContent("Up 20% on previous period");
    expect(screen.getByRole("link", { name: /Open now/ })).toHaveTextContent("2 critical");
    expect(document.querySelector('[data-tile="Cost of non-conformance"]')).toHaveTextContent("Down 10% on previous period");
    expect(screen.getByText("£18k")).toBeInTheDocument();
    expect(screen.getByText("12.5")).toBeInTheDocument();
  });

  it("links tiles and parts to the filtered register", async () => {
    renderAt("/Non-Conformance");
    await userEvent.click(await screen.findByRole("link", { name: /Open now/ }));
    expect(screen.getByTestId("where").textContent).toBe("/Non-Conformance/Register?stage=draft,open,contained,investigating,dispositioned,awaiting_closure");
  });

  it("filters by the Customer / Supplier tab and period, kept in the URL", async () => {
    renderAt("/Non-Conformance");
    await screen.findByRole("link", { name: /NCs raised/ });
    await userEvent.click(screen.getByRole("radio", { name: "Customer" }));
    await waitFor(() => expect(apiFetch.mock.calls.at(-1)[0]).toContain("source=customer"));
    await userEvent.click(screen.getByRole("button", { name: /^Period/ }));
    await userEvent.click(within(screen.getByRole("dialog", { name: "Choose period" })).getByRole("button", { name: /^Last 30 days/ }));
    await waitFor(() => expect(apiFetch.mock.calls.at(-1)[0]).toContain(`from=${format(subDays(new Date(), 29), "yyyy-MM-dd")}`));
    expect(screen.getByTestId("where").textContent).toBe("/Non-Conformance?tab=customer&period=30d");
    // A part link goes to the register with that tab's source.
    await userEvent.click(screen.getByRole("link", { name: "BRK-100" }));
    expect(screen.getByTestId("where").textContent).toMatch(/^\/Non-Conformance\/Register\?source=customer&part=p1&partLabel=BRK-100/);
  });

  it("offers the trend as a table and lists failure modes, stages, severity and parts", async () => {
    renderAt("/Non-Conformance");
    await screen.findByRole("link", { name: /NCs raised/ });
    await userEvent.click(screen.getByRole("button", { name: "Show table" }));
    const table = screen.getByRole("table", { name: "NCs raised per period" });
    expect(within(table).getAllByRole("row")).toHaveLength(3);
    expect(within(table).getByText("Oct 26")).toBeInTheDocument();
    expect(within(table).getByText("£4,300.50")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Failure modes" })).toHaveTextContent("Dimensional");
    expect(within(screen.getByRole("list", { name: "Severity" })).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["Critical28%", "Major1042%", "Minor1250%", "Not set00%"]);
    expect(within(screen.getByRole("table", { name: "Parts with the most NCs" })).getByText("£5,200.00")).toBeInTheDocument();
  });

  it("draws the open non-conformances as the stages in order, each a link to the register, and the trend by where they came from", async () => {
    renderAt("/Non-Conformance");
    await screen.findByRole("link", { name: /NCs raised/ });
    const stages = within(screen.getByRole("list", { name: "Open NCs by stage" })).getAllByRole("link");
    expect(stages.map((a) => a.textContent)).toEqual(["6Open", "3Investigating"]);
    expect(stages[1]).toHaveAttribute("href", "/Non-Conformance/Register?stage=investigating");
    // the period's totals by origin are the trend chart's legend: internal 8, customer 3, supplier 1
    expect(within(screen.getByRole("list", { name: "NCs raised by where they came from" })).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["Internal867%", "Customer325%", "Supplier18%"]);
    // a source is a link to the register for the period
    expect(within(screen.getByRole("list", { name: "NCs by source" })).getByRole("link", { name: "Calibration" }).getAttribute("href")).toMatch(/^\/Non-Conformance\/Register\?source=calibration&from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}$/);
  });

  it("lists where the non-conformances came from and what kind of problem they are, as separate breakdowns", async () => {
    renderAt("/Non-Conformance");
    await screen.findByRole("link", { name: /NCs raised/ });
    const bySource = screen.getByRole("region", { name: "By source" });
    expect(bySource).toHaveTextContent("Calibration");
    expect(bySource).toHaveTextContent("Customer");
    const byCategory = screen.getByRole("region", { name: "By category" });
    expect(byCategory).toHaveTextContent("Process");
    expect(byCategory).toHaveTextContent("Uncategorised");
  });

  it("the Internal tab covers every internal kind of source", async () => {
    renderAt("/Non-Conformance?tab=internal");
    await waitFor(() => expect(decodeURIComponent(apiFetch.mock.calls.at(-1)[0])).toContain("source=internal,internal_audit,external_audit,production_inspection,final_inspection,calibration,engineering,management_review"));
    expect(screen.getByRole("radio", { name: "Internal" })).toBeChecked();
  });

  it("the Supplier tab covers supplier and goods receiving", async () => {
    renderAt("/Non-Conformance?tab=supplier");
    await screen.findByRole("link", { name: /NCs raised/ });
    await waitFor(() => expect(decodeURIComponent(apiFetch.mock.calls.at(-1)[0])).toContain("source=supplier,goods_receiving"));
  });

  it("explains a failed load", async () => {
    const { ApiClientError } = await import("../../lib/api-client");
    apiFetch.mockRejectedValue(new ApiClientError({ status: 403, code: "forbidden", message: "You do not have permission" }));
    renderAt("/Non-Conformance");
    expect(await screen.findByRole("alert")).toHaveTextContent("permission");
  });
});
