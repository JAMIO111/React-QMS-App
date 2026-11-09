import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

let permissions;
const apiFetch = vi.fn();
vi.mock("../../lib/api-client", async (importOriginal) => ({ ...(await importOriginal()), apiFetch: (...a) => apiFetch(...a) }));
vi.mock("../../contexts/OrganisationProvider", () => ({ useOrganisation: () => ({ organisationId: "org-1" }) }));
vi.mock("../../hooks/useQmsApi", () => ({ usePermissions: () => ({ can: (p) => permissions.includes(p) }) }));
vi.mock("../../contexts/ToastProvider", () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock("../ncr/Pickers", async (importOriginal) => ({ ...(await importOriginal()), PartPicker: () => null }));

import RequirementsPage from "./RequirementsPage";
import GoodsReceiptPage from "./GoodsReceiptPage";
import NcrReceiptSource from "./NcrReceiptSource";

const supplier = { id: "s1", code: "ACME", name: "Acme Metals" };
const rule = (over = {}) => ({ id: "r1", name: "Acme default", status: "draft", strategy: "fixed", level: "normal", sampleSize: 5, acceptNumber: 0, operationCode: "INCOMING", reducesControls: false, supplier, part: null, partFamily: null, classification: null, riskRating: null, rationale: null, approvedAt: null, approvedBy: null, ...over });
const calls = [];
const routeApi = (routes) =>
  apiFetch.mockImplementation(async (path, opts = {}) => {
    const k = `${opts.method ?? "GET"} ${path.split("?")[0]}`;
    calls.push({ k, path, body: opts.body });
    if (!(k in routes)) throw new Error(`unexpected ${k}`);
    return routes[k];
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
  permissions = ["receiving.read", "receiving.manage", "supplier_quality.manage", "supplier_quality.approve", "inspection.record", "ncr.create", "master_data.read"];
  calls.length = 0;
  apiFetch.mockReset();
});

describe("inspection requirements page", () => {
  it("lists a draft with what it asks for and lets an approver approve it", async () => {
    routeApi({
      "GET /inspection-requirements": { data: [rule(), rule({ id: "r2", name: "Relaxed", strategy: "skip_lot", skipEvery: 4, level: "reduced", reducesControls: true })] },
      "POST /inspection-requirements/r1/approve": { ok: true },
    });
    renderAt(<RequirementsPage />, "/x", "/x");
    expect(await screen.findByText("Acme default")).toBeInTheDocument();
    expect(screen.getByText("A sample of 5")).toBeInTheDocument();
    expect(screen.getByText("Reduces inspection")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Approve Acme default" }));
    await userEvent.click(await screen.findByRole("button", { name: "Approve" }));
    await waitFor(() => expect(calls.some((c) => c.k === "POST /inspection-requirements/r1/approve")).toBe(true));
  });

  it("hides write actions from people who can only read", async () => {
    permissions = ["receiving.read"];
    routeApi({ "GET /inspection-requirements": { data: [rule()] } });
    renderAt(<RequirementsPage />, "/x", "/x");
    await screen.findByText("Acme default");
    expect(screen.queryByRole("button", { name: /Write a requirement/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Approve/ })).toBeNull();
  });
});

describe("receipt line inspection", () => {
  const receipt = (line) => ({
    id: "g1", reference: "GR-26-0001", supplier, purchaseOrder: null, site: null, receivedOn: "2026-11-02", deliveryNote: null, status: "received", lineCount: 1, createdAt: "2026-11-02T09:00:00Z",
    notes: null, cancelledAt: null, cancelledBy: null, cancelReason: null, createdBy: null,
    lines: [{ id: "x1", poLine: null, part: { id: "p1", partNumber: "BRK-1", name: "Bracket" }, material: null, quantityReceived: 60, lot: { id: "lot1", lotNumber: "LOT-A" }, notes: null, lotStatus: "on_hold", ncrs: [], dispositions: [], disposition: null, ...line }],
  });
  const pending = { status: "pending", determination: { required: true, ruleName: "Acme default", strategy: "fixed", level: "normal", sampleSize: 5, basis: "rule" }, assessment: { state: "not_started", samples: 0, failedSamples: 0, requiredSamples: 5, outcome: "incomplete", inspectionId: null } };

  it("shows why inspection is needed and starts it", async () => {
    routeApi({ "GET /goods-receipts/g1": receipt(pending), "POST /goods-receipt-lines/x1/start-inspection": { ok: true } });
    renderAt(<GoodsReceiptPage />, "/r/g1", "/r/:id");
    expect(await screen.findByText("Awaiting inspection")).toBeInTheDocument();
    expect(screen.getByText(/rule: Acme default/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Start inspection/ }));
    await waitFor(() => expect(calls.some((c) => c.k === "POST /goods-receipt-lines/x1/start-inspection")).toBe(true));
  });

  it("records a decision with a reason", async () => {
    routeApi({ "GET /goods-receipts/g1": receipt(pending), "POST /goods-receipt-lines/x1/disposition": { ok: true } });
    renderAt(<GoodsReceiptPage />, "/r/g1", "/r/:id");
    await userEvent.click(await screen.findByRole("button", { name: "Decide" }));
    await userEvent.click(await screen.findByRole("combobox", { name: /Decision/ }));
    await userEvent.click(await screen.findByRole("option", { name: "Reject" }));
    await userEvent.type(screen.getByLabelText(/Why/), "Out of tolerance");
    await userEvent.click(screen.getByRole("button", { name: "Record decision" }));
    await waitFor(() => expect(calls.find((c) => c.k === "POST /goods-receipt-lines/x1/disposition")?.body).toMatchObject({ decision: "rejected", reason: "Out of tolerance" }));
  });

  it("rejects only a part of the line when a quantity is given, and refuses more than was received", async () => {
    routeApi({ "GET /goods-receipts/g1": receipt(pending), "POST /goods-receipt-lines/x1/disposition": { ok: true } });
    renderAt(<GoodsReceiptPage />, "/r/g1", "/r/:id");
    await userEvent.click(await screen.findByRole("button", { name: "Decide" }));
    await userEvent.click(await screen.findByRole("combobox", { name: /Decision/ }));
    await userEvent.click(await screen.findByRole("option", { name: "Reject" }));
    await userEvent.type(screen.getByLabelText(/Why/), "Some were bent");
    await userEvent.type(screen.getByLabelText("Quantity rejected"), "61");
    expect(screen.getByText("Enter a number above 0 and up to 60")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Record decision" })).toBeDisabled();
    await userEvent.clear(screen.getByLabelText("Quantity rejected"));
    await userEvent.type(screen.getByLabelText("Quantity rejected"), "12");
    await userEvent.click(screen.getByRole("button", { name: "Record decision" }));
    await waitFor(() => expect(calls.find((c) => c.k === "POST /goods-receipt-lines/x1/disposition")?.body).toMatchObject({ decision: "rejected", quantity: 12 }));
  });

  it("offers no actions on a cancelled receipt", async () => {
    routeApi({ "GET /goods-receipts/g1": { ...receipt(pending), status: "cancelled", cancelReason: "Wrong supplier" } });
    renderAt(<GoodsReceiptPage />, "/r/g1", "/r/:id");
    await screen.findByText("Awaiting inspection");
    expect(screen.queryByRole("button", { name: "Decide" })).toBeNull();
  });
});

describe("NC receipt source", () => {
  it("links to the receipt", () => {
    render(<MemoryRouter><NcrReceiptSource source={{ available: true, items: [{ receiptId: "g1", reference: "GR-26-0001", lineNumber: 1, receivedOn: "2026-11-02", deliveryNote: "DN-1", lotNumber: "LOT-A", quantityReceived: 60 }] }} /></MemoryRouter>);
    expect(screen.getByRole("link", { name: "GR-26-0001" })).toHaveAttribute("href", "/Supplier-Quality/Goods-Receipts/g1");
    expect(screen.getByText(/lot LOT-A/)).toBeInTheDocument();
  });

  const ncr = { id: "n1", supplier: { id: "s1", name: "Acme Metals" }, part: { id: "p1", partNumber: "BRK-1" }, stage: "open" };
  const wrap = (ui) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter>{ui}<div id="modal-root" /></MemoryRouter></QueryClientProvider>);

  it("offers to link an NC with no delivery to a received line of its supplier, and sends the choice", async () => {
    routeApi({
      "GET /goods-receipt-lines/lookup": { data: [{ id: "x9", receiptId: "g9", reference: "GR-26-0009", lineNumber: 2, receivedOn: "2026-11-03", deliveryNote: "DN-9", part: { id: "p1", partNumber: "BRK-1", name: "Bracket" }, material: null, lotNumber: "LOT-Z", quantityReceived: 80, poNumber: "PO-7" }] },
      "POST /ncrs/n1/receipt-link": { available: true, items: [] },
    });
    wrap(<NcrReceiptSource source={{ available: true, items: [] }} ncr={ncr} canLink />);
    expect(screen.getByText(/Not linked to a delivery/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Link to a received line" }));
    await userEvent.click(await screen.findByRole("combobox", { name: /Received line/ }));
    await userEvent.click(await screen.findByRole("option", { name: /GR-26-0009 · line 2/ }));
    await userEvent.click(screen.getByRole("button", { name: "Link" }));
    await waitFor(() => expect(calls.find((c) => c.k === "POST /ncrs/n1/receipt-link")?.body).toEqual({ receiptLineId: "x9" }));
    expect(calls.find((c) => c.k === "GET /goods-receipt-lines/lookup").path).toMatch(/supplierId=s1&partId=p1/);
  });

  it("ends a link only with a reason", async () => {
    routeApi({ "POST /receipt-line-ncrs/k1/unlink": { available: true, items: [] } });
    wrap(<NcrReceiptSource source={{ available: true, items: [{ linkId: "k1", linkedAt: "2026-11-04T09:00:00Z", receiptId: "g1", reference: "GR-26-0001", lineNumber: 1, receivedOn: "2026-11-02", deliveryNote: null, lotNumber: null, quantityReceived: 60 }] }} ncr={ncr} canLink />);
    expect(screen.queryByRole("button", { name: "Link to a received line" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "End link" }));
    const end = await screen.findByRole("button", { name: "End the link" });
    expect(end).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/Why is it ending/), "Wrong line");
    await userEvent.click(end);
    await waitFor(() => expect(calls.find((c) => c.k === "POST /receipt-line-ncrs/k1/unlink")?.body).toEqual({ reason: "Wrong line" }));
  });

  it("offers no link or unlink to someone who cannot change the NC", () => {
    wrap(<NcrReceiptSource source={{ available: true, items: [{ linkId: "k1", linkedAt: "2026-11-04T09:00:00Z", receiptId: "g1", reference: "GR-26-0001", lineNumber: 1, receivedOn: "2026-11-02", deliveryNote: null, lotNumber: null, quantityReceived: 60 }] }} ncr={ncr} />);
    expect(screen.queryByRole("button", { name: "End link" })).toBeNull();
  });
});
