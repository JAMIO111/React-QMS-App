import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

let permissions;
const apiFetch = vi.fn();
vi.mock("../../lib/api-client", async (importOriginal) => ({ ...(await importOriginal()), apiFetch: (...a) => apiFetch(...a) }));
vi.mock("../../contexts/OrganisationProvider", () => ({ useOrganisation: () => ({ organisationId: "org-1" }) }));
vi.mock("../../hooks/useQmsApi", () => ({ usePermissions: () => ({ can: (p) => permissions.includes(p) }) }));
vi.mock("../../contexts/ToastProvider", () => ({ useToast: () => ({ showToast: vi.fn() }) }));

import SupplierAudits from "./SupplierAudits";

const supplier = { id: "s1", code: "ACME", name: "Acme Metals", displayName: "Acme Metals" };
const audit = { id: "a1", reference: "AUD-001", title: "Supplier process audit", auditType: "supplier", questionCount: 5, criticalCount: 1, passMark: 80, lastRecord: { id: "r1", reference: "AR-26-0001", performedOn: "2026-10-01", result: "fail" }, nextDueOn: "2027-10-01" };
const record = { id: "r1", reference: "AR-26-0001", status: "completed", result: "fail", score: 62, audit: { id: "a1", title: "Supplier process audit" }, version: 2, performedOn: "2026-10-01" };
const finding = { id: "f1", reference: "AF-26-0001", title: "Calibration records missing", classification: { label: "Major nonconformity", kind: "nonconformity" }, status: "open", dueOn: "2026-12-01", overdue: false, ncr: { id: "n1", reference: "NCR-26-0007" } };
const calls = [];
const routeApi = (routes) =>
  apiFetch.mockImplementation(async (path, opts = {}) => {
    const k = `${opts.method ?? "GET"} ${path.split("?")[0]}`;
    calls.push({ k, path, body: opts.body });
    if (!(k in routes)) throw new Error(`unexpected ${k}`);
    return routes[k];
  });
const renderUi = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter><SupplierAudits supplier={supplier} /><div id="modal-root" /></MemoryRouter>
    </QueryClientProvider>
  );

beforeEach(() => {
  permissions = ["audits.read", "audits.perform"];
  calls.length = 0;
  apiFetch.mockReset();
});

describe("supplier audits tab", () => {
  it("asks for this supplier only and shows the audits, records and findings with their links", async () => {
    routeApi({
      "GET /audits": { data: [audit], page: 1, pageSize: 50, total: 1 },
      "GET /audit-records": { data: [record], page: 1, pageSize: 25, total: 1 },
      "GET /audit-findings": { data: [finding], page: 1, pageSize: 50, total: 1 },
    });
    renderUi();
    expect(await screen.findByRole("link", { name: "AUD-001 · Supplier process audit" })).toHaveAttribute("href", "/Audits/Templates/a1");
    expect(screen.getByRole("link", { name: "AR-26-0001" })).toHaveAttribute("href", "/Audits/Records/r1");
    expect(await screen.findByRole("link", { name: "AF-26-0001" })).toHaveAttribute("href", "/Audits/Findings/f1");
    expect(screen.getByRole("link", { name: "NCR-26-0007" })).toBeInTheDocument();
    expect(screen.getByText("Calibration records missing")).toBeInTheDocument();
    for (const k of ["GET /audits", "GET /audit-records", "GET /audit-findings"]) expect(calls.find((c) => c.k === k).path).toContain("supplierId=s1");
    expect(calls.find((c) => c.k === "GET /audits").path).toContain("status=active");
  });

  it("says so when there is nothing yet", async () => {
    routeApi({ "GET /audits": { data: [], total: 0 }, "GET /audit-records": { data: [], total: 0 }, "GET /audit-findings": { data: [], total: 0 } });
    renderUi();
    expect(await screen.findByText("No active audit lists this supplier.")).toBeInTheDocument();
    expect(await screen.findByText("No audit has been carried out on this supplier yet.")).toBeInTheDocument();
    expect(await screen.findByText("No findings from audits of this supplier.")).toBeInTheDocument();
  });

  it("starts an audit carried out on this supplier, only for people who may perform audits", async () => {
    routeApi({
      "GET /audits": { data: [audit], total: 1 }, "GET /audit-records": { data: [], total: 0 }, "GET /audit-findings": { data: [], total: 0 },
      "POST /audit-records": { id: "r9", reference: "AR-26-0009" },
    });
    renderUi();
    await userEvent.click(await screen.findByRole("button", { name: "Start an audit" }));
    await userEvent.selectOptions(await screen.findByRole("combobox", { name: /^Audit/ }), "a1");
    await userEvent.click(screen.getByRole("button", { name: "Start audit" }));
    await waitFor(() => expect(calls.find((c) => c.k === "POST /audit-records")?.body).toEqual({ auditId: "a1", targets: [{ kind: "supplier", supplierId: "s1" }] }));
  });

  it("offers no start to a reader", async () => {
    permissions = ["audits.read"];
    routeApi({ "GET /audits": { data: [], total: 0 }, "GET /audit-records": { data: [], total: 0 }, "GET /audit-findings": { data: [], total: 0 } });
    renderUi();
    await screen.findByText("No active audit lists this supplier.");
    expect(screen.queryByRole("button", { name: "Start an audit" })).toBeNull();
  });
});
