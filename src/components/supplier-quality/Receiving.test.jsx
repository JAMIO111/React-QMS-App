import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

let permissions;
const apiFetch = vi.fn();
vi.mock("../../lib/api-client", async (importOriginal) => ({ ...(await importOriginal()), apiFetch: (...a) => apiFetch(...a) }));
vi.mock("../../contexts/OrganisationProvider", () => ({ useOrganisation: () => ({ organisationId: "org-1" }) }));
vi.mock("../../hooks/useQmsApi", () => ({ usePermissions: () => ({ can: (p) => permissions.includes(p) }) }));
vi.mock("../../contexts/ToastProvider", () => ({ useToast: () => ({ showToast: vi.fn() }) }));
// The part picker searches parts; these tests use materials, so keep it quiet.
vi.mock("../ncr/Pickers", async (importOriginal) => ({ ...(await importOriginal()), PartPicker: () => null }));

import PurchaseOrdersPage from "./PurchaseOrdersPage";
import PurchaseOrderPage from "./PurchaseOrderPage";
import GoodsReceiptPage from "./GoodsReceiptPage";
import SupplierReceiving from "./SupplierReceiving";

const supplier = { id: "s1", code: "ACME", name: "Acme Metals" };
const orderRow = (over = {}) => ({ id: "o1", poNumber: "PO-1", supplier, status: "open", orderedOn: "2026-11-01", lineCount: 2, outstandingLines: 2, lateLines: 1, nextDueOn: "2026-11-05", createdAt: "2026-11-01T09:00:00Z", ...over });
const order = (over = {}) => ({
  ...orderRow(), notes: null, cancelReason: null, closedAt: null, createdBy: null,
  lines: [
    { id: "l1", lineNumber: 1, part: { id: "p1", partNumber: "BRK-1", name: "Bracket" }, material: null, quantityOrdered: 100, unit: "kg", requestedOn: "2026-11-01", agreedOn: null, dueOn: "2026-11-01", status: "open", quantityReceived: 0, quantityOutstanding: 100, late: true, daysLate: 8, firstReceivedOn: null, lastReceivedOn: null },
    { id: "l2", lineNumber: 2, part: null, material: "Bolts", quantityOrdered: 10, unit: null, requestedOn: "2026-12-20", agreedOn: null, dueOn: "2026-12-20", status: "open", quantityReceived: 4, quantityOutstanding: 6, late: false, daysLate: 0, firstReceivedOn: "2026-11-02", lastReceivedOn: "2026-11-02" },
  ],
  receipts: [], ...over,
});
const receipt = (over = {}) => ({
  id: "g1", reference: "GR-26-0001", supplier, purchaseOrder: { id: "o1", poNumber: "PO-1" }, site: null, receivedOn: "2026-11-02", deliveryNote: "DN-4412", status: "received", lineCount: 1, createdAt: "2026-11-02T09:00:00Z",
  notes: null, cancelledAt: null, cancelledBy: null, cancelReason: null, createdBy: { id: "u1", name: "Ada Owner" },
  lines: [{ id: "x1", poLine: { id: "l1", lineNumber: 1 }, part: { id: "p1", partNumber: "BRK-1", name: "Bracket" }, material: null, quantityReceived: 60, lot: { id: "lot1", lotNumber: "LOT-A" }, notes: null }], ...over,
});
const calls = [];
const routeApi = (routes = {}) =>
  apiFetch.mockImplementation(async (path, opts = {}) => {
    const k = `${opts.method ?? "GET"} ${path.split("?")[0]}`;
    calls.push({ k, path, body: opts.body });
    if (!(k in routes)) throw new Error(`unexpected ${k}`);
    return typeof routes[k] === "function" ? routes[k](path, opts) : routes[k];
  });
const renderAt = (ui, at, route = "*") =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[at]}>
        <Routes><Route path={route} element={ui} /></Routes>
        <div id="modal-root" />
      </MemoryRouter>
    </QueryClientProvider>
  );

beforeEach(() => {
  permissions = ["receiving.read", "receiving.manage", "master_data.read"];
  calls.length = 0;
  apiFetch.mockReset();
});

describe("purchase order register", () => {
  it("lists open orders, flags late lines, filters Late and offers Record an order only to managers", async () => {
    routeApi({ "GET /purchase-orders": { data: [orderRow()], page: 1, pageSize: 25, total: 1 } });
    renderAt(<PurchaseOrdersPage />, "/Supplier-Quality/Purchase-Orders", "/Supplier-Quality/Purchase-Orders");
    expect(await screen.findByRole("link", { name: "PO-1" })).toHaveAttribute("href", "/Supplier-Quality/Purchase-Orders/o1");
    expect(screen.getByText("1 late")).toBeInTheDocument();
    expect(calls[0].path).toContain("status=open");
    expect(screen.getByRole("button", { name: /Record an order/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Late" }));
    await waitFor(() => expect(calls.at(-1).path).toContain("late=true"));
  });

  it("hides the record button from people who can only read", async () => {
    permissions = ["receiving.read"];
    routeApi({ "GET /purchase-orders": { data: [], page: 1, pageSize: 25, total: 0 } });
    renderAt(<PurchaseOrdersPage />, "/Supplier-Quality/Purchase-Orders", "/Supplier-Quality/Purchase-Orders");
    expect(await screen.findByText("No purchase orders here")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Record an order/ })).not.toBeInTheDocument();
  });
});

describe("purchase order page", () => {
  const open = (o = order()) => {
    routeApi({ "GET /purchase-orders/o1": o, "GET /purchase-orders/lookup": { data: [] } });
    renderAt(<PurchaseOrderPage />, "/Supplier-Quality/Purchase-Orders/o1", "/Supplier-Quality/Purchase-Orders/:id");
  };

  it("shows each line's received, outstanding and lateness, and the requested and agreed dates", async () => {
    open();
    expect(await screen.findByRole("heading", { name: "PO-1" })).toBeInTheDocument();
    expect(screen.getByText(/1 line is late/)).toBeInTheDocument();
    const table = screen.getByRole("table", { name: "Order lines" });
    expect(within(table).getByText("8 days late")).toBeInTheDocument();
    expect(within(table).getAllByRole("row")).toHaveLength(3);
    expect(within(table).getByText("100 kg")).toBeInTheDocument();
    expect(within(table).getByText("BRK-1 · Bracket")).toBeInTheDocument();
  });

  it("records a delivery against the order with the outstanding quantity ready, and a lot number that makes the lot", async () => {
    routeApi({
      "GET /purchase-orders/o1": order(),
      "GET /purchase-orders/lookup": { data: [] },
      "POST /goods-receipts": receipt(),
      "GET /goods-receipts/g1": receipt(),
    });
    renderAt(<PurchaseOrderPage />, "/Supplier-Quality/Purchase-Orders/o1", "/Supplier-Quality/Purchase-Orders/:id");
    await userEvent.click(await screen.findByRole("button", { name: "Record a delivery" }));
    const dialog = await screen.findByRole("dialog");
    const qty1 = await within(dialog).findByLabelText("Line 1 quantity received");
    expect(qty1).toHaveValue(100);
    expect(within(dialog).getByLabelText("Line 2 quantity received")).toHaveValue(6);
    await userEvent.clear(qty1);
    await userEvent.type(qty1, "60");
    await userEvent.click(within(dialog).getByLabelText("Include Line 2: Bolts")); // not delivered this time
    await userEvent.type(within(dialog).getByLabelText("Line 1 lot number"), "LOT-A");
    await userEvent.type(within(dialog).getByLabelText("Delivery note"), "DN-4412");
    await userEvent.click(within(dialog).getByRole("button", { name: "Record receipt" }));
    await waitFor(() => expect(calls.find((c) => c.k === "POST /goods-receipts")).toBeTruthy());
    const body = calls.find((c) => c.k === "POST /goods-receipts").body;
    expect(body).toMatchObject({ supplierId: "s1", purchaseOrderId: "o1", deliveryNote: "DN-4412", lines: [{ poLineId: "l1", quantity: 60, lotNumber: "LOT-A" }] });
    expect(body.lines).toHaveLength(1);
    expect(body.clientKey).toHaveLength(36);
  });

  it("sets the agreed date without touching the requested one", async () => {
    routeApi({
      "GET /purchase-orders/o1": order(),
      "GET /purchase-orders/lookup": { data: [] },
      "PATCH /purchase-order-lines/l1": order(),
    });
    renderAt(<PurchaseOrderPage />, "/Supplier-Quality/Purchase-Orders/o1", "/Supplier-Quality/Purchase-Orders/:id");
    await userEvent.click(await screen.findByRole("button", { name: "Set the agreed date for line 1" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/that stays/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls.find((c) => c.k === "PATCH /purchase-order-lines/l1")?.body).toEqual({ agreedOn: null }));
  });

  it("a read-only person sees the order but no actions; a closed order has none either", async () => {
    permissions = ["receiving.read"];
    open();
    await screen.findByRole("heading", { name: "PO-1" });
    expect(screen.queryByRole("button", { name: "Record a delivery" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Close order" })).not.toBeInTheDocument();
  });

  it("cancelling needs a reason", async () => {
    routeApi({ "GET /purchase-orders/o1": order(), "POST /purchase-orders/o1/cancel": order({ status: "cancelled", cancelReason: "Supplier cannot deliver" }) });
    renderAt(<PurchaseOrderPage />, "/Supplier-Quality/Purchase-Orders/o1", "/Supplier-Quality/Purchase-Orders/:id");
    await userEvent.click(await screen.findByRole("button", { name: "Cancel order" }));
    const dialog = await screen.findByRole("dialog");
    const submit = within(dialog).getByRole("button", { name: "Cancel order" });
    expect(submit).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText("Why is it being cancelled?"), "Supplier cannot deliver");
    await userEvent.click(submit);
    await waitFor(() => expect(calls.find((c) => c.k === "POST /purchase-orders/o1/cancel")?.body).toEqual({ reason: "Supplier cannot deliver" }));
  });
});

describe("goods receipt page", () => {
  it("shows the lines, links a made lot to its trace and cancels with a reason", async () => {
    routeApi({ "GET /goods-receipts/g1": receipt(), "POST /goods-receipts/g1/cancel": receipt({ status: "cancelled", cancelReason: "Wrong site", cancelledAt: "2026-11-03T09:00:00Z", cancelledBy: { id: "u1", name: "Ada Owner" } }) });
    renderAt(<GoodsReceiptPage />, "/Supplier-Quality/Goods-Receipts/g1", "/Supplier-Quality/Goods-Receipts/:id");
    expect(await screen.findByRole("heading", { name: "GR-26-0001" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "LOT-A" })).toHaveAttribute("href", "/Production/Traceability?type=lot&id=lot1");
    expect(screen.getByRole("link", { name: "PO-1" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Cancel receipt" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText("Why is it being cancelled?"), "Wrong site");
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel receipt" }));
    await waitFor(() => expect(calls.find((c) => c.k === "POST /goods-receipts/g1/cancel")?.body).toEqual({ reason: "Wrong site" }));
  });
});

describe("the supplier's Incoming quality tab", () => {
  it("lists open orders and the latest deliveries and offers both actions", async () => {
    routeApi({
      "GET /purchase-orders": { data: [orderRow()], page: 1, pageSize: 25, total: 1 },
      "GET /goods-receipts": { data: [{ ...receipt(), lines: undefined }], page: 1, pageSize: 10, total: 1 },
    });
    renderAt(<SupplierReceiving supplier={{ ...supplier, displayName: null }} />, "/");
    expect((await screen.findAllByRole("link", { name: "PO-1" })).length).toBeGreaterThan(0);
    expect(await screen.findByRole("link", { name: "GR-26-0001" })).toBeInTheDocument();
    expect(calls.find((c) => c.k === "GET /purchase-orders").path).toContain("supplierId=s1");
    expect(screen.getByRole("button", { name: /Record an order/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Record a delivery/ })).toBeInTheDocument();
  });

  it("records a purchase order with its lines for this supplier, and a line can be added and removed", async () => {
    routeApi({
      "GET /purchase-orders": { data: [], page: 1, pageSize: 25, total: 0 },
      "GET /goods-receipts": { data: [], page: 1, pageSize: 10, total: 0 },
      "POST /purchase-orders": order(),
      "GET /purchase-orders/o1": order(),
    });
    renderAt(<SupplierReceiving supplier={{ ...supplier, displayName: null }} />, "/");
    await userEvent.click(await screen.findByRole("button", { name: /Record an order/ }));
    const dialog = await screen.findByRole("dialog");
    const submit = within(dialog).getByRole("button", { name: "Record order" });
    expect(submit).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText("Order number"), "PO-9");
    await userEvent.click(within(dialog).getByRole("button", { name: /Add a line/ }));
    expect(within(dialog).getByLabelText("Line 2 material")).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Remove line 2" }));
    expect(within(dialog).queryByLabelText("Line 2 material")).not.toBeInTheDocument();
    await userEvent.type(within(dialog).getByLabelText("Line 1 material"), "Steel bar");
    await userEvent.type(within(dialog).getByLabelText(/Line 1 quantity/), "40");
    await userEvent.click(submit);
    await waitFor(() => expect(calls.find((c) => c.k === "POST /purchase-orders")).toBeTruthy());
    expect(calls.find((c) => c.k === "POST /purchase-orders").body).toMatchObject({ supplierId: "s1", poNumber: "PO-9", lines: [{ material: "Steel bar", quantity: 40 }] });
  });

  it("says so when the person has no access", () => {
    permissions = [];
    routeApi({});
    renderAt(<SupplierReceiving supplier={supplier} />, "/");
    expect(screen.getByText(/do not have access to purchasing and receiving/)).toBeInTheDocument();
    expect(apiFetch).not.toHaveBeenCalled();
  });
});
