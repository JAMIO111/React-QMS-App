import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

let permissions;
const apiFetch = vi.fn();
const toast = vi.hoisted(() => vi.fn());
vi.mock("../../lib/api-client", async (importOriginal) => ({ ...(await importOriginal()), apiFetch: (...a) => apiFetch(...a) }));
vi.mock("../../contexts/OrganisationProvider", () => ({ useOrganisation: () => ({ organisationId: "org-1" }) }));
vi.mock("../../contexts/ToastProvider", () => ({ useToast: () => ({ showToast: toast }) }));
vi.mock("../../contexts/SearchProvider", () => ({ useGlobalSearch: () => ({ debouncedSearchTerm: "", setSearchTerm: vi.fn() }) }));
vi.mock("../../hooks/useQmsApi", () => ({ usePermissions: () => ({ can: (p) => permissions.includes(p) }) }));
const upload = vi.fn();
vi.mock("@/api/supabaseApi", () => ({ uploadFileToSupabase: (...a) => upload(...a), generateSignedUrl: vi.fn() }));

import { findingFromAnswer, suggestClassification } from "../../lib/audits";
import AuditFindingPage from "./AuditFindingPage";
import AuditFindingsPage from "./AuditFindingsPage";
import NcrAuditSource from "./NcrAuditSource";
import SettingsAudits from "../Settings/SettingsAudits";

const CLASSES = [
  { id: "c-major", key: "major_nc", label: "Major non-conformity", kind: "nonconformity", defaultSeverity: "major", sequence: 1, active: true, findingCount: 3 },
  { id: "c-minor", key: "minor_nc", label: "Minor non-conformity", kind: "nonconformity", defaultSeverity: "minor", sequence: 2, active: true, findingCount: 1 },
  { id: "c-obs", key: "observation", label: "Observation", kind: "observation", defaultSeverity: null, sequence: 3, active: true, findingCount: 0 },
  { id: "c-ofi", key: "ofi", label: "Opportunity for improvement", kind: "opportunity", defaultSeverity: null, sequence: 4, active: false, findingCount: 0 },
];
const finding = (over = {}) => ({
  id: "f1",
  reference: "AF-26-0001",
  status: "open",
  title: "Work instruction missing",
  description: "No instruction at the machine",
  requirement: "Instructions are at every machine",
  classification: { id: "c-major", key: "major_nc", label: "Major non-conformity", kind: "nonconformity" },
  owner: { id: "e1", name: "Grace Hopper" },
  dueOn: "2026-11-20",
  overdue: false,
  record: { id: "r1", reference: "AR-26-0001", status: "completed", performedOn: "2026-11-08", audit: { id: "a1", reference: "AUD-001", title: "Cell audit" } },
  answer: { id: "s-q1", sequence: 1, question: "Is the work instruction at the machine?" },
  ncr: null,
  fileCount: 0,
  closedNote: null,
  closedAt: null,
  closedBy: null,
  reopenReason: null,
  withdrawReason: null,
  withdrawnAt: null,
  createdAt: "2026-11-08T10:00:00Z",
  createdBy: { id: "u1", name: "Ines Inspector" },
  ...over,
});

const calls = [];
let routes;
const routeApi = (extra = {}) => {
  routes = {
    "GET /audit-finding-classifications": { data: CLASSES },
    "GET /employees/lookup": { data: [{ id: "e1", name: "Grace Hopper", jobTitle: null, active: true }, { id: "e2", name: "Alan Turing", jobTitle: "Engineer", active: true }] },
    "GET /audits": { data: [{ id: "a1", reference: "AUD-001", title: "Cell audit", auditType: "layered_process", questionCount: 4, criticalCount: 1, passMark: 80 }], page: 1, pageSize: 200, total: 1 },
    "GET /audit-findings/f1/attachments": { data: [] },
    ...extra,
  };
  apiFetch.mockImplementation(async (path, opts = {}) => {
    const k = `${opts.method ?? "GET"} ${path.split("?")[0]}`;
    calls.push({ k, path, body: opts.body });
    if (!(k in routes)) throw new Error(`unexpected ${k}`);
    const r = routes[k];
    if (r instanceof Error) throw r;
    return typeof r === "function" ? r(opts.body) : r;
  });
};
const sent = (k) => calls.filter((c) => c.k === k);
const last = (k) => sent(k).at(-1);

const Where = () => {
  const l = useLocation();
  return <p data-testid="where">{l.pathname + l.search}</p>;
};
const renderAt = (url) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="/Audits/Findings" element={<><AuditFindingsPage /><Where /></>} />
          <Route path="/Audits/Findings/:id" element={<><AuditFindingPage /><Where /></>} />
          <Route path="/Audits/Records/:id" element={<Where />} />
          <Route path="/Non-Conformance/Register/:id" element={<Where />} />
          <Route path="/Settings/Audits" element={<SettingsAudits />} />
        </Routes>
        <div id="modal-root" />
      </MemoryRouter>
    </QueryClientProvider>
  );

beforeEach(() => {
  permissions = ["audits.read", "audits.manage", "audits.perform", "ncr.create"];
  calls.length = 0;
  apiFetch.mockReset();
  toast.mockReset();
});

describe("helpers", () => {
  it("starts a finding from the question and the auditor's words", () => {
    expect(findingFromAnswer({ question: "Is the floor clear?", response: { note: "Swarf", choice: null } })).toEqual({ title: "Is the floor clear?", description: "Swarf" });
    expect(findingFromAnswer({ question: "Condition?", response: { note: "Greasy", choice: "Oily" } }).description).toBe("Greasy\nAnswered: Oily");
    expect(findingFromAnswer({ question: "Q", response: { note: null } }).description).toBe("Q");
    expect(findingFromAnswer({ question: "x".repeat(300), response: null }).title).toHaveLength(200);
  });

  it("suggests major for a critical question, minor otherwise, never a switched-off classification", () => {
    expect(suggestClassification(CLASSES, { critical: true }).key).toBe("major_nc");
    expect(suggestClassification(CLASSES, { critical: false }).key).toBe("minor_nc");
    expect(suggestClassification(CLASSES, null).key).toBe("minor_nc");
    const off = CLASSES.map((c) => (c.key === "minor_nc" ? { ...c, active: false } : c));
    expect(suggestClassification(off, { critical: false }).key).toBe("major_nc");
    expect(suggestClassification([{ ...CLASSES[2] }], { critical: true }).key).toBe("observation");
    expect(suggestClassification([], {})).toBeNull();
  });
});

describe("a finding", () => {
  it("shows what was found, who owns it, when it is due and where it came from", async () => {
    routeApi({ "GET /audit-findings/f1": finding() });
    renderAt("/Audits/Findings/f1");
    expect(await screen.findByRole("heading", { name: "AF-26-0001 · Work instruction missing" })).toBeInTheDocument();
    expect(screen.getAllByText("Major non-conformity").length).toBeGreaterThan(0);
    expect(screen.getByText("Open")).toBeInTheDocument();
    expect(screen.getByText("No instruction at the machine")).toBeInTheDocument();
    expect(screen.getByText("Instructions are at every machine")).toBeInTheDocument();
    expect(screen.getByText("Grace Hopper")).toBeInTheDocument();
    expect(screen.getByText(/Question 1: Is the work instruction at the machine\?/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "AR-26-0001 · Cell audit" })).toHaveAttribute("href", "/Audits/Records/r1");
    expect(screen.getByText(/No non-conformance has been raised from this finding yet/)).toBeInTheDocument();
    expect(screen.queryByText("Overdue")).toBeNull();
  });

  it("flags an overdue finding", async () => {
    routeApi({ "GET /audit-findings/f1": finding({ overdue: true, dueOn: "2026-11-01" }) });
    renderAt("/Audits/Findings/f1");
    expect(await screen.findByText("Overdue")).toBeInTheDocument();
  });

  it("offers the actions each person may take, and only while they apply", async () => {
    routeApi({ "GET /audit-findings/f1": finding() });
    const view = renderAt("/Audits/Findings/f1");
    await screen.findByRole("heading", { name: /AF-26-0001/ });
    for (const name of ["Create non-conformance", "Edit", "Close finding", "Withdraw"]) expect(screen.getByRole("button", { name })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reopen" })).toBeNull();
    view.unmount();

    permissions = ["audits.read", "audits.perform"];
    routeApi({ "GET /audit-findings/f1": finding() });
    const performer = renderAt("/Audits/Findings/f1");
    await screen.findByRole("heading", { name: /AF-26-0001/ });
    expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Withdraw" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Close finding" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Create non-conformance" })).toBeNull();
    expect(screen.getByText(/needs permission to create non-conformances/)).toBeInTheDocument();
    performer.unmount();

    permissions = ["audits.read"];
    routeApi({ "GET /audit-findings/f1": finding() });
    renderAt("/Audits/Findings/f1");
    await screen.findByRole("heading", { name: /AF-26-0001/ });
    expect(screen.queryAllByRole("button").map((b) => b.textContent)).not.toEqual(expect.arrayContaining(["Edit"]));
    for (const name of ["Create non-conformance", "Edit", "Close finding", "Withdraw", "Reopen"]) expect(screen.queryByRole("button", { name })).toBeNull();
  });

  it("offers no non-conformance for an observation, and none to withdraw once one is raised", async () => {
    routeApi({ "GET /audit-findings/f1": finding({ classification: { id: "c-obs", key: "observation", label: "Observation", kind: "observation" } }) });
    const view = renderAt("/Audits/Findings/f1");
    await screen.findByRole("heading", { name: /AF-26-0001/ });
    expect(screen.queryByRole("button", { name: "Create non-conformance" })).toBeNull();
    expect(screen.getByText(/is an observation, so it is not raised as a non-conformance/)).toBeInTheDocument();
    view.unmount();

    routeApi({ "GET /audit-findings/f1": finding({ ncr: { id: "n9", reference: "NCR-26-0009", stage: "draft" } }) });
    renderAt("/Audits/Findings/f1");
    await screen.findByRole("heading", { name: /AF-26-0001/ });
    expect(screen.getByRole("link", { name: "NCR-26-0009" })).toHaveAttribute("href", "/Non-Conformance/Register/n9");
    expect(screen.getByText(/can be closed once that non-conformance is closed/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create non-conformance" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Withdraw" })).toBeNull();
  });

  it("shows a closed finding with its note and offers only to reopen it; a withdrawn one shows the reason", async () => {
    routeApi({ "GET /audit-findings/f1": finding({ status: "closed", closedNote: "Instruction posted", closedBy: { id: "u2", name: "Mo Manager" }, closedAt: "2026-11-09T10:00:00Z" }) });
    const view = renderAt("/Audits/Findings/f1");
    const banner = await screen.findByRole("status");
    expect(banner).toHaveTextContent(/Closed.*By Mo Manager/);
    expect(banner).toHaveTextContent("Instruction posted");
    expect(screen.getByRole("button", { name: "Reopen" })).toBeInTheDocument();
    for (const name of ["Edit", "Close finding", "Withdraw", "Create non-conformance"]) expect(screen.queryByRole("button", { name })).toBeNull();
    view.unmount();

    routeApi({ "GET /audit-findings/f1": finding({ status: "withdrawn", withdrawReason: "Raised on the wrong record" }) });
    renderAt("/Audits/Findings/f1");
    expect(await screen.findByRole("status")).toHaveTextContent(/Withdrawn.*Raised on the wrong record/);
    expect(screen.queryAllByRole("button", { name: /^(Edit|Close finding|Withdraw|Reopen|Create non-conformance)$/ })).toHaveLength(0);
  });

  it("lets someone who may perform audits, but not manage them, neither reopen nor close", async () => {
    permissions = ["audits.read", "audits.perform"];
    routeApi({ "GET /audit-findings/f1": finding({ status: "closed", closedNote: "Done", closedAt: "2026-11-09T10:00:00Z" }) });
    renderAt("/Audits/Findings/f1");
    await screen.findByRole("status");
    expect(screen.queryByRole("button", { name: "Reopen" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
  });

  it("uploads evidence into the finding's own folder of the record", async () => {
    upload.mockResolvedValue({ path: "org-1/audit/r1/findings/f1/u1-photo.jpg" });
    URL.createObjectURL = vi.fn(() => "blob:preview");
    URL.revokeObjectURL = vi.fn();
    routeApi({ "GET /audit-findings/f1": finding(), "POST /audit-findings/f1/attachments": { id: "x2", findingId: "f1", fileName: "photo.jpg", contentType: "image/jpeg", sizeBytes: 1, storagePath: "org-1/audit/r1/findings/f1/u1-photo.jpg", createdAt: "2026-11-08T10:00:00Z", createdBy: null, deletedAt: null, deleteReason: null } });
    const { container } = renderAt("/Audits/Findings/f1");
    await screen.findByRole("heading", { name: /AF-26-0001/ });
    await userEvent.upload(container.querySelector("input[type=file]"), new File(["x"], "photo.jpg", { type: "image/jpeg" }));
    await userEvent.click(await screen.findByRole("button", { name: /Save upload/ }));
    await waitFor(() => expect(sent("POST /audit-findings/f1/attachments")).toHaveLength(1));
    expect(upload).toHaveBeenCalledWith(expect.any(File), "audit-files", "org-1", "f1", "audit/r1/findings");
    expect(last("POST /audit-findings/f1/attachments").body).toEqual({ storagePath: "org-1/audit/r1/findings/f1/u1-photo.jpg", fileName: "photo.jpg", contentType: "image/jpeg", sizeBytes: 1 });
  });

  it("raises a draft non-conformance with the finding's words, and opens it", async () => {
    routeApi({ "GET /audit-findings/f1": finding(), "POST /audit-findings/f1/create-ncr": { nonconformanceId: "n1", created: true, finding: finding() } });
    renderAt("/Audits/Findings/f1");
    await userEvent.click(await screen.findByRole("button", { name: "Create non-conformance" }));
    const dialog = await screen.findByRole("dialog", { name: "Raise a non-conformance" });
    expect(within(dialog).getByLabelText("Title")).toHaveValue("Work instruction missing");
    expect(within(dialog).getByLabelText("Description")).toHaveValue("Raised from audit AR-26-0001, finding AF-26-0001.");
    await userEvent.click(within(dialog).getByRole("combobox", { name: "Severity" }));
    await userEvent.click(await screen.findByRole("option", { name: "Critical" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Raise non-conformance" }));
    await waitFor(() => expect(last("POST /audit-findings/f1/create-ncr")?.body).toEqual({ title: "Work instruction missing", description: "Raised from audit AR-26-0001, finding AF-26-0001.", severity: "critical" }));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/Non-Conformance/Register/n1"));
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Draft non-conformance raised" }));
  });

  it("says so when the finding already had its non-conformance, and takes the person to it", async () => {
    routeApi({ "GET /audit-findings/f1": finding(), "POST /audit-findings/f1/create-ncr": { nonconformanceId: "n7", created: false, finding: finding() } });
    renderAt("/Audits/Findings/f1");
    await userEvent.click(await screen.findByRole("button", { name: "Create non-conformance" }));
    await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Raise non-conformance" }));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/Non-Conformance/Register/n7"));
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Already raised" }));
    // Nothing was sent that the person did not see: no severity when none was chosen.
    expect(last("POST /audit-findings/f1/create-ncr")?.body).toEqual({ title: "Work instruction missing", description: "Raised from audit AR-26-0001, finding AF-26-0001." });
  });

  it("closes, withdraws and reopens with a reason", async () => {
    routeApi({ "GET /audit-findings/f1": finding(), "POST /audit-findings/f1/close": finding({ status: "closed", closedNote: "Done", closedAt: "2026-11-09T10:00:00Z" }), "POST /audit-findings/f1/withdraw": finding({ status: "withdrawn", withdrawReason: "Oops" }), "POST /audit-findings/f1/reopen": finding() });
    const view = renderAt("/Audits/Findings/f1");
    await userEvent.click(await screen.findByRole("button", { name: "Close finding" }));
    let dialog = await screen.findByRole("dialog", { name: "Close AF-26-0001?" });
    const confirm = within(dialog).getByRole("button", { name: "Close finding" });
    expect(confirm).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText(/How was it resolved/), "Instruction posted");
    await userEvent.click(confirm);
    await waitFor(() => expect(last("POST /audit-findings/f1/close")?.body).toEqual({ note: "Instruction posted" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await userEvent.click(screen.getByRole("button", { name: "Withdraw" }));
    dialog = await screen.findByRole("dialog", { name: "Withdraw AF-26-0001?" });
    await userEvent.type(within(dialog).getByLabelText(/Why was it raised in error/), "Wrong record");
    await userEvent.click(within(dialog).getByRole("button", { name: "Withdraw finding" }));
    await waitFor(() => expect(last("POST /audit-findings/f1/withdraw")?.body).toEqual({ reason: "Wrong record" }));
    view.unmount();

    routeApi({ "GET /audit-findings/f1": finding({ status: "closed", closedNote: "Done", closedAt: "2026-11-09T10:00:00Z" }), "POST /audit-findings/f1/reopen": finding() });
    renderAt("/Audits/Findings/f1");
    await userEvent.click(await screen.findByRole("button", { name: "Reopen" }));
    dialog = await screen.findByRole("dialog", { name: "Reopen AF-26-0001?" });
    await userEvent.type(within(dialog).getByLabelText(/Why is it being reopened/), "Not fixed");
    await userEvent.click(within(dialog).getByRole("button", { name: "Reopen finding" }));
    await waitFor(() => expect(last("POST /audit-findings/f1/reopen")?.body).toEqual({ reason: "Not fixed" }));
  });

  it("edits an open finding, sending what is on screen", async () => {
    routeApi({ "GET /audit-findings/f1": finding(), "PATCH /audit-findings/f1": finding({ title: "Instruction missing at CNC-1" }) });
    renderAt("/Audits/Findings/f1");
    await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit AF-26-0001" });
    expect(within(dialog).getByLabelText("Title")).toHaveValue("Work instruction missing");
    expect(within(dialog).getByLabelText(/What was found/)).toHaveValue("No instruction at the machine");
    expect(within(dialog).getByRole("combobox", { name: /Classification/ })).toHaveValue("Major non-conformity");
    expect(within(dialog).getByRole("combobox", { name: /Owner/ })).toHaveValue("Grace Hopper");
    await userEvent.clear(within(dialog).getByLabelText("Title"));
    await userEvent.type(within(dialog).getByLabelText("Title"), "Instruction missing at CNC-1");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save finding" }));
    await waitFor(() =>
      expect(last("PATCH /audit-findings/f1")?.body).toEqual({
        classificationId: "c-major",
        title: "Instruction missing at CNC-1",
        description: "No instruction at the machine",
        requirement: "Instructions are at every machine",
        ownerId: "e1",
        dueOn: "2026-11-20",
      })
    );
  });

  it("shows the evidence, and lets only someone who may perform audits add to an open finding", async () => {
    routeApi({ "GET /audit-findings/f1": finding(), "GET /audit-findings/f1/attachments": { data: [{ id: "x1", findingId: "f1", fileName: "photo.jpg", contentType: "image/jpeg", sizeBytes: 2048, storagePath: "org-1/audit/r1/findings/f1/u-photo.jpg", createdAt: "2026-11-08T10:00:00Z", createdBy: null, deletedAt: null, deleteReason: null }] } });
    const view = renderAt("/Audits/Findings/f1");
    expect(await screen.findByText("photo.jpg")).toBeInTheDocument();
    expect(screen.getByText(/Drag and drop|Browse|drop/i)).toBeInTheDocument();
    view.unmount();
    permissions = ["audits.read", "audits.perform"];
    routeApi({ "GET /audit-findings/f1": finding({ status: "closed", closedNote: "Done", closedAt: "2026-11-09T10:00:00Z" }), "GET /audit-findings/f1/attachments": { data: [{ id: "x1", findingId: "f1", fileName: "photo.jpg", contentType: "image/jpeg", sizeBytes: 2048, storagePath: "p", createdAt: "2026-11-08T10:00:00Z", createdBy: null, deletedAt: null, deleteReason: null }] } });
    renderAt("/Audits/Findings/f1");
    expect(await screen.findByText("photo.jpg")).toBeInTheDocument();
    expect(screen.queryByText(/Drag and drop/i)).toBeNull();
  });
});

describe("the findings register", () => {
  const page = (rows, total = rows.length) => ({ data: rows, page: 1, pageSize: 25, total });

  it("lists findings with their classification, audit, owner, due date and non-conformance", async () => {
    routeApi({
      "GET /audit-findings": page([
        finding({ ncr: { id: "n9", reference: "NCR-26-0009", stage: "draft" } }),
        finding({ id: "f2", reference: "AF-26-0002", title: "Swarf", classification: { id: "c-obs", key: "observation", label: "Observation", kind: "observation" }, owner: null, dueOn: null, overdue: true, status: "closed" }),
      ]),
    });
    renderAt("/Audits/Findings");
    const table = await screen.findByRole("region", { name: "Audit findings" });
    expect(await within(table).findByRole("link", { name: "AF-26-0001" })).toHaveAttribute("href", "/Audits/Findings/f1");
    expect(within(table).getByText("Work instruction missing")).toBeInTheDocument();
    expect(within(table).getByText("Major non-conformity")).toBeInTheDocument();
    expect(within(table).getAllByRole("link", { name: /AR-26-0001 · Cell audit/ })).toHaveLength(2);
    expect(within(table).getByText("Grace Hopper")).toBeInTheDocument();
    expect(within(table).getByRole("link", { name: "NCR-26-0009" })).toHaveAttribute("href", "/Non-Conformance/Register/n9");
    expect(within(table).getByLabelText("Overdue")).toBeInTheDocument();
    expect(screen.getByText("2 findings")).toBeInTheDocument();
    expect(last("GET /audit-findings").path).toContain("sort=reference&order=desc");
  });

  it("filters by status, classification, kind, owner and audit, and only the overdue, kept in the URL with chips that clear them", async () => {
    routeApi({ "GET /audit-findings": page([finding()]) });
    renderAt("/Audits/Findings");
    await screen.findByRole("link", { name: "AF-26-0001" });
    const choose = async (label, option) => {
      await userEvent.click(screen.getByRole("combobox", { name: label }));
      await userEvent.click(await screen.findByRole("option", { name: new RegExp(`^${option}`) }));
    };
    await choose("Status", "Open");
    await waitFor(() => expect(last("GET /audit-findings").path).toContain("status=open"));
    await choose("Classification", "Major non-conformity");
    await waitFor(() => expect(last("GET /audit-findings").path).toContain("classificationId=c-major"));
    await choose("Kind", "Non-conformity");
    await waitFor(() => expect(last("GET /audit-findings").path).toContain("kind=nonconformity"));
    await choose("Owner", "Alan Turing");
    await waitFor(() => expect(last("GET /audit-findings").path).toContain("ownerId=e2"));
    await choose("Audit", "AUD-001");
    await waitFor(() => expect(last("GET /audit-findings").path).toContain("auditId=a1"));
    await userEvent.click(screen.getByRole("checkbox", { name: "Only overdue findings" }));
    await waitFor(() => expect(last("GET /audit-findings").path).toContain("overdue=true"));
    const url = screen.getByTestId("where").textContent;
    for (const part of ["status=open", "classification=c-major", "kind=nonconformity", "owner=e2", "audit=a1", "overdue=true"]) expect(url).toContain(part);
    const chips = within(screen.getByLabelText("Active filters"));
    expect(chips.getByText("Status: Open")).toBeInTheDocument();
    expect(chips.getByText("Classification: Major non-conformity")).toBeInTheDocument();
    expect(chips.getByText("Owner: Alan Turing")).toBeInTheDocument();
    await userEvent.click(chips.getByRole("button", { name: "Remove filter Status: Open" }));
    await waitFor(() => expect(last("GET /audit-findings").path).not.toContain("status=open"));
    await userEvent.click(chips.getByRole("button", { name: "Clear all" }));
    await waitFor(() => expect(screen.queryByLabelText("Active filters")).toBeNull());
    expect(last("GET /audit-findings").path).not.toContain("classificationId");
  });

  it("starts from a URL with filters already set", async () => {
    routeApi({ "GET /audit-findings": page([]) });
    renderAt("/Audits/Findings?status=open&overdue=true&kind=observation");
    await waitFor(() => expect(last("GET /audit-findings")?.path).toMatch(/status=open/));
    expect(last("GET /audit-findings").path).toContain("overdue=true");
    expect(last("GET /audit-findings").path).toContain("kind=observation");
    expect(screen.getByRole("checkbox", { name: "Only overdue findings" })).toBeChecked();
  });
});

describe("Settings → Audits", () => {
  it("lists the classifications with their kind, default severity and how many findings use each", async () => {
    routeApi();
    renderAt("/Settings/Audits");
    const list = within(await screen.findByRole("list", { name: "Finding classifications" }));
    const items = list.getAllByRole("listitem");
    expect(items).toHaveLength(4);
    expect(items[0]).toHaveTextContent("Major non-conformity");
    expect(items[0]).toHaveTextContent("major_nc");
    expect(items[0]).toHaveTextContent("Severity: Major");
    expect(items[0]).toHaveTextContent("3 findings");
    expect(items[1]).toHaveTextContent("1 finding");
    expect(items[2]).toHaveTextContent("Observation");
    expect(within(items[3]).getByRole("switch")).not.toBeChecked();
    expect(within(items[0]).getByRole("switch")).toBeChecked();
  });

  // The list is fetched once; any refetch after a save waits, so what is on screen is the optimistic change or its rollback.
  const listOnce = () => {
    let gets = 0;
    return () => (gets++ === 0 ? { data: CLASSES } : new Promise(() => {}));
  };

  it("switches one off at once, before the server has answered", async () => {
    routeApi({ "GET /audit-finding-classifications": listOnce(), "PATCH /audit-finding-classifications/c-major": () => new Promise(() => {}) });
    renderAt("/Settings/Audits");
    const sw = await screen.findByRole("switch", { name: "Major non-conformity is in use" });
    expect(sw).toBeChecked();
    await userEvent.click(sw);
    await waitFor(() => expect(screen.getByRole("switch", { name: "Major non-conformity is in use" })).not.toBeChecked());
    expect(last("PATCH /audit-finding-classifications/c-major")?.body).toEqual({ active: false });
  });

  it("puts a switch back when the save fails", async () => {
    let fail;
    routeApi({ "GET /audit-finding-classifications": listOnce(), "PATCH /audit-finding-classifications/c-minor": () => new Promise((_, reject) => (fail = reject)) });
    renderAt("/Settings/Audits");
    await userEvent.click(await screen.findByRole("switch", { name: "Minor non-conformity is in use" }));
    await waitFor(() => expect(screen.getByRole("switch", { name: "Minor non-conformity is in use" })).not.toBeChecked());
    fail(new Error("Nope"));
    await waitFor(() => expect(screen.getByRole("switch", { name: "Minor non-conformity is in use" })).toBeChecked());
  });

  it("says so when a switch could not be saved", async () => {
    routeApi({
      "PATCH /audit-finding-classifications/c-minor": () => {
        throw new Error("Nope");
      },
    });
    renderAt("/Settings/Audits");
    await userEvent.click(await screen.findByRole("switch", { name: "Minor non-conformity is in use" }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ type: "error", title: "Not saved", message: "Nope" })));
  });

  it("adds a classification with a key worked out from its name, and only a non-conformity has a default severity", async () => {
    routeApi({ "POST /audit-finding-classifications": { ...CLASSES[0], id: "c-new", key: "critical_nonconformity", label: "Critical nonconformity" } });
    renderAt("/Settings/Audits");
    await userEvent.click(await screen.findByRole("button", { name: /Add classification/ }));
    const dialog = await screen.findByRole("dialog", { name: "Add a classification" });
    expect(within(dialog).getByRole("button", { name: "Add classification" })).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText(/^Name/), "Critical nonconformity");
    expect(within(dialog).getByLabelText(/^Key/)).toHaveValue("critical_nonconformity");
    await userEvent.click(within(dialog).getByRole("combobox", { name: /Default severity/ }));
    await userEvent.click(await screen.findByRole("option", { name: "Critical" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Add classification" }));
    await waitFor(() => expect(last("POST /audit-finding-classifications")?.body).toEqual({ key: "critical_nonconformity", label: "Critical nonconformity", kind: "nonconformity", defaultSeverity: "critical" }));
  });

  it("sends no severity for an observation", async () => {
    routeApi({ "POST /audit-finding-classifications": { ...CLASSES[2], id: "c-new" } });
    renderAt("/Settings/Audits");
    await userEvent.click(await screen.findByRole("button", { name: /Add classification/ }));
    const dialog = await screen.findByRole("dialog", { name: "Add a classification" });
    await userEvent.type(within(dialog).getByLabelText(/^Name/), "Note");
    await userEvent.click(within(dialog).getByRole("combobox", { name: /^Kind/ }));
    await userEvent.click(await screen.findByRole("option", { name: /^Observation/ }));
    expect(within(dialog).queryByRole("combobox", { name: /Default severity/ })).toBeNull();
    await userEvent.click(within(dialog).getByRole("button", { name: "Add classification" }));
    await waitFor(() => expect(last("POST /audit-finding-classifications")?.body).toEqual({ key: "note", label: "Note", kind: "observation", defaultSeverity: null }));
  });

  it("drops a severity chosen for a non-conformity when the kind is changed to an observation", async () => {
    routeApi({ "POST /audit-finding-classifications": { ...CLASSES[2], id: "c-new" } });
    renderAt("/Settings/Audits");
    await userEvent.click(await screen.findByRole("button", { name: /Add classification/ }));
    const dialog = await screen.findByRole("dialog", { name: "Add a classification" });
    await userEvent.type(within(dialog).getByLabelText(/^Name/), "Note");
    await userEvent.click(within(dialog).getByRole("combobox", { name: /Default severity/ }));
    await userEvent.click(await screen.findByRole("option", { name: "Critical" }));
    await userEvent.click(within(dialog).getByRole("combobox", { name: /^Kind/ }));
    await userEvent.click(await screen.findByRole("option", { name: /^Observation/ }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Add classification" }));
    await waitFor(() => expect(last("POST /audit-finding-classifications")?.body).toEqual({ key: "note", label: "Note", kind: "observation", defaultSeverity: null }));
  });

  it("renames one and sets its severity, but the kind cannot be changed", async () => {
    routeApi({ "PATCH /audit-finding-classifications/c-minor": { ...CLASSES[1], label: "Minor NC" } });
    renderAt("/Settings/Audits");
    await userEvent.click(await screen.findByRole("button", { name: "Edit Minor non-conformity" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit Minor non-conformity" });
    expect(within(dialog).getByRole("combobox", { name: /^Kind/ })).toBeDisabled();
    expect(within(dialog).queryByLabelText(/^Key/)).toBeNull();
    await userEvent.clear(within(dialog).getByLabelText(/^Name/));
    await userEvent.type(within(dialog).getByLabelText(/^Name/), "Minor NC");
    await userEvent.click(within(dialog).getByRole("combobox", { name: /Default severity/ }));
    await userEvent.click(await screen.findByRole("option", { name: "Major" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(last("PATCH /audit-finding-classifications/c-minor")?.body).toEqual({ label: "Minor NC", defaultSeverity: "major" }));
  });

  it("is read-only without audits.manage", async () => {
    permissions = ["audits.read"];
    routeApi();
    renderAt("/Settings/Audits");
    await screen.findByRole("list", { name: "Finding classifications" });
    expect(screen.queryByRole("button", { name: /Add classification/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Edit / })).toBeNull();
    expect(screen.getAllByRole("switch").every((s) => s.disabled)).toBe(true);
  });
});

describe("the audit behind a non-conformance", () => {
  const source = (over = {}) => ({
    available: true,
    items: [
      {
        record: { id: "r1", reference: "AR-26-0001", status: "completed", performedOn: "2026-11-08", audit: { id: "a1", reference: "AUD-001", title: "Cell audit" } },
        finding: { id: "f1", reference: "AF-26-0001", title: "Work instruction missing", status: "open", classification: { label: "Major non-conformity", kind: "nonconformity" } },
        answers: [{ sequence: 1, question: "Is the work instruction at the machine?", result: "fail", note: "Missing at the machine" }],
        files: [{ id: "x1", fileName: "photo.jpg", contentType: "image/jpeg", sizeBytes: 100, storagePath: "p" }],
      },
      {
        record: { id: "r2", reference: "AR-26-0002", status: "completed", performedOn: "2026-11-01", audit: { id: "a1", reference: "AUD-001", title: "Cell audit" } },
        finding: null,
        answers: [{ sequence: 2, question: "Is the floor clear?", result: "fail", note: null }],
        files: [],
      },
    ],
    ...over,
  });

  it("shows the audit record, the finding with its classification, the answers and the evidence", () => {
    render(
      <MemoryRouter>
        <NcrAuditSource source={source()} />
      </MemoryRouter>
    );
    expect(screen.getByRole("link", { name: "AR-26-0001" })).toHaveAttribute("href", "/Audits/Records/r1");
    expect(screen.getByRole("link", { name: "AF-26-0001" })).toHaveAttribute("href", "/Audits/Findings/f1");
    expect(screen.getByText("Major non-conformity")).toBeInTheDocument();
    expect(screen.getByText("Open")).toBeInTheDocument();
    const answers = screen.getByRole("list", { name: "Answers behind this NC from AR-26-0001" });
    expect(answers).toHaveTextContent("Question 1: Is the work instruction at the machine?");
    expect(answers).toHaveTextContent("Missing at the machine");
    expect(within(screen.getByRole("list", { name: "Evidence from the finding" })).getAllByRole("listitem")).toHaveLength(1);
  });

  it("shows an NC raised straight from answers, before findings existed, by its record and answers only", () => {
    render(
      <MemoryRouter>
        <NcrAuditSource source={source()} />
      </MemoryRouter>
    );
    expect(screen.getByRole("link", { name: "AR-26-0002" })).toBeInTheDocument();
    const legacy = screen.getByRole("list", { name: "Answers behind this NC from AR-26-0002" });
    expect(legacy).toHaveTextContent("Question 2: Is the floor clear?");
    expect(screen.getAllByRole("link", { name: /^AF-/ })).toHaveLength(1);
  });
});
