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
// The pickers search the server; here each is a button that chooses one fixed record.
vi.mock("../ncr/Pickers", async (importOriginal) => ({
  ...(await importOriginal()),
  PartPicker: ({ label, onChange }) => <button type="button" onClick={() => onChange("p1")}>{label}</button>,
  PartyPicker: ({ label, onChange }) => <button type="button" onClick={() => onChange("c1")}>{label}</button>,
}));

import CustomerOrdersPage from "./CustomerOrdersPage";
import CustomerOrderPage from "./CustomerOrderPage";
import ShipmentPage from "./ShipmentPage";
import { orderFilterQuery } from "../../lib/shipping";

const customer = { id: "c1", code: "ACME", name: "Acme Motors" };
const orderRow = (over = {}) => ({ id: "o1", orderNumber: "CO-1", customerReference: "PO-7788", customer, status: "open", orderedOn: "2026-11-01", lineCount: 2, outstandingLines: 2, lateLines: 1, nextDueOn: "2026-11-05", createdAt: "2026-11-01T09:00:00Z", ...over });
const order = (over = {}) => ({
  ...orderRow(), notes: null, cancelReason: null, closedAt: null, createdBy: null,
  lines: [
    { id: "l1", lineNumber: 1, part: { id: "p1", partNumber: "BRK-1", name: "Bracket" }, quantityOrdered: 100, unit: "pcs", requestedOn: "2026-11-01", agreedOn: null, dueOn: "2026-11-01", status: "open", quantityShipped: 0, quantityOutstanding: 100, quantityOver: 0, late: true, daysLate: 8, firstShippedOn: null, lastShippedOn: null },
    { id: "l2", lineNumber: 2, part: { id: "p2", partNumber: "BRK-2", name: "Other" }, quantityOrdered: 10, unit: null, requestedOn: "2026-12-20", agreedOn: null, dueOn: "2026-12-20", status: "open", quantityShipped: 14, quantityOutstanding: 0, quantityOver: 4, late: false, daysLate: 0, firstShippedOn: "2026-11-02", lastShippedOn: "2026-11-02" },
  ],
  shipments: [], ...over,
});
const shipment = (over = {}) => ({
  id: "s1", reference: "SH-26-0001", customer, customerOrder: { id: "o1", orderNumber: "CO-1" }, site: null, shippedOn: "2026-11-02", deliveryNote: "DN-4412", status: "shipped", lineCount: 1, createdAt: "2026-11-02T09:00:00Z",
  notes: null, cancelledAt: null, cancelledBy: null, cancelReason: null, createdBy: { id: "u1", name: "Ada Owner" },
  lines: [{ id: "x1", lineNumber: 1, orderLine: { id: "l1", lineNumber: 1 }, part: { id: "p1", partNumber: "BRK-1", name: "Bracket" }, quantityShipped: 60, lot: { id: "lot1", lotNumber: "LOT-A" }, lotStatus: "on_hold", notes: null }], ...over,
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
  permissions = ["shipping.read", "shipping.manage", "master_data.read"];
  calls.length = 0;
  apiFetch.mockReset();
});

describe("customer order filters", () => {
  it("say what each view asks the API for", () => {
    expect(orderFilterQuery("open")).toEqual({ status: "open" });
    expect(orderFilterQuery("late")).toEqual({ status: "open", late: "true" });
    expect(orderFilterQuery("closed")).toEqual({ status: "closed,cancelled" });
    expect(orderFilterQuery("all")).toEqual({ status: "all" });
  });
});

describe("customer order register", () => {
  it("lists orders with the customer's own number and what is late, and asks for late ones", async () => {
    routeApi({ "GET /customer-orders": { data: [orderRow()], page: 1, pageSize: 25, total: 1 } });
    renderAt(<CustomerOrdersPage />, "/");
    expect(await screen.findByRole("link", { name: "CO-1" })).toBeInTheDocument();
    expect(screen.getByText("PO-7788")).toBeInTheDocument();
    expect(screen.getByText("1 late")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Late" }));
    await waitFor(() => expect(calls.some((c) => c.path.includes("late=true") && c.path.includes("status=open"))).toBe(true));
  });

  it("records an order only when it is complete, then sends it", async () => {
    routeApi({
      "GET /customer-orders": { data: [], page: 1, pageSize: 25, total: 0 },
      "POST /customer-orders": order(),
      "GET /customer-orders/o1": order(),
    });
    renderAt(<CustomerOrdersPage />, "/");
    await userEvent.click(await screen.findByRole("button", { name: /Record an order/ }));
    const dialog = await screen.findByRole("dialog");
    const submit = within(dialog).getByRole("button", { name: "Record order" });
    expect(submit).toBeDisabled();
    await userEvent.click(within(dialog).getByRole("button", { name: "Customer" }));
    await userEvent.type(within(dialog).getByLabelText("Order number"), "CO-9");
    await userEvent.click(within(dialog).getByRole("button", { name: /Line 1 part/ }));
    await userEvent.type(within(dialog).getByLabelText(/Line 1 quantity/), "40");
    await userEvent.click(within(dialog).getByRole("button", { name: /Add a line/ }));
    expect(within(dialog).getByLabelText(/Line 2 quantity/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Remove line 2" }));
    expect(within(dialog).queryByLabelText(/Line 2 quantity/)).not.toBeInTheDocument();
    await userEvent.click(submit);
    await waitFor(() => expect(calls.find((c) => c.k === "POST /customer-orders")).toBeTruthy());
    expect(calls.find((c) => c.k === "POST /customer-orders").body).toMatchObject({ customerId: "c1", orderNumber: "CO-9", lines: [{ partId: "p1", quantity: 40 }] });
  });

  it("hides the record button from someone who may only read", async () => {
    permissions = ["shipping.read"];
    routeApi({ "GET /customer-orders": { data: [], page: 1, pageSize: 25, total: 0 } });
    renderAt(<CustomerOrdersPage />, "/");
    await screen.findByText(/No customer orders here/);
    expect(screen.queryByRole("button", { name: /Record an order/ })).not.toBeInTheDocument();
  });
});

describe("customer order page", () => {
  const at = "/Shipping/Orders/o1";
  const route = "/Shipping/Orders/:id";

  it("shows shipped, outstanding, over and late for each line", async () => {
    routeApi({ "GET /customer-orders/o1": order() });
    renderAt(<CustomerOrderPage />, at, route);
    expect(await screen.findByRole("heading", { name: "CO-1" })).toBeInTheDocument();
    expect(screen.getByText("1 line is late")).toBeInTheDocument();
    expect(screen.getByText("8 days late")).toBeInTheDocument();
    expect(screen.getByText("over by 4")).toBeInTheDocument();
    expect(screen.getByText("Nothing shipped yet.")).toBeInTheDocument();
  });

  it("records a shipment with the outstanding quantities ready and the lot named", async () => {
    routeApi({ "GET /customer-orders/o1": order(), "POST /shipments": shipment(), "GET /shipments/s1": shipment() });
    renderAt(<CustomerOrderPage />, at, route);
    await userEvent.click(await screen.findByRole("button", { name: "Record a shipment" }));
    const dialog = await screen.findByRole("dialog");
    // Line 2 has nothing outstanding, so only line 1 is offered.
    expect(await within(dialog).findByLabelText(/Include Line 1/)).toBeChecked();
    expect(within(dialog).queryByLabelText(/Include Line 2/)).not.toBeInTheDocument();
    expect(within(dialog).getByLabelText(/Line 1 quantity shipped/)).toHaveValue(100);
    await userEvent.clear(within(dialog).getByLabelText(/Line 1 quantity shipped/));
    await userEvent.type(within(dialog).getByLabelText(/Line 1 quantity shipped/), "60");
    await userEvent.type(within(dialog).getByLabelText(/Line 1 lot number/), "LOT-A");
    await userEvent.click(within(dialog).getByRole("button", { name: "Record shipment" }));
    await waitFor(() => expect(calls.find((c) => c.k === "POST /shipments")).toBeTruthy());
    const body = calls.find((c) => c.k === "POST /shipments").body;
    expect(body).toMatchObject({ customerId: "c1", customerOrderId: "o1", lines: [{ orderLineId: "l1", quantity: 60, lotNumber: "LOT-A" }] });
    expect(body.clientKey).toMatch(/.{8,}/);
  });

  it("closes an order with one confirmation", async () => {
    routeApi({ "GET /customer-orders/o1": order(), "POST /customer-orders/o1/close": order({ status: "closed" }) });
    renderAt(<CustomerOrderPage />, at, route);
    await userEvent.click(await screen.findByRole("button", { name: "Close order" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Close order" }));
    await waitFor(() => expect(calls.some((c) => c.k === "POST /customer-orders/o1/close")).toBe(true));
  });

  it("needs a reason of three characters to cancel", async () => {
    routeApi({ "GET /customer-orders/o1": order(), "POST /customer-orders/o1/cancel": order({ status: "cancelled" }) });
    renderAt(<CustomerOrderPage />, at, route);
    await userEvent.click(await screen.findByRole("button", { name: "Cancel order" }));
    const dialog = await screen.findByRole("dialog");
    const go = within(dialog).getByRole("button", { name: "Cancel order" });
    expect(go).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText(/Why is it being cancelled/), "Customer withdrew it");
    await userEvent.click(go);
    await waitFor(() => expect(calls.find((c) => c.k === "POST /customer-orders/o1/cancel")?.body).toEqual({ reason: "Customer withdrew it" }));
  });

  it("shows no actions on a closed order", async () => {
    routeApi({ "GET /customer-orders/o1": order({ status: "closed", closedAt: "2026-11-05T10:00:00Z" }) });
    renderAt(<CustomerOrderPage />, at, route);
    expect(await screen.findByText("Closed", { selector: "span" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Record a shipment" })).not.toBeInTheDocument();
  });
});

describe("shipment page", () => {
  const at = "/Shipping/Shipments/s1";
  const route = "/Shipping/Shipments/:id";

  it("says when a lot that went out is on hold, as information only", async () => {
    routeApi({ "GET /shipments/s1": shipment() });
    renderAt(<ShipmentPage />, at, route);
    expect(await screen.findByRole("heading", { name: "SH-26-0001" })).toBeInTheDocument();
    expect(screen.getByText(/LOT-A is on hold/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "LOT-A" })).toHaveAttribute("href", expect.stringContaining("/Production/Traceability"));
  });

  it("cancels with a reason", async () => {
    routeApi({ "GET /shipments/s1": shipment(), "POST /shipments/s1/cancel": shipment({ status: "cancelled" }) });
    renderAt(<ShipmentPage />, at, route);
    await userEvent.click(await screen.findByRole("button", { name: "Cancel shipment" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText(/Why is it being cancelled/), "Keyed in error");
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel shipment" }));
    await waitFor(() => expect(calls.find((c) => c.k === "POST /shipments/s1/cancel")?.body).toEqual({ reason: "Keyed in error" }));
  });

  it("offers no cancel button to someone who may only read", async () => {
    permissions = ["shipping.read"];
    routeApi({ "GET /shipments/s1": shipment() });
    renderAt(<ShipmentPage />, at, route);
    await screen.findByRole("heading", { name: "SH-26-0001" });
    expect(screen.queryByRole("button", { name: "Cancel shipment" })).not.toBeInTheDocument();
  });
});
