import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

let permissions;
let orgSettings;
let job;
const apiFetch = vi.fn();
vi.mock("../../lib/api-client", async (importOriginal) => ({ ...(await importOriginal()), apiFetch: (...a) => apiFetch(...a) }));
vi.mock("../../contexts/OrganisationProvider", () => ({ useOrganisation: () => ({ organisationId: "org-1" }) }));
vi.mock("../../hooks/useQmsApi", () => ({
  usePermissions: () => ({ can: (p) => permissions.includes(p) }),
  useSites: () => ({ data: { data: [] } }),
  useOrganisationDetails: () => ({ data: { settings: orgSettings } }),
}));
vi.mock("../../contexts/ToastProvider", () => ({ useToast: () => ({ showToast: vi.fn() }) }));

import JobPage from "./JobPage";

const rod = { id: "p1", partNumber: "ROD-1", name: "Rod" };
const order = { id: "o1", orderNumber: "WO-154789", status: "released" };
const baseJob = (over = {}) => ({
  id: "j1", reference: "IPI-26-0007", status: "in_progress", result: null, part: rod, partRevision: "A", plan: { id: "cp1", planCode: "CP-ROD", revisionCode: "A" }, operationCode: "OP-10",
  site: { id: "s1", name: "Plant A" }, machine: { id: "m1", code: "CNC-1", name: "Lathe 1" }, workOrder: null, lot: null, lotSize: 24, serial: null,
  links: { productionOrder: null, lot: null, serial: null },
  triggerType: "first_off", startedAt: new Date().toISOString(), startedBy: { id: "u1", name: "Sam Operator" }, failures: 0, completedAt: null, completedBy: null, abandonReason: null,
  requirements: [], schedule: [], samples: [], measurements: [], ncrs: [], ...over,
});

const renderIt = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={["/Jobs/j1"]}>
        <Routes>
          <Route path="/Jobs/:id" element={<JobPage />} />
        </Routes>
        <div id="modal-root" />
      </MemoryRouter>
    </QueryClientProvider>
  );
const writes = () => apiFetch.mock.calls.filter(([, o]) => o && o.method && o.method !== "GET").map(([path, o]) => ({ path, method: o.method, body: o.body }));

beforeEach(() => {
  permissions = ["inspection.read", "inspection.record", "production.read"];
  orgSettings = { useLotsAndSerials: true, allowInlineOrders: false, requireProductionOrder: false };
  job = baseJob();
  apiFetch.mockReset();
  apiFetch.mockImplementation(async (path, opts = {}) => {
    const k = `${opts.method ?? "GET"} ${path.split("?")[0]}`;
    if (k === "GET /inspections/j1") return job;
    if (k.startsWith("GET /gauges")) return { data: [], page: 1, pageSize: 200, total: 0 };
    if (k === "GET /jobs/j1/revisions") return { days: 30, partRevisionSuperseded: false, planRevisionSuperseded: false, data: [] };
    if (k === "GET /production-orders/lookup") return { data: [{ id: "o1", orderNumber: "WO-154789", part: rod, status: "released", quantityPlanned: 24 }] };
    if (k === "GET /lots/lookup") return { data: [] };
    if (k === "GET /serial-numbers/lookup") return { data: [] };
    if (k === "PUT /jobs/j1/production-links") {
      job = { ...job, links: { ...job.links, ...(opts.body.productionOrderId ? { productionOrder: order } : {}) }, workOrder: opts.body.productionOrderId ? "WO-154789" : job.workOrder };
      return job;
    }
    if (k === "POST /production-orders/inline") return { id: "o9", orderNumber: opts.body.orderNumber, status: "planned", quantityPlanned: opts.body.quantityPlanned, part: rod };
    throw new Error(`unexpected ${k}`);
  });
});

describe("production records on the job hub", () => {
  it("offers the order, lot and serial number to people who may read them, and links the job to the order picked", async () => {
    renderIt();
    const records = await screen.findByLabelText("Production records");
    expect(within(records).getByRole("combobox", { name: "Production order" })).toBeInTheDocument();
    expect(within(records).getByRole("combobox", { name: "Lot" })).toBeInTheDocument();
    expect(within(records).getByRole("combobox", { name: "Serial number" })).toBeInTheDocument();
    await userEvent.click(within(records).getByRole("combobox", { name: "Production order" }));
    await userEvent.click(await screen.findByRole("option", { name: /WO-154789/ }));
    await waitFor(() => expect(writes()).toEqual([{ path: "/jobs/j1/production-links", method: "PUT", body: { productionOrderId: "o1" } }]));
    // The typed work order now comes from the order and cannot be typed over.
    await waitFor(() => expect(screen.getByLabelText("Work order")).toBeDisabled());
    expect(screen.getByLabelText("Work order")).toHaveValue("WO-154789");
    expect(screen.getByText("From the production order")).toBeInTheDocument();
  });

  it("is not shown to someone who may not read production records, and the typed fields stay as they were", async () => {
    permissions = ["inspection.read", "inspection.record"];
    renderIt();
    await screen.findByLabelText("Work order");
    expect(screen.queryByLabelText("Production records")).toBeNull();
    expect(screen.getByLabelText("Work order")).toBeEnabled();
  });

  it("offers only the order when the organisation does not use lots and serial numbers", async () => {
    orgSettings = { ...orgSettings, useLotsAndSerials: false };
    renderIt();
    const records = await screen.findByLabelText("Production records");
    expect(within(records).getByRole("combobox", { name: "Production order" })).toBeInTheDocument();
    expect(within(records).queryByRole("combobox", { name: "Lot" })).toBeNull();
    expect(within(records).queryByRole("combobox", { name: "Serial number" })).toBeNull();
  });

  it("says, as information, when the lot is on hold or the order is closed", async () => {
    job = baseJob({ links: { productionOrder: { ...order, status: "closed" }, lot: { id: "l1", lotNumber: "LOT-1", status: "on_hold", statusReason: "Suspect material" }, serial: null }, workOrder: "WO-154789", lot: "LOT-1" });
    renderIt();
    const notes = await screen.findByLabelText("About the linked production records");
    expect(within(notes).getByText("Lot LOT-1 is on hold: Suspect material.")).toBeInTheDocument();
    expect(within(notes).getByText("Order WO-154789 is closed.")).toBeInTheDocument();
    expect(within(screen.getByLabelText("Production records")).getByRole("combobox", { name: "Production order" })).toBeEnabled(); // nothing is blocked
  });

  it("lets people who manage production make a new order for the job’s part, and links it", async () => {
    permissions = [...permissions, "production.manage"];
    renderIt();
    await userEvent.click(await screen.findByRole("button", { name: "Not listed? Make a new order" }));
    const dialog = await screen.findByRole("dialog", { name: "Make a production order" });
    const make = within(dialog).getByRole("button", { name: "Make order" });
    expect(make).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText("Order number"), "WO-NEW-1");
    await userEvent.type(within(dialog).getByLabelText("Quantity ordered"), "24");
    await userEvent.click(make);
    await waitFor(() => expect(writes().map((w) => [w.method, w.path])).toEqual([["POST", "/production-orders/inline"], ["PUT", "/jobs/j1/production-links"]]));
    expect(writes()[0].body).toEqual({ orderNumber: "WO-NEW-1", partId: "p1", quantityPlanned: 24, siteId: "s1" });
    expect(writes()[1].body).toEqual({ productionOrderId: "o9" });
  });

  it("offers an operator that only when the organisation allows it", async () => {
    renderIt();
    await screen.findByLabelText("Production records");
    expect(screen.queryByRole("button", { name: "Not listed? Make a new order" })).toBeNull();
  });

  it("offers an operator that when the organisation allows it", async () => {
    orgSettings = { ...orgSettings, allowInlineOrders: true };
    renderIt();
    expect(await screen.findByRole("button", { name: "Not listed? Make a new order" })).toBeInTheDocument();
  });

  it("does not let a finished job be linked", async () => {
    job = baseJob({ status: "completed", result: "pass", completedAt: new Date().toISOString(), completedBy: { id: "u1", name: "Sam" } });
    renderIt();
    const records = await screen.findByLabelText("Production records");
    expect(within(records).getByRole("combobox", { name: "Production order" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Not listed? Make a new order" })).toBeNull();
  });
});
