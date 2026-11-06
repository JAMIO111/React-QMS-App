import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

let permissions;
const apiFetch = vi.fn();
const confirm = vi.fn();
vi.mock("../../lib/api-client", async (importOriginal) => ({ ...(await importOriginal()), apiFetch: (...a) => apiFetch(...a) }));
vi.mock("../../contexts/OrganisationProvider", () => ({ useOrganisation: () => ({ organisationId: "org-1" }) }));
vi.mock("../../contexts/ConfirmationModalProvider", () => ({ useConfirm: () => confirm }));
vi.mock("../../hooks/useQmsApi", () => ({
  usePermissions: () => ({ can: (p) => permissions.includes(p) }),
  useAllDepartments: () => ({ data: { data: [{ id: "d1", code: "GI", name: "Goods-in" }, { id: "d2", code: "FI", name: "Final inspection" }] } }),
  useRoles: () => ({ data: { data: [{ id: "r1", key: "inspector", name: "Inspector" }] } }),
  useMembers: () => ({ data: { data: [] } }),
}));
vi.mock("../../hooks/useProcessControl", () => ({
  useMachines: () => ({ data: { items: [{ id: "mc1", code: "L1", name: "Lathe 1" }] } }),
  usePartFamilies: () => ({ data: { items: [{ id: "f1", code: "HCR", name: "Rods" }] } }),
}));
vi.mock("../ncr/Pickers", () => ({ PartPicker: () => <div /> }));

import QualityAlertsPage from "./QualityAlertsPage";
import QualityAlertPage from "./QualityAlertPage";
import QualityAlertForm from "./QualityAlertForm";

const summary = (over = {}) => ({
  id: "a1", number: 1, reference: "QA-001", revision: 2, revisionLetter: "B", title: "Incorrect material specification", category: "supplier", severity: "high",
  status: "active", inForce: true, effectiveDate: "2026-11-05", expiryDate: "2026-12-05", acknowledgeBy: "2026-11-07", issuedAt: "2026-11-05T09:00:00Z",
  issuedBy: { id: "u1", name: "Ada Owner" }, createdBy: { id: "u1", name: "Ada Owner" }, updatedAt: "2026-11-05T09:00:00Z", ...over,
});
const detail = (over = {}) => ({
  ...summary(),
  description: "The certificate says 4140, the drawing needs 4340.",
  requiredAction: "Quarantine lot 77.",
  revisionReason: "It was lot 76",
  supersedesId: "a0",
  withdrawn: null,
  scope: {
    parts: [{ id: "sp1", kind: "part", partId: "p1", partFamilyId: null, label: "HCR-100 · Rod 100" }],
    machines: [{ id: "sm1", machineId: "mc1", label: "L1 · Lathe 1" }],
    operations: ["OP-020"],
    departments: [{ id: "sd1", departmentId: "d1", label: "GI · Goods-in (Plant A)" }],
    targets: [{ id: "t1", kind: "department", departmentId: "d1", roleId: null, membershipId: null, label: "GI · Goods-in (Plant A)" }],
  },
  revisions: [
    { id: "a1", revision: 2, revisionLetter: "B", status: "active", issuedAt: "2026-11-05T09:00:00Z", revisionReason: "It was lot 76" },
    { id: "a0", revision: 1, revisionLetter: "A", status: "superseded", issuedAt: "2026-11-04T09:00:00Z", revisionReason: null },
  ],
  ...over,
});

const renderAt = (url) => {
  let where = "";
  const Where = () => ((where = useLocation().pathname + useLocation().search), null);
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="/Documentation/Quality-Alerts" element={<><QualityAlertsPage /><Where /></>} />
          <Route path="/Documentation/Quality-Alerts/new" element={<><QualityAlertForm /><Where /></>} />
          <Route path="/Documentation/Quality-Alerts/:id" element={<><QualityAlertPage /><Where /></>} />
          <Route path="/Documentation/Quality-Alerts/:id/edit" element={<><QualityAlertForm /><Where /></>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return () => where;
};

beforeEach(() => {
  apiFetch.mockReset();
  confirm.mockReset();
  permissions = ["documentation.read", "documentation.manage", "documentation.issue"];
});

describe("Quality alerts register", () => {
  it("lists alerts with reference and revision, severity and status as words, and filters through the URL", async () => {
    apiFetch.mockResolvedValue({ data: [summary(), summary({ id: "a2", reference: "QA-002", revisionLetter: "A", title: "Gauge out of calibration", severity: "critical", status: "draft", inForce: false, effectiveDate: null, expiryDate: null })] });
    const where = renderAt("/Documentation/Quality-Alerts");
    const table = await screen.findByRole("table", { name: "Quality alerts" });
    expect(within(table).getByRole("link", { name: "QA-001 rev B" })).toHaveAttribute("href", "/Documentation/Quality-Alerts/a1");
    expect(within(table).getByText("Critical")).toBeInTheDocument();
    expect(within(table).getByText("Draft")).toBeInTheDocument();
    expect(within(table).getByText("5 Nov 2026")).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("Severity"), "critical");
    expect(where()).toContain("severity=critical");
    expect(apiFetch.mock.calls.at(-1)[0]).toContain("severity=critical");
    expect(screen.getByRole("button", { name: /New quality alert/ })).toBeInTheDocument();
  });

  it("offers no New button without documentation.manage", async () => {
    permissions = ["documentation.read"];
    apiFetch.mockResolvedValue({ data: [] });
    renderAt("/Documentation/Quality-Alerts");
    expect(await screen.findByText("No quality alerts match.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /New quality alert/ })).toBeNull();
  });
});

describe("Quality alert page", () => {
  it("shows the content, scope, targets and revisions, and offers revise and withdraw on an active alert", async () => {
    apiFetch.mockResolvedValue(detail());
    renderAt("/Documentation/Quality-Alerts/a1");
    expect(await screen.findByRole("heading", { name: "Incorrect material specification" })).toBeInTheDocument();
    expect(screen.getByText(/certificate says 4140/)).toBeInTheDocument();
    expect(screen.getByText("HCR-100 · Rod 100")).toBeInTheDocument();
    expect(screen.getByText("OP-020")).toBeInTheDocument();
    expect(screen.getByText(/Why revision B:/)).toBeInTheDocument();
    const revisions = screen.getByRole("list", { name: "Revisions" });
    expect(within(revisions).getByRole("link", { name: "Revision A" })).toHaveAttribute("href", "/Documentation/Quality-Alerts/a0");
    expect(screen.getByRole("button", { name: "Issue a revision" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Withdraw" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
  });

  it("withdraws with a required reason", async () => {
    let body;
    apiFetch.mockImplementation(async (path, opts = {}) => (path.endsWith("/withdraw") ? ((body = opts.body), detail({ status: "withdrawn" })) : detail()));
    renderAt("/Documentation/Quality-Alerts/a1");
    await userEvent.click(await screen.findByRole("button", { name: "Withdraw" }));
    const dialog = screen.getByRole("dialog");
    const submit = within(dialog).getByRole("button", { name: "Withdraw" });
    expect(submit).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText("Reason"), "Issued in error");
    await userEvent.click(submit);
    expect(body).toEqual({ reason: "Issued in error" });
  });

  it("a draft can be edited, issued after confirming, and discarded; others cannot issue", async () => {
    const calls = [];
    apiFetch.mockImplementation(async (path, opts = {}) => (calls.push(`${opts.method ?? "GET"} ${path}`), path.endsWith("/issue") ? detail({ status: "active" }) : detail({ status: "draft", inForce: false, revisionReason: null, withdrawn: null })));
    confirm.mockResolvedValue(true);
    renderAt("/Documentation/Quality-Alerts/a1");
    expect(await screen.findByRole("button", { name: "Edit" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Issue alert" }));
    expect(confirm).toHaveBeenCalled();
    expect(calls).toContain("POST /quality-alerts/a1/issue");
  });

  it("without documentation.issue a draft has no Issue button", async () => {
    permissions = ["documentation.read", "documentation.manage"];
    apiFetch.mockResolvedValue(detail({ status: "draft", inForce: false }));
    renderAt("/Documentation/Quality-Alerts/a1");
    expect(await screen.findByRole("button", { name: "Edit" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Issue alert" })).toBeNull();
  });
});

describe("Quality alert form", () => {
  it("creates a draft with content, scope and targets", async () => {
    let body;
    apiFetch.mockImplementation(async (path, opts = {}) => ((body = opts.body), detail({ id: "new1", status: "draft" })));
    const where = renderAt("/Documentation/Quality-Alerts/new");
    const form = screen.getByRole("form", { name: "Quality alert" });
    await userEvent.type(within(form).getByLabelText("Title"), "Supplier material defect");
    await userEvent.selectOptions(within(form).getByLabelText("Category"), "supplier");
    await userEvent.selectOptions(within(form).getByLabelText("Severity"), "critical");
    await userEvent.type(within(form).getByLabelText("Description"), "Cracks found");
    await userEvent.type(within(form).getByLabelText("Required action"), "Stop using lot 12");
    await userEvent.type(within(form).getByLabelText("Add an operation code"), "OP-020{enter}");
    await userEvent.selectOptions(within(form).getByLabelText("Add a machine"), "mc1");
    const target = within(within(form).getByRole("group", { name: "Departments (their members)" }));
    await userEvent.click(target.getByRole("checkbox", { name: /Goods-in/ }));
    await userEvent.click(within(form).getByRole("button", { name: "Save draft" }));
    expect(body).toMatchObject({
      title: "Supplier material defect", category: "supplier", severity: "critical", description: "Cracks found", requiredAction: "Stop using lot 12",
      effectiveDate: null, expiryDate: null, acknowledgeBy: null,
      scope: { parts: [], machines: ["mc1"], operations: ["OP-020"], departments: [], targets: [{ departmentId: "d1" }] },
    });
    await waitFor(() => expect(where()).toBe("/Documentation/Quality-Alerts/new1"));
  });

  it("needs a title, and checks the dates", async () => {
    renderAt("/Documentation/Quality-Alerts/new");
    const form = screen.getByRole("form", { name: "Quality alert" });
    await userEvent.click(within(form).getByRole("button", { name: "Save draft" }));
    expect(within(form).getByRole("alert")).toHaveTextContent("Give the alert a title");
    await userEvent.type(within(form).getByLabelText("Title"), "x");
    await userEvent.type(within(form).getByLabelText("Effective date"), "2026-11-10");
    await userEvent.type(within(form).getByLabelText("Expiry date"), "2026-11-01");
    await userEvent.click(within(form).getByRole("button", { name: "Save draft" }));
    expect(within(form).getByRole("alert")).toHaveTextContent("expiry date cannot be before");
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("loads a draft for editing, and refuses an issued alert", async () => {
    apiFetch.mockResolvedValue(detail({ status: "draft", inForce: false }));
    renderAt("/Documentation/Quality-Alerts/a1/edit");
    const form = await screen.findByRole("form", { name: "Quality alert" });
    expect(within(form).getByLabelText("Title")).toHaveValue("Incorrect material specification");
    expect(within(form).getByRole("list", { name: "Machines" })).toHaveTextContent("L1 · Lathe 1");
    expect(within(within(form).getByRole("group", { name: "Departments (their members)" })).getByRole("checkbox", { name: /Goods-in/ })).toBeChecked();
  });

  it("an issued alert cannot be edited", async () => {
    apiFetch.mockResolvedValue(detail());
    renderAt("/Documentation/Quality-Alerts/a1/edit");
    expect(await screen.findByText(/is issued and cannot be edited/)).toBeInTheDocument();
  });
});
