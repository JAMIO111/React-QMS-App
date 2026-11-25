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
import FmeaDashboard from "./FmeaDashboard";

const dashboard = {
  period: { from: "2026-08-26", to: "2026-11-24", bucket: "month" },
  kpis: { inForce: 4, drafts: 2, awaitingApproval: 1, reviewsOverdue: 1, needAttention: 6, highPriority: 2, notInPlan: 3, openActions: 5, overdueActions: 2, actionsDone: 3, revisionsApproved: 2, started: 1, reviewsRecorded: 1 },
  byPriority: [{ priority: "high", count: 2 }, { priority: "medium", count: 4 }, { priority: "low", count: 10 }, { priority: "unrated", count: 0 }],
  byKind: [{ kind: "process", count: 3 }, { kind: "design", count: 1 }],
  trend: [{ start: "2026-09-01", approved: 1, actionsDone: 0 }, { start: "2026-10-01", approved: 1, actionsDone: 3 }],
  topCauses: [{ causeId: "c1", fmeaId: "f1", revisionId: "r1", number: "FMEA-001", title: "Machining", failureMode: "Bore oversize", cause: "Tool wear", severity: 8, occurrence: 8, detection: 8, rpn: 512, priority: "high", hasAction: true }],
  reviewsOverdue: [{ id: "f1", number: "FMEA-001", title: "Machining", kind: "process", letter: "A", owner: "Ada", nextReviewOn: "2026-11-01", days: 23 }],
  awaitingApproval: [{ revisionId: "r9", fmeaId: "f9", number: "FMEA-009", title: "Assembly", letter: null, submittedAt: "2026-11-20T09:00:00.000Z", approver: "Quinn Manager" }],
  overdueActions: [{ id: "a1", fmeaId: "f1", revisionId: "r1", number: "FMEA-001", title: "Machining", description: "Change the tool every 50 parts", owner: "Bob Bloggs", dueOn: "2026-11-20", days: 4 }],
};

const renderIt = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={["/FMEA"]}>
        <Routes>
          <Route path="/FMEA" element={<FmeaDashboard />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );

beforeEach(() => {
  apiFetch.mockReset();
  apiFetch.mockImplementation(async () => dashboard);
});

describe("the FMEA dashboard", () => {
  it("asks for the period in one request and shows what is in force, with the revisions being prepared and waiting", async () => {
    renderIt();
    expect(await screen.findByText("2 revisions being prepared · 1 waiting for approval")).toBeInTheDocument();
    expect(apiFetch.mock.calls.filter(([path]) => path.startsWith("/fmea-dashboard?from="))).toHaveLength(1);
    expect(screen.getByRole("heading", { name: "FMEA dashboard" })).toBeInTheDocument();
  });

  it("names the causes that need attention and links each to its revision", async () => {
    renderIt();
    const table = await screen.findByRole("table", { name: "Causes needing attention" });
    expect(within(table).getByRole("link", { name: "FMEA-001" })).toHaveAttribute("href", "/FMEA/f1/revisions/r1");
    expect(table).toHaveTextContent("Bore oversize");
    expect(table).toHaveTextContent("Tool wear · has an action");
    expect(table).toHaveTextContent("512");
    expect(table).toHaveTextContent("High");
  });

  it("lists late actions, late reviews and what waits for an approver, in words", async () => {
    renderIt();
    const actions = await screen.findByRole("list", { name: "Actions overdue" });
    expect(actions).toHaveTextContent("Change the tool every 50 parts");
    expect(actions).toHaveTextContent("4 days late");
    const reviews = screen.getByRole("list", { name: "FMEA reviews overdue" });
    expect(within(reviews).getByRole("link", { name: "FMEA-001 · Machining" })).toHaveAttribute("href", "/FMEA/f1");
    expect(reviews).toHaveTextContent("23 days late");
    const waiting = screen.getByRole("list", { name: "Revisions waiting for approval" });
    expect(waiting).toHaveTextContent("Approver: Quinn Manager");
  });

  it("says so when nothing needs doing", async () => {
    apiFetch.mockImplementation(async () => ({ ...dashboard, kpis: { ...dashboard.kpis, inForce: 0 }, byKind: [], byPriority: dashboard.byPriority.map((p) => ({ ...p, count: 0 })), topCauses: [], reviewsOverdue: [], awaitingApproval: [], overdueActions: [], trend: [] }));
    renderIt();
    expect(await screen.findByText("No FMEA is in force yet.")).toBeInTheDocument();
    expect(screen.getByText("No action is overdue.")).toBeInTheDocument();
    expect(screen.getByText("No FMEA is past its review date.")).toBeInTheDocument();
    expect(screen.getByText("No revision is waiting for approval.")).toBeInTheDocument();
    expect(screen.getByText("No cause in an FMEA in force needs attention.")).toBeInTheDocument();
  });

  it("shows the reason when the figures cannot be loaded", async () => {
    apiFetch.mockImplementation(async () => {
      throw Object.assign(new Error("You may not read FMEAs"), { status: 403 });
    });
    renderIt();
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
  });
});

describe("the FMEA menu", () => {
  it("opens on the dashboard, with the register and My actions under it", () => {
    const fmea = menuStructure.find((m) => m.name === "FMEA");
    expect(fmea.subMenu.map((s) => [s.name, s.path])).toEqual([
      ["Dashboard", "/FMEA"],
      ["FMEAs", "/FMEA/Register"],
      ["My actions", "/FMEA/My-Actions"],
    ]);
  });
});
