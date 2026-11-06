import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

let permissions;
const apiFetch = vi.fn();
vi.mock("../../lib/api-client", async (importOriginal) => ({ ...(await importOriginal()), apiFetch: (...a) => apiFetch(...a) }));
vi.mock("../../contexts/OrganisationProvider", () => ({ useOrganisation: () => ({ organisationId: "org-1" }) }));
vi.mock("../../hooks/useQmsApi", () => ({ usePermissions: () => ({ can: (p) => permissions.includes(p) }) }));

import AlertsPage from "./AlertsPage";
import { notificationLink } from "../../lib/notifications";

const alert = (over = {}) => ({
  id: "a1",
  part: { id: "p1", partNumber: "HCR-100" },
  characteristicKey: "OD",
  characteristicName: "Outer diameter",
  operationCode: "OP-020",
  variant: "imr",
  rule: "we1",
  side: "above",
  summary: "Rule 1: One point beyond 3σ (outside the control limits)",
  pointAt: "2026-11-05T08:10:00Z",
  inspection: { id: "i1", reference: "IPI-26-0001" },
  status: "open",
  raisedAt: "2026-11-05T08:10:00Z",
  acknowledgedAt: null,
  acknowledgedBy: null,
  note: null,
  ...over,
});
const renderPage = (url = "/Process-Control/Alerts") =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="/Process-Control/Alerts" element={<AlertsPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );

beforeEach(() => {
  apiFetch.mockReset();
  permissions = ["spc.read", "spc.manage"];
});

describe("SPC alerts", () => {
  it("lists open alerts with links to the chart and the inspection", async () => {
    apiFetch.mockResolvedValue({ data: [alert()], openCount: 1 });
    renderPage();
    const table = await screen.findByRole("table", { name: "SPC alerts" });
    expect(within(table).getByRole("link", { name: /HCR-100 · Outer diameter/ })).toHaveAttribute("href", "/Process-Control/SPC?part=p1&c=OD%7COP-020");
    expect(within(table).getByRole("link", { name: "IPI-26-0001" })).toHaveAttribute("href", "/Inspections/i1");
    expect(within(table).getByText(/Rule 1: One point beyond 3σ/)).toBeInTheDocument();
    expect(screen.getByText("1 open")).toBeInTheDocument();
    expect(apiFetch.mock.calls[0][0]).toContain("status=open");
  });

  it("acknowledges with a required note", async () => {
    let body;
    apiFetch.mockImplementation(async (path, opts = {}) => {
      if (path.startsWith("/spc/alerts/a1/acknowledge")) return ((body = opts.body), alert({ status: "acknowledged" }));
      return { data: [alert()], openCount: 1 };
    });
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "Acknowledge" }));
    const dialog = screen.getByRole("dialog");
    const submit = within(dialog).getByRole("button", { name: "Acknowledge" });
    expect(submit).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText("What was done"), "Tool changed");
    await userEvent.click(submit);
    expect(body).toEqual({ note: "Tool changed" });
  });

  it("offers no acknowledge button without spc.manage, and shows who acknowledged and why", async () => {
    permissions = ["spc.read"];
    apiFetch.mockResolvedValue({
      data: [alert({ status: "acknowledged", acknowledgedAt: "2026-11-05T09:00:00Z", acknowledgedBy: { id: "u1", name: "Ada Owner" }, note: "Tool changed" })],
      openCount: 0,
    });
    renderPage("/Process-Control/Alerts?status=acknowledged");
    expect(await screen.findByText(/Ada Owner/)).toHaveTextContent("Tool changed");
    expect(screen.queryByRole("button", { name: "Acknowledge" })).toBeNull();
    expect(apiFetch.mock.calls[0][0]).toContain("status=acknowledged");
  });

  it("says when there is nothing open, and a notification leads here", async () => {
    apiFetch.mockResolvedValue({ data: [], openCount: 0 });
    renderPage();
    expect(await screen.findByText("No open alerts.")).toBeInTheDocument();
    expect(notificationLink({ entityType: "spc_alerts", entityId: "a1", details: {} })).toBe("/Process-Control/Alerts");
  });
});
