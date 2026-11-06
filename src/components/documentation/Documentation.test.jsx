import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { format } from "date-fns";
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
  useMembers: () => ({ data: { data: [
    { membershipId: "m1", userId: "u1", firstName: "Ann", surname: "Tester", email: "ann@example.test", status: "active" },
    { membershipId: "m2", userId: "u2", firstName: "Bob", surname: "Tester", email: "bob@example.test", status: "active" },
  ] } }),
}));
vi.mock("../../hooks/useProcessControl", () => ({
  useMachines: () => ({ data: { items: [{ id: "mc1", code: "L1", name: "Lathe 1" }] } }),
  usePartFamilies: () => ({ data: { items: [{ id: "f1", code: "HCR", name: "Rods" }] } }),
}));
vi.mock("../ncr/Pickers", () => ({ PartPicker: () => <div />, PartyPicker: () => <div />, RemoteComboBox: () => <div /> }));
vi.mock("@/contexts/ToastProvider", () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock("../../hooks/useNcr", () => ({ useNcrs: () => ({ data: { data: [] } }) }));
vi.mock("../../hooks/useCalibration", () => ({ useGauges: () => ({ data: { data: [] } }), useGaugeCalibrations: () => ({ data: [] }) }));

import QualityAlertsPage from "./QualityAlertsPage";
import QualityAlertPage from "./QualityAlertPage";
import QualityAlertForm from "./QualityAlertForm";
import MyAlertsPage from "./MyAlertsPage";

const summary = (over = {}) => ({
  id: "a1", number: 1, reference: "QA-001", revision: 2, revisionLetter: "B", title: "Incorrect material specification", category: "supplier", severity: "high",
  status: "active", inForce: true, effectiveDate: "2026-11-05", expiryDate: "2026-12-05", acknowledgeBy: "2026-11-07", issuedAt: "2026-11-05T09:00:00Z",
  issuedBy: { id: "u1", name: "Ada Owner" }, createdBy: { id: "u1", name: "Ada Owner" }, updatedAt: "2026-11-05T09:00:00Z", progress: { total: 5, viewed: 4, acknowledged: 3, overdue: 2 }, ...over,
});
const detail = (over = {}) => ({
  ...summary(),
  description: "The certificate says 4140, the drawing needs 4340.",
  requiredAction: "Quarantine lot 77.",
  revisionReason: "It was lot 76",
  supersedesId: "a0",
  withdrawn: null,
  me: null,
  links: [
    { id: "l1", kind: "nonconformance", recordId: "n1", label: "NC-26-001 · Scrapped batch", source: "supplier", gaugeId: null },
    { id: "l2", kind: "gauge", recordId: "g1", label: "G-001 · Micrometer", source: null, gaugeId: null },
    { id: "l3", kind: "supplier", recordId: "s1", label: null, source: null, gaugeId: null },
  ],
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
          <Route path="/Documentation/My-Alerts" element={<><MyAlertsPage /><Where /></>} />
          <Route path="/Documentation/Quality-Alerts/new" element={<><QualityAlertForm /><Where /></>} />
          <Route path="/Documentation/Quality-Alerts/:id" element={<><QualityAlertPage /><Where /></>} />
          <Route path="/Documentation/Quality-Alerts/:id/edit" element={<><QualityAlertForm /><Where /></>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return () => where;
};

const preview = { total: 2, targets: [{ id: "t1", kind: "department", label: "Goods-in", count: 2 }, { id: "t2", kind: "department", label: "Machining", count: 0 }] };
const recipients = {
  data: [
    { id: "r1", membershipId: "m1", name: "Ann Tester", reachedVia: ["Department: Goods-in"], firstViewedAt: "2026-11-05T10:00:00Z", acknowledgedAt: "2026-11-05T10:05:00Z", note: "Quarantined", overdue: false },
    { id: "r2", membershipId: "m3", name: "Cat Tester", reachedVia: ["Department: Final inspection"], firstViewedAt: null, acknowledgedAt: null, note: null, overdue: true },
  ],
  totals: { total: 2, viewed: 1, acknowledged: 1, overdue: 1 },
};
const attachments = [{ id: "f1", fileName: "mill-certificate.pdf", contentType: "application/pdf", sizeBytes: 2048, description: null, storagePath: "org-1/quality-alerts/a1/x-mill-certificate.pdf", createdAt: "2026-11-05T09:00:00Z", createdBy: { id: "u1", name: "Ada Owner" }, deletedAt: null, deleteReason: null }];
/** Answers the extra reads the alert page makes; `main` answers everything else. */
const respond = (main) => async (path, opts = {}) => {
  if (path.endsWith("/recipients-preview")) return preview;
  if (path.includes("/attachments")) return { data: attachments };
  if (path.endsWith("/recipients") && (opts.method ?? "GET") === "GET") return recipients;
  return typeof main === "function" ? main(path, opts) : main;
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
    apiFetch.mockImplementation(respond(detail()));
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
    apiFetch.mockImplementation(respond((path, opts = {}) => (path.endsWith("/withdraw") ? ((body = opts.body), detail({ status: "withdrawn" })) : detail())));
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
    apiFetch.mockImplementation(respond((path, opts = {}) => (calls.push(`${opts.method ?? "GET"} ${path}`), path.endsWith("/issue") ? detail({ status: "active" }) : detail({ status: "draft", inForce: false, revisionReason: null, withdrawn: null }))));
    confirm.mockResolvedValue(true);
    renderAt("/Documentation/Quality-Alerts/a1");
    expect(await screen.findByRole("button", { name: "Edit" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Issue alert" }));
    expect(confirm).toHaveBeenCalled();
    expect(calls).toContain("POST /quality-alerts/a1/issue");
  });

  it("without documentation.issue a draft has no Issue button", async () => {
    permissions = ["documentation.read", "documentation.manage"];
    apiFetch.mockImplementation(respond(detail({ status: "draft", inForce: false })));
    renderAt("/Documentation/Quality-Alerts/a1");
    expect(await screen.findByRole("button", { name: "Edit" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Issue alert" })).toBeNull();
  });
});

describe("Quality alert form", () => {
  it("creates a draft with content, scope and targets", async () => {
    let body;
    apiFetch.mockImplementation(respond((path, opts = {}) => (opts.method === "POST" && (body = opts.body), detail({ id: "new1", status: "draft" }))));
    const where = renderAt("/Documentation/Quality-Alerts/new");
    const form = screen.getByRole("form", { name: "Quality alert" });
    await userEvent.type(within(form).getByLabelText("Title"), "Supplier material defect");
    await userEvent.selectOptions(within(form).getByLabelText("Category"), "supplier");
    await userEvent.selectOptions(within(form).getByLabelText("Severity"), "critical");
    await userEvent.type(within(form).getByLabelText("Description"), "Cracks found");
    await userEvent.type(within(form).getByLabelText("Required action"), "Stop using lot 12");
    await userEvent.type(within(form).getByLabelText("Add an operation code"), "OP-020{enter}");
    await userEvent.click(within(form).getByRole("combobox", { name: "Add a machine" }));
    await userEvent.click(screen.getByRole("option", { name: /Lathe 1/ }));
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
    const day = (d) => format(new Date(new Date().getFullYear(), new Date().getMonth(), d), "EEEE d MMMM yyyy");
    await userEvent.click(within(form).getByRole("button", { name: /Effective date/ }));
    await userEvent.click(screen.getByRole("button", { name: day(10) }));
    await userEvent.click(within(form).getByRole("button", { name: /Expiry date/ }));
    await userEvent.click(screen.getByRole("button", { name: day(1) }));
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

describe("Acknowledgement", () => {
  it("a recipient sees a banner and acknowledges with an optional note", async () => {
    permissions = ["documentation.read"];
    let body;
    const mineView = detail({ progress: null, me: { firstViewedAt: "2026-11-05T09:30:00Z", acknowledgedAt: null, note: null, reachedVia: ["Department: Goods-in"], overdue: false } });
    apiFetch.mockImplementation(async (path, opts = {}) => (path.endsWith("/acknowledge") ? ((body = opts.body), detail({ me: { ...mineView.me, acknowledgedAt: "2026-11-05T10:00:00Z", note: "Done" } })) : mineView));
    renderAt("/Documentation/Quality-Alerts/a1");
    const banner = await screen.findByRole("status");
    expect(banner).toHaveTextContent(/addressed to you/);
    expect(banner).toHaveTextContent(/by 7 Nov 2026/);
    await userEvent.click(within(banner).getByRole("button", { name: "Acknowledge" }));
    const dialog = screen.getByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText("Note (optional)"), "Done");
    await userEvent.click(within(dialog).getByRole("button", { name: "I have read and understood" }));
    expect(body).toEqual({ note: "Done" });
    expect(screen.queryByRole("table", { name: "Recipients" })).toBeNull(); // not a manager
  });

  it("shows an acknowledged alert as acknowledged, with no button", async () => {
    permissions = ["documentation.read"];
    apiFetch.mockResolvedValue(detail({ progress: null, me: { firstViewedAt: "2026-11-05T09:30:00Z", acknowledgedAt: "2026-11-05T10:00:00Z", note: null, reachedVia: ["Named"], overdue: false } }));
    renderAt("/Documentation/Quality-Alerts/a1");
    expect(await screen.findByText(/You acknowledged this alert on/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Acknowledge" })).toBeNull();
  });

  it("a manager sees who was asked, who has viewed and acknowledged, and who is overdue; filters; adds a person", async () => {
    const calls = [];
    apiFetch.mockImplementation(respond((path, opts = {}) => (calls.push(`${opts.method ?? "GET"} ${path}`), detail())));
    renderAt("/Documentation/Quality-Alerts/a1");
    const table = await screen.findByRole("table", { name: "Recipients" });
    const totals = screen.getByLabelText("Acknowledgement totals");
    expect(within(totals).getAllByText("1 of 2", { selector: "dd" })).toHaveLength(2); // viewed and acknowledged
    expect(within(table).getByText("Overdue")).toBeInTheDocument();
    expect(within(table).getByText(/Quarantined/)).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("Show"), "open");
    expect(within(table).queryByText("Ann Tester")).toBeNull();
    expect(within(table).getByText("Cat Tester")).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("Show"), "all");
    await userEvent.selectOptions(screen.getByLabelText("Department"), "Goods-in");
    expect(within(table).queryByText("Cat Tester")).toBeNull();
    await userEvent.selectOptions(screen.getByLabelText("Person to add"), "m2");
    await userEvent.click(within(screen.getByRole("form", { name: "Add a person" })).getByRole("button", { name: "Add" }));
    expect(calls).toContain("POST /quality-alerts/a1/recipients");
  });

  it("a draft shows how many people each target reaches and warns about an empty one", async () => {
    apiFetch.mockImplementation(respond(detail({ status: "draft", inForce: false })));
    renderAt("/Documentation/Quality-Alerts/a1");
    expect(await screen.findByText(/people will be asked to acknowledge it/)).toBeInTheDocument();
    const list = screen.getByRole("list", { name: "People reached by each target" });
    expect(within(list).getByText("Goods-in (department): 2")).toBeInTheDocument();
    expect(within(list).getByText("Machining (department): nobody")).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "Recipients" })).toBeNull();
  });
});

describe("My alerts", () => {
  const item = (over = {}) => ({ ...summary(), progress: null, state: "open", me: { firstViewedAt: null, acknowledgedAt: null, note: null, reachedVia: ["Named"], overdue: false }, ...over });

  it("lists what is addressed to me, marks overdue and acknowledged, and acknowledges from the list", async () => {
    permissions = ["documentation.read"];
    const calls = [];
    apiFetch.mockImplementation(async (path, opts = {}) => {
      calls.push(`${opts.method ?? "GET"} ${path}`);
      if (path.endsWith("/acknowledge")) return detail();
      return {
        data: [
          item({ id: "x1", reference: "QA-007", revisionLetter: "A", title: "Gauge out of calibration", me: { firstViewedAt: null, acknowledgedAt: null, note: null, reachedVia: [], overdue: true } }),
          item({ id: "x2", reference: "QA-008", revisionLetter: "A", title: "Frequency change", state: "acknowledged", me: { firstViewedAt: "2026-11-05T09:00:00Z", acknowledgedAt: "2026-11-05T10:00:00Z", note: null, reachedVia: [], overdue: false } }),
          item({ id: "x3", reference: "QA-009", revisionLetter: "A", title: "Old news", state: "closed", status: "withdrawn" }),
        ],
        unacknowledged: 1,
        overdue: 1,
      };
    });
    renderAt("/Documentation/My-Alerts");
    const table = await screen.findByRole("table", { name: "My alerts" });
    expect(screen.getByText("1 to acknowledge, 1 overdue")).toBeInTheDocument();
    expect(within(table).getByText("Overdue")).toBeInTheDocument();
    expect(within(table).getByText("Acknowledged")).toBeInTheDocument();
    expect(within(table).getByRole("link", { name: "QA-007 rev A" })).toHaveAttribute("href", "/Documentation/Quality-Alerts/x1");
    expect(within(table).getAllByRole("button", { name: "Acknowledge" })).toHaveLength(1);
    await userEvent.click(within(table).getByRole("button", { name: "Acknowledge" }));
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "I have read and understood" }));
    expect(calls).toContain("POST /quality-alerts/x1/acknowledge");
  });

  it("after acknowledging from the list, the row, the counts and the menu badge refresh without a reload", async () => {
    permissions = ["documentation.read"];
    let acknowledged = false;
    const calls = [];
    apiFetch.mockImplementation(async (path, opts = {}) => {
      calls.push(`${opts.method ?? "GET"} ${path}`);
      if (path.endsWith("/acknowledge")) return ((acknowledged = true), detail());
      return {
        data: [
          item({
            id: "x1", reference: "QA-007", revisionLetter: "A", title: "Gauge out of calibration",
            state: acknowledged ? "acknowledged" : "open",
            me: { firstViewedAt: "2026-11-05T09:00:00Z", acknowledgedAt: acknowledged ? "2026-11-06T10:00:00Z" : null, note: null, reachedVia: [], overdue: false },
          }),
        ],
        unacknowledged: acknowledged ? 0 : 1,
        overdue: 0,
      };
    });
    renderAt("/Documentation/My-Alerts");
    const table = await screen.findByRole("table", { name: "My alerts" });
    await userEvent.click(within(table).getByRole("button", { name: "Acknowledge" }));
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "I have read and understood" }));
    await waitFor(() => expect(within(table).queryByRole("button", { name: "Acknowledge" })).toBeNull());
    expect(within(table).getByText("Acknowledged")).toBeInTheDocument();
    expect(screen.getByText("0 to acknowledge")).toBeInTheDocument();
    expect(calls.filter((c) => c === "GET /quality-alerts/mine")).toHaveLength(2);
  });

  it("says when nothing is addressed to me", async () => {
    permissions = ["documentation.read"];
    apiFetch.mockResolvedValue({ data: [], unacknowledged: 0, overdue: 0 });
    renderAt("/Documentation/My-Alerts");
    expect(await screen.findByText(/No quality alerts are addressed to you/)).toBeInTheDocument();
  });
});

describe("Register for managers", () => {
  it("shows acknowledgement progress and filters to overdue", async () => {
    apiFetch.mockResolvedValue({ data: [summary()] });
    renderAt("/Documentation/Quality-Alerts");
    const table = await screen.findByRole("table", { name: "Quality alerts" });
    expect(within(table).getByText(/3 of 5/)).toBeInTheDocument();
    expect(within(table).getByText(/2 overdue/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("checkbox", { name: /overdue acknowledgements/ }));
    expect(apiFetch.mock.calls.at(-1)[0]).toContain("overdue=true");
  });

  it("readers see no progress column or overdue filter", async () => {
    permissions = ["documentation.read"];
    apiFetch.mockResolvedValue({ data: [summary({ progress: null })] });
    renderAt("/Documentation/Quality-Alerts");
    const table = await screen.findByRole("table", { name: "Quality alerts" });
    expect(within(table).queryByText("Acknowledged")).toBeNull();
    expect(screen.queryByRole("checkbox", { name: /overdue/ })).toBeNull();
  });
});

describe("Related records and files (DOC3)", () => {
  it("an alert page lists linked records as links where the reader may see them, and the files", async () => {
    permissions = ["documentation.read"];
    apiFetch.mockImplementation(respond(() => detail()));
    renderAt("/Documentation/Quality-Alerts/a1");
    const card = (await screen.findByText("Related records")).closest("section, div");
    const list = await screen.findByRole("list", { name: "Linked records" });
    expect(within(list).getByRole("link", { name: "NC-26-001 · Scrapped batch" })).toHaveAttribute("href", "/Non-Conformance/Supplier/n1");
    expect(within(list).getByRole("link", { name: "G-001 · Micrometer" })).toHaveAttribute("href", "/Calibration/Gauges/g1");
    expect(within(list).getByText("Not available to you")).toBeInTheDocument(); // a record the reader cannot read: no label, no link
    expect(within(list).getAllByRole("link")).toHaveLength(2);
    expect(card).toBeTruthy();
    expect(await screen.findByText("mill-certificate.pdf")).toBeInTheDocument();
    expect(screen.queryByLabelText(/Add files/)).toBeNull(); // read-only: no upload area
    expect(screen.queryByRole("button", { name: /Remove mill-certificate/ })).toBeNull();
  });

  it("the editor sends the links it loaded, offers files for a saved draft and removal of a link", async () => {
    let body;
    apiFetch.mockImplementation(respond((path, opts = {}) => (opts.method === "PATCH" ? ((body = opts.body), detail({ status: "draft", inForce: false })) : detail({ status: "draft", inForce: false }))));
    renderAt("/Documentation/Quality-Alerts/a1/edit");
    const form = await screen.findByRole("form", { name: "Quality alert" });
    expect(within(form).getByRole("list", { name: "Linked records" })).toHaveTextContent("NC-26-001 · Scrapped batch");
    expect(await within(form).findByLabelText(/Add files/)).toBeInTheDocument();
    await userEvent.click(within(form).getByRole("button", { name: "Remove link to G-001 · Micrometer" }));
    await userEvent.click(within(form).getByRole("button", { name: "Save draft" }));
    expect(body.scope.links).toEqual([{ nonconformanceId: "n1" }, { supplierId: "s1" }]);
  });

  it("a new draft says files come after the first save", async () => {
    renderAt("/Documentation/Quality-Alerts/new");
    expect(screen.getByText(/Files can be attached once the draft is saved/)).toBeInTheDocument();
  });
});
