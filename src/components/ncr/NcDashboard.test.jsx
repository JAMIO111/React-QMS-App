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
    { start: "2026-09-01", internal: 3, customer: 1, supplier: 0, cost: 1200 },
    { start: "2026-10-01", internal: 5, customer: 2, supplier: 1, cost: 4300.5 },
  ],
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
          <Route path="/Non-Conformance/:type" element={<Where />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );

beforeEach(() => {
  apiFetch.mockReset();
  apiFetch.mockResolvedValue(dashboard);
});

describe("NC dashboard", () => {
  it("shows the KPI tiles for the last 12 months of all NC types", async () => {
    renderAt("/Non-Conformance");
    expect(await screen.findByRole("heading", { name: "Non-conformance dashboard" })).toBeInTheDocument();
    const [path] = apiFetch.mock.calls[0];
    const today = new Date();
    expect(path).toBe(`/ncr-dashboard?from=${format(subDays(new Date(today.getFullYear() - 1, today.getMonth(), today.getDate()), -1), "yyyy-MM-dd")}&to=${format(today, "yyyy-MM-dd")}`);
    const raised = await screen.findByRole("link", { name: /NCs raised/ });
    expect(raised).toHaveTextContent("24");
    expect(raised).toHaveTextContent("Up 20% on previous period");
    expect(screen.getByRole("link", { name: /Open now/ })).toHaveTextContent("2 critical");
    expect(screen.getByText("Cost of non-conformance", { selector: "span" }).closest("div").parentElement).toHaveTextContent("Down 10% on previous period");
    expect(screen.getByText("£18k")).toBeInTheDocument();
    expect(screen.getByText("12.5")).toBeInTheDocument();
  });

  it("links tiles and parts to the filtered register", async () => {
    renderAt("/Non-Conformance");
    await userEvent.click(await screen.findByRole("link", { name: /Open now/ }));
    expect(screen.getByTestId("where").textContent).toBe("/Non-Conformance/Internal?stage=draft,open,contained,investigating,dispositioned,awaiting_closure");
  });

  it("filters by NC type and period, kept in the URL", async () => {
    renderAt("/Non-Conformance");
    await screen.findByRole("link", { name: /NCs raised/ });
    await userEvent.click(screen.getByRole("radio", { name: "Customer" }));
    await waitFor(() => expect(apiFetch.mock.calls.at(-1)[0]).toContain("source=customer"));
    await userEvent.click(screen.getByRole("combobox", { name: "Period" }));
    await userEvent.click(screen.getByRole("option", { name: "Last 30 days" }));
    await waitFor(() => expect(apiFetch.mock.calls.at(-1)[0]).toContain(`from=${format(subDays(new Date(), 29), "yyyy-MM-dd")}`));
    expect(screen.getByTestId("where").textContent).toBe("/Non-Conformance?type=Customer&period=30d");
    // A part link goes to that type's register.
    await userEvent.click(screen.getByRole("link", { name: "BRK-100" }));
    expect(screen.getByTestId("where").textContent).toMatch(/^\/Non-Conformance\/Customer\?part=p1&partLabel=BRK-100/);
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
    expect(screen.getByRole("region", { name: "Severity" })).toHaveTextContent("Critical");
    expect(within(screen.getByRole("table", { name: "Parts with the most NCs" })).getByText("£5,200.00")).toBeInTheDocument();
  });

  it("explains a failed load", async () => {
    const { ApiClientError } = await import("../../lib/api-client");
    apiFetch.mockRejectedValue(new ApiClientError({ status: 403, code: "forbidden", message: "You do not have permission" }));
    renderAt("/Non-Conformance");
    expect(await screen.findByRole("alert")).toHaveTextContent("permission");
  });
});
