import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, within, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { format } from "date-fns";

let permissions;
const apiFetch = vi.fn();
vi.mock("../../lib/api-client", async (importOriginal) => ({ ...(await importOriginal()), apiFetch: (...a) => apiFetch(...a) }));
vi.mock("../../contexts/OrganisationProvider", () => ({ useOrganisation: () => ({ organisationId: "org-1" }) }));
vi.mock("../../hooks/useQmsApi", () => ({
  usePermissions: () => ({ can: (p) => permissions.includes(p) }),
  useSites: () => ({ data: { data: [{ id: "s1", code: "MAIN", name: "Main site" }] } }),
  useOrganisationDetails: () => ({ data: { settings: { baseCurrency: "GBP", vatRate: 0.2 } } }),
}));
const upload = vi.fn();
vi.mock("@/api/supabaseApi", () => ({ uploadFileToSupabase: (...a) => upload(...a), generateSignedUrl: vi.fn() }));
vi.mock("../../contexts/ToastProvider", () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock("../../contexts/SearchProvider", () => ({ useGlobalSearch: () => ({ debouncedSearchTerm: "" }) }));

import NcrPage from "./NcrPage";
import NonConformance from "../NonConformance";
import SettingsDataManagement from "../Settings/SettingsDataManagement";

const ALL = ["ncr.read", "ncr.create", "ncr.update", "ncr.delete", "lookups.manage", "master_data.read"];
const classifications = [
  { id: "fm1", kind: "failure_mode", parentId: null, code: "DIM", name: "Dimensional", description: null, active: true },
  { id: "sf1", kind: "sub_failure_mode", parentId: "fm1", code: null, name: "Oversize", description: null, active: true },
  { id: "fm2", kind: "failure_mode", parentId: null, code: null, name: "Cosmetic", description: null, active: true },
  { id: "pr1", kind: "process", parentId: null, code: "CNC", name: "Machining", description: null, active: true },
];
const ncr = (over = {}) => ({
  id: "n1", reference: "NCM-26-001", source: "internal", stage: "open", severity: "major", title: "Bore oversize", detectedAt: "2026-11-01",
  quantityAffected: 4, totalCost: 292.4, costCurrency: "GBP", part: { id: "p1", partNumber: "BRK-100", name: "Bracket", revision: "A" }, customer: null, supplier: null,
  workOrder: "WO-1", purchaseOrder: null, customerReference: null, failureMode: { id: "fm1", name: "Dimensional" },
  subFailureMode: { id: "sf1", name: "Oversize" }, causalProcess: null, deletedAt: null, createdAt: "2026-11-01T09:00:00Z",
  stageReason: null, description: "0.05 over", requirement: null, actualResult: null, site: null, partRevisionId: "r1", lotNumber: null,
  serialNumber: null, quantityInspected: null, detectionProcess: null, responsibleEmployee: null, owner: null,
  detectedBy: { id: "u1", name: "Ada Owner" }, createdBy: { id: "u1", name: "Ada Owner" }, closedAt: null, closedBy: null,
  deletedBy: null, deleteReason: null, updatedAt: "2026-11-01T09:00:00Z", ...over,
});
const page = (data) => ({ data, nextCursor: null });

const calls = [];
const routeApi = (routes) =>
  apiFetch.mockImplementation(async (path, opts = {}) => {
    const k = `${opts.method ?? "GET"} ${path.split("?")[0]}`;
    calls.push({ k, path, body: opts.body });
    const all = {
      "GET /ncr-classifications": { data: classifications },
      "GET /employees": { data: [{ id: "e1", name: "Sam Operator", jobTitle: null, active: true }] },
      "GET /parts": page([{ id: "p1", partNumber: "BRK-100", name: "Bracket" }]),
      "GET /parts/p1": { id: "p1", revisions: [{ id: "r1", revision: "A", status: "released" }] },
      "GET /customers": page([{ id: "c1", code: "ACME", name: "Acme Fabrication", displayName: "Acme" }]),
      "GET /suppliers": page([{ id: "sp1", code: "STEEL", name: "Steel Supplies", displayName: null }]),
      ...routes,
    };
    // Every NCR page also loads its costs, files and history.
    if (!(k in all) && /^GET \/ncrs\/[^/]+\/costs$/.test(k)) return { data: [], totals: { baseCurrency: "GBP", net: 0, gross: 0, count: 0 } };
    if (!(k in all) && /^GET \/ncrs\/[^/]+\/(attachments|history)$/.test(k)) return { data: [] };
    if (!(k in all)) throw new Error(`unexpected ${k}`);
    return typeof all[k] === "function" ? all[k](path, opts) : all[k];
  });

const Where = () => {
  const l = useLocation();
  return <p data-testid="where">{l.pathname + l.search}</p>;
};
const renderAt = (url) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="/Non-Conformance/:type" element={<><NonConformance /><Where /></>} />
          <Route path="/Non-Conformance/:type/:id" element={<><NcrPage /><Where /></>} />
          <Route path="/Settings" element={<SettingsDataManagement />} />
        </Routes>
        <div id="modal-root" />
      </MemoryRouter>
    </QueryClientProvider>
  );
const lastCall = (k) => calls.filter((c) => c.k === k).at(-1);
/** Choose an option in one of the form's combo boxes. */
const pick = async (label, option) => {
  await userEvent.click(screen.getByRole("combobox", { name: label }));
  await userEvent.click(await screen.findByRole("option", { name: option }));
};

beforeEach(() => {
  apiFetch.mockReset();
  calls.length = 0;
  permissions = [...ALL];
  document.body.innerHTML = '<div id="modal-root"></div>';
});

describe("NC registers", () => {
  it.each([
    ["Internal", "internal", "Work order"],
    ["Customer", "customer", "Customer ref."],
    ["Supplier", "supplier", "Purchase order"],
  ])("lists %s non-conformances from the API with their own columns", async (type, source, column) => {
    routeApi({ "GET /ncrs": { data: [ncr({ source })], page: 1, pageSize: 25, total: 1 } });
    renderAt(`/Non-Conformance/${type}`);
    expect(await screen.findByText("NCM-26-001")).toBeInTheDocument();
    expect(lastCall("GET /ncrs").path).toContain(`source=${source}`);
    expect(screen.getByRole("columnheader", { name: new RegExp(column) })).toBeInTheDocument();
    expect(screen.getByText("1 record")).toBeInTheDocument();
  });

  it("sorts on the server when a header is clicked", async () => {
    routeApi({ "GET /ncrs": { data: [ncr()], page: 1, pageSize: 25, total: 1 } });
    renderAt("/Non-Conformance/Internal");
    await screen.findByText("NCM-26-001");
    await userEvent.click(within(screen.getByRole("columnheader", { name: /Detected/ })).getByRole("button"));
    await waitFor(() => expect(lastCall("GET /ncrs").path).toContain("sort=detectedAt"));
    expect(lastCall("GET /ncrs").path).toContain("order=asc");
  });

  it("shows each NC's total cost and sorts by it", async () => {
    routeApi({ "GET /ncrs": { data: [ncr(), ncr({ id: "n2", reference: "NCM-26-002", title: "No costs", totalCost: 0 })], page: 1, pageSize: 25, total: 2 } });
    renderAt("/Non-Conformance/Internal");
    await screen.findByText("NCM-26-001");
    const header = screen.getByRole("columnheader", { name: /Total cost/ });
    expect(screen.getByText("£292.40")).toBeInTheDocument();
    await userEvent.click(within(header).getByRole("button"));
    await waitFor(() => expect(lastCall("GET /ncrs").path).toContain("sort=totalCost"));
  });

  it("opens a record on double-click and offers New NC with ncr.create", async () => {
    routeApi({ "GET /ncrs": { data: [ncr()], page: 1, pageSize: 25, total: 1 }, "GET /ncrs/n1": ncr() });
    renderAt("/Non-Conformance/Internal");
    await userEvent.dblClick(await screen.findByText("Bore oversize"));
    expect(screen.getByTestId("where")).toHaveTextContent("/Non-Conformance/Internal/n1");
  });

  it("hides New NC without ncr.create", async () => {
    permissions = ["ncr.read"];
    routeApi({ "GET /ncrs": { data: [], page: 1, pageSize: 25, total: 0 } });
    renderAt("/Non-Conformance/Internal");
    expect(await screen.findByText("No records found.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /New NC/ })).toBeNull();
  });

  it("filters by stage and shows deleted records on request", async () => {
    routeApi({ "GET /ncrs": { data: [], page: 1, pageSize: 25, total: 0 } });
    renderAt("/Non-Conformance/Internal");
    await screen.findByText("No records found.");
    await userEvent.click(screen.getByRole("button", { name: /Filter/ }));
    const pane = screen.getByRole("dialog", { name: "Filter non-conformances" });
    await userEvent.click(within(pane).getByText("Investigating"));
    await userEvent.click(within(pane).getByRole("combobox", { name: "Deleted records" }));
    await userEvent.click(within(pane).getByRole("option", { name: "Only deleted" }));
    await userEvent.click(within(pane).getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(lastCall("GET /ncrs").path).toContain("stage=investigating"));
    expect(lastCall("GET /ncrs").path).toContain("deleted=only");
  });

  it("filters by failure mode and sub-failure mode, shows what is applied and removes filters one by one", async () => {
    routeApi({ "GET /ncrs": { data: [], page: 1, pageSize: 25, total: 0 } });
    renderAt("/Non-Conformance/Internal?page=3");
    await screen.findByText("No records found.");
    await userEvent.click(screen.getByRole("button", { name: /Filter/ }));
    const pane = screen.getByRole("dialog", { name: "Filter non-conformances" });
    // Before a failure mode is chosen, each sub-failure mode shows its failure mode.
    await userEvent.click(within(pane).getByRole("combobox", { name: "Sub-failure mode" }));
    expect(within(pane).getByRole("option", { name: /Oversize/ })).toHaveTextContent("Dimensional");
    await userEvent.keyboard("{Escape}");
    await userEvent.click(within(pane).getByRole("combobox", { name: "Failure mode" }));
    await userEvent.click(within(pane).getByRole("option", { name: "DIM – Dimensional" }));
    await userEvent.click(within(pane).getByRole("combobox", { name: "Sub-failure mode" }));
    await userEvent.click(within(pane).getByRole("option", { name: "Oversize" }));
    await userEvent.click(within(pane).getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(lastCall("GET /ncrs").path).toContain("failureModeId=fm1&subFailureModeId=sf1"));
    expect(lastCall("GET /ncrs").path).toContain("page=1");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Filter non-conformances" })).toBeNull());

    const active = screen.getByLabelText("Active filters");
    expect(active).toHaveTextContent("Failure mode: Dimensional");
    expect(active).toHaveTextContent("Sub-failure mode: Oversize");
    await userEvent.click(within(active).getByRole("button", { name: "Remove filter Sub-failure mode: Oversize" }));
    await waitFor(() => expect(lastCall("GET /ncrs").path).not.toContain("subFailureModeId"));
    expect(lastCall("GET /ncrs").path).toContain("failureModeId=fm1");
    await userEvent.click(within(screen.getByLabelText("Active filters")).getByRole("button", { name: "Clear all" }));
    await waitFor(() => expect(lastCall("GET /ncrs").path).not.toContain("failureModeId"));
    expect(screen.queryByLabelText("Active filters")).toBeNull();
  });

  it("filters by date, severity, part, customer, total cost and quantity", async () => {
    routeApi({
      "GET /ncrs": { data: [], page: 1, pageSize: 25, total: 0 },
      "GET /ncrs/ranges": { cost: { max: 873 }, quantity: { max: 48 }, baseCurrency: "GBP" },
    });
    renderAt("/Non-Conformance/Internal");
    await screen.findByText("No records found.");
    await userEvent.click(screen.getByRole("button", { name: /Filter/ }));
    const pane = screen.getByRole("dialog", { name: "Filter non-conformances" });

    await userEvent.click(within(pane).getByText("Critical"));
    await userEvent.click(within(pane).getByText("Major"));
    await userEvent.click(within(pane).getByRole("combobox", { name: "Part number" }));
    await userEvent.click(await within(pane).findByRole("option", { name: "BRK-100 · Bracket" }));
    await userEvent.click(within(pane).getByRole("combobox", { name: "Customer" }));
    await userEvent.click(await within(pane).findByRole("option", { name: /^Acme/ }));

    // Sliders run from 0 to the register's highest value, rounded up (£873 → £900, 48 → 50).
    const costMin = within(pane).getByRole("slider", { name: "Total cost minimum" });
    const costMax = within(pane).getByRole("slider", { name: "Total cost maximum" });
    expect(costMax).toHaveAttribute("max", "900");
    fireEvent.change(costMin, { target: { value: "100" } });
    fireEvent.change(costMax, { target: { value: "500" } });
    fireEvent.change(within(pane).getByRole("slider", { name: "Quantity affected minimum" }), { target: { value: "5" } });
    expect(within(pane).getByText("£100 – £500")).toBeInTheDocument();

    // Detected from: the 1st of this month.
    const first = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    await userEvent.click(within(pane).getByRole("button", { name: /^Detected from/ }));
    await userEvent.click(within(screen.getByRole("dialog", { name: "Choose detected from" })).getByRole("button", { name: format(first, "EEEE d MMMM yyyy") }));
    expect(screen.getByRole("dialog", { name: "Filter non-conformances" })).toBeInTheDocument();

    await userEvent.click(within(pane).getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(lastCall("GET /ncrs").path).toContain("severity=critical%2Cmajor"));
    const path = lastCall("GET /ncrs").path;
    for (const part of ["partId=p1", "customerId=c1", "costMin=100", "costMax=500", "qtyMin=5", `from=${format(first, "yyyy-MM-dd")}`]) expect(path).toContain(part);
    expect(path).not.toContain("qtyMax");
    const active = screen.getByLabelText("Active filters");
    for (const text of ["Severity: Critical, Major", "Part: BRK-100 · Bracket", "Customer: Acme", "Total cost £100 – £500", "Quantity from 5"]) expect(active).toHaveTextContent(text);
    await userEvent.click(within(active).getByRole("button", { name: "Remove filter Total cost £100 – £500" }));
    await waitFor(() => expect(lastCall("GET /ncrs").path).not.toContain("costMin"));
  });

  it("offers the supplier filter on the supplier register", async () => {
    routeApi({ "GET /ncrs": { data: [], page: 1, pageSize: 25, total: 0 }, "GET /ncrs/ranges": { cost: { max: 0 }, quantity: { max: 0 }, baseCurrency: "GBP" } });
    renderAt("/Non-Conformance/Supplier");
    await screen.findByText("No records found.");
    await userEvent.click(screen.getByRole("button", { name: /Filter/ }));
    const pane = screen.getByRole("dialog", { name: "Filter non-conformances" });
    expect(within(pane).getByRole("combobox", { name: "Supplier" })).toBeInTheDocument();
    expect(within(pane).queryByRole("combobox", { name: "Customer" })).toBeNull();
    expect(within(pane).getByText("No costs recorded in this register yet.")).toBeInTheDocument();
    expect(within(pane).getByRole("slider", { name: "Total cost minimum" })).toBeDisabled();
  });

  it("opens the filters as a full-height drawer that closes from its backdrop", async () => {
    routeApi({ "GET /ncrs": { data: [], page: 1, pageSize: 25, total: 0 } });
    renderAt("/Non-Conformance/Internal");
    await screen.findByText("No records found.");
    await userEvent.click(screen.getByRole("button", { name: /Filter/ }));
    const drawer = screen.getByRole("dialog", { name: "Filter non-conformances" });
    expect(drawer.tagName).toBe("ASIDE");
    expect(drawer).toHaveClass("inset-y-0", "right-0", "h-dvh");
    expect(drawer.parentElement.parentElement).toBe(document.body);
    await userEvent.click(within(drawer).getByText("Closed"));
    fireEvent.mouseDown(drawer.previousElementSibling);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Filter non-conformances" })).toBeNull());
    expect(lastCall("GET /ncrs").path).not.toContain("stage=");
  });

  it("closes the filter pane on Escape without applying", async () => {
    routeApi({ "GET /ncrs": { data: [], page: 1, pageSize: 25, total: 0 } });
    renderAt("/Non-Conformance/Internal");
    await screen.findByText("No records found.");
    await userEvent.click(screen.getByRole("button", { name: /Filter/ }));
    await userEvent.click(within(screen.getByRole("dialog", { name: "Filter non-conformances" })).getByText("Closed"));
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Filter non-conformances" })).toBeNull());
    expect(lastCall("GET /ncrs").path).not.toContain("stage=");
  });
});

describe("NC form", () => {
  it("raises an internal NC with only the internal fields", async () => {
    routeApi({ "POST /ncrs": (_p, o) => ncr({ ...o.body, id: "n9", reference: "NCM-26-002" }), "GET /ncrs/n9": ncr({ id: "n9", reference: "NCM-26-002" }) });
    renderAt("/Non-Conformance/Internal/new");
    expect(await screen.findByRole("heading", { name: "New internal non-conformance" })).toBeInTheDocument();
    expect(screen.queryByLabelText(/Customer$/)).toBeNull();
    await userEvent.type(screen.getByLabelText("Title *"), "Bore oversize");
    await pick(/^Severity/, "Major");
    await userEvent.type(screen.getByLabelText("Quantity affected"), "4");
    await userEvent.type(screen.getByLabelText("Work order"), "WO-7");
    expect(screen.getByRole("combobox", { name: "Sub-failure mode" })).toBeDisabled();
    await pick("Failure mode", "DIM – Dimensional");
    await pick("Sub-failure mode", "Oversize");
    const today = new Date();
    const first = new Date(today.getFullYear(), today.getMonth(), 1);
    await userEvent.click(screen.getByRole("button", { name: /^Detected on/ }));
    await userEvent.click(within(screen.getByRole("dialog", { name: "Choose detected on" })).getByRole("button", { name: format(first, "EEEE d MMMM yyyy") }));
    await userEvent.click(screen.getByRole("button", { name: "Raise NC" }));
    const body = lastCall("POST /ncrs").body;
    const iso = format(first, "yyyy-MM-dd");
    expect(body).toMatchObject({ source: "internal", open: true, title: "Bore oversize", severity: "major", quantityAffected: 4, workOrder: "WO-7", failureModeId: "fm1", subFailureModeId: "sf1", detectedAt: iso });
    expect(body).not.toHaveProperty("customerId");
    expect(body).not.toHaveProperty("supplierId");
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/Non-Conformance/Internal/n9"));
  });

  it("asks for the customer on customer NCs and the supplier on supplier NCs", async () => {
    routeApi({ "POST /ncrs": (_p, o) => ncr({ ...o.body, id: "n8" }), "GET /ncrs/n8": ncr({ id: "n8", source: "customer" }) });
    renderAt("/Non-Conformance/Customer/new");
    await userEvent.type(await screen.findByLabelText("Title *"), "Complaint");
    await pick(/^Customer/, /^Acme/);
    await userEvent.type(screen.getByLabelText("Customer reference"), "CLM-9");
    await userEvent.click(screen.getByRole("button", { name: "Save as draft" }));
    expect(lastCall("POST /ncrs").body).toMatchObject({ source: "customer", customerId: "c1", customerReference: "CLM-9" });
    expect(lastCall("POST /ncrs").body).not.toHaveProperty("open");
  });

  it("sends only the changed fields when editing", async () => {
    routeApi({ "GET /ncrs/n1": ncr(), "PATCH /ncrs/n1": (_p, o) => ncr(o.body) });
    renderAt("/Non-Conformance/Internal/n1");
    const title = await screen.findByLabelText("Title *");
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    await userEvent.clear(title);
    await userEvent.type(title, "Bore oversize on op 20");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(lastCall("PATCH /ncrs/n1").body).toEqual({ title: "Bore oversize on op 20" });
  });

  it("moves the stage forward and asks for a reason to cancel", async () => {
    routeApi({ "GET /ncrs/n1": ncr(), "POST /ncrs/n1/transitions": (_p, o) => ncr({ stage: o.body.to }) });
    renderAt("/Non-Conformance/Internal/n1");
    await userEvent.click(await screen.findByRole("button", { name: "Move to Contained" }));
    expect(lastCall("POST /ncrs/n1/transitions").body).toEqual({ to: "contained" });

    await userEvent.click(screen.getByRole("button", { name: "Cancel NC" }));
    const dialog = screen.getByRole("dialog", { name: "Cancel NCM-26-001?" });
    expect(within(dialog).getByRole("button", { name: "Cancel NC" })).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText("Why is it being cancelled?"), "Duplicate of NCM-26-000");
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel NC" }));
    expect(lastCall("POST /ncrs/n1/transitions").body).toEqual({ to: "cancelled", reason: "Duplicate of NCM-26-000" });
  });

  it("locks closed records and offers reopen with a reason", async () => {
    routeApi({ "GET /ncrs/n1": ncr({ stage: "closed", closedAt: "2026-11-02T09:00:00Z", closedBy: { id: "u1", name: "Ada Owner" } }) });
    renderAt("/Non-Conformance/Internal/n1");
    expect(await screen.findByText(/This non-conformance is closed; reopen it/)).toBeInTheDocument();
    expect(screen.getByLabelText("Title *")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Reopen" }));
    expect(screen.getByRole("dialog", { name: "Reopen NCM-26-001?" })).toBeInTheDocument();
  });

  it("deletes with a reason and restores a deleted record", async () => {
    routeApi({ "GET /ncrs/n1": ncr(), "POST /ncrs/n1/delete": (_p, o) => ncr({ deletedAt: "2026-11-03T09:00:00Z", deleteReason: o.body.reason }), "GET /ncrs": { data: [], page: 1, pageSize: 25, total: 0 } });
    renderAt("/Non-Conformance/Internal/n1");
    await userEvent.click(await screen.findByRole("button", { name: "Delete" }));
    const dialog = screen.getByRole("dialog", { name: "Delete NCM-26-001?" });
    await userEvent.type(within(dialog).getByLabelText("Reason for deleting"), "Raised in error");
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    expect(lastCall("POST /ncrs/n1/delete").body).toEqual({ reason: "Raised in error" });
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/Non-Conformance/Internal"));
  });

  it("shows deleted records read-only with a restore button", async () => {
    routeApi({ "GET /ncrs/n1": ncr({ deletedAt: "2026-11-03T09:00:00Z", deletedBy: { id: "u1", name: "Ada Owner" }, deleteReason: "Raised in error" }), "POST /ncrs/n1/restore": ncr() });
    renderAt("/Non-Conformance/Internal/n1");
    expect(await screen.findByText(/Raised in error/)).toBeInTheDocument();
    expect(screen.getByLabelText("Title *")).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Restore" }));
    expect(lastCall("POST /ncrs/n1/restore")).toBeTruthy();
  });

  it("is read-only without ncr.update", async () => {
    permissions = ["ncr.read"];
    routeApi({ "GET /ncrs/n1": ncr() });
    renderAt("/Non-Conformance/Internal/n1");
    expect(await screen.findByLabelText("Title *")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Move to Contained" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  });

  it("shows the history in plain words", async () => {
    routeApi({
      "GET /ncrs/n1": ncr(),
      "GET /ncrs/n1/history": {
        data: [
          { id: "h1", at: "2026-11-01T09:00:00Z", actor: { id: "u1", name: "Ada Owner" }, action: "insert", changedFields: [], previous: null, current: {}, reason: null, source: "api" },
          { id: "h2", at: "2026-11-02T09:00:00Z", actor: { id: "u1", name: "Ada Owner" }, action: "update", changedFields: ["stage", "severity", "quantity_affected", "updated_at"], previous: { stage: "draft", severity: null, quantity_affected: 2 }, current: { stage: "open", severity: "major", quantity_affected: 4 }, reason: "Raised", source: "api", names: {} },
          { id: "h3", at: "2026-11-02T10:00:00Z", actor: { id: "u1", name: "Ada Owner" }, action: "update", changedFields: ["failure_mode_id", "description"], previous: { failure_mode_id: "11111111-1111-4111-8111-111111111111", description: "First words" }, current: { failure_mode_id: "22222222-2222-4222-8222-222222222222", description: "Better words" }, reason: null, source: "api", names: { "11111111-1111-4111-8111-111111111111": "Cosmetic", "22222222-2222-4222-8222-222222222222": "Dimensional" } },
        ],
      },
    });
    renderAt("/Non-Conformance/Internal/n1");
    await screen.findByRole("heading", { level: 2, name: "History" });
    const items = await screen.findAllByRole("listitem");
    const text = items.map((li) => li.textContent);
    expect(text).toContain("Stage: Draft → Open");
    expect(text).toContain("Severity: — → Major");
    expect(text).toContain("Quantity affected: 2 → 4");
    expect(text).toContain("Failure mode: Cosmetic → Dimensional");
    expect(text).toContain("Description:BeforeFirst wordsAfterBetter words");
    expect(screen.getAllByText("Ada Owner")).toHaveLength(3);
  });

  it("explains a server rule", async () => {
    const { ApiClientError } = await import("../../lib/api-client");
    routeApi({
      "GET /ncrs/n1": ncr({ stage: "draft", severity: null }),
      "POST /ncrs/n1/transitions": () => Promise.reject(new ApiClientError({ status: 409, code: "ncr_rule", message: "To open this non-conformance, fill in: severity" })),
    });
    renderAt("/Non-Conformance/Internal/n1");
    await userEvent.click(await screen.findByRole("button", { name: "Open this NC" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("To open this non-conformance, fill in: severity");
  });
});

describe("Settings → Data Management", () => {
  it("adds failure modes and sub-failure modes, renames and deactivates", async () => {
    routeApi({ "POST /ncr-classifications": (_p, o) => ({ id: "x", ...o.body }), "PATCH /ncr-classifications/fm2": (_p, o) => ({ id: "fm2", ...o.body }) });
    renderAt("/Settings");
    await userEvent.click(screen.getByRole("button", { name: "Expand Failure modes" }));
    expect(await screen.findByText("Oversize")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("New failure mode"), "Contamination");
    await userEvent.click(screen.getAllByRole("button", { name: "Add" }).at(-1));
    expect(lastCall("POST /ncr-classifications").body).toEqual({ kind: "failure_mode", name: "Contamination" });
    await userEvent.type(screen.getAllByLabelText("New sub-failure mode")[0], "Undersize");
    await userEvent.click(screen.getAllByRole("button", { name: "Add" })[0]);
    expect(lastCall("POST /ncr-classifications").body).toEqual({ kind: "sub_failure_mode", name: "Undersize", parentId: "fm1" });
    await userEvent.click(screen.getByRole("button", { name: "Deactivate Cosmetic" }));
    expect(lastCall("PATCH /ncr-classifications/fm2").body).toEqual({ active: false });
  });

  it("is read-only without lookups.manage", async () => {
    permissions = ["ncr.read"];
    routeApi({});
    renderAt("/Settings");
    await userEvent.click(screen.getByRole("button", { name: "Expand Failure modes" }));
    expect(await screen.findByText("Dimensional")).toBeInTheDocument();
    expect(screen.queryByLabelText("New failure mode")).toBeNull();
    expect(screen.queryByRole("button", { name: /Deactivate/ })).toBeNull();
  });
});

describe("NC page layout, costs and files", () => {
  const costList = {
    data: [
      { id: "c1", costType: "scrap", description: "Scrapped bar", incurredOn: "2026-11-01", currency: "GBP", vatTreatment: "inclusive", vatRate: 0.2, amount: 120,
        exchangeRate: 1, netAmount: 100, vatAmount: 20, grossAmount: 120, baseCurrency: "GBP", netBase: 100, grossBase: 120,
        createdAt: "2026-11-01T09:00:00Z", createdBy: { id: "u1", name: "Ada Owner" }, deletedAt: null, deleteReason: null },
    ],
    totals: { baseCurrency: "GBP", net: 100, gross: 120, count: 1 },
  };

  it("shows the old form's sections; costs and files wait until the NC is saved", async () => {
    routeApi({});
    renderAt("/Non-Conformance/Internal/new");
    const nav = await screen.findByRole("navigation", { name: "Sections" });
    expect(within(nav).getByRole("button", { name: "Go to NC Details" })).toBeEnabled();
    expect(within(nav).getByRole("button", { name: "Go to Cost" })).toBeDisabled();
    expect(within(nav).getByRole("button", { name: "Go to Additional Info" })).toBeDisabled();
    expect(screen.queryByRole("table", { name: "Costs" })).toBeNull();
  });

  it("lists costs with base-currency totals and adds a cost with a VAT preview", async () => {
    routeApi({ "GET /ncrs/n1": ncr(), "GET /ncrs/n1/costs": costList, "POST /ncrs/n1/costs": (_p, o) => ({ id: "c2", ...o.body }) });
    renderAt("/Non-Conformance/Internal/n1");
    const table = await screen.findByRole("table", { name: "Costs" });
    expect(within(table).getByText("Scrapped bar")).toBeInTheDocument();
    expect(within(table).getByText("Total (1 item)")).toBeInTheDocument();
    expect(within(table).getAllByText("£120.00").length).toBeGreaterThan(0);

    await userEvent.click(screen.getByRole("button", { name: "New item" }));
    const dialog = screen.getByRole("dialog", { name: "New cost item" });
    await userEvent.click(within(dialog).getByRole("combobox", { name: /Cost type/ }));
    await userEvent.click(await within(dialog).findByRole("option", { name: "Labour" }));
    await userEvent.click(within(dialog).getByRole("combobox", { name: "VAT option" }));
    await userEvent.click(within(dialog).getByRole("option", { name: "VAT exclusive" }));
    await userEvent.type(within(dialog).getByLabelText(/Amount \(ex\. VAT\)/), "50");
    const preview = within(dialog).getByLabelText("Cost preview");
    expect(preview).toHaveTextContent("£50.00");
    expect(preview).toHaveTextContent("£10.00");
    expect(preview).toHaveTextContent("£60.00");
    await userEvent.click(within(dialog).getByRole("button", { name: "Add cost" }));
    await waitFor(() => expect(lastCall("POST /ncrs/n1/costs").body).toMatchObject({ costType: "labour", currency: "GBP", vatTreatment: "exclusive", vatRate: 0.2, amount: 50, exchangeRate: 1 }));
  });

  it("asks for an exchange rate for a foreign currency", async () => {
    routeApi({ "GET /ncrs/n1": ncr(), "POST /ncrs/n1/costs": (_p, o) => ({ id: "c2", ...o.body }) });
    renderAt("/Non-Conformance/Internal/n1");
    await userEvent.click(await screen.findByRole("button", { name: "New item" }));
    const dialog = screen.getByRole("dialog", { name: "New cost item" });
    await userEvent.click(within(dialog).getByRole("combobox", { name: /Cost type/ }));
    await userEvent.click(await within(dialog).findByRole("option", { name: "Transport" }));
    const currency = within(dialog).getByRole("combobox", { name: /Currency/ });
    await userEvent.click(currency);
    await userEvent.type(currency, "EUR");
    await userEvent.click(within(dialog).getByRole("option", { name: /^EUR/ }));
    await userEvent.type(within(dialog).getByLabelText(/^Amount/), "100");
    await userEvent.click(within(dialog).getByRole("button", { name: "Add cost" }));
    expect(await within(dialog).findByText("Enter the exchange rate")).toBeInTheDocument();
    await userEvent.type(within(dialog).getByLabelText(/Exchange rate/), "0.85");
    expect(within(dialog).getByLabelText("Cost preview")).toHaveTextContent("£85.00");
    await userEvent.click(within(dialog).getByRole("button", { name: "Add cost" }));
    await waitFor(() => expect(lastCall("POST /ncrs/n1/costs").body).toMatchObject({ costType: "transport", currency: "EUR", amount: 100, exchangeRate: 0.85 }));
  });

  it("deletes a cost with a reason", async () => {
    routeApi({ "GET /ncrs/n1": ncr(), "GET /ncrs/n1/costs": costList, "POST /ncr-costs/c1/delete": {} });
    renderAt("/Non-Conformance/Internal/n1");
    await userEvent.click(await screen.findByRole("button", { name: "Delete Scrap cost" }));
    const dialog = screen.getByRole("dialog", { name: "Delete scrap cost?" });
    await userEvent.type(within(dialog).getByLabelText("Reason for deleting"), "Duplicate");
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    expect(lastCall("POST /ncr-costs/c1/delete").body).toEqual({ reason: "Duplicate" });
  });

  it("uploads dropped files to the NC folder and records them; removing asks for a reason", async () => {
    upload.mockResolvedValue({ path: "org-1/ncr/n1/u1-photo.jpg" });
    routeApi({
      "GET /ncrs/n1": ncr(),
      "GET /ncrs/n1/attachments": { data: [{ id: "f1", fileName: "report.pdf", contentType: "application/pdf", sizeBytes: 2048, description: null, storagePath: "org-1/ncr/n1/x-report.pdf",
        createdAt: "2026-11-01T09:00:00Z", createdBy: { id: "u1", name: "Ada Owner" }, deletedAt: null, deleteReason: null }] },
      "POST /ncrs/n1/attachments": (_p, o) => ({ id: "f2", ...o.body }),
      "POST /ncr-attachments/f1/delete": {},
    });
    renderAt("/Non-Conformance/Internal/n1");
    expect(await screen.findByText("report.pdf")).toBeInTheDocument();
    const file = new File(["jpeg"], "photo.jpg", { type: "image/jpeg" });
    globalThis.URL.createObjectURL ??= () => "blob:preview";
    globalThis.URL.revokeObjectURL ??= () => {};
    await userEvent.upload(screen.getByTestId("file-input"), file);
    expect(screen.getByText("Unsaved file")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Save upload" }));
    await waitFor(() => expect(lastCall("POST /ncrs/n1/attachments")?.body).toEqual({ storagePath: "org-1/ncr/n1/u1-photo.jpg", fileName: "photo.jpg", contentType: "image/jpeg", sizeBytes: 4 }));
    expect(upload).toHaveBeenCalledWith(file, "nc-files", "org-1", "n1");

    await userEvent.click(screen.getByRole("button", { name: "Remove report.pdf" }));
    const dialog = screen.getByRole("dialog", { name: "Remove report.pdf?" });
    await userEvent.type(within(dialog).getByLabelText("Reason for removing"), "Wrong file");
    await userEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    expect(lastCall("POST /ncr-attachments/f1/delete").body).toEqual({ reason: "Wrong file" });
  });

  it("hides cost and file editing on a closed NC", async () => {
    routeApi({ "GET /ncrs/n1": ncr({ stage: "closed" }), "GET /ncrs/n1/costs": costList });
    renderAt("/Non-Conformance/Internal/n1");
    expect(await screen.findByRole("table", { name: "Costs" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New item" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Add files/ })).toBeNull();
  });
});

describe("dialogs inside the NC form", () => {
  it("saving a cost does not also save the NC", async () => {
    routeApi({ "GET /ncrs/n1": ncr(), "POST /ncrs/n1/costs": (_p, o) => ({ id: "c9", ...o.body }), "PATCH /ncrs/n1": (_p, o) => ncr(o.body) });
    renderAt("/Non-Conformance/Internal/n1");
    const title = await screen.findByLabelText("Title *");
    await userEvent.type(title, " (edited)");
    await userEvent.click(screen.getByRole("button", { name: "New item" }));
    const dialog = screen.getByRole("dialog", { name: "New cost item" });
    await userEvent.click(within(dialog).getByRole("combobox", { name: /Cost type/ }));
    await userEvent.click(await within(dialog).findByRole("option", { name: "Rework" }));
    await userEvent.type(within(dialog).getByLabelText(/^Amount/), "10");
    await userEvent.click(within(dialog).getByRole("button", { name: "Add cost" }));
    await waitFor(() => expect(lastCall("POST /ncrs/n1/costs")).toBeTruthy());
    expect(lastCall("PATCH /ncrs/n1")).toBeUndefined();
  });
});
