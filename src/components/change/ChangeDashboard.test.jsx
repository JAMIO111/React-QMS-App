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
import ChangeDashboard from "./ChangeDashboard";

const dashboard = {
  period: { from: "2026-08-26", to: "2026-11-24", bucket: "month" },
  kpis: { open: 7, expedited: 2, atBoard: 2, signoffsWaiting: 3, tasksOverdue: 1, tasksOpen: 5, pastCutIn: 1, customerWaiting: 1, drafts: 2, submitted: 4, approved: 3, closed: 2, notEffective: 1, daysToApprove: 6.5, daysToClose: null },
  byStage: [{ stage: "assessment", count: 1 }, { stage: "approval", count: 2 }, { stage: "approved", count: 1 }, { stage: "implementing", count: 2 }, { stage: "verifying", count: 1 }],
  byType: [{ type: "Process", count: 5 }, { type: "Design", count: 2 }],
  trend: [{ start: "2026-09-01", submitted: 1, closed: 0 }, { start: "2026-10-01", submitted: 3, closed: 2 }],
  waitingSignoffs: [{ changeId: "c1", reference: "ECR-26-0001", title: "Move bracket to CNC 7", signer: "Quinn Manager", function: "Quality", days: 9 }],
  overdueTasks: [{ taskId: "t1", changeId: "c2", reference: "ECN-26-0002", description: "Update the control plan", owner: "Bob Bloggs", dueOn: "2026-11-20", daysLate: 4 }],
  pastCutInList: [{ changeId: "c3", reference: "ECN-26-0003", title: "New gauge", stage: "implementing", cutInOn: "2026-11-10", daysAgo: 14 }],
  recentlyClosed: [{ changeId: "c4", reference: "ECN-26-0004", title: "Torque spec", closedOn: "2026-11-15", result: "not_effective" }],
};

const renderIt = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={["/Change"]}>
        <Routes>
          <Route path="/Change" element={<ChangeDashboard />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );

beforeEach(() => {
  apiFetch.mockReset();
  apiFetch.mockImplementation(async () => dashboard);
});

describe("the change dashboard", () => {
  it("asks for the period in one request and shows the open figure and where changes stand", async () => {
    renderIt();
    expect(await screen.findByText("2 expedited · 2 drafts not yet submitted")).toBeInTheDocument();
    expect(apiFetch.mock.calls.filter(([path]) => path.startsWith("/changes-dashboard?from="))).toHaveLength(1);
    const stages = screen.getByRole("list", { name: "Changes by stage" });
    expect(within(stages).getAllByRole("listitem")).toHaveLength(5);
    expect(stages).toHaveTextContent("Approval");
  });

  it("lists what is waiting, late and past its cut-in point, each a link to the change", async () => {
    renderIt();
    const waiting = await screen.findByRole("list", { name: "Sign-offs waiting" });
    expect(within(waiting).getByRole("link", { name: "ECR-26-0001 · Move bracket to CNC 7" })).toHaveAttribute("href", "/Change/c1");
    expect(waiting).toHaveTextContent("Quinn Manager for Quality");
    expect(waiting).toHaveTextContent("waiting 9 days");
    const tasks = screen.getByRole("list", { name: "Tasks overdue" });
    expect(tasks).toHaveTextContent("Update the control plan");
    expect(tasks).toHaveTextContent("4 days late");
    const cut = screen.getByRole("table", { name: "Changes past their cut-in point" });
    expect(within(cut).getByRole("link", { name: /ECN-26-0003/ })).toHaveAttribute("href", "/Change/c3");
    expect(cut).toHaveTextContent("14 days ago");
  });

  it("says in words what was closed and whether the check found it effective", async () => {
    renderIt();
    const closed = await screen.findByRole("list", { name: "Recently closed changes" });
    expect(closed).toHaveTextContent("ECN-26-0004 · Torque spec");
    expect(closed).toHaveTextContent("not effective");
  });

  it("says so when nothing needs doing", async () => {
    apiFetch.mockImplementation(async () => ({ ...dashboard, kpis: { ...dashboard.kpis, open: 0, signoffsWaiting: 0 }, byType: [], waitingSignoffs: [], overdueTasks: [], pastCutInList: [], recentlyClosed: [], trend: [] }));
    renderIt();
    expect(await screen.findByText("No sign-offs are waiting.")).toBeInTheDocument();
    expect(screen.getByText("No tasks are overdue.")).toBeInTheDocument();
    expect(screen.getByText("No changes are open.")).toBeInTheDocument();
    expect(screen.getByText("Nothing submitted or closed in this period.")).toBeInTheDocument();
  });

  it("shows the reason when the figures cannot be loaded", async () => {
    apiFetch.mockImplementation(async () => {
      throw Object.assign(new Error("You may not read changes"), { status: 403 });
    });
    renderIt();
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
  });
});

describe("the Change menu", () => {
  it("opens on the dashboard, with the register and My changes under it", () => {
    const change = menuStructure.find((m) => m.name === "Change");
    expect(change.subMenu.map((s) => [s.name, s.path])).toEqual([
      ["Dashboard", "/Change"],
      ["Changes", "/Change/Register"],
      ["My changes", "/Change/Mine"],
    ]);
  });
});
