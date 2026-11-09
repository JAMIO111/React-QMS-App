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
  responseDueOn: "2026-12-01", overdue: false, daysOverdue: 0, ncrCount: 1, responseCount: 0, issuedAt: "2026-11-01T09:00:00Z", closedAt: null, createdAt: "2026-11-01T08:00:00Z", ...over,
});
const detail = (over = {}) => ({
  ...row(), problemDescription: "Brackets arrive bent", originalResponseDueOn: "2026-12-01", contact: { id: "k1", name: "Quality contact", email: null }, capa: null, issuedBy: { id: "u1", name: "Ada Owner" },
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
    expect(screen.getByRole("button", { name: "Extend the due date" })).toBeInTheDocument();
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

  it("lists the SCARs of this NC and raises one with the supplier and the NC chosen", async () => {
    routeApi({
      "GET /supplier-quality/scars": { data: [], page: 1, pageSize: 20, total: 0 },
      "GET /supplier-quality/suppliers/s1": { contacts: [] },
      "GET /ncrs": { data: [{ id: "n1", reference: "NC-000001", title: "Bent bracket", source: "supplier", detectedAt: "2026-11-01" }], page: 1, pageSize: 50, total: 1 },
      "POST /supplier-quality/scars": () => detail(),
    });
    renderAt(<NcrScarCard ncr={{ id: "n1", supplier: { id: "s1", name: "Acme Metals" } }} />);
    expect(await screen.findByText("No SCAR raised for this non-conformance.")).toBeInTheDocument();
    expect(calls[0].path).toContain("ncrId=n1");
    await userEvent.click(screen.getByRole("button", { name: "Raise a SCAR" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Acme Metals")).toBeInTheDocument();
    await userEvent.type(within(dialog).getByLabelText("Title"), "Bent brackets");
    expect(await within(dialog).findByRole("checkbox")).toBeChecked();
    await userEvent.click(within(dialog).getByRole("button", { name: "Create draft" }));
    await waitFor(() => expect(calls.find((c) => c.k === "POST /supplier-quality/scars")).toBeTruthy());
    const body = calls.find((c) => c.k === "POST /supplier-quality/scars").body;
    expect(body).toMatchObject({ supplierId: "s1", title: "Bent brackets", ncrIds: ["n1"] });
    expect(body.clientKey).toHaveLength(36);
  });
});
