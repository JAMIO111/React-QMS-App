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
      { id: "q1", sequence: 1, question: "Is the cell clean?", guidance: "Floor, bench, machine", answerType: "pass_fail", passAnswer: null, unit: null, lowerLimit: null, upperLimit: null, critical: true },
      { id: "q2", sequence: 2, question: "Coolant concentration", guidance: null, answerType: "number", passAnswer: null, unit: "%", lowerLimit: 6, upperLimit: 9, critical: false },
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

  it("defines an audit: the procedure, a checklist with every answer type, what it is relevant to, who is expected and the schedule", async () => {
    routeApi({ "POST /audits": () => ({ ...detail(), id: "new1", reference: "AUD-003" }), "GET /audits/new1": detail() });
    renderAt("/Documentation/Audits/new");
    await screen.findByRole("heading", { name: "Define an audit" });
    await userEvent.type(screen.getByLabelText(/^Title/), "Weekly LPA");
    await userEvent.selectOptions(screen.getByLabelText(/^Type/), "layered_process");
    await userEvent.clear(screen.getByLabelText(/^Pass mark/));
    await userEvent.type(screen.getByLabelText(/^Pass mark/), "90");
    await userEvent.selectOptions(screen.getByLabelText(/^How often/), "every_n_days");
    await userEvent.type(screen.getByLabelText(/^Number of days/), "10");
    await userEvent.type(screen.getByRole("textbox", { name: /^Procedure/ }), "Walk the cell");
    await userEvent.click(await screen.findByLabelText("CNC-1 · Lathe"));
    await userEvent.type(screen.getByLabelText("Operation code"), "OP-20{Enter}");
    await userEvent.click(screen.getByLabelText("MACH · Machining"));
    await userEvent.selectOptions(screen.getByLabelText("Expected auditor"), "person");
    await userEvent.selectOptions(screen.getByLabelText(/^Person/), "u1");

    await userEvent.click(screen.getByRole("button", { name: /Add a question/ }));
    await userEvent.type(within(screen.getByRole("listitem", { name: "Question 1" })).getByLabelText(/^Question/), "Is the cell clean?");
    await userEvent.click(within(screen.getByRole("listitem", { name: "Question 1" })).getByLabelText(/Critical/));
    await userEvent.click(screen.getByRole("button", { name: /Add a question/ }));
    const q2 = screen.getByRole("listitem", { name: "Question 2" });
    await userEvent.type(within(q2).getByLabelText(/^Question/), "Coolant concentration");
    await userEvent.selectOptions(within(q2).getByLabelText(/Answered with/), "number");
    await userEvent.type(within(q2).getByLabelText("Lower limit"), "6");
    await userEvent.type(within(q2).getByLabelText("Upper limit"), "9");
    await userEvent.type(within(q2).getByLabelText("Unit"), "%");
    await userEvent.click(screen.getByRole("button", { name: /Add a question/ }));
    const q3 = screen.getByRole("listitem", { name: "Question 3" });
    await userEvent.type(within(q3).getByLabelText(/^Question/), "Sheet signed?");
    await userEvent.selectOptions(within(q3).getByLabelText(/Answered with/), "yes_no");
    await userEvent.selectOptions(within(q3).getByLabelText("Passes with"), "no");

    // First due date: needed while scheduled.
    await userEvent.click(screen.getByRole("button", { name: "Define audit" }));
    expect(await screen.findByText("Give the first due date")).toBeInTheDocument();
    expect(sent("POST /audits")).toHaveLength(0);
    await userEvent.click(screen.getByRole("button", { name: /^First due/ }));
    await userEvent.click(within(await screen.findByRole("dialog", { name: "Choose first due" })).getAllByRole("button", { name: /\d{4}$/ })[0]);
    await userEvent.click(screen.getByRole("button", { name: "Define audit" }));
    await waitFor(() => expect(sent("POST /audits")).toHaveLength(1));
    const body = sent("POST /audits")[0].body;
    expect(body).toMatchObject({
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
    expect(body.questions).toEqual([
      { question: "Is the cell clean?", guidance: null, answerType: "pass_fail", critical: true },
      { question: "Coolant concentration", guidance: null, answerType: "number", unit: "%", lowerLimit: 6, upperLimit: 9, critical: false },
      { question: "Sheet signed?", guidance: null, answerType: "yes_no", passAnswer: "no", critical: false },
    ]);
    expect(body.targets).toEqual([{ kind: "machine", machineId: "m1" }, { kind: "operation", operationCode: "OP-20" }, { kind: "department", departmentId: "d1" }]);
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/Documentation/Audits/new1"));
  });

  it("needs no first due date for an audit done on demand", async () => {
    routeApi({ "POST /audits": () => ({ ...detail(), id: "new1" }), "GET /audits/new1": detail() });
    renderAt("/Documentation/Audits/new");
    await userEvent.type(await screen.findByLabelText(/^Title/), "On request");
    await userEvent.selectOptions(screen.getByLabelText(/^How often/), "on_demand");
    expect(screen.queryByLabelText(/^First due/)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Define audit" }));
    await waitFor(() => expect(sent("POST /audits")).toHaveLength(1));
    expect(sent("POST /audits")[0].body.frequency).toEqual({ kind: "on_demand" });
  });

  it("asks for limits on a number question and for words on every question", async () => {
    routeApi();
    renderAt("/Documentation/Audits/new");
    await userEvent.type(await screen.findByLabelText(/^Title/), "x");
    await userEvent.selectOptions(screen.getByLabelText(/^How often/), "on_demand");
    await userEvent.click(screen.getByRole("button", { name: /Add a question/ }));
    await userEvent.selectOptions(within(screen.getByRole("listitem", { name: "Question 1" })).getByLabelText(/Answered with/), "number");
    await userEvent.click(screen.getByRole("button", { name: "Define audit" }));
    const needed = await screen.findByRole("alert", { name: "Still needed" });
    expect(within(needed).getByText("Every question needs its words")).toBeInTheDocument();
    expect(within(needed).getByText("A number question needs a lower or an upper limit")).toBeInTheDocument();
  });

  it("moves and removes questions, and a note cannot be critical", async () => {
    routeApi({ "GET /audits/a1": detail(), "PATCH /audits/a1": () => detail() });
    renderAt("/Documentation/Audits/a1/edit");
    await screen.findByRole("heading", { name: "Edit AUD-001" });
    await userEvent.click(screen.getByRole("button", { name: "Move question 1 down" }));
    const list = screen.getByRole("list", { name: "Checklist" });
    expect(within(within(list).getByRole("listitem", { name: "Question 1" })).getByLabelText(/^Question/)).toHaveValue("Coolant concentration");
    await userEvent.selectOptions(within(within(list).getByRole("listitem", { name: "Question 2" })).getByLabelText(/Answered with/), "text");
    expect(within(within(list).getByRole("listitem", { name: "Question 2" })).queryByLabelText(/Critical/)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Remove question 1" }));
    expect(within(screen.getByRole("list", { name: "Checklist" })).getAllByRole("listitem")).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(sent("PATCH /audits/a1")).toHaveLength(1));
    expect(sent("PATCH /audits/a1")[0].body.questions).toEqual([{ question: "Is the cell clean?", guidance: "Floor, bench, machine", answerType: "text", critical: false }]);
    expect(sent("PATCH /audits/a1")[0].body.targets).toEqual([{ kind: "machine", machineId: "m1" }, { kind: "operation", operationCode: "OP-20" }]);
  });

  it("starts an edit from the audit as it is, and says records keep their own questions", async () => {
    routeApi({ "GET /audits/a1": detail() });
    renderAt("/Documentation/Audits/a1/edit");
    expect(await screen.findByLabelText(/^Title/)).toHaveValue("Layered process audit, CNC cell");
    expect(screen.getByLabelText(/^Pass mark/)).toHaveValue("95");
    expect(screen.getByLabelText(/^How often/)).toHaveValue("weekly");
    expect(await screen.findByLabelText("CNC-1 · Lathe")).toBeChecked();
    expect(screen.getByLabelText("CNC-2 · Mill")).not.toBeChecked();
    expect(within(screen.getByRole("list", { name: "Operations" })).getByText("OP-20")).toBeInTheDocument();
    expect(screen.getByText(/Audits already done keep the questions they were done against/)).toBeInTheDocument();
  });
});
