import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
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
vi.mock("../../contexts/ToastProvider", () => ({ useToast: () => ({ showToast: vi.fn() }) }));

import LotsPage from "./LotsPage";
import OrderPage from "./OrderPage";
import OrdersPage from "./OrdersPage";
import SerialsPage from "./SerialsPage";

const rod = { id: "p1", partNumber: "ROD-100", name: "Rod" };
const order = (over = {}) => ({
  id: "o1", orderNumber: "WO-1001", part: rod, partRevision: { id: "r1", revision: "A", version: 1 }, customer: { id: "c1", code: "ACME", name: "Acme Hydraulics" }, site: { id: "s1", code: "MAIN", name: "Main site" },
  quantityPlanned: 500, dueDate: "2026-12-01", status: "planned", statusReason: null, notes: null, external: null, lotCount: 2, serialCount: 7, operationCount: 1,
  createdAt: "2026-11-01T09:00:00Z", updatedAt: "2026-11-01T09:00:00Z", operations: [], ...over,
});
const lot = (over = {}) => ({
  id: "l1", lotNumber: "LOT-1", part: rod, origin: "produced", productionOrder: { id: "o1", orderNumber: "WO-1001" }, supplier: null, site: { id: "s1", code: "MAIN", name: "Main site" },
  quantity: 100, receivedOn: null, status: "open", statusReason: null, notes: null, serialCount: 3, createdAt: "2026-11-02T09:00:00Z", updatedAt: "2026-11-02T09:00:00Z", ...over,
});
const serial = (over = {}) => ({
  id: "n1", serialNumber: "SN-0001", part: rod, lot: { id: "l1", lotNumber: "LOT-1" }, productionOrder: { id: "o1", orderNumber: "WO-1001" }, site: null, status: "in_production", statusReason: null, notes: null,
  createdAt: "2026-11-03T09:00:00Z", updatedAt: "2026-11-03T09:00:00Z", ...over,
});
const page = (data) => ({ data, page: 1, pageSize: 25, total: data.length });

const calls = [];
let routes;
const routeApi = (extra = {}) => {
  routes = {
    "GET /parts": { data: [rod], nextCursor: null },
    "GET /parts/p1": { ...rod, revisions: [{ id: "r1", revision: "A", status: "released", version: 1 }] },
    "GET /customers": { data: [], nextCursor: null },
    "GET /suppliers": { data: [], nextCursor: null },
    "GET /machines": { data: [{ id: "m1", code: "LATHE-1", name: "Lathe" }], nextCursor: null },
    "GET /production-orders/lookup": { data: [] },
    "GET /lots/lookup": { data: [] },
    "GET /serial-numbers/lookup": { data: [] },
    ...extra,
  };
  apiFetch.mockImplementation(async (path, opts = {}) => {
    const k = `${opts.method ?? "GET"} ${path.split("?")[0]}`;
    calls.push({ k, path, body: opts.body });
    if (!(k in routes)) throw new Error(`unexpected ${k}`);
    const r = routes[k];
    return typeof r === "function" ? r(opts.body) : r;
  });
};
const listCall = (k) => calls.filter((c) => c.k === k).at(-1);
const lastWrite = () => calls.filter((c) => !c.k.startsWith("GET ")).at(-1);

const renderAt = (url, element, path) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path={path} element={element} />
          <Route path="/Production/Orders/:id" element={<div>order page</div>} />
        </Routes>
        <div id="modal-root" />
      </MemoryRouter>
    </QueryClientProvider>
  );

beforeEach(() => {
  permissions = ["production.read", "production.manage"];
  calls.length = 0;
  apiFetch.mockReset();
});

describe("production orders register", () => {
  it("is a server-side table with a count, status badges, newest first, and New order", async () => {
    routeApi({ "GET /production-orders": page([order(), order({ id: "o2", orderNumber: "WO-1002", status: "in_progress", customer: null })]) });
    renderAt("/Production/Orders", <OrdersPage />, "/Production/Orders");
    const table = await screen.findByRole("region", { name: "Orders" });
    expect(await within(table).findByText("WO-1001")).toBeInTheDocument();
    expect(within(table).getByText("Planned")).toBeInTheDocument();
    expect(within(table).getByText("In progress")).toBeInTheDocument();
    expect(within(table).getByText("Acme Hydraulics")).toBeInTheDocument();
    expect(listCall("GET /production-orders").path).toContain("sort=createdAt&order=desc");
    expect(screen.getByText("2 orders")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New order" })).toBeInTheDocument();
  });

  it("filters by status chips in the URL, shows what is filtered and clears it", async () => {
    routeApi({ "GET /production-orders": page([order()]) });
    renderAt("/Production/Orders", <OrdersPage />, "/Production/Orders");
    await screen.findByText("WO-1001");
    await userEvent.click(within(screen.getByRole("group", { name: "Status" })).getByRole("button", { name: "Released" }));
    await userEvent.click(within(screen.getByRole("group", { name: "Status" })).getByRole("button", { name: "In progress" }));
    await waitFor(() => expect(listCall("GET /production-orders").path).toContain("status=released%2Cin_progress"));
    expect(within(screen.getByRole("group", { name: "Status" })).getByRole("button", { name: "Released" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(within(screen.getByRole("group", { name: "Status" })).getByRole("button", { name: "Released" }));
    await waitFor(() => expect(listCall("GET /production-orders").path).toContain("status=in_progress"));
    expect(listCall("GET /production-orders").path).not.toContain("released");
  });

  it("scopes to one part from the URL and offers to remove it", async () => {
    routeApi({ "GET /production-orders": page([order()]) });
    renderAt("/Production/Orders?partId=p1", <OrdersPage />, "/Production/Orders");
    await screen.findByText("WO-1001");
    expect(listCall("GET /production-orders").path).toContain("partId=p1");
    await userEvent.click(screen.getByRole("button", { name: /Remove filter For one part/ }));
    await waitFor(() => expect(listCall("GET /production-orders").path).not.toContain("partId"));
  });

  it("hides New order from someone who may only read", async () => {
    permissions = ["production.read"];
    routeApi({ "GET /production-orders": page([order()]) });
    renderAt("/Production/Orders", <OrdersPage />, "/Production/Orders");
    await screen.findByText("WO-1001");
    expect(screen.queryByRole("button", { name: "New order" })).toBeNull();
  });

  it("creates an order (the only site is chosen), then opens it", async () => {
    routeApi({ "GET /production-orders": page([]), "POST /production-orders": order({ id: "o9", orderNumber: "WO-9" }) });
    renderAt("/Production/Orders", <OrdersPage />, "/Production/Orders");
    await userEvent.click(await screen.findByRole("button", { name: "New order" }));
    const dialog = await screen.findByRole("dialog", { name: "New production order" });
    const submit = within(dialog).getByRole("button", { name: "Create order" });
    expect(submit).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText("Order number"), " WO-9 ");
    await userEvent.type(within(dialog).getByLabelText("Quantity planned"), "50");
    expect(submit).toBeDisabled(); // no part yet
    await userEvent.click(within(dialog).getByRole("combobox", { name: "Part" }));
    await userEvent.click(await screen.findByRole("option", { name: /ROD-100/ }));
    await waitFor(() => expect(submit).toBeEnabled());
    await userEvent.click(submit);
    await waitFor(() => expect(lastWrite()?.k).toBe("POST /production-orders"));
    expect(lastWrite().body).toEqual({ orderNumber: "WO-9", partId: "p1", siteId: "s1", partRevisionId: null, customerId: null, quantityPlanned: 50, dueDate: null, notes: null });
    expect(await screen.findByText("order page")).toBeInTheDocument();
  });

  it("shows the database's answer when it refuses", async () => {
    const { ApiClientError } = await import("../../lib/api-client");
    routeApi({
      "GET /production-orders": page([]),
      "POST /production-orders": () => {
        throw new ApiClientError({ status: 409, code: "conflict", message: "A production order with this number already exists" });
      },
    });
    renderAt("/Production/Orders", <OrdersPage />, "/Production/Orders");
    await userEvent.click(await screen.findByRole("button", { name: "New order" }));
    const dialog = await screen.findByRole("dialog", { name: "New production order" });
    await userEvent.type(within(dialog).getByLabelText("Order number"), "WO-1");
    await userEvent.type(within(dialog).getByLabelText("Quantity planned"), "5");
    await userEvent.click(within(dialog).getByRole("combobox", { name: "Part" }));
    await userEvent.click(await screen.findByRole("option", { name: /ROD-100/ }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Create order" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("A production order with this number already exists");
  });
});

describe("production order page", () => {
  const withOps = (over = {}) =>
    order({
      status: "released",
      operations: [
        { id: "x1", sequence: 10, operationCode: "OP-10", description: "Turning", machine: { id: "m1", code: "LATHE-1", name: "Lathe" }, status: "pending" },
      ],
      ...over,
    });
  const open = (o) => {
    routeApi({ "GET /production-orders/o1": o, "PATCH /production-orders/o1": o, "PATCH /production-operations/x1": o, "POST /production-orders/o1/operations": o });
    return renderAt("/Production/Orders/o1", <OrderPage />, "/Production/Orders/:id");
  };

  it("shows the order, its operations and links to what was made for it", async () => {
    open(withOps());
    expect(await screen.findByRole("heading", { name: "Order WO-1001" })).toBeInTheDocument();
    const ops = screen.getByRole("table", { name: "Operations" });
    expect(within(ops).getByText("OP-10")).toBeInTheDocument();
    expect(within(ops).getByText("LATHE-1 · Lathe")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "2 lots" })).toHaveAttribute("href", "/Production/Lots?productionOrderId=o1");
    expect(screen.getByRole("link", { name: "7 serial numbers" })).toHaveAttribute("href", "/Production/Serials?productionOrderId=o1");
    expect(screen.getByRole("link", { name: "ROD-100 · Rod" })).toHaveAttribute("href", "/Parts/p1");
  });

  it("moves the order on, and asks why before cancelling", async () => {
    open(withOps());
    const moves = await screen.findByRole("group", { name: "Change Order status" });
    await userEvent.click(within(moves).getByRole("button", { name: "Start" }));
    await waitFor(() => expect(lastWrite()).toMatchObject({ k: "PATCH /production-orders/o1", body: { status: "in_progress" } }));
    await userEvent.click(within(moves).getByRole("button", { name: "Cancel order" }));
    const dialog = await screen.findByRole("dialog", { name: "Cancel order" });
    const confirm = within(dialog).getByRole("button", { name: "Cancel order" });
    expect(confirm).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText("Why is the order cancelled?"), "Customer withdrew");
    await userEvent.click(confirm);
    await waitFor(() => expect(lastWrite()).toMatchObject({ k: "PATCH /production-orders/o1", body: { status: "cancelled", statusReason: "Customer withdrew" } }));
  });

  it("moves an operation on and adds one", async () => {
    open(withOps());
    const ops = await screen.findByRole("table", { name: "Operations" });
    await userEvent.click(within(ops).getByRole("button", { name: "Start" }));
    await waitFor(() => expect(lastWrite()).toMatchObject({ k: "PATCH /production-operations/x1", body: { status: "in_progress" } }));
    const form = screen.getByRole("form", { name: "Add an operation" });
    const add = within(form).getByRole("button", { name: "Add operation" });
    expect(add).toBeDisabled();
    await userEvent.type(within(form).getByLabelText("Operation code"), "OP-20");
    await userEvent.click(add);
    await waitFor(() => expect(lastWrite()).toMatchObject({ k: "POST /production-orders/o1/operations", body: { operationCode: "OP-20", description: null, machineId: null } }));
  });

  it("offers no moves, no operation form and no edits on a closed order, and none to a reader", async () => {
    open(withOps({ status: "closed" }));
    await screen.findByRole("heading", { name: "Order WO-1001" });
    expect(screen.queryByRole("group", { name: "Change Order status" })).toBeNull();
    expect(screen.queryByRole("form", { name: "Add an operation" })).toBeNull();
    expect(within(screen.getByRole("table", { name: "Operations" })).queryByRole("button")).toBeNull();
  });

  it("is read-only for someone without production.manage", async () => {
    permissions = ["production.read"];
    open(withOps());
    await screen.findByRole("heading", { name: "Order WO-1001" });
    expect(screen.queryByRole("group", { name: "Change Order status" })).toBeNull();
    expect(screen.queryByRole("form", { name: "Add an operation" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /View/ }));
    const dialog = await screen.findByRole("dialog", { name: "Order WO-1001" });
    expect(within(dialog).queryByRole("button", { name: "Save changes" })).toBeNull();
  });
});

describe("lots register", () => {
  it("lists lots with their origin, order and status, and filters by origin", async () => {
    routeApi({ "GET /lots": page([lot(), lot({ id: "l2", lotNumber: "HEAT-77", origin: "received", productionOrder: null, supplier: { id: "su1", code: "STEEL", name: "Steel Co" }, status: "on_hold", statusReason: "Suspect" })]) });
    renderAt("/Production/Lots", <LotsPage />, "/Production/Lots");
    const table = await screen.findByRole("region", { name: "Lots" });
    expect(await within(table).findByText("HEAT-77")).toBeInTheDocument();
    expect(within(table).getByText("On hold")).toBeInTheDocument();
    expect(within(table).getByText("Steel Co")).toBeInTheDocument();
    expect(screen.getByText("2 lots")).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("Origin"), "received");
    await waitFor(() => expect(listCall("GET /lots").path).toContain("origin=received"));
  });

  it("creates a received lot with its supplier and received date left out when produced", async () => {
    routeApi({ "GET /lots": page([]), "POST /lots": lot() });
    renderAt("/Production/Lots", <LotsPage />, "/Production/Lots");
    await userEvent.click(await screen.findByRole("button", { name: "New lot" }));
    const dialog = await screen.findByRole("dialog", { name: "New lot" });
    await userEvent.type(within(dialog).getByLabelText("Lot number"), "LOT-5");
    await userEvent.click(within(dialog).getByRole("combobox", { name: "Part" }));
    await userEvent.click(await screen.findByRole("option", { name: /ROD-100/ }));
    await userEvent.type(within(dialog).getByLabelText("Quantity"), "40");
    await userEvent.click(within(dialog).getByRole("button", { name: "Create lot" }));
    await waitFor(() => expect(lastWrite()?.k).toBe("POST /lots"));
    expect(lastWrite().body).toMatchObject({ lotNumber: "LOT-5", partId: "p1", origin: "produced", productionOrderId: null, supplierId: null, quantity: 40, receivedOn: null });
  });

  it("puts a lot on hold only with a reason", async () => {
    routeApi({ "GET /lots": page([lot()]), "PATCH /lots/l1": lot({ status: "on_hold", statusReason: "Suspect material" }) });
    renderAt("/Production/Lots", <LotsPage />, "/Production/Lots");
    const row = await screen.findByText("LOT-1");
    await userEvent.dblClick(row);
    const dialog = await screen.findByRole("dialog", { name: "Lot LOT-1" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Put on hold" }));
    const ask = await screen.findByRole("dialog", { name: "Put on hold" });
    const confirm = within(ask).getByRole("button", { name: "Put on hold" });
    expect(confirm).toBeDisabled();
    await userEvent.type(within(ask).getByLabelText("Why is the lot on hold?"), "Suspect material");
    await userEvent.click(confirm);
    await waitFor(() => expect(lastWrite()).toMatchObject({ k: "PATCH /lots/l1", body: { status: "on_hold", statusReason: "Suspect material" } }));
  });

  it("shows a closed lot as frozen, without a save button", async () => {
    routeApi({ "GET /lots": page([lot({ status: "closed" })]) });
    renderAt("/Production/Lots", <LotsPage />, "/Production/Lots");
    await userEvent.dblClick(await screen.findByText("LOT-1"));
    const dialog = await screen.findByRole("dialog", { name: "Lot LOT-1" });
    expect(within(dialog).getByText(/closed, so it can no longer be changed/)).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Save changes" })).toBeNull();
    expect(within(dialog).queryByRole("group", { name: "Change Lot status" })).toBeNull();
  });
});

describe("serial numbers register", () => {
  const openNew = async () => {
    routeApi({ "GET /serial-numbers": page([serial()]), "POST /serial-numbers": { data: [serial()] } });
    renderAt("/Production/Serials", <SerialsPage />, "/Production/Serials");
    await userEvent.click(await screen.findByRole("button", { name: "New serial numbers" }));
    const dialog = await screen.findByRole("dialog", { name: "New serial numbers" });
    await userEvent.click(within(dialog).getByRole("combobox", { name: "Part" }));
    await userEvent.click(await screen.findByRole("option", { name: /ROD-100/ }));
    return dialog;
  };

  it("lists serial numbers with part, lot and status", async () => {
    routeApi({ "GET /serial-numbers": page([serial(), serial({ id: "n2", serialNumber: "SN-0002", status: "scrapped" })]) });
    renderAt("/Production/Serials?lotId=l1", <SerialsPage />, "/Production/Serials");
    const table = await screen.findByRole("region", { name: "Serial numbers" });
    expect(await within(table).findByText("SN-0002")).toBeInTheDocument();
    expect(within(table).getByText("Scrapped")).toBeInTheDocument();
    expect(listCall("GET /serial-numbers").path).toContain("lotId=l1");
    expect(screen.getByRole("button", { name: /Remove filter In one lot/ })).toBeInTheDocument();
  });

  it("adds one serial number", async () => {
    const dialog = await openNew();
    await userEvent.type(within(dialog).getByLabelText("Serial number"), "SN-77");
    await userEvent.click(within(dialog).getByRole("button", { name: "Add 1 serial number" }));
    await waitFor(() => expect(lastWrite()?.k).toBe("POST /serial-numbers"));
    expect(lastWrite().body).toEqual({ partId: "p1", lotId: null, productionOrderId: null, notes: null, serialNumber: "SN-77" });
  });

  it("previews and adds a numbered range", async () => {
    const dialog = await openNew();
    await userEvent.click(within(dialog).getByRole("tab", { name: "A range" }));
    await userEvent.type(within(dialog).getByLabelText("Prefix"), "SN-");
    const from = within(dialog).getByLabelText("From");
    await userEvent.clear(from);
    await userEvent.type(from, "8");
    const to = within(dialog).getByLabelText("To");
    await userEvent.clear(to);
    await userEvent.type(to, "12");
    expect(within(dialog).getByText(/5 serial numbers: SN-0008 … SN-0012/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Add 5 serial numbers" }));
    await waitFor(() => expect(lastWrite()?.k).toBe("POST /serial-numbers"));
    expect(lastWrite().body.serials).toEqual(["SN-0008", "SN-0009", "SN-0010", "SN-0011", "SN-0012"]);
  });

  it("adds a pasted list and refuses a range over the limit", async () => {
    const dialog = await openNew();
    await userEvent.click(within(dialog).getByRole("tab", { name: "A list" }));
    await userEvent.type(within(dialog).getByLabelText("Serial numbers"), "A1, A2{enter}A3");
    expect(within(dialog).getByText(/3 serial numbers: A1, A2, A3/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("tab", { name: "A range" }));
    const to = within(dialog).getByLabelText("To");
    await userEvent.clear(to);
    await userEvent.type(to, "600");
    expect(within(dialog).getByText(/at most 500 at a time/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: /^Add/ })).toBeDisabled();
  });

  it("scraps a serial number only with a reason", async () => {
    routeApi({ "GET /serial-numbers": page([serial()]), "PATCH /serial-numbers/n1": serial({ status: "scrapped", statusReason: "Cracked" }) });
    renderAt("/Production/Serials", <SerialsPage />, "/Production/Serials");
    await userEvent.dblClick(await screen.findByText("SN-0001"));
    const dialog = await screen.findByRole("dialog", { name: "Serial number SN-0001" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Scrap" }));
    const ask = await screen.findByRole("dialog", { name: "Scrap" });
    expect(within(ask).getByRole("button", { name: "Scrap" })).toBeDisabled();
    await userEvent.type(within(ask).getByLabelText("Why is it scrapped?"), "Cracked");
    await userEvent.click(within(ask).getByRole("button", { name: "Scrap" }));
    await waitFor(() => expect(lastWrite()).toMatchObject({ k: "PATCH /serial-numbers/n1", body: { status: "scrapped", statusReason: "Cracked" } }));
  });
});
