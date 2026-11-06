import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

let permissions;
const apiFetch = vi.fn();
vi.mock("../../lib/api-client", async (importOriginal) => ({
  ...(await importOriginal()),
  apiFetch: (...a) => apiFetch(...a),
}));
vi.mock("../../contexts/OrganisationProvider", () => ({
  useOrganisation: () => ({ organisationId: "org-1" }),
}));
vi.mock("../../hooks/useQmsApi", () => ({
  usePermissions: () => ({ can: (p) => permissions.includes(p) }),
}));
vi.mock("../Breadcrumb", () => ({
  default: () => <nav aria-label="Breadcrumb" />,
}));
vi.mock("recharts", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    ResponsiveContainer: ({ children }) => (
      <div data-testid="chart-area">{children}</div>
    ),
  };
});

import ProcessControlDashboard from "./ProcessControlDashboard";

const data = (over = {}) => ({
  period: {
    from: "2026-08-09",
    to: "2026-11-06",
    previousFrom: "2026-05-12",
    previousTo: "2026-08-08",
    bucket: "week",
  },
  kpis: {
    awaitingApproval: 2,
    effectivePlans: 5,
    plansWithoutEffective: 1,
    inspections: 12,
    inspectionsPrevious: 10,
    inProgress: 3,
    firstPassRate: 83.3,
    openFailures: 4,
  },
  inspectionsByPeriod: [
    { start: "2026-10-26", pass: 3, fail: 1, inProgress: 1 },
  ],
  revisionsByStatus: [
    { key: "draft", label: "Draft", count: 1 },
    { key: "pending_approval", label: "Awaiting approval", count: 2 },
    { key: "effective", label: "Effective", count: 5 },
  ],
  failuresByCharacteristic: [{ key: "OD", label: "Outer diameter", count: 3 }],
  planAttention: [
    {
      kind: "awaiting_approval",
      planId: "p1",
      revisionId: "r1",
      planCode: "CP-HCR-001",
      title: "Rods",
      revisionCode: "B",
      since: "2026-11-03T09:00:00Z",
      by: "Ada Owner",
    },
    {
      kind: "no_effective_revision",
      planId: "p2",
      revisionId: null,
      planCode: "CP-SHAFT",
      title: "Shafts",
      revisionCode: null,
      since: null,
      by: null,
    },
  ],
  openFailures: [
    {
      inspectionId: "i1",
      reference: "IPI-26-0004",
      partNumber: "HCR-100",
      characteristic: "Outer diameter",
      value: "25.060 mm",
      limits: "24.95 to 25.05 mm",
      measuredAt: "2026-11-05T08:00:00Z",
    },
  ],
  inProgress: [
    {
      id: "i2",
      reference: "IPI-26-0009",
      partNumber: "HCR-200",
      operationCode: "OP-020",
      startedAt: "2026-11-04T08:00:00Z",
      ageHours: 52.5,
      samples: 4,
    },
    {
      id: "i3",
      reference: "IPI-26-0010",
      partNumber: "HCR-200",
      operationCode: null,
      startedAt: "2026-11-06T08:00:00Z",
      ageHours: 3,
      samples: 1,
    },
  ],
  spc: {
    available: true,
    windowDays: 30,
    monitored: 6,
    withSignals: 2,
    withoutBaseline: 4,
    signalCount: 5,
    byRule: [
      { rule: "we1", count: 3 },
      { rule: "range", count: 2 },
    ],
    recent: [
      {
        partId: "p9",
        partNumber: "HCR-100",
        characteristicKey: "OD",
        characteristicName: "Outer diameter",
        operationCode: "OP-020",
        rule: "we1",
        text: "One point beyond 3σ (outside the control limits)",
        at: "2026-11-05T09:00:00Z",
        point: 47,
        inspections: [{ id: "i1", reference: "IPI-26-0004" }],
      },
    ],
  },
  ...over,
});

const renderPage = (url = "/Process-Control") => {
  let search = "";
  const Where = () => ((search = useLocation().search), null);
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route
            path="/Process-Control"
            element={
              <>
                <ProcessControlDashboard />
                <Where />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return () => search;
};

beforeEach(() => {
  apiFetch.mockReset();
  permissions = ["process_control.read", "inspection.read", "spc.read"];
  apiFetch.mockResolvedValue(data());
});

describe("Process control dashboard", () => {
  it("shows the KPIs with what needs attention highlighted", async () => {
    renderPage();
    expect(
      await screen.findByRole("heading", { name: "Process control dashboard" }),
    ).toBeInTheDocument();
    const tile = (label) => screen.getAllByText(label)[0].closest("a, .rounded-2xl"); // the KPI tiles come first on the page
    expect(
      within(tile("Awaiting approval")).getByText("2"),
    ).toBeInTheDocument();
    expect(
      within(tile("Effective plans")).getByText("1 active without one"),
    ).toBeInTheDocument();
    expect(
      within(tile("Inspections")).getByText(/Up 20% on previous period/),
    ).toBeInTheDocument();
    expect(
      within(tile("Inspections")).getByText("3 in progress"),
    ).toBeInTheDocument();
    expect(
      within(tile("Pass first time")).getByText("83.3%"),
    ).toBeInTheDocument();
    expect(within(tile("Open failures")).getByText("4")).toBeInTheDocument();
    expect(
      within(tile("SPC signals (30 days)")).getByText("2 of 6 charts"),
    ).toBeInTheDocument();
  });

  it("asks for the period in the URL and defaults to 90 days", async () => {
    renderPage();
    await screen.findByRole("heading", { name: "Process control dashboard" });
    const q = apiFetch.mock.calls[0][0];
    const p = new URLSearchParams(q.split("?")[1]);
    expect(
      (Date.parse(p.get("to")) - Date.parse(p.get("from"))) / 86_400_000,
    ).toBe(89);
  });

  it("lists the latest signals with a link to the chart and the inspection", async () => {
    renderPage();
    const table = await screen.findByRole("table", {
      name: "Latest SPC signals",
    });
    const link = within(table).getByRole("link", {
      name: /HCR-100 · Outer diameter/,
    });
    expect(link).toHaveAttribute(
      "href",
      "/Process-Control/SPC?part=p9&c=OD%7COP-020",
    );
    expect(
      within(table).getByRole("link", { name: "IPI-26-0004" }),
    ).toHaveAttribute("href", "/Inspections/i1");
    expect(
      screen.getByText(/does not mean product is nonconforming/),
    ).toBeInTheDocument();
  });

  it("lists plans needing attention, open failures and old in-progress inspections", async () => {
    renderPage();
    const plans = await screen.findByRole("list", {
      name: "Control plans needing attention",
    });
    expect(
      within(plans).getByRole("link", { name: "CP-HCR-001" }),
    ).toHaveAttribute("href", "/Process-Control/Plans/p1/revisions/r1");
    expect(
      within(plans).getByText(/Revision B submitted by Ada Owner/),
    ).toBeInTheDocument();
    expect(
      within(plans).getByRole("link", { name: "CP-SHAFT" }),
    ).toHaveAttribute("href", "/Process-Control/Plans/p2");
    const failures = screen.getByRole("table", {
      name: "Failures needing action",
    });
    expect(within(failures).getByText("25.060 mm")).toBeInTheDocument();
    const working = screen.getByRole("table", {
      name: "Inspections in progress",
    });
    expect(within(working).getByText("2 d 5 h")).toHaveClass(
      "text-error-color",
    );
    expect(within(working).getByText("3 h")).not.toHaveClass(
      "text-error-color",
    );
  });

  it("hides inspection sections without inspection.read and SPC sections without SPC access", async () => {
    permissions = ["process_control.read"];
    apiFetch.mockResolvedValue(
      data({
        spc: {
          available: false,
          windowDays: 30,
          monitored: 0,
          withSignals: 0,
          withoutBaseline: 0,
          signalCount: 0,
          byRule: [],
          recent: [],
        },
      }),
    );
    renderPage();
    await screen.findByRole("heading", { name: "Process control dashboard" });
    expect(
      screen.queryByRole("table", { name: "Failures needing action" }),
    ).toBeNull();
    expect(
      screen.queryByRole("table", { name: "Inspections in progress" }),
    ).toBeNull();
    expect(
      screen.queryByRole("table", { name: "Latest SPC signals" }),
    ).toBeNull();
    expect(screen.queryByRole("link", { name: "SPC charts" })).toBeNull();
    expect(screen.getByText("No access to SPC")).toBeInTheDocument();
    expect(
      screen.getByRole("list", { name: "Control plans needing attention" }),
    ).toBeInTheDocument();
  });

  it("says so when nothing needs attention", async () => {
    apiFetch.mockResolvedValue(
      data({
        kpis: {
          ...data().kpis,
          awaitingApproval: 0,
          openFailures: 0,
          firstPassRate: null,
        },
        planAttention: [],
        openFailures: [],
        inProgress: [],
        failuresByCharacteristic: [],
        spc: {
          ...data().spc,
          recent: [],
          byRule: [],
          signalCount: 0,
          withSignals: 0,
        },
      }),
    );
    renderPage();
    expect(
      await screen.findByText("Every plan is approved and current."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Every failed reading has been handled."),
    ).toBeInTheDocument();
    expect(screen.getByText("No inspections in progress.")).toBeInTheDocument();
    expect(
      screen.getByText("No failed readings in this period."),
    ).toBeInTheDocument();
    expect(
      screen.getAllByText(/No signals in the last 30 days/).length,
    ).toBeGreaterThan(0);
  });

  it("shows an API error", async () => {
    apiFetch.mockRejectedValue(new Error("boom"));
    renderPage();
    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });
});
