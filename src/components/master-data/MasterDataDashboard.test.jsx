import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

let permissions;
let payload;
const apiFetch = vi.fn();
vi.mock("../../lib/api-client", async (importOriginal) => ({ ...(await importOriginal()), apiFetch: (...a) => apiFetch(...a) }));
vi.mock("../../contexts/OrganisationProvider", () => ({ useOrganisation: () => ({ organisationId: "org-1" }) }));
vi.mock("../../hooks/useQmsApi", () => ({ usePermissions: () => ({ can: (p) => permissions.includes(p) }) }));
// Charts need a measured container, which jsdom does not have; their data is checked through the API tests.
vi.mock("recharts", async (importOriginal) => ({ ...(await importOriginal()), ResponsiveContainer: ({ children }) => <div data-testid="chart">{children}</div> }));

import MasterDataDashboard from "./MasterDataDashboard";

const week = (start, over = {}) => ({ start, parts: 0, partFamilies: 0, machines: 0, customers: 0, suppliers: 0, employees: 0, ...over });
const data = (over = {}) => ({
  asOf: "2026-11-07T19:00:00.000Z",
  entities: [
    { kind: "parts", total: 120, active: 110, added30Days: 8 },
    { kind: "partFamilies", total: 6, active: 6, added30Days: 0 },
    { kind: "machines", total: 14, active: 12, added30Days: 1 },
    { kind: "customers", total: 9, active: 9, added30Days: 2 },
    { kind: "suppliers", total: 17, active: 16, added30Days: 0 },
    { kind: "employees", total: 41, active: 40, added30Days: 3 },
  ],
  attention: [
    { key: "parts_without_release", label: "Active parts with no released revision", kind: "parts", count: 7, of: 110 },
    { key: "parts_without_family", label: "Active parts with no part family", kind: "parts", count: 0, of: 110 },
    { key: "parts_without_customer", label: "Active parts with no customer", kind: "parts", count: 0, of: 110 },
    { key: "machines_without_site", label: "Active machines with no site", kind: "machines", count: 2, of: 12 },
    { key: "employees_without_department", label: "Active employees with no department", kind: "employees", count: 0, of: 40 },
  ],
  growth: Array.from({ length: 12 }, (_, i) => week(`2026-0${(i % 9) + 1}-01`)),
  partsByFamily: [{ key: "f1", label: "ROD · Rods", count: 60 }, { key: "none", label: "No family", count: 5 }],
  machinesBySite: [{ key: "s1", label: "Main site", count: 12 }],
  employeesByDepartment: [{ key: "d1", label: "Manufacturing", count: 30 }],
  revisionsByStatus: [{ key: "released", label: "released", count: 100 }, { key: "draft", label: "draft", count: 12 }],
  recent: [
    { kind: "parts", id: "11111111-1111-1111-1111-111111111111", label: "ROD-100", action: "added", at: "2026-11-07T18:00:00.000Z", by: "Ada Owner" },
    { kind: "machines", id: "22222222-2222-2222-2222-222222222222", label: "CNC-1 · Lathe", action: "changed", at: "2026-11-07T17:00:00.000Z", by: null },
    { kind: "partFamilies", id: "33333333-3333-3333-3333-333333333333", label: "ROD · Rods", action: "added", at: "2026-11-07T16:30:00.000Z", by: null },
  ],
  events: {
    available: true,
    last24Hours: 4,
    waiting: 3,
    oldestWaitingAt: "2026-11-06T10:00:00.000Z",
    byType: [{ key: "part.revision.released", label: "part.revision.released", count: 3 }],
    recent: [{ id: "e1", type: "part.revision.released", entityType: "part_revision", at: "2026-11-07T16:00:00.000Z", processedAt: null, by: "Ada Owner" }],
  },
  ...over,
});

const renderIt = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <MasterDataDashboard />
      </MemoryRouter>
    </QueryClientProvider>
  );

beforeEach(() => {
  permissions = ["master_data.read", "audit.read"];
  payload = data();
  apiFetch.mockReset();
  apiFetch.mockImplementation(async (path) => {
    if (path === "/master-data-dashboard") return payload;
    throw new Error(`unexpected ${path}`);
  });
});

describe("the master data overview", () => {
  it("shows a tile for each kind with its total, active and recent additions, linking to its register", async () => {
    renderIt();
    const totals = await screen.findByLabelText("Totals");
    const parts = within(totals).getByRole("link", { name: /Parts/ });
    expect(parts).toHaveAttribute("href", "/Parts");
    expect(parts).toHaveTextContent("120");
    expect(parts).toHaveTextContent("110 active · 8 added in 30 days");
    expect(within(totals).getByRole("link", { name: /Employees/ })).toHaveAttribute("href", "/Employees");
    expect(within(totals).getAllByRole("link")).toHaveLength(6);
  });

  it("lists every data-quality check, with the failing ones counted against the active records and the healthy ones said to be healthy", async () => {
    renderIt();
    const list = await screen.findByRole("list", { name: "Data quality checks" });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(5);
    expect(items[0]).toHaveTextContent("Active parts with no released revision");
    expect(items[0]).toHaveTextContent("7 of 110");
    expect(items[0]).toHaveTextContent("needs attention");
    expect(items[1]).toHaveTextContent("None");
    expect(items[1]).toHaveTextContent("healthy");
    expect(within(items[3]).getByRole("link")).toHaveAttribute("href", "/Machines");
    expect(screen.getByText("2 of 5 checks need attention (active records only)")).toBeInTheDocument();
  });

  it("says every check passes when none fail", async () => {
    payload = data({ attention: data().attention.map((a) => ({ ...a, count: 0 })) });
    renderIt();
    expect(await screen.findByText("Every check passes")).toBeInTheDocument();
  });

  it("lists the latest changes with who and what happened", async () => {
    renderIt();
    const list = await screen.findByRole("list", { name: "Recent changes" });
    const [first, second] = within(list).getAllByRole("listitem");
    expect(first).toHaveTextContent("ROD-100");
    expect(first).toHaveTextContent("Added by Ada Owner");
    expect(first).toHaveTextContent("Part");
    expect(second).toHaveTextContent("Changed ·");
    expect(within(list).getAllByRole("listitem")[2]).toHaveTextContent("Part family"); // not "Part familie"
  });

  it("is honest that no connectors exist yet, and shows the change events that are real", async () => {
    renderIt();
    expect(await screen.findByText(/No connectors, imports or sync runs are set up yet/)).toBeInTheDocument();
    const card = screen.getByRole("region", { name: "Integrations and change events" });
    expect(within(card).getByText("Events in 24 hours").nextSibling).toHaveTextContent("4");
    expect(within(card).getByText("Waiting for a consumer").nextSibling).toHaveTextContent("3");
    expect(within(card).getByRole("list", { name: "Latest events" })).toHaveTextContent("part.revision.released");
    expect(within(card).getByRole("list", { name: "Latest events" })).toHaveTextContent("Waiting");
  });

  it("explains the missing change stream to people without audit access, and still shows everything else", async () => {
    permissions = ["master_data.read"];
    payload = data({ events: { available: false, last24Hours: 0, waiting: 0, oldestWaitingAt: null, byType: [], recent: [] } });
    renderIt();
    expect(await screen.findByText(/visible to people with audit access, which you do not have/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Latest events")).toBeNull();
    expect(screen.getByLabelText("Totals")).toBeInTheDocument();
  });

  it("shows empty states for an organisation with no data", async () => {
    payload = data({
      entities: data().entities.map((e) => ({ ...e, total: 0, active: 0, added30Days: 0 })),
      attention: data().attention.map((a) => ({ ...a, count: 0, of: 0 })),
      partsByFamily: [],
      machinesBySite: [],
      employeesByDepartment: [],
      revisionsByStatus: [],
      recent: [],
      events: { available: true, last24Hours: 0, waiting: 0, oldestWaitingAt: null, byType: [], recent: [] },
    });
    renderIt();
    expect(await screen.findByText("Nothing has been added yet.")).toBeInTheDocument();
    expect(screen.getByText("No active parts.")).toBeInTheDocument();
    expect(screen.getByText("No part revisions yet.")).toBeInTheDocument();
    expect(screen.getByText("No events yet.")).toBeInTheDocument();
  });

  it("shows the reason when the figures cannot be loaded", async () => {
    apiFetch.mockRejectedValue(Object.assign(new Error("Something went wrong"), { status: 500 }));
    renderIt();
    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });
});
