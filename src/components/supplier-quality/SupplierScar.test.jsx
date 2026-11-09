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

import ScarsPage from "./ScarsPage";
import ScarPage from "./ScarPage";
import NcrScarCard from "./NcrScarCard";

const row = (over = {}) => ({
  id: "c1", reference: "SCAR-26-0001", title: "Bent brackets", supplier: { id: "s1", code: "ACME", name: "Acme Metals" }, severity: "major", status: "issued",
  owner: { id: "u1", name: "Ada Owner" }, responseDueOn: "2026-12-01", overdue: false, daysOverdue: 0, ncrCount: 1, responseCount: 0, issuedAt: "2026-11-01T09:00:00Z", closedAt: null, createdAt: "2026-11-01T08:00:00Z", ...over,
});
const detail = (over = {}) => ({
  ...row(), problemDescription: "Brackets arrive bent", requirementBreached: null, objectiveEvidence: null, containmentRequirements: null, items: [], originalResponseDueOn: "2026-12-01", contact: { id: "k1", name: "Quality contact", email: null }, capa: null, issuedBy: { id: "u1", name: "Ada Owner" },
  acknowledgedAt: null, acknowledgedBy: null, acknowledgedNote: null, closedBy: null, cancelledAt: null, cancelledBy: null, cancelReason: null, createdBy: { id: "u1", name: "Ada Owner" },
  ncrs: [{ linkId: "l1", ncr: { id: "n1", reference: "NC-000001", title: "Bent bracket", stage: "open", severity: "major" }, linkedAt: "2026-11-01T08:00:00Z", endedAt: null, endReason: null }],
  responses: [], implementations: [], verifications: [], extensions: [], history: [{ id: "h1", fromStatus: null, toStatus: "draft", reason: "Created", changedAt: "2026-11-01T08:00:00Z", changedBy: { id: "u1", name: "Ada Owner" } }], ...over,
});
const calls = [];
const routeApi = (routes = {}) =>
  apiFetch.mockImplementation(async (path, opts = {}) => {
    const k = `${opts.method ?? "GET"} ${path.split("?")[0]}`;
    calls.push({ k, path, body: opts.body });
    if (!(k in routes)) throw new Error(`unexpected ${k}`);
    return typeof routes[k] === "function" ? routes[k](path, opts) : routes[k];
  });
const renderAt = (ui, at = "/") =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[at]}>
        <Routes>
          <Route path="/Supplier-Quality/SCARs" element={ui} />
          <Route path="/Supplier-Quality/SCARs/:id" element={ui} />
          <Route path="*" element={ui} />
        </Routes>
        <div id="modal-root" />
      </MemoryRouter>
    </QueryClientProvider>
  );

beforeEach(() => {
  permissions = ["supplier_quality.read", "supplier_quality.manage"];
  calls.length = 0;
  apiFetch.mockReset();
});

describe("SCAR register", () => {
  it("lists the running SCARs, flags the late ones and filters", async () => {
    routeApi({ "GET /supplier-quality/scars": () => ({ data: [row({ overdue: true, daysOverdue: 3 })], page: 1, pageSize: 25, total: 1 }) });
    renderAt(<ScarsPage />, "/Supplier-Quality/SCARs");
    expect(await screen.findByRole("link", { name: "SCAR-26-0001" })).toHaveAttribute("href", "/Supplier-Quality/SCARs/c1");
    expect(screen.getByText("3 days late")).toBeInTheDocument();
    expect(calls[0].path).toContain("status=running");
    await userEvent.click(screen.getByRole("button", { name: "Overdue" }));
    await waitFor(() => expect(calls.at(-1).path).toContain("overdue=true"));
    await userEvent.click(screen.getByRole("button", { name: "All" }));
    await waitFor(() => expect(calls.at(-1).path).toContain("status=all"));
  });

  it("offers Raise a SCAR only to people who may manage", async () => {
    routeApi({ "GET /supplier-quality/scars": { data: [], page: 1, pageSize: 25, total: 0 } });
    permissions = ["supplier_quality.read"];
    renderAt(<ScarsPage />, "/Supplier-Quality/SCARs");
    expect(await screen.findByText("No SCARs here")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Raise a SCAR/ })).not.toBeInTheDocument();
  });
});

describe("SCAR page", () => {
  const open = (scar) => {
    routeApi({ "GET /supplier-quality/scars/c1": scar, "GET /supplier-quality/suppliers/s1": { contacts: [] } });
    renderAt(<ScarPage />, "/Supplier-Quality/SCARs/c1");
  };

  it("keeps the stages apart and offers the next step for the status", async () => {
    open(detail({ status: "issued" }));
    expect(await screen.findByRole("heading", { name: "SCAR-26-0001" })).toBeInTheDocument();
    const rail = screen.getByRole("list", { name: "Stages" });
    expect(within(rail).getAllByRole("listitem")).toHaveLength(5);
    expect(within(rail).getByText(/Supplier response/)).toHaveAttribute("aria-current", "step");
    expect(screen.getByRole("button", { name: "Record a response" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Request more time" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Verify effectiveness" })).not.toBeInTheDocument();
    expect(screen.getByText("No response yet.")).toBeInTheDocument();
  });

  it("a response is recorded and waits for review; it does not close the SCAR", async () => {
    let current = detail({ status: "acknowledged" });
    routeApi({
      "GET /supplier-quality/scars/c1": () => current,
      "GET /supplier-quality/suppliers/s1": { contacts: [] },
      "POST /supplier-quality/scars/c1/responses": (_p, o) => { current = detail({ status: "response_received", responseCount: 1, responses: [{ id: "r1", seq: 1, rootCause: o.body.rootCause, containment: null, correctiveAction: o.body.correctiveAction, preventiveAction: null, plannedCompletionOn: null, respondedOn: o.body.respondedOn, respondedByName: null, contact: null, receivedAt: "2026-11-05T09:00:00Z", receivedBy: { id: "u1", name: "Ada Owner" }, review: null }] }); return current; },
    });
    renderAt(<ScarPage />, "/Supplier-Quality/SCARs/c1");
    await userEvent.click(await screen.findByRole("button", { name: "Record a response" }));
    const dialog = await screen.findByRole("dialog");
    const submit = within(dialog).getByRole("button", { name: "Record response" });
    expect(submit).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText("Root cause"), "Jig worn");
    await userEvent.type(within(dialog).getByLabelText("Corrective action"), "Replace the jig");
    await userEvent.click(submit);
    await waitFor(() => expect(calls.some((c) => c.k === "POST /supplier-quality/scars/c1/responses")).toBe(true));
    expect(calls.find((c) => c.k === "POST /supplier-quality/scars/c1/responses").body).toMatchObject({ rootCause: "Jig worn", correctiveAction: "Replace the jig" });
    expect(await screen.findByRole("button", { name: "Start the review" })).toBeInTheDocument();
    expect(screen.getByText("Not reviewed yet.")).toBeInTheDocument();
  });

  it("only an approver can verify effectiveness", async () => {
    open(detail({ status: "verifying" }));
    expect(await screen.findByText(/Waiting for someone with approval rights/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Verify effectiveness" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Record more implementation" })).toBeInTheDocument();
  });

  it("an approver sees Verify effectiveness and its dialog closes the SCAR on an effective result", async () => {
    permissions = [...permissions, "supplier_quality.approve"];
    let current = detail({ status: "verifying", implementations: [{ id: "i1", description: "New jig fitted", implementedOn: "2026-11-05", evidenceNote: null, recordedAt: "2026-11-05T09:00:00Z", recordedBy: null }] });
    routeApi({
      "GET /supplier-quality/scars/c1": () => current,
      "GET /supplier-quality/suppliers/s1": { contacts: [] },
      "POST /supplier-quality/scars/c1/verifications": () => { current = detail({ status: "closed", closedAt: "2026-11-06T09:00:00Z", closedBy: { id: "u2", name: "Quality Manager" } }); return current; },
    });
    renderAt(<ScarPage />, "/Supplier-Quality/SCARs/c1");
    await userEvent.click(await screen.findByRole("button", { name: "Verify effectiveness" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText("How it was checked"), "Next three deliveries");
    await userEvent.type(within(dialog).getByLabelText("What was found"), "All within tolerance");
    await userEvent.click(within(dialog).getByRole("button", { name: "Verify and close" }));
    await waitFor(() => expect(calls.find((c) => c.k === "POST /supplier-quality/scars/c1/verifications")?.body).toMatchObject({ result: "effective", method: "Next three deliveries" }));
    expect(await screen.findByText(/Verified effective/)).toBeInTheDocument();
  });

  it("shows the requirement, evidence, containment, owner and affected items, and the response's extra fields", async () => {
    open(detail({
      status: "response_received", requirementBreached: "Drawing note 4", objectiveEvidence: "Photos 1 to 3", containmentRequirements: "Quarantine stock", owner: { id: "u2", name: "Quality Manager" },
      items: [
        { id: "i1", part: { id: "p1", partNumber: "BRK-1", name: "Bracket" }, material: null, lot: { id: "l1", lotNumber: "LOT-A" }, receiptReference: "DN-4412", quantity: 120, notes: null, addedAt: "2026-11-01T09:00:00Z", endedAt: null, endReason: null },
        { id: "i2", part: null, material: "Old steel", lot: null, receiptReference: null, quantity: null, notes: null, addedAt: "2026-11-01T09:00:00Z", endedAt: "2026-11-02T09:00:00Z", endReason: "Added in error" },
      ],
      responses: [{ id: "r1", seq: 1, rootCause: "Jig worn", containment: null, correctiveAction: "Replace the jig", preventiveAction: null, plannedCompletionOn: null, respondedOn: "2026-11-05", respondedByName: null, extentOfCondition: "Lots 1180 to 1184", escapePoint: "No dye-penetrant check", responsibleName: "Their welding engineer", rootCauseMethod: "five_whys", contact: null, receivedAt: "2026-11-05T09:00:00Z", receivedBy: null, review: null }],
    }));
    expect(await screen.findByText("Drawing note 4")).toBeInTheDocument();
    expect(screen.getByText("Photos 1 to 3")).toBeInTheDocument();
    expect(screen.getByText("Quarantine stock")).toBeInTheDocument();
    expect(screen.getByText("Quality Manager")).toBeInTheDocument();
    const items = screen.getByRole("list", { name: "Affected items" });
    expect(within(items).getByText(/BRK-1 · Bracket · Lot LOT-A · Receipt DN-4412/)).toBeInTheDocument();
    expect(within(items).getAllByRole("listitem")).toHaveLength(1); // the removed one is folded away
    expect(screen.getByText("1 removed")).toBeInTheDocument();
    expect(screen.getByText("5 Whys")).toBeInTheDocument();
    expect(screen.getByText("No dye-penetrant check")).toBeInTheDocument();
    expect(screen.getByText("Lots 1180 to 1184")).toBeInTheDocument();
    expect(screen.getByText("Their welding engineer")).toBeInTheDocument();
  });

  it("records the response with the extent of condition, escape point, responsible person and method", async () => {
    routeApi({
      "GET /supplier-quality/scars/c1": detail({ status: "issued" }),
      "GET /supplier-quality/suppliers/s1": { contacts: [] },
      "POST /supplier-quality/scars/c1/responses": detail({ status: "response_received" }),
    });
    renderAt(<ScarPage />, "/Supplier-Quality/SCARs/c1");
    await userEvent.click(await screen.findByRole("button", { name: "Record a response" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText("Root cause"), "Jig worn");
    await userEvent.type(within(dialog).getByLabelText("Escape point"), "No dye-penetrant check");
    await userEvent.type(within(dialog).getByLabelText("Extent of condition"), "Lots 1180 to 1184");
    await userEvent.type(within(dialog).getByLabelText("Responsible for the corrective action"), "Their welding engineer");
    await userEvent.type(within(dialog).getByLabelText("Corrective action"), "Replace the jig");
    await userEvent.click(within(dialog).getByRole("button", { name: "Record response" }));
    await waitFor(() => expect(calls.find((c) => c.k === "POST /supplier-quality/scars/c1/responses")).toBeTruthy());
    expect(calls.find((c) => c.k === "POST /supplier-quality/scars/c1/responses").body).toMatchObject({
      rootCause: "Jig worn", escapePoint: "No dye-penetrant check", extentOfCondition: "Lots 1180 to 1184", responsibleName: "Their welding engineer", correctiveAction: "Replace the jig",
    });
  });

  it("an extension waits for a decision: the requester sees no Decide button, an approver who did not ask does", async () => {
    const pending = (over = {}) => ({ id: "x1", previousDueOn: "2026-12-01", newDueOn: "2026-12-15", reason: "Supplier on holiday", extendedAt: "2026-11-02T09:00:00Z", extendedBy: { id: "u1", name: "Ada Owner" }, status: "pending", decidedAt: null, decidedBy: null, decisionNote: null, canDecide: false, ...over });
    open(detail({ status: "issued", extensions: [pending()] }));
    expect(await screen.findByText("Waiting for a decision")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Decide" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Request more time" })).not.toBeInTheDocument(); // one at a time
    expect(screen.getByRole("button", { name: "Withdraw" })).toBeInTheDocument();
  });

  it("an approver decides an extension with a note", async () => {
    permissions = [...permissions, "supplier_quality.approve"];
    const x = { id: "x1", previousDueOn: "2026-12-01", newDueOn: "2026-12-15", reason: "Supplier on holiday", extendedAt: "2026-11-02T09:00:00Z", extendedBy: { id: "u3", name: "Eng" }, status: "pending", decidedAt: null, decidedBy: null, decisionNote: null, canDecide: true };
    let current = detail({ status: "issued", extensions: [x] });
    routeApi({
      "GET /supplier-quality/scars/c1": () => current,
      "GET /supplier-quality/suppliers/s1": { contacts: [] },
      "POST /supplier-quality/scar-extensions/x1/decide": () => { current = detail({ status: "issued", responseDueOn: "2026-12-15", extensions: [{ ...x, status: "approved", canDecide: false, decidedAt: "2026-11-03T09:00:00Z", decidedBy: { id: "u2", name: "Quality Manager" }, decisionNote: "Justified" }] }); return current; },
    });
    renderAt(<ScarPage />, "/Supplier-Quality/SCARs/c1");
    await userEvent.click(await screen.findByRole("button", { name: "Decide" }));
    const dialog = await screen.findByRole("dialog");
    const submit = within(dialog).getByRole("button", { name: "Record decision" });
    expect(submit).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText("Why it is justified"), "Justified");
    await userEvent.click(submit);
    await waitFor(() => expect(calls.find((c) => c.k === "POST /supplier-quality/scar-extensions/x1/decide")?.body).toMatchObject({ approve: true, note: "Justified" }));
    expect(await screen.findByText(/Approved by Quality Manager/)).toBeInTheDocument();
  });

  it("a cancelled SCAR offers nothing to do and says why", async () => {
    open(detail({ status: "cancelled", cancelledAt: "2026-11-06T09:00:00Z", cancelledBy: { id: "u1", name: "Ada Owner" }, cancelReason: "Wrong supplier" }));
    expect(await screen.findByText("Wrong supplier", { exact: false })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel SCAR" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Record a response" })).not.toBeInTheDocument();
  });
});

describe("the NC page card", () => {
  it("shows nothing for an NC with no supplier", () => {
    routeApi({});
    renderAt(<NcrScarCard ncr={{ id: "n1", supplier: null }} />);
    expect(screen.queryByLabelText("Supplier corrective action")).not.toBeInTheDocument();
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("lists the SCARs of this NC and raises one with the supplier and the NC chosen, filling the form from the NC", async () => {
    routeApi({
      "GET /supplier-quality/scars": { data: [], page: 1, pageSize: 20, total: 0 },
      "GET /supplier-quality/scar-people": { data: [{ userId: "u1", name: "Ada Owner" }] },
      "GET /supplier-quality/suppliers/s1": { contacts: [] },
      "GET /ncrs": { data: [{ id: "n1", reference: "NC-000001", title: "Bent bracket", source: "supplier", detectedAt: "2026-11-01" }], page: 1, pageSize: 50, total: 1 },
      "GET /ncrs/n1": { id: "n1", reference: "NC-000001", title: "Bent bracket", description: "Brackets arrive bent on every pallet", requirement: "Flat within 0.5 mm", actualResult: "Bent by 2 mm" },
      "POST /supplier-quality/scars": () => detail(),
    });
    renderAt(<NcrScarCard ncr={{ id: "n1", supplier: { id: "s1", name: "Acme Metals" } }} />);
    expect(await screen.findByText("No SCAR raised for this non-conformance.")).toBeInTheDocument();
    expect(calls[0].path).toContain("ncrId=n1");
    await userEvent.click(screen.getByRole("button", { name: "Raise a SCAR" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Acme Metals")).toBeInTheDocument();
    // the non-conformance is chosen first, as a combo box, and fills the form
    expect(within(dialog).getByRole("combobox", { name: /Non-conformance this is about/ })).toBeInTheDocument();
    await waitFor(() => expect(within(dialog).getByLabelText("Title")).toHaveValue("Bent bracket"));
    expect(within(dialog).getByLabelText("The problem")).toHaveValue("Brackets arrive bent on every pallet");
    expect(within(dialog).getByLabelText("Requirement breached")).toHaveValue("Requirement: Flat within 0.5 mm\nActual: Bent by 2 mm");
    expect(within(dialog).getByRole("list", { name: "Linked non-conformances" })).toHaveTextContent("NC-000001");
    // what the person writes is never overwritten
    await userEvent.clear(within(dialog).getByLabelText("Title"));
    await userEvent.type(within(dialog).getByLabelText("Title"), "Bent brackets, pallet 4");
    await userEvent.type(within(dialog).getByLabelText("Objective evidence"), "Photos 1 to 3");
    await userEvent.type(within(dialog).getByLabelText("Containment required"), "Quarantine stock");
    await userEvent.click(within(dialog).getByRole("button", { name: "Create draft" }));
    await waitFor(() => expect(calls.find((c) => c.k === "POST /supplier-quality/scars")).toBeTruthy());
    const body = calls.find((c) => c.k === "POST /supplier-quality/scars").body;
    expect(body).toMatchObject({ supplierId: "s1", title: "Bent brackets, pallet 4", problemDescription: "Brackets arrive bent on every pallet", ncrIds: ["n1"], requirementBreached: "Requirement: Flat within 0.5 mm\nActual: Bent by 2 mm", objectiveEvidence: "Photos 1 to 3", containmentRequirements: "Quarantine stock" });
    expect(body.clientKey).toHaveLength(36);
  });
});
