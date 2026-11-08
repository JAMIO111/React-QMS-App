import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

let permissions;
const apiFetch = vi.fn();
vi.mock("../../lib/api-client", async (importOriginal) => ({ ...(await importOriginal()), apiFetch: (...a) => apiFetch(...a) }));
vi.mock("../../contexts/OrganisationProvider", () => ({ useOrganisation: () => ({ organisationId: "org-1" }) }));
vi.mock("../../contexts/ToastProvider", () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock("../../contexts/SearchProvider", () => ({ useGlobalSearch: () => ({ debouncedSearchTerm: "", setSearchTerm: vi.fn() }) }));
vi.mock("../../hooks/useQmsApi", () => ({
  usePermissions: () => ({ can: (p) => permissions.includes(p) }),
  useAllDepartments: () => ({ data: { data: [{ id: "d1", code: "MACH", name: "Machining" }] } }),
  useMembers: () => ({ data: { data: [{ membershipId: "m1", userId: "u1", firstName: "Ines", surname: "Inspector", email: "i@x.test", status: "active" }] } }),
  useRoles: () => ({ data: { data: [{ id: "r1", key: "inspector", name: "Inspector" }] } }),
}));

import AuditForm from "./AuditForm";
import AuditPage from "./AuditPage";
import AuditsPage from "./AuditsPage";

const summary = (over = {}) => ({
  id: "a1",
  reference: "AUD-001",
  title: "Layered process audit, CNC cell",
  auditType: "layered_process",
  frequency: { kind: "weekly", interval: null, firstDueOn: "2026-11-09" },
  auditor: { kind: "none", id: null, name: null },
  passMark: 95,
  status: "active",
  questionCount: 2,
  criticalCount: 1,
  lastRecord: null,
  nextDueOn: null,
  targets: { machines: 1, operations: 1, departments: 0, preview: ["CNC-1", "OP-20"] },
  createdAt: "2026-11-01T09:00:00Z",
  ...over,
});
const detail = (over = {}) => {
  const { targets: _t, ...base } = summary();
  return {
    ...base,
    purpose: "Check the basics every week",
    procedure: "1. Walk the cell.\n2. Check each item.",
    graceDays: 2,
    weekdaysOnly: true,
    retired: null,
    questions: [
      { id: "q1", sequence: 1, question: "Is the cell clean?", guidance: "Floor, bench, machine", answerType: "pass_fail", passAnswer: null, unit: null, lowerLimit: null, upperLimit: null, nominal: null, options: null, ratingMax: null, passRating: null, critical: true },
      { id: "q2", sequence: 2, question: "Coolant concentration", guidance: null, answerType: "numeric", passAnswer: null, unit: "%", lowerLimit: 6, upperLimit: 9, nominal: null, options: null, ratingMax: null, passRating: null, critical: false },
    ],
    targets: [{ kind: "machine", id: "m1", label: "CNC-1 · Lathe" }, { kind: "operation", id: "OP-20", label: "OP-20" }],
    createdBy: { id: "u9", name: "Ada Owner" },
    updatedAt: "2026-11-02T09:00:00Z",
    ...over,
  };
};

const calls = [];
let routes;
const routeApi = (extra = {}) => {
  routes = {
    "GET /machines": { data: [{ id: "m1", code: "CNC-1", name: "Lathe" }, { id: "m2", code: "CNC-2", name: "Mill" }], nextCursor: null },
    "GET /audits/operation-codes": { data: [{ code: "OP-20", name: "Rough turn" }, { code: "OP-30", name: null }] },
    ...extra,
  };
  apiFetch.mockImplementation(async (path, opts = {}) => {
    const k = `${opts.method ?? "GET"} ${path.split("?")[0]}`;
    calls.push({ k, path, body: opts.body });
    if (!(k in routes)) throw new Error(`unexpected ${k}`);
    const r = routes[k];
    return typeof r === "function" ? r(opts.body) : r;
  });
};
const sent = (k) => calls.filter((c) => c.k === k);
const lastList = () => calls.filter((c) => c.k === "GET /audits").at(-1);

const Where = () => {
  const l = useLocation();
  return <p data-testid="where">{l.pathname + l.search}</p>;
};
const renderAt = (url) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="/Documentation/Audits" element={<><AuditsPage /><Where /></>} />
          <Route path="/Documentation/Audits/new" element={<><AuditForm /><Where /></>} />
          <Route path="/Documentation/Audits/:id" element={<><AuditPage /><Where /></>} />
          <Route path="/Documentation/Audits/:id/edit" element={<><AuditForm /><Where /></>} />
          <Route path="/Documentation/Audit-Records/:id" element={<Where />} />
        </Routes>
        <div id="modal-root" />
      </MemoryRouter>
    </QueryClientProvider>
  );

beforeEach(() => {
  permissions = ["audits.read", "audits.manage", "audits.perform"];
  calls.length = 0;
  apiFetch.mockReset();
});

describe("audits register", () => {
  it("lists the audits with what each is relevant to, its frequency and questions, and a count", async () => {
    routeApi({ "GET /audits": { data: [summary(), summary({ id: "a2", reference: "AUD-002", title: "Monthly 5S", auditType: "housekeeping", frequency: { kind: "every_n_days", interval: 10, firstDueOn: "2026-11-16" }, status: "retired", questionCount: 5, criticalCount: 0, targets: { machines: 0, operations: 0, departments: 0, preview: [] } })], page: 1, pageSize: 25, total: 2 } });
    renderAt("/Documentation/Audits");
    const table = await screen.findByRole("region", { name: "Audits" });
    expect(await within(table).findByRole("link", { name: "AUD-001" })).toHaveAttribute("href", "/Documentation/Audits/a1");
    expect(within(table).getByText("1 machine, 1 operation (CNC-1, OP-20)")).toBeInTheDocument();
    expect(within(table).getByText("Every week")).toBeInTheDocument();
    expect(within(table).getByText("Every 10 days")).toBeInTheDocument();
    expect(within(table).getByText("Layered process audit")).toBeInTheDocument();
    expect(within(table).getByText("Retired")).toBeInTheDocument();
    expect(screen.getByText("2 audits")).toBeInTheDocument();
    expect(lastList().path).toContain("sort=reference&order=asc");
  });

  it("shows when each audit was last done, with its result, and when it is next due, marking one that is overdue", async () => {
    routeApi({
      "GET /audits": {
        data: [
          summary({ lastRecord: { id: "r1", reference: "AR-26-0001", performedOn: "2026-11-02", result: "fail" }, nextDueOn: "2099-01-05" }),
          summary({ id: "a2", reference: "AUD-002", title: "Monthly 5S", lastRecord: null, nextDueOn: "2020-01-06" }),
          summary({ id: "a3", reference: "AUD-003", title: "On demand", lastRecord: { id: "r3", reference: "AR-26-0003", performedOn: "2026-10-01", result: "pass" }, nextDueOn: null }),
        ],
        page: 1,
        pageSize: 25,
        total: 3,
      },
    });
    renderAt("/Documentation/Audits");
    const table = await screen.findByRole("region", { name: "Audits" });
    const rows = await within(table).findAllByRole("row");
    const body = rows.slice(1);
    expect(within(body[0]).getByRole("link", { name: /Nov 2026/ })).toHaveAttribute("href", "/Documentation/Audit-Records/r1");
    expect(within(body[0]).getByText("Fail")).toBeInTheDocument();
    expect(within(body[0]).getByText(/Jan 2099$/)).toBeInTheDocument();
    expect(within(body[0]).queryByText(/overdue/)).toBeNull();
    expect(within(body[1]).getByText("Never")).toBeInTheDocument();
    expect(within(body[1]).getByText(/Jan 2020 \(overdue\)/)).toBeInTheDocument();
    expect(within(body[2]).getByText("Pass")).toBeInTheDocument();
  });

  it("offers New audit only to people who manage audits", async () => {
    routeApi({ "GET /audits": { data: [], page: 1, pageSize: 25, total: 0 } });
    const { unmount } = renderAt("/Documentation/Audits");
    expect(await screen.findByRole("button", { name: /New audit/ })).toBeInTheDocument();
    unmount();
    permissions = ["audits.read"];
    renderAt("/Documentation/Audits");
    await screen.findByText("0 audits");
    expect(screen.queryByRole("button", { name: /New audit/ })).toBeNull();
  });

  it("filters by type, status and machine, kept in the URL with chips that clear them", async () => {
    routeApi({ "GET /audits": { data: [], page: 1, pageSize: 25, total: 0 } });
    renderAt("/Documentation/Audits");
    await screen.findByText("0 audits");
    await userEvent.selectOptions(screen.getByLabelText("Type"), "housekeeping");
    await userEvent.selectOptions(screen.getByLabelText("Status"), "retired");
    await userEvent.selectOptions(await screen.findByRole("option", { name: "CNC-1 · Lathe" }).then((o) => o.closest("select")), "m1");
    await waitFor(() => expect(lastList().path).toContain("machineId=m1"));
    expect(lastList().path).toContain("type=housekeeping");
    expect(lastList().path).toContain("status=retired");
    expect(screen.getByTestId("where")).toHaveTextContent("type=housekeeping");
    const active = screen.getByLabelText("Active filters");
    expect(active).toHaveTextContent("Type: Housekeeping / 5S");
    expect(active).toHaveTextContent("Machine: CNC-1");
    await userEvent.click(within(active).getByRole("button", { name: "Remove filter Status: Retired" }));
    await waitFor(() => expect(lastList().path).not.toContain("status="));
    await userEvent.click(within(screen.getByLabelText("Active filters")).getByRole("button", { name: "Clear all" }));
    await waitFor(() => expect(lastList().path).not.toContain("machineId"));
    expect(screen.queryByLabelText("Active filters")).toBeNull();
  });
});

describe("audit page", () => {
  it("shows the facts, what it is relevant to, the procedure and the checklist with critical questions and limits", async () => {
    routeApi({ "GET /audits/a1": detail() });
    renderAt("/Documentation/Audits/a1");
    expect(await screen.findByRole("heading", { name: /AUD-001 · Layered process audit, CNC cell/ })).toBeInTheDocument();
    expect(screen.getByText("Every week")).toBeInTheDocument();
    expect(screen.getByText("2 days, weekdays only")).toBeInTheDocument();
    expect(screen.getByText("95% and every critical question")).toBeInTheDocument();
    expect(screen.getByText("2 (1 critical)")).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "Machines" })).getByText("CNC-1 · Lathe")).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "Operations" })).getByText("OP-20")).toBeInTheDocument();
    expect(screen.getByText(/1\. Walk the cell\./)).toBeInTheDocument();
    const list = screen.getByRole("list", { name: "Checklist" });
    expect(within(list).getByText("Critical")).toBeInTheDocument();
    expect(within(list).getByText(/passes 6 to 9 %/)).toBeInTheDocument();
    expect(within(list).getByText("Floor, bench, machine")).toBeInTheDocument();
  });

  it("shows when it was last done and is next due, and starts an audit for people who may perform audits", async () => {
    routeApi({
      "GET /audits/a1": detail({ lastRecord: { id: "r1", reference: "AR-26-0001", performedOn: "2026-11-02", result: "pass" }, nextDueOn: "2026-11-16" }),
      "POST /audit-records": { id: "r7", reference: "AR-26-0007" },
    });
    const { unmount } = renderAt("/Documentation/Audits/a1");
    expect(await screen.findByRole("link", { name: /Nov 2026: Pass/ })).toHaveAttribute("href", "/Documentation/Audit-Records/r1");
    expect(screen.getByText(/16 Nov 2026/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Audit records" })).toHaveAttribute("href", "/Documentation/Audit-Records?audit=a1");
    expect(screen.getByRole("link", { name: "Schedule" })).toHaveAttribute("href", "/Documentation/Audit-Schedule?audit=a1");
    await userEvent.click(screen.getByRole("button", { name: /Start audit/ }));
    await waitFor(() => expect(sent("POST /audit-records")[0]?.body).toEqual({ auditId: "a1" }));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/Documentation/Audit-Records/r7"));
    unmount();
    permissions = ["audits.read", "audits.manage"];
    renderAt("/Documentation/Audits/a1");
    await screen.findByRole("heading", { name: /AUD-001/ });
    expect(screen.queryByRole("button", { name: /Start audit/ })).toBeNull();
  });

  it("does not offer to start a retired audit", async () => {
    routeApi({ "GET /audits/a1": detail({ status: "retired", retired: { at: "2026-11-03T09:00:00Z", by: null, reason: "Replaced" } }) });
    renderAt("/Documentation/Audits/a1");
    await screen.findByRole("heading", { name: /AUD-001/ });
    expect(screen.queryByRole("button", { name: /Start audit/ })).toBeNull();
  });

  it("lets managers edit and retire with a reason, and shows the retirement afterwards", async () => {
    routeApi({ "GET /audits/a1": detail(), "POST /audits/a1/retire": detail({ status: "retired" }) });
    renderAt("/Documentation/Audits/a1");
    expect(await screen.findByRole("link", { name: /Edit/ })).toHaveAttribute("href", "/Documentation/Audits/a1/edit");
    await userEvent.click(screen.getByRole("button", { name: "Retire" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "Retire audit" })).toBeDisabled();
    await userEvent.type(within(dialog).getByRole("textbox"), "Replaced");
    await userEvent.click(within(dialog).getByRole("button", { name: "Retire audit" }));
    await waitFor(() => expect(sent("POST /audits/a1/retire")).toHaveLength(1));
    expect(sent("POST /audits/a1/retire")[0].body).toEqual({ reason: "Replaced" });
  });

  it("shows a retired audit with its reason and a Reactivate button, and no editing without manage rights", async () => {
    routeApi({ "GET /audits/a1": detail({ status: "retired", retired: { at: "2026-11-05T09:00:00Z", by: { id: "u9", name: "Ada Owner" }, reason: "Replaced by the LPA" } }), "POST /audits/a1/reactivate": detail() });
    const { unmount } = renderAt("/Documentation/Audits/a1");
    expect(await screen.findByText(/Replaced by the LPA/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Reactivate" }));
    await waitFor(() => expect(sent("POST /audits/a1/reactivate")).toHaveLength(1));
    unmount();
    permissions = ["audits.read"];
    renderAt("/Documentation/Audits/a1");
    await screen.findByRole("heading", { name: /AUD-001/ });
    expect(screen.queryByRole("link", { name: /Edit/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Retire|Reactivate/ })).toBeNull();
  });
});

const pick = async (name, option, scope = screen) => {
  await userEvent.click(scope.getByRole("combobox", { name }));
  await userEvent.click(await screen.findByRole("option", { name: new RegExp(`^${option.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?! /)`) }));
};
const addQuestion = async (text, type) => {
  await userEvent.click(screen.getByRole("button", { name: /Add a question/ }));
  const items = screen.getAllByRole("listitem").filter((li) => /^Question \d+$/.test(li.getAttribute("aria-label") ?? ""));
  const q = within(items.at(-1));
  await userEvent.type(q.getByLabelText(/^Question/), text);
  if (type) await pick("Answered with", type, q);
  return q;
};
const fillFirstDue = async () => {
  await userEvent.click(screen.getByRole("button", { name: /^First due/ }));
  await userEvent.click(within(await screen.findByRole("dialog", { name: "Choose first due" })).getAllByRole("button", { name: /\d{4}$/ })[0]);
};
const saved = () => sent("POST /audits")[0].body;

describe("audit form", () => {
  it("lists what is still needed and sends nothing until it is there", async () => {
    routeApi();
    renderAt("/Documentation/Audits/new");
    await screen.findByRole("heading", { name: "Define an audit" });
    await userEvent.click(screen.getByRole("button", { name: "Define audit" }));
    const needed = await screen.findByRole("alert", { name: "Still needed" });
    expect(within(needed).getByText("Give the audit a title")).toBeInTheDocument();
    expect(within(needed).getByText("Give the first due date")).toBeInTheDocument();
    expect(sent("POST /audits")).toHaveLength(0);
  });

  it("uses the custom combo box for every drop-down: there is no native select in the form", async () => {
    routeApi();
    const { container } = renderAt("/Documentation/Audits/new");
    await screen.findByRole("heading", { name: "Define an audit" });
    await addQuestion("Q", "Rating");
    expect(container.querySelectorAll("select")).toHaveLength(0);
    for (const name of ["Type", "How often", "Expected auditor", "Add a machine", "Add an operation", "Add a department", "Answered with", "Scale", "Lowest acceptable rating"]) {
      expect(screen.getByRole("combobox", { name })).toBeInTheDocument();
    }
  });

  it("offers the ten response types, each with an example of the question it suits", async () => {
    routeApi();
    renderAt("/Documentation/Audits/new");
    await screen.findByRole("heading", { name: "Define an audit" });
    await userEvent.click(screen.getByRole("button", { name: /Add a question/ }));
    await userEvent.click(screen.getByRole("combobox", { name: "Answered with" }));
    const options = (await screen.findAllByRole("option")).map((o) => o.textContent);
    expect(options).toEqual([
      "Yes / NoIs the procedure being followed?",
      "Compliant / Non-compliantDoes the process meet requirements?",
      "Pass / FailDoes the product meet specifications?",
      "Yes / No / N/AIs the requirement applicable?",
      "NumericWhat was the measured temperature?",
      "TextDescribe the observation",
      "Multiple choiceSelect applicable condition",
      "MeasurementEnter actual dimensional measurement",
      "Evidence requiredUpload photograph/document",
      "RatingScore from 1–5",
    ]);
  });

  it("defines an audit: the procedure, what it is relevant to chosen from drop-downs, who is expected, the schedule and a checklist", async () => {
    routeApi({ "POST /audits": () => ({ ...detail(), id: "new1", reference: "AUD-003" }), "GET /audits/new1": detail() });
    renderAt("/Documentation/Audits/new");
    await screen.findByRole("heading", { name: "Define an audit" });
    await userEvent.type(screen.getByLabelText(/^Title/), "Weekly LPA");
    await pick("Type", "Layered process audit");
    await userEvent.clear(screen.getByLabelText(/^Pass mark/));
    await userEvent.type(screen.getByLabelText(/^Pass mark/), "90");
    await pick("How often", "Every N days");
    await userEvent.type(screen.getByLabelText(/^Number of days/), "10");
    await userEvent.type(screen.getByRole("textbox", { name: /^Procedure/ }), "Walk the cell");
    await pick("Add a machine", "CNC-1 · Lathe");
    await pick("Add a machine", "CNC-2 · Mill");
    await pick("Add an operation", "OP-20");
    await pick("Add a department", "MACH · Machining");
    expect(within(screen.getByRole("list", { name: "Machines" })).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["CNC-1 · Lathe", "CNC-2 · Mill"]);
    expect(within(screen.getByRole("list", { name: "Operations" })).getByText("OP-20")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Remove machine CNC-2 · Mill" }));
    expect(within(screen.getByRole("list", { name: "Machines" })).queryByText("CNC-2 · Mill")).toBeNull();
    // A chosen one is not offered again.
    await userEvent.click(screen.getByRole("combobox", { name: "Add a machine" }));
    expect(await screen.findByRole("option", { name: "CNC-2 · Mill" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "CNC-1 · Lathe" })).toBeNull();
    await userEvent.keyboard("{Escape}");
    await pick("Expected auditor", "A named person");
    await pick("Person", "Ines Inspector");

    const q1 = await addQuestion("Is the cell clean?");
    await userEvent.click(q1.getByLabelText(/Critical/));
    const q2 = await addQuestion("Coolant concentration", "Numeric");
    await userEvent.type(q2.getByLabelText("Lower limit"), "6");
    await userEvent.type(q2.getByLabelText("Upper limit"), "9");
    await userEvent.type(q2.getByLabelText("Unit"), "%");
    const q3 = await addQuestion("Sheet signed?", "Yes / No");
    await pick("Passes with", "No", q3);

    await userEvent.click(screen.getByRole("button", { name: "Define audit" }));
    expect(await screen.findByText("Give the first due date")).toBeInTheDocument();
    expect(sent("POST /audits")).toHaveLength(0);
    await fillFirstDue();
    await userEvent.click(screen.getByRole("button", { name: "Define audit" }));
    await waitFor(() => expect(sent("POST /audits")).toHaveLength(1));
    expect(saved()).toMatchObject({
      title: "Weekly LPA",
      auditType: "layered_process",
      passMark: 90,
      graceDays: 0,
      weekdaysOnly: false,
      procedure: "Walk the cell",
      purpose: null,
      frequency: { kind: "every_n_days", interval: 10, firstDueOn: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) },
      auditor: { kind: "person", userId: "u1" },
    });
    expect(saved().questions).toEqual([
      { question: "Is the cell clean?", guidance: null, answerType: "pass_fail", critical: true },
      { question: "Coolant concentration", guidance: null, answerType: "numeric", unit: "%", lowerLimit: 6, upperLimit: 9, critical: false },
      { question: "Sheet signed?", guidance: null, answerType: "yes_no", passAnswer: "no", critical: false },
    ]);
    expect(saved().targets).toEqual([{ kind: "machine", machineId: "m1" }, { kind: "operation", operationCode: "OP-20" }, { kind: "department", departmentId: "d1" }]);
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/Documentation/Audits/new1"));
  });

  it("needs no first due date for an audit done on demand", async () => {
    routeApi({ "POST /audits": () => ({ ...detail(), id: "new1" }), "GET /audits/new1": detail() });
    renderAt("/Documentation/Audits/new");
    await userEvent.type(await screen.findByLabelText(/^Title/), "On request");
    await pick("How often", "On demand");
    expect(screen.queryByLabelText(/^First due/)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Define audit" }));
    await waitFor(() => expect(sent("POST /audits")).toHaveLength(1));
    expect(saved().frequency).toEqual({ kind: "on_demand" });
  });

  describe("what each response type asks the template for", () => {
    const start = async () => {
      routeApi({ "POST /audits": () => ({ ...detail(), id: "new1" }), "GET /audits/new1": detail() });
      renderAt("/Documentation/Audits/new");
      await userEvent.type(await screen.findByLabelText(/^Title/), "Types");
      await pick("How often", "On demand");
    };
    const save = async () => {
      await userEvent.click(screen.getByRole("button", { name: "Define audit" }));
      await waitFor(() => expect(sent("POST /audits")).toHaveLength(1));
      return saved().questions;
    };

    it("yes / no and yes / no / N/A: which answer passes", async () => {
      await start();
      const a = await addQuestion("Followed?", "Yes / No");
      expect(a.getByRole("combobox", { name: "Passes with" })).toBeInTheDocument();
      const b = await addQuestion("Applicable?", "Yes / No / N/A");
      await pick("Passes with", "No", b);
      expect(await save()).toEqual([
        { question: "Followed?", guidance: null, answerType: "yes_no", passAnswer: "yes", critical: false },
        { question: "Applicable?", guidance: null, answerType: "yes_no_na", passAnswer: "no", critical: false },
      ]);
    });

    it("compliant / non-compliant and pass / fail need nothing more", async () => {
      await start();
      const a = await addQuestion("Meets requirements?", "Compliant / Non-compliant");
      expect(a.queryByRole("combobox", { name: "Passes with" })).toBeNull();
      await userEvent.click(a.getByLabelText(/Critical/));
      await addQuestion("Meets spec?", "Pass / Fail");
      expect(await save()).toEqual([
        { question: "Meets requirements?", guidance: null, answerType: "compliant", critical: true },
        { question: "Meets spec?", guidance: null, answerType: "pass_fail", critical: false },
      ]);
    });

    it("numeric: a unit and optional limits; it can be critical only once a limit makes it able to fail", async () => {
      await start();
      const q = await addQuestion("Temperature", "Numeric");
      expect(q.queryByLabelText(/Critical/)).toBeNull();
      await userEvent.type(q.getByLabelText("Unit"), "C");
      await userEvent.type(q.getByLabelText("Upper limit"), "80");
      await userEvent.click(q.getByLabelText(/Critical/));
      expect(await save()).toEqual([{ question: "Temperature", guidance: null, answerType: "numeric", unit: "C", lowerLimit: null, upperLimit: 80, critical: true }]);
    });

    it("text and evidence: nothing to set, never critical", async () => {
      await start();
      const t = await addQuestion("Describe", "Text");
      expect(t.queryByLabelText(/Critical/)).toBeNull();
      const e = await addQuestion("Photograph", "Evidence required");
      expect(e.queryByLabelText(/Critical/)).toBeNull();
      expect(e.getByText(/must add at least one photograph or document/)).toBeInTheDocument();
      expect(await save()).toEqual([
        { question: "Describe", guidance: null, answerType: "text", critical: false },
        { question: "Photograph", guidance: null, answerType: "evidence", critical: false },
      ]);
    });

    it("measurement: nominal, tolerance both ways and a unit, with the limits worked out and shown", async () => {
      await start();
      const q = await addQuestion("Diameter", "Measurement");
      await userEvent.type(q.getByLabelText(/^Nominal/), "10");
      await userEvent.type(q.getByLabelText(/^Tolerance −/), "0.05");
      await userEvent.type(q.getByLabelText(/^Tolerance \+/), "0.1");
      await userEvent.type(q.getByLabelText(/^Unit/), "mm");
      expect(q.getByText("Passes from 9.95 to 10.1 mm")).toBeInTheDocument();
      await userEvent.click(q.getByLabelText(/Critical/));
      expect(await save()).toEqual([{ question: "Diameter", guidance: null, answerType: "measurement", unit: "mm", nominal: 10, lowerLimit: 9.95, upperLimit: 10.1, critical: true }]);
    });

    it("multiple choice: the options, each marked acceptable or not, at least two", async () => {
      await start();
      const q = await addQuestion("Condition", "Multiple choice");
      expect(within(q.getByRole("list", { name: "Options of question 1" })).getAllByRole("listitem")).toHaveLength(2);
      expect(q.getByRole("button", { name: "Remove option 1" })).toBeDisabled();
      await userEvent.type(q.getByLabelText("Option 1"), "Clean");
      await userEvent.type(q.getByLabelText("Option 2"), "Oily");
      await userEvent.click(q.getByLabelText("Option 2 is acceptable"));
      await userEvent.click(q.getByRole("button", { name: "Add an option" }));
      await userEvent.type(q.getByLabelText("Option 3"), "Dusty");
      expect(await save()).toEqual([
        {
          question: "Condition",
          guidance: null,
          answerType: "multiple_choice",
          options: [{ label: "Clean", passes: true }, { label: "Oily", passes: false }, { label: "Dusty", passes: true }],
          critical: false,
        },
      ]);
    });

    it("rating: a scale of 3 to 10 (5 unless chosen) and an optional lowest acceptable rating", async () => {
      await start();
      const q = await addQuestion("Housekeeping", "Rating");
      expect(q.getByRole("combobox", { name: "Scale" })).toHaveValue("1 to 5");
      expect(q.queryByLabelText(/Critical/)).toBeNull();
      await pick("Scale", "1 to 7", q);
      await pick("Lowest acceptable rating", "3", q);
      await userEvent.click(q.getByLabelText(/Critical/));
      expect(await save()).toEqual([{ question: "Housekeeping", guidance: null, answerType: "rating", ratingMax: 7, passRating: 3, critical: true }]);
    });

    it("a lowest acceptable rating that falls off a narrower scale is dropped, and the question stops being scored", async () => {
      await start();
      const q = await addQuestion("Housekeeping", "Rating");
      await pick("Scale", "1 to 7", q);
      await pick("Lowest acceptable rating", "5", q);
      expect(q.getByLabelText(/Critical/)).toBeInTheDocument();
      await pick("Scale", "1 to 3", q);
      expect(q.getByRole("combobox", { name: "Lowest acceptable rating" })).toHaveValue("");
      expect(q.queryByLabelText(/Critical/)).toBeNull();
      expect(await save()).toEqual([{ question: "Housekeeping", guidance: null, answerType: "rating", ratingMax: 3, passRating: null, critical: false }]);
    });

    it("a required drop-down cannot be cleared, an optional one can", async () => {
      await start();
      expect(screen.queryByRole("button", { name: "Clear Type" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Clear How often" })).toBeNull();
      const q = await addQuestion("Housekeeping", "Rating");
      expect(q.queryByRole("button", { name: "Clear Answered with" })).toBeNull();
      expect(q.queryByRole("button", { name: "Clear Lowest acceptable rating" })).toBeNull();
      await pick("Lowest acceptable rating", "3", q);
      await userEvent.click(q.getByRole("button", { name: "Clear Lowest acceptable rating" }));
      expect(q.getByRole("combobox", { name: "Lowest acceptable rating" })).toHaveValue("");
    });

    it("changing the type keeps what is still meaningful and drops critical when the question can no longer fail", async () => {
      await start();
      const q = await addQuestion("Followed?", "Pass / Fail");
      await userEvent.click(q.getByLabelText(/Critical/));
      await pick("Answered with", "Text", q);
      expect(q.queryByLabelText(/Critical/)).toBeNull();
      await pick("Answered with", "Pass / Fail", q);
      expect(q.getByLabelText(/Critical/)).not.toBeChecked();
    });
  });

  it("says what is wrong with a question in words: no words, limits the wrong way round, an unfinished measurement, repeated options", async () => {
    routeApi();
    renderAt("/Documentation/Audits/new");
    await userEvent.type(await screen.findByLabelText(/^Title/), "x");
    await pick("How often", "On demand");
    await userEvent.click(screen.getByRole("button", { name: /Add a question/ }));
    const n = await addQuestion("Limits", "Numeric");
    await userEvent.type(n.getByLabelText("Lower limit"), "9");
    await userEvent.type(n.getByLabelText("Upper limit"), "1");
    const m = await addQuestion("Diameter", "Measurement");
    await userEvent.type(m.getByLabelText(/^Nominal/), "10");
    const c = await addQuestion("Condition", "Multiple choice");
    await userEvent.type(c.getByLabelText("Option 1"), "Same");
    await userEvent.type(c.getByLabelText("Option 2"), " same ");
    await userEvent.click(screen.getByRole("button", { name: "Define audit" }));
    const needed = await screen.findByRole("alert", { name: "Still needed" });
    expect(within(needed).getByText("Every question needs its words")).toBeInTheDocument();
    expect(within(needed).getByText("Question 2: the lower limit is above the upper limit")).toBeInTheDocument();
    expect(within(needed).getByText("Question 3: a measurement needs a nominal value, its tolerance (− and +) and a unit")).toBeInTheDocument();
    expect(within(needed).getByText("Question 4: an option is listed twice")).toBeInTheDocument();
    expect(sent("POST /audits")).toHaveLength(0);
  });

  it("moves and removes questions", async () => {
    routeApi({ "GET /audits/a1": detail(), "PATCH /audits/a1": () => detail() });
    renderAt("/Documentation/Audits/a1/edit");
    await screen.findByRole("heading", { name: "Edit AUD-001" });
    await userEvent.click(screen.getByRole("button", { name: "Move question 1 down" }));
    const list = screen.getByRole("list", { name: "Checklist" });
    expect(within(within(list).getByRole("listitem", { name: "Question 1" })).getByLabelText(/^Question/)).toHaveValue("Coolant concentration");
    await userEvent.click(screen.getByRole("button", { name: "Remove question 1" }));
    expect(within(screen.getByRole("list", { name: "Checklist" })).getAllByRole("listitem")).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(sent("PATCH /audits/a1")).toHaveLength(1));
    expect(sent("PATCH /audits/a1")[0].body.questions).toEqual([{ question: "Is the cell clean?", guidance: "Floor, bench, machine", answerType: "pass_fail", critical: true }]);
    expect(sent("PATCH /audits/a1")[0].body.targets).toEqual([{ kind: "machine", machineId: "m1" }, { kind: "operation", operationCode: "OP-20" }]);
  });

  it("starts an edit from the audit as it is: what it is relevant to as chips, and a measurement's tolerance worked back from its limits", async () => {
    routeApi({
      "GET /audits/a1": detail({
        questions: [{ id: "q9", sequence: 1, question: "Diameter", guidance: null, answerType: "measurement", passAnswer: null, unit: "mm", lowerLimit: 9.95, upperLimit: 10.1, nominal: 10, options: null, ratingMax: null, passRating: null, critical: true }],
      }),
    });
    renderAt("/Documentation/Audits/a1/edit");
    expect(await screen.findByLabelText(/^Title/)).toHaveValue("Layered process audit, CNC cell");
    expect(screen.getByLabelText(/^Pass mark/)).toHaveValue("95");
    expect(screen.getByRole("combobox", { name: "How often" })).toHaveValue("Every week");
    expect(await within(screen.getByRole("list", { name: "Machines" })).findByText("CNC-1 · Lathe")).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "Operations" })).getByText("OP-20")).toBeInTheDocument();
    const q = within(screen.getByRole("listitem", { name: "Question 1" }));
    expect(q.getByLabelText(/^Nominal/)).toHaveValue("10");
    expect(q.getByLabelText(/^Tolerance −/)).toHaveValue("0.05");
    expect(q.getByLabelText(/^Tolerance \+/)).toHaveValue("0.1");
    expect(q.getByLabelText(/Critical/)).toBeChecked();
    expect(screen.getByText(/Audits already done keep the questions they were done against/)).toBeInTheDocument();
  });
});
