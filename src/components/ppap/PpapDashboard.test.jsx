import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("../../lib/api-client", async (orig) => ({ ...(await orig()), apiFetch: vi.fn() }));
vi.mock("../../contexts/OrganisationProvider", () => ({ useOrganisation: () => ({ organisationId: "org-1" }) }));
vi.mock("../../lib/breadcrumbs", async (orig) => ({ ...(await orig()), useBreadcrumbNames: () => {} }));
vi.mock("recharts", async (importOriginal) => {
  const mod = await importOriginal();
  const { cloneElement } = await import("react");
  return { ...mod, ResponsiveContainer: ({ children }) => cloneElement(children, { width: 600, height: 300 }) };
});

import { apiFetch } from "../../lib/api-client";
import { menuStructure } from "../../MenuStructure";
import PpapDashboard from "./PpapDashboard";

const dashboard = {
  period: { from: "2026-08-26", to: "2026-11-24", bucket: "month" },
  kpis: {
    inPreparation: 2, awaitingCustomer: 1, awaitingUs: 1, approved: 5, interim: 1, interimEnding: 1, interimLapsed: 1, rejected: 1, reviewsOverdue: 2,
    sent: 6, approvedInPeriod: 3, interimInPeriod: 1, rejectedInPeriod: 1, averageDaysToAnswer: 12.5,
  },
  byStatus: [
    { status: "draft", count: 1 }, { status: "in_preparation", count: 1 }, { status: "ready", count: 0 }, { status: "submitted", count: 2 },
    { status: "approved", count: 5 }, { status: "interim_approved", count: 2 }, { status: "rejected", count: 1 },
  ],
  byDirection: [{ direction: "submitted", count: 10 }, { direction: "received", count: 2 }],
  trend: [{ start: "2026-09-01", sent: 2, approved: 1, interim: 0, rejected: 0 }, { start: "2026-10-01", sent: 4, approved: 2, interim: 1, rejected: 1 }],
  needsAction: [
    { id: "p1", reference: "PPAP-26-0001", direction: "submitted", partNumber: "PD-100", partName: "Bracket", party: "Wayne Ltd", reason: "rejected", on: "2026-11-20", days: 4 },
    { id: "p2", reference: "PPAP-26-0002", direction: "submitted", partNumber: "PD-200", partName: "Clip", party: "Stark Ltd", reason: "interim_lapsed", on: "2026-11-21", days: -3 },
    { id: "p3", reference: "PPAP-26-0003", direction: "received", partNumber: "PD-300", partName: "Housing", party: "Acme Castings", reason: "interim_ending", on: "2026-12-04", days: 10 },
    { id: "p4", reference: "PPAP-26-0004", direction: "submitted", partNumber: "PD-400", partName: "Rod", party: "Wayne Ltd", reason: "review_overdue", on: "2026-11-01", days: 23 },
  ],
  awaiting: [{ id: "p5", reference: "PPAP-26-0005", direction: "submitted", partNumber: "PD-500", partName: "Pin", party: "Stark Ltd", reason: "awaiting", on: "2026-11-19", days: 5 }],
};

const renderIt = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={["/PPAP"]}>
        <Routes>
          <Route path="/PPAP" element={<PpapDashboard />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );

beforeEach(() => {
  apiFetch.mockReset();
  apiFetch.mockImplementation(async () => dashboard);
});

describe("the part approvals dashboard", () => {
  it("asks for the period in one request and shows what is in force, with what is waiting and being prepared", async () => {
    renderIt();
    expect(await screen.findByText("2 waiting for an answer · 2 being prepared · 2 on an interim approval")).toBeInTheDocument();
    expect(apiFetch.mock.calls.filter(([path]) => path.startsWith("/ppap-dashboard?from="))).toHaveLength(1);
    expect(screen.getByRole("heading", { name: "Part approvals dashboard" })).toBeInTheDocument();
  });

  it("lists what needs action in words, each a link to its submission", async () => {
    renderIt();
    const list = await screen.findByRole("list", { name: "Part approvals that need action" });
    expect(within(list).getByRole("link", { name: "PPAP-26-0001 · PD-100" })).toHaveAttribute("href", "/PPAP/p1");
    expect(list).toHaveTextContent("Rejected");
    expect(list).toHaveTextContent("4 days ago");
    expect(list).toHaveTextContent("Interim approval ran out");
    expect(list).toHaveTextContent("3 days ago");
    expect(list).toHaveTextContent("Acme Castings (supplier)");
    expect(list).toHaveTextContent("10 days left");
    expect(list).toHaveTextContent("Revalidation overdue");
    expect(list).toHaveTextContent("23 days ago");
  });

  it("lists what is waiting for an answer, longest waiting first", async () => {
    renderIt();
    const waiting = await screen.findByRole("list", { name: "Part approvals waiting for an answer" });
    expect(waiting).toHaveTextContent("Sent Nov 19, 2026 · waiting 5 days");
  });

  it("says in the tiles what the answers were, with the average wait", async () => {
    renderIt();
    expect(await screen.findByText(/3 approved · 1 for now · 1 rejected · 12\.5 days on average/)).toBeInTheDocument();
    expect(screen.getByText("1 ran out · 1 ending within 30 days")).toBeInTheDocument();
    expect(screen.getByText("1 waiting for a customer · 1 from a supplier waiting for us")).toBeInTheDocument();
  });

  it("says so when nothing needs doing", async () => {
    apiFetch.mockImplementation(async () => ({ ...dashboard, kpis: { ...dashboard.kpis, approved: 0 }, byStatus: dashboard.byStatus.map((s) => ({ ...s, count: 0 })), needsAction: [], awaiting: [], trend: [] }));
    renderIt();
    expect(await screen.findByText("No part approval has been started yet.")).toBeInTheDocument();
    expect(screen.getByText("Nothing needs action.")).toBeInTheDocument();
    expect(screen.getByText("No part approval is waiting for an answer.")).toBeInTheDocument();
    expect(screen.getByText("No part approval was sent or answered in this period.")).toBeInTheDocument();
  });

  it("shows the reason when the figures cannot be loaded", async () => {
    apiFetch.mockImplementation(async () => {
      throw Object.assign(new Error("You may not read part approvals"), { status: 403 });
    });
    renderIt();
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
  });
});

describe("the PPAP menu", () => {
  it("opens on the dashboard, with the register under it", () => {
    const ppap = menuStructure.find((m) => m.name === "PPAP");
    expect(ppap.subMenu.map((s) => [s.name, s.path])).toEqual([
      ["Dashboard", "/PPAP"],
      ["Part approvals", "/PPAP/Register"],
    ]);
  });
});
