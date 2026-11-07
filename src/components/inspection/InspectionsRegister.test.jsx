import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

let permissions;
const apiFetch = vi.fn();
vi.mock("../../lib/api-client", async (importOriginal) => ({ ...(await importOriginal()), apiFetch: (...a) => apiFetch(...a) }));
vi.mock("../../contexts/OrganisationProvider", () => ({ useOrganisation: () => ({ organisationId: "org-1" }) }));
vi.mock("../../hooks/useQmsApi", () => ({
  usePermissions: () => ({ can: (p) => permissions.includes(p) }),
  useSites: () => ({ data: { data: [{ id: "s1", code: "MAIN", name: "Main site" }] } }),
}));
vi.mock("../../contexts/SearchProvider", () => ({ useGlobalSearch: () => ({ debouncedSearchTerm: "" }) }));

import InspectionsPage from "./InspectionsPage";
import { StatusPill } from "./shared";

const row = (over = {}) => ({
  id: "i1",
  reference: "IPI-26-0001",
  status: "completed",
  result: "pass",
  part: { id: "p1", partNumber: "HCR-100", name: "Rod 100" },
  partRevision: "A",
  plan: { id: "cp1", planCode: "CP-1", revisionCode: "A" },
  operationCode: "OP-020",
  site: { id: "s1", name: "Main site" },
  machine: null,
  workOrder: "WO-77",
  lot: "L-1",
  lotSize: null,
  serial: null,
  triggerType: "first_off",
  startedAt: "2026-11-02T09:00:00Z",
  startedBy: { id: "u1", name: "Ada Owner" },
  failures: 0,
  ...over,
});

const calls = [];
const routeApi = (list) =>
  apiFetch.mockImplementation(async (path, opts = {}) => {
    const k = `${opts.method ?? "GET"} ${path.split("?")[0]}`;
    calls.push({ k, path });
    if (k === "GET /inspections") return list;
    if (k === "GET /machines") return { data: [{ id: "m1", code: "LATHE-1", name: "Lathe", siteId: "s1" }], nextCursor: null };
    if (k === "GET /parts") return { data: [], nextCursor: null };
    throw new Error(`unexpected ${k}`);
  });
const lastList = () => calls.filter((c) => c.k === "GET /inspections").at(-1);

const Where = () => {
  const l = useLocation();
  return <p data-testid="where">{l.pathname + l.search}</p>;
};
const renderAt = (url = "/Inspections") =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="/Inspections" element={<><InspectionsPage /><Where /></>} />
          <Route path="/Inspections/new" element={<Where />} />
          <Route path="/Inspections/:id" element={<Where />} />
        </Routes>
        <div id="modal-root" />
      </MemoryRouter>
    </QueryClientProvider>
  );

beforeEach(() => {
  permissions = ["inspection.read", "inspection.record"];
  calls.length = 0;
  apiFetch.mockReset();
});

describe("status pills", () => {
  it("shows Completed in the pass green and In progress in the warning colour", () => {
    const { container } = render(
      <>
        <StatusPill status="completed" />
        <StatusPill status="in_progress" />
      </>
    );
    expect(screen.getByText("Completed").className).toContain("text-success-color");
    expect(screen.getByText("In progress").className).toContain("text-warning-color");
    expect(container.querySelectorAll("span")).toHaveLength(2);
  });
});

describe("inspection register", () => {
  it("is a server-side table: sorted newest first, no search or filter row above it, a record count and the Start button", async () => {
    routeApi({ data: [row(), row({ id: "i2", reference: "IPI-26-0002", status: "in_progress", result: null, failures: 2 })], page: 1, pageSize: 25, total: 2 });
    renderAt();
    const table = await screen.findByRole("region", { name: "Inspections" });
    expect(await within(table).findByText("IPI-26-0001")).toBeInTheDocument();
    expect(lastList().path).toContain("sort=startedAt&order=desc");
    expect(within(table).getByText("2 failed so far")).toBeInTheDocument();
    expect(screen.getByText("2 inspections")).toBeInTheDocument();
    expect(screen.queryByLabelText(/Search reference, part/)).toBeNull();
    expect(screen.getByRole("button", { name: "Filter" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start inspection" })).toBeInTheDocument();
  });

  it("sorts by a column header on the server and keeps columns configurable", async () => {
    routeApi({ data: [row()], page: 1, pageSize: 25, total: 1 });
    renderAt();
    const table = await screen.findByRole("region", { name: "Inspections" });
    await within(table).findByText("IPI-26-0001");
    await userEvent.click(within(table).getByTitle("Sort by Part"));
    await waitFor(() => expect(lastList().path).toContain("sort=part&order=asc"));
    expect(screen.getByRole("button", { name: /columns/i })).toBeInTheDocument();
  });

  it("filters from the drawer (several statuses at once), shows chips and clears them", async () => {
    routeApi({ data: [row()], page: 1, pageSize: 25, total: 1 });
    renderAt();
    await screen.findByText("IPI-26-0001");
    await userEvent.click(screen.getByRole("button", { name: "Filter" }));
    const pane = await screen.findByRole("dialog", { name: "Filter inspections" });
    await userEvent.click(within(pane).getByText("In progress"));
    await userEvent.click(within(pane).getByText("Completed"));
    await userEvent.click(within(pane).getByText("Fail"));
    await userEvent.click(within(pane).getByText("First-off"));
    await userEvent.click(within(pane).getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(lastList().path).toMatch(/status=in_progress%2Ccompleted/));
    expect(lastList().path).toContain("result=fail");
    expect(lastList().path).toContain("trigger=first_off");
    expect(screen.getByRole("button", { name: /Remove filter Status: In progress, Completed/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Remove filter Result: Fail/ }));
    await waitFor(() => expect(lastList().path).not.toContain("result=fail"));
    await userEvent.click(screen.getByRole("button", { name: "Clear all" }));
    await waitFor(() => expect(lastList().path).not.toContain("status="));
  });

  it("reads filters from the address, so a filtered register can be shared", async () => {
    routeApi({ data: [], page: 1, pageSize: 25, total: 0 });
    renderAt("/Inspections?status=abandoned&from=2026-11-01&machine=m1&machineLabel=LATHE-1");
    await waitFor(() => expect(lastList().path).toContain("status=abandoned"));
    expect(lastList().path).toContain("from=2026-11-01");
    expect(lastList().path).toContain("machineId=m1");
    expect(await screen.findByRole("button", { name: /Remove filter Machine: LATHE-1/ })).toBeInTheDocument();
  });

  it("opens an inspection from the row actions", async () => {
    routeApi({ data: [row()], page: 1, pageSize: 25, total: 1 });
    renderAt();
    const table = await screen.findByRole("region", { name: "Inspections" });
    await within(table).findByText("IPI-26-0001");
    await userEvent.click(within(table).getByRole("button", { name: "Actions" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Open" }));
    expect(screen.getByTestId("where").textContent).toBe("/Inspections/i1");
  });

  it("hides Start inspection without permission", async () => {
    permissions = ["inspection.read"];
    routeApi({ data: [], page: 1, pageSize: 25, total: 0 });
    renderAt();
    await screen.findByText("0 inspections");
    expect(screen.queryByRole("button", { name: "Start inspection" })).toBeNull();
  });
});
