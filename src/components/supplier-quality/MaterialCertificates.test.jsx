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

import MaterialCertificatesPage from "./MaterialCertificatesPage";
import GoodsReceiptPage from "./GoodsReceiptPage";

const supplier = { id: "s1", code: "ACME", name: "Acme Metals" };
const cert = (over = {}) => ({
  id: "c1", supplier, certificateNumber: "MTR-100", kind: "mill_test_report", part: { id: "p1", partNumber: "BAR-1", name: "Steel bar" }, material: null, specification: "EN 10025", heatNumber: "H-100",
  receiptLine: { id: "x1", lineNumber: 1, receiptId: "g1", receiptReference: "GR-26-0001" }, lot: { id: "lot1", lotNumber: "LOT-A" }, issuedOn: "2026-11-01", document: null, notes: null, status: "received",
  reviewedBy: null, reviewedAt: null, reviewNote: null, withdrawnAt: null, withdrawalReason: null, createdBy: null, createdAt: "2026-11-02T09:00:00Z", ...over,
});
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
  permissions = ["receiving.read", "receiving.manage", "supplier_quality.manage", "master_data.read", "supplier_quality.read"];
  calls.length = 0;
  apiFetch.mockReset();
});

describe("material certificate register", () => {
  it("lists what waits for review with its traceability, and a manager accepts it", async () => {
    routeApi({ "GET /material-certificates": { data: [cert()], page: 1, pageSize: 25, total: 1, reviewCount: 1 }, "POST /material-certificates/c1/review": cert({ status: "accepted" }) });
    renderAt(<MaterialCertificatesPage />, "/x", "/x");
    expect(await screen.findByText("MTR-100")).toBeInTheDocument();
    expect(screen.getByText("Heat H-100")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Lot LOT-A/ })).toBeInTheDocument();
    expect(screen.getByText("Waiting for review")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Review MTR-100" }));
    const submit = (await screen.findAllByRole("button", { name: "Accept" })).at(-1);
    await userEvent.click(submit);
    await waitFor(() => expect(calls.find((c) => c.k === "POST /material-certificates/c1/review")?.body).toMatchObject({ accept: true }));
  });

  it("hides review from people who only record", async () => {
    permissions = ["receiving.read", "receiving.manage"];
    routeApi({ "GET /material-certificates": { data: [cert()], page: 1, pageSize: 25, total: 1, reviewCount: 1 } });
    renderAt(<MaterialCertificatesPage />, "/x", "/x");
    await screen.findByText("MTR-100");
    expect(screen.queryByRole("button", { name: "Review MTR-100" })).toBeNull();
    expect(screen.getByRole("button", { name: "Withdraw MTR-100" })).toBeInTheDocument();
  });

  it("offers no actions to a reader and asks the API for the review filter", async () => {
    permissions = ["receiving.read"];
    routeApi({ "GET /material-certificates": { data: [cert({ status: "accepted" })], page: 1, pageSize: 25, total: 1, reviewCount: 0 } });
    renderAt(<MaterialCertificatesPage />, "/x?status=review", "/x");
    await screen.findByText("MTR-100");
    expect(calls[0].path).toContain("status=review");
    expect(screen.queryByRole("button", { name: /Record a certificate/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Withdraw/ })).toBeNull();
  });
});

describe("certificate on a receipt line", () => {
  it("shows what the line has on file and records one from the line", async () => {
    const receipt = {
      id: "g1", reference: "GR-26-0001", supplier, purchaseOrder: null, site: null, receivedOn: "2026-11-02", deliveryNote: null, status: "received", lineCount: 1, createdAt: "2026-11-02T09:00:00Z",
      notes: null, cancelledAt: null, cancelledBy: null, cancelReason: null, createdBy: null,
      lines: [{ id: "x1", poLine: null, part: { id: "p1", partNumber: "BAR-1", name: "Steel bar" }, material: null, quantityReceived: 20, lot: { id: "lot1", lotNumber: "LOT-A" }, notes: null, status: "not_required", ncrs: [], dispositions: [], disposition: null, certificates: { received: 1, accepted: 0, rejected: 0 } }],
    };
    routeApi({ "GET /goods-receipts/g1": receipt, "GET /supplier-quality/suppliers/s1/documents": { data: [] }, "POST /material-certificates": cert() });
    renderAt(<GoodsReceiptPage />, "/r/g1", "/r/:id");
    expect(await screen.findByText("1 to review")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Add certificate" }));
    await userEvent.type(await screen.findByLabelText(/Certificate number/), "MTR-9");
    await userEvent.click(screen.getByRole("button", { name: "Record certificate" }));
    await waitFor(() => expect(calls.find((c) => c.k === "POST /material-certificates")?.body).toMatchObject({ supplierId: "s1", certificateNumber: "MTR-9", receiptLineId: "x1", kind: "mill_test_report" }));
  });
});
