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
vi.mock("../../hooks/useQmsApi", () => ({ usePermissions: () => ({ can: (p) => permissions.includes(p) }) }));

import AuditRecordPage from "./AuditRecordPage";
import AuditRecordsPage from "./AuditRecordsPage";
import AuditSchedulePage from "./AuditSchedulePage";

const question = (over) => ({ id: "q1", sequence: 1, question: "Is the work instruction at the machine?", guidance: "On the board", answerType: "yes_no", passAnswer: "yes", unit: null, lowerLimit: null, upperLimit: null, critical: true, response: null, ...over });
const questions = () => [
  question(),
  question({ id: "q2", sequence: 2, question: "Is the floor clear?", guidance: null, answerType: "pass_fail", passAnswer: null, critical: false }),
  question({ id: "q3", sequence: 3, question: "Coolant concentration", guidance: null, answerType: "number", passAnswer: null, unit: "%", lowerLimit: 6, upperLimit: 10, critical: false }),
  question({ id: "q4", sequence: 4, question: "Anything else seen", guidance: null, answerType: "text", passAnswer: null, critical: false }),
];
const answered = (q, response) => ({ ...q, response: { id: `s-${q.id}`, answer: null, value: null, note: null, result: null, ncrs: [], ...response } });
const record = (over = {}) => ({
  id: "r1",
  reference: "AR-26-0001",
  status: "in_progress",
  result: null,
  score: null,
  passMark: 80,
  passedCount: null,
  failedCount: null,
  criticalFailedCount: null,
  naCount: null,
  audit: { id: "a1", reference: "AUD-001", title: "Cell audit", auditType: "layered_process" },
  carriedOutOn: [],
  scheduledFor: "2026-11-02",
  performedOn: "2026-11-08",
  auditor: { id: "u1", name: "Ines Inspector" },
  completedAt: null,
  completedBy: null,
  startedAt: "2026-11-08T09:00:00Z",
  procedure: "Walk the cell.",
  notes: null,
  abandonReason: null,
  availableTargets: [{ kind: "machine", id: "m1", label: "CNC-1 · Lathe" }, { kind: "machine", id: "m2", label: "CNC-2 · Mill" }, { kind: "operation", id: "OP-10", label: "OP-10" }],
  targetsRequired: true,
  problems: ["3 questions are not answered (first: question 1)", "choose which machines, operations or departments it was carried out on"],
  targets: [],
  questions: questions(),
  ...over,
});

const slot = (over = {}) => ({
  id: "o1",
  dueOn: "2026-11-05",
  state: "missed",
  daysFromToday: -3,
  graceDays: 2,
  skippedReason: null,
  record: null,
  audit: { id: "a1", reference: "AUD-001", title: "Cell audit", auditType: "layered_process", passMark: 80, auditor: { kind: "none", name: null }, relevantTo: ["CNC-1"] },
  ...over,
});
const scheduleBody = (items, counts = {}) => ({
  today: "2026-11-08",
  window: { from: "2026-10-09", to: "2026-12-08" },
  counts: { total: items.length, upcoming: 1, dueNext7Days: 1, inProgress: 0, overdue: 1, missed: 2, done: 3, donePassed: 2, doneFailed: 1, skipped: 1, passRate: 66.7, onTimeRate: 40, ...counts },
  data: items,
  truncated: false,
});

const calls = [];
let routes;
const routeApi = (extra = {}) => {
  routes = {
    "GET /machines": { data: [{ id: "m1", code: "CNC-1", name: "Lathe" }, { id: "m2", code: "CNC-2", name: "Mill" }], nextCursor: null },
    "GET /audits": { data: [{ id: "a1", reference: "AUD-001", title: "Cell audit", auditType: "layered_process", questionCount: 4, criticalCount: 1, passMark: 80 }], page: 1, pageSize: 200, total: 1 },
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
          <Route path="/Documentation/Audit-Records" element={<><AuditRecordsPage /><Where /></>} />
          <Route path="/Documentation/Audit-Records/:id" element={<><AuditRecordPage /><Where /></>} />
          <Route path="/Documentation/Audit-Schedule" element={<><AuditSchedulePage /><Where /></>} />
          <Route path="/Documentation/Audits/:id" element={<Where />} />
          <Route path="/Non-Conformance/Internal/:id" element={<Where />} />
        </Routes>
        <div id="modal-root" />
      </MemoryRouter>
    </QueryClientProvider>
  );

beforeEach(() => {
  permissions = ["audits.read", "audits.manage", "audits.perform", "ncr.create"];
  calls.length = 0;
  apiFetch.mockReset();
});

describe("answering an audit", () => {
  it("shows the questions as they were started, with the procedure and what is still needed", async () => {
    routeApi({ "GET /audit-records/r1": record() });
    renderAt("/Documentation/Audit-Records/r1");
    expect(await screen.findByRole("heading", { name: "AR-26-0001 · Cell audit" })).toBeInTheDocument();
    const list = screen.getByRole("list", { name: "Checklist" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(4);
    expect(within(list).getByText("Critical")).toBeInTheDocument();
    expect(within(list).getByText(/"yes" passes/)).toBeInTheDocument();
    expect(within(list).getByText(/passes 6 to 10 %/)).toBeInTheDocument();
    expect(screen.getByText("Walk the cell.")).toBeInTheDocument();
    const needed = screen.getByRole("list", { name: "Still needed" });
    expect(needed).toHaveTextContent("3 questions are not answered");
    expect(needed).toHaveTextContent("choose which machines");
    expect(screen.getByRole("button", { name: "Complete audit" })).toBeDisabled();
  });

  it("saves a pass / fail or yes / no answer as soon as it is chosen, and shows it straight away", async () => {
    // The save is still on its way: the screen already shows the answer.
    routeApi({ "GET /audit-records/r1": record(), "PUT /audit-records/r1/responses": () => new Promise(() => {}) });
    renderAt("/Documentation/Audit-Records/r1");
    const group = await screen.findAllByRole("radiogroup", { name: "Answer to question 2" });
    await userEvent.click(within(group[0]).getByRole("radio", { name: "Fail" }));
    expect(within(group[0]).getByRole("radio", { name: "Fail" })).toHaveAttribute("aria-checked", "true");
    await waitFor(() => expect(sent("PUT /audit-records/r1/responses")).toHaveLength(1));
    expect(last("PUT /audit-records/r1/responses").body).toEqual({ questionId: "q2", answer: "fail", value: null, note: null });
    // A failure asks what was found.
    expect(await screen.findByLabelText("What was found, question 2")).toBeInTheDocument();
    await userEvent.click(within(screen.getByRole("radiogroup", { name: "Answer to question 1" })).getByRole("radio", { name: "No" }));
    await waitFor(() => expect(sent("PUT /audit-records/r1/responses")).toHaveLength(2));
    expect(last("PUT /audit-records/r1/responses").body).toMatchObject({ questionId: "q1", answer: "no" });
  });

  it("puts the answer back when it cannot be saved", async () => {
    let gets = 0;
    routeApi({
      // After the first read the page waits for the server, so what is on screen is the optimistic answer or its rollback, not a refetch.
      "GET /audit-records/r1": () => (gets++ === 0 ? record() : new Promise(() => {})),
      "PUT /audit-records/r1/responses": () => Promise.reject(new Error("The server said no")),
    });
    renderAt("/Documentation/Audit-Records/r1");
    const fail = within((await screen.findAllByRole("radiogroup", { name: "Answer to question 2" }))[0]).getByRole("radio", { name: "Fail" });
    await userEvent.click(fail);
    await waitFor(() => expect(sent("PUT /audit-records/r1/responses")).toHaveLength(1));
    await waitFor(() => expect(fail).toHaveAttribute("aria-checked", "false"));
  });

  it("saves a number when the box is left, and not applicable instead of it", async () => {
    routeApi({ "GET /audit-records/r1": record(), "PUT /audit-records/r1/responses": record() });
    renderAt("/Documentation/Audit-Records/r1");
    const box = await screen.findByLabelText("Answer to question 3");
    await userEvent.type(box, "8.5");
    expect(sent("PUT /audit-records/r1/responses")).toHaveLength(0);
    await userEvent.tab();
    await waitFor(() => expect(last("PUT /audit-records/r1/responses")?.body).toEqual({ questionId: "q3", answer: null, value: 8.5, note: null }));
    await userEvent.click(within(screen.getByRole("radiogroup", { name: "Not applicable, question 3" })).getByRole("radio", { name: "N/A" }));
    await waitFor(() => expect(last("PUT /audit-records/r1/responses").body).toMatchObject({ questionId: "q3", answer: "na", value: null }));
  });

  it("saves what was found for a failed answer when the note is left, and a text question's note", async () => {
    const failed = record({ questions: questions().map((q) => (q.id === "q2" ? answered(q, { answer: "fail", result: "fail" }) : q)) });
    routeApi({ "GET /audit-records/r1": failed, "PUT /audit-records/r1/responses": failed });
    renderAt("/Documentation/Audit-Records/r1");
    const found = await screen.findByLabelText("What was found, question 2");
    expect(found).toHaveAttribute("aria-required", "true");
    await userEvent.type(found, "Swarf under the bench");
    await userEvent.tab();
    await waitFor(() => expect(last("PUT /audit-records/r1/responses")?.body).toEqual({ questionId: "q2", answer: "fail", value: null, note: "Swarf under the bench" }));
    await userEvent.type(screen.getByLabelText("Note for question 4"), "Tidy otherwise");
    await userEvent.tab();
    await waitFor(() => expect(last("PUT /audit-records/r1/responses").body).toEqual({ questionId: "q4", answer: null, value: null, note: "Tidy otherwise" }));
  });

  it("lets the auditor tick what the audit was carried out on, one or several", async () => {
    let current = record({ targets: [{ kind: "machine", id: "m1", label: "CNC-1 · Lathe" }] });
    routeApi({
      "GET /audit-records/r1": () => current,
      "PUT /audit-records/r1/targets": (body) => {
        current = { ...current, targets: body.targets.map((t) => current.availableTargets.find((a) => a.id === (t.machineId ?? t.operationCode))) };
        return current;
      },
    });
    renderAt("/Documentation/Audit-Records/r1");
    const lathe = await screen.findByRole("checkbox", { name: "CNC-1 · Lathe" });
    expect(lathe).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "CNC-2 · Mill" })).not.toBeChecked();
    await userEvent.click(screen.getByRole("checkbox", { name: "OP-10" }));
    await waitFor(() => expect(last("PUT /audit-records/r1/targets")?.body).toEqual({ targets: [{ kind: "machine", machineId: "m1" }, { kind: "operation", operationCode: "OP-10" }] }));
    await userEvent.click(lathe);
    await waitFor(() => expect(sent("PUT /audit-records/r1/targets")).toHaveLength(2));
    expect(last("PUT /audit-records/r1/targets").body).toEqual({ targets: [{ kind: "operation", operationCode: "OP-10" }] });
  });

  it("completes the audit once nothing is still needed, and says what the database worked out", async () => {
    const ready = record({ problems: [], targets: [{ kind: "machine", id: "m1", label: "CNC-1 · Lathe" }] });
    routeApi({ "GET /audit-records/r1": ready, "POST /audit-records/r1/complete": { ...ready, status: "completed", result: "pass", score: 100, reference: "AR-26-0001" } });
    renderAt("/Documentation/Audit-Records/r1");
    const button = await screen.findByRole("button", { name: "Complete audit" });
    expect(button).toBeEnabled();
    expect(screen.queryByRole("list", { name: "Still needed" })).toBeNull();
    await userEvent.click(button);
    await waitFor(() => expect(sent("POST /audit-records/r1/complete")).toHaveLength(1));
  });

  it("abandons with a reason", async () => {
    routeApi({ "GET /audit-records/r1": record(), "POST /audit-records/r1/abandon": record() });
    renderAt("/Documentation/Audit-Records/r1");
    await userEvent.click(await screen.findByRole("button", { name: "Abandon" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText("Why is it being abandoned?"), "Started by mistake");
    await userEvent.click(within(dialog).getByRole("button", { name: "Abandon audit" }));
    await waitFor(() => expect(last("POST /audit-records/r1/abandon")?.body).toEqual({ reason: "Started by mistake" }));
  });

  it("is read-only for people who may not perform audits", async () => {
    permissions = ["audits.read"];
    routeApi({ "GET /audit-records/r1": record() });
    renderAt("/Documentation/Audit-Records/r1");
    await screen.findByRole("heading", { name: /AR-26-0001/ });
    expect(screen.getAllByRole("radio").every((r) => r.disabled)).toBe(true);
    expect(screen.getByLabelText("Answer to question 3")).toBeDisabled();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Complete audit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Abandon" })).toBeNull();
  });
});

describe("a completed audit", () => {
  const done = () =>
    record({
      status: "completed",
      result: "fail",
      score: 66.67,
      passedCount: 2,
      failedCount: 1,
      naCount: 1,
      criticalFailedCount: 1,
      completedAt: "2026-11-08T10:00:00Z",
      completedBy: { id: "u1", name: "Ines Inspector" },
      problems: [],
      availableTargets: [],
      targets: [{ kind: "machine", id: "m1", label: "CNC-1 · Lathe" }],
      questions: questions().map((q) => (q.id === "q1" ? answered(q, { answer: "no", result: "fail", note: "Missing at the machine" }) : q.id === "q2" ? answered(q, { answer: "pass", result: "pass" }) : q.id === "q3" ? answered(q, { value: 8, result: "pass" }) : q)),
    });

  it("shows the result, the score against the pass mark and the failed critical question, with everything frozen", async () => {
    routeApi({ "GET /audit-records/r1": done() });
    renderAt("/Documentation/Audit-Records/r1");
    const banner = await screen.findByRole("status");
    expect(banner).toHaveTextContent("Failed with 66.7% (pass mark 80%)");
    expect(banner).toHaveTextContent("2 passed, 1 failed, 1 not applicable; 1 critical question failed");
    expect(screen.getByRole("list", { name: "Carried out on" })).toHaveTextContent("CNC-1 · Lathe");
    expect(screen.getAllByRole("radio").every((r) => r.disabled)).toBe(true);
    expect(screen.queryByRole("button", { name: "Complete audit" })).toBeNull();
    expect(screen.getByDisplayValue("Missing at the machine")).toHaveAttribute("readonly");
  });

  it("raises a draft non-conformance from the failed answers, prefilled, and opens it", async () => {
    routeApi({ "GET /audit-records/r1": done(), "POST /audit-records/r1/raise-ncr": { nonconformanceId: "n1", record: done() } });
    renderAt("/Documentation/Audit-Records/r1");
    await userEvent.click(await screen.findByRole("button", { name: "Raise non-conformance" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("checkbox", { name: /Is the work instruction at the machine\?/ })).toBeChecked();
    expect(within(dialog).getByLabelText("Title")).toHaveValue("AUD-001: Is the work instruction at the machine?");
    expect(within(dialog).getByLabelText("Description").value).toContain("Missing at the machine");
    await userEvent.selectOptions(within(dialog).getByLabelText("Severity"), "major");
    await userEvent.click(within(dialog).getByRole("button", { name: "Raise non-conformance" }));
    await waitFor(() => expect(last("POST /audit-records/r1/raise-ncr")?.body).toMatchObject({ responseIds: ["s-q1"], title: "AUD-001: Is the work instruction at the machine?", severity: "major" }));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/Non-Conformance/Internal/n1"));
  });

  it("offers only the failed answers that are not already on a non-conformance, and only to people who may raise them", async () => {
    const two = done();
    two.questions[1] = answered(two.questions[1], { answer: "fail", result: "fail", note: "Swarf" });
    two.questions[0].response.ncrs = [{ id: "n9", reference: "NCR-26-0009", stage: "draft" }];
    routeApi({ "GET /audit-records/r1": two });
    const { unmount } = renderAt("/Documentation/Audit-Records/r1");
    await userEvent.click(await screen.findByRole("button", { name: "Raise non-conformance" }));
    const dialog = await screen.findByRole("dialog");
    const boxes = within(dialog).getAllByRole("checkbox");
    expect(boxes).toHaveLength(1);
    expect(boxes[0]).toHaveAccessibleName(/Is the floor clear\?/);
    unmount();
    permissions = ["audits.read"];
    renderAt("/Documentation/Audit-Records/r1");
    await screen.findByRole("status");
    expect(screen.queryByRole("button", { name: "Raise non-conformance" })).toBeNull();
  });

  it("offers it only with the right to raise non-conformances, and links the ones already raised", async () => {
    permissions = ["audits.read"];
    const raised = done();
    raised.questions[0].response.ncrs = [{ id: "n9", reference: "NCR-26-0009", stage: "draft" }];
    routeApi({ "GET /audit-records/r1": raised });
    renderAt("/Documentation/Audit-Records/r1");
    expect(await screen.findByRole("link", { name: "NCR-26-0009" })).toHaveAttribute("href", "/Non-Conformance/Internal/n9");
    expect(screen.queryByRole("button", { name: "Raise non-conformance" })).toBeNull();
  });
});

describe("audit records register", () => {
  const row = (over = {}) => ({
    id: "r1",
    reference: "AR-26-0001",
    status: "completed",
    result: "fail",
    score: 66.67,
    passMark: 80,
    passedCount: 2,
    failedCount: 1,
    criticalFailedCount: 1,
    audit: { id: "a1", reference: "AUD-001", title: "Cell audit", auditType: "layered_process" },
    carriedOutOn: ["CNC-1 · Lathe", "OP-10"],
    scheduledFor: "2026-11-02",
    performedOn: "2026-11-08",
    auditor: { id: "u1", name: "Ines Inspector" },
    completedAt: "2026-11-08T10:00:00Z",
    startedAt: "2026-11-08T09:00:00Z",
    ...over,
  });

  it("lists the records with what each was carried out on, who did it, the result and score", async () => {
    routeApi({ "GET /audit-records": { data: [row(), row({ id: "r2", reference: "AR-26-0002", status: "in_progress", result: null, score: null, scheduledFor: null, carriedOutOn: [], failedCount: null, criticalFailedCount: null })], page: 1, pageSize: 25, total: 2 } });
    renderAt("/Documentation/Audit-Records");
    const table = await screen.findByRole("region", { name: "Audit records" });
    expect(await within(table).findByRole("link", { name: "AR-26-0001" })).toHaveAttribute("href", "/Documentation/Audit-Records/r1");
    expect(within(table).getAllByText("AUD-001 · Cell audit")).toHaveLength(2);
    expect(within(table).getByText("CNC-1 · Lathe, OP-10")).toBeInTheDocument();
    expect(within(table).getAllByText("Ines Inspector")).toHaveLength(2);
    expect(within(table).getByText("Fail")).toBeInTheDocument();
    expect(within(table).getByText("66.7%")).toBeInTheDocument();
    expect(within(table).getByText("(1 critical)")).toBeInTheDocument();
    expect(within(table).getByText("Unscheduled")).toBeInTheDocument();
    expect(within(table).getByText("In progress")).toBeInTheDocument();
    expect(screen.getByText("2 audit records")).toBeInTheDocument();
    expect(last("GET /audit-records").path).toContain("sort=performedOn&order=desc");
  });

  it("filters by result, status, audit, machine, dates and whose they are, kept in the URL with chips that clear them", async () => {
    routeApi({ "GET /audit-records": { data: [], page: 1, pageSize: 25, total: 0 } });
    renderAt("/Documentation/Audit-Records");
    await screen.findByText("0 audit records");
    await userEvent.selectOptions(screen.getByLabelText("Result"), "fail");
    await userEvent.selectOptions(screen.getByLabelText("Status"), "completed");
    await userEvent.selectOptions(await screen.findByRole("option", { name: "AUD-001 · Cell audit" }).then((o) => o.closest("select")), "a1");
    await userEvent.selectOptions(await screen.findByRole("option", { name: "CNC-1 · Lathe" }).then((o) => o.closest("select")), "m1");
    await userEvent.click(screen.getByRole("checkbox", { name: "Only audits I did" }));
    await waitFor(() => expect(last("GET /audit-records").path).toContain("mine=true"));
    const path = last("GET /audit-records").path;
    for (const part of ["result=fail", "status=completed", "auditId=a1", "machineId=m1"]) expect(path).toContain(part);
    expect(screen.getByTestId("where")).toHaveTextContent("result=fail");
    const active = screen.getByLabelText("Active filters");
    expect(active).toHaveTextContent("Result: Fail");
    expect(active).toHaveTextContent("Audit: AUD-001");
    expect(active).toHaveTextContent("Machine: CNC-1");
    await userEvent.click(within(active).getByRole("button", { name: "Remove filter Result: Fail" }));
    await waitFor(() => expect(last("GET /audit-records").path).not.toContain("result=fail"));
    await userEvent.click(within(screen.getByLabelText("Active filters")).getByRole("button", { name: "Clear all" }));
    await waitFor(() => expect(screen.queryByLabelText("Active filters")).toBeNull());
    expect(last("GET /audit-records").path).not.toContain("auditId");
  });

  it("starts an unscheduled audit, only for people who may perform audits, and opens its record", async () => {
    routeApi({ "GET /audit-records": { data: [], page: 1, pageSize: 25, total: 0 }, "POST /audit-records": { id: "r9", reference: "AR-26-0009" } });
    const { unmount } = renderAt("/Documentation/Audit-Records");
    await userEvent.click(await screen.findByRole("button", { name: /Start an audit/ }));
    const dialog = await screen.findByRole("dialog");
    const start = within(dialog).getByRole("button", { name: "Start audit" });
    expect(start).toBeDisabled();
    await userEvent.selectOptions(await within(dialog).findByLabelText(/Audit/), "a1");
    expect(within(dialog).getByText(/4 questions, 1 critical\. Pass mark 80%/)).toBeInTheDocument();
    await userEvent.click(start);
    await waitFor(() => expect(last("POST /audit-records")?.body).toEqual({ auditId: "a1" }));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/Documentation/Audit-Records/r9"));
    unmount();
    permissions = ["audits.read"];
    renderAt("/Documentation/Audit-Records");
    await screen.findByText("0 audit records");
    expect(screen.queryByRole("button", { name: /Start an audit/ })).toBeNull();
  });
});

describe("audit schedule", () => {
  const items = () => [
    slot(),
    slot({ id: "o2", dueOn: "2026-11-06", state: "overdue", daysFromToday: -2 }),
    slot({ id: "o3", dueOn: "2026-11-09", state: "upcoming", daysFromToday: 1 }),
    slot({ id: "o4", dueOn: "2026-10-26", state: "done", daysFromToday: -13, record: { id: "r1", reference: "AR-26-0001", status: "completed", result: "pass", score: 100, performedOn: "2026-10-26" } }),
    slot({ id: "o5", dueOn: "2026-10-19", state: "done", daysFromToday: -20, record: { id: "r2", reference: "AR-26-0002", status: "completed", result: "fail", score: 50, performedOn: "2026-10-20" } }),
    slot({ id: "o6", dueOn: "2026-11-08", state: "in_progress", daysFromToday: 0, record: { id: "r3", reference: "AR-26-0003", status: "in_progress", result: null, score: null, performedOn: "2026-11-08" } }),
    slot({ id: "o7", dueOn: "2026-10-12", state: "skipped", daysFromToday: -27, skippedReason: "Shutdown week" }),
  ];

  it("counts what is due, overdue, missed, in progress and done, with the pass and on-time rates", async () => {
    routeApi({ "GET /audit-schedule": scheduleBody(items()) });
    renderAt("/Documentation/Audit-Schedule");
    const table = await screen.findByRole("table", { name: "Scheduled audits" });
    const tile = (name) => screen.getByRole("button", { name: new RegExp(`^${name}`) });
    expect(tile("Due in 7 days")).toHaveTextContent("1");
    expect(tile("Overdue")).toHaveTextContent("1");
    expect(tile("Missed")).toHaveTextContent("2");
    expect(tile("Done")).toHaveTextContent("3");
    expect(tile("Done")).toHaveTextContent("2 passed, 1 failed");
    expect(screen.getByText("66.7%")).toBeInTheDocument();
    expect(screen.getByText("40%")).toBeInTheDocument();
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(7);
    expect(within(rows[0]).getByText("Missed")).toBeInTheDocument();
    expect(within(table).getByText("Done · Pass")).toBeInTheDocument();
    expect(within(table).getByText("Done · Fail")).toBeInTheDocument();
    expect(within(table).getByText("Shutdown week")).toBeInTheDocument();
    expect(within(table).getByRole("link", { name: "Continue AR-26-0003" })).toHaveAttribute("href", "/Documentation/Audit-Records/r3");
    expect(within(table).getByRole("link", { name: "View AR-26-0001" })).toHaveAttribute("href", "/Documentation/Audit-Records/r1");
    expect(within(table).getByText(/\(3 days ago\)/)).toBeInTheDocument();
    expect(within(table).getByText(/\(in 1 day\)/)).toBeInTheDocument();
    expect(last("GET /audit-schedule").path).not.toContain("from=");
  });

  it("filters to a state when its figure is chosen, kept in the URL, and back again", async () => {
    routeApi({ "GET /audit-schedule": scheduleBody(items()) });
    renderAt("/Documentation/Audit-Schedule");
    await screen.findByRole("table", { name: "Scheduled audits" });
    await userEvent.click(screen.getByRole("button", { name: /^Missed/ }));
    await waitFor(() => expect(last("GET /audit-schedule").path).toContain("state=missed"));
    expect(screen.getByRole("button", { name: /^Missed/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("where")).toHaveTextContent("state=missed");
    await userEvent.click(screen.getByRole("button", { name: /^Missed/ }));
    await waitFor(() => expect(last("GET /audit-schedule").path).not.toContain("state="));
  });

  it("starts the audit for a slot and opens its record", async () => {
    routeApi({ "GET /audit-schedule": scheduleBody(items()), "POST /audit-records": { id: "r8", reference: "AR-26-0008" } });
    renderAt("/Documentation/Audit-Schedule");
    await userEvent.click(await screen.findByRole("button", { name: "Start AUD-001 due 2026-11-05" }));
    await waitFor(() => expect(last("POST /audit-records")?.body).toEqual({ auditId: "a1", occurrenceId: "o1" }));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/Documentation/Audit-Records/r8"));
  });

  it("skips a slot with a reason and puts a skipped one back, for people who manage audits", async () => {
    routeApi({ "GET /audit-schedule": scheduleBody(items()), "POST /audit-occurrences/o1/skip": slot(), "POST /audit-occurrences/o7/unskip": slot() });
    renderAt("/Documentation/Audit-Schedule");
    await userEvent.click(await screen.findByRole("button", { name: "Skip AUD-001 due 2026-11-05" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText("Why is it being skipped?"), "Machine down");
    await userEvent.click(within(dialog).getByRole("button", { name: "Skip audit" }));
    await waitFor(() => expect(last("POST /audit-occurrences/o1/skip")?.body).toEqual({ reason: "Machine down" }));
    await userEvent.click(screen.getByRole("button", { name: "Put back AUD-001 due 2026-10-12" }));
    await waitFor(() => expect(sent("POST /audit-occurrences/o7/unskip")).toHaveLength(1));
  });

  it("offers only what the person may do", async () => {
    permissions = ["audits.read"];
    routeApi({ "GET /audit-schedule": scheduleBody(items()) });
    renderAt("/Documentation/Audit-Schedule");
    await screen.findByRole("table", { name: "Scheduled audits" });
    expect(screen.queryByRole("button", { name: /^Start / })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Skip / })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Put back / })).toBeNull();
    expect(screen.queryByRole("button", { name: /Start an unscheduled audit/ })).toBeNull();
    expect(screen.getByRole("link", { name: "View AR-26-0001" })).toBeInTheDocument();
  });

  it("shows a month as a calendar with each slot on its day, and opens a slot for its actions", async () => {
    routeApi({ "GET /audit-schedule": scheduleBody(items()), "POST /audit-records": { id: "r8" } });
    renderAt("/Documentation/Audit-Schedule?view=calendar&month=2026-11");
    const grid = await screen.findByRole("grid", { name: "Audit calendar, November 2026" });
    expect(last("GET /audit-schedule").path).toContain("from=2026-11-01");
    expect(last("GET /audit-schedule").path).toContain("to=2026-11-30");
    const day = within(grid).getByRole("gridcell", { name: "2026-11-05" });
    const chip = within(day).getByRole("button", { name: /AUD-001 Missed/ });
    expect(within(grid).getByRole("gridcell", { name: "2026-11-08" })).toHaveTextContent("AUD-001 In progress");
    await userEvent.click(chip);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Due 5 Nov 2026|Due .*2026/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Relevant to CNC-1\./)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: /Start AUD-001/ }));
    await waitFor(() => expect(last("POST /audit-records")?.body).toEqual({ auditId: "a1", occurrenceId: "o1" }));
  });

  it("does not apply the state filter to the calendar, which shows every state", async () => {
    routeApi({ "GET /audit-schedule": scheduleBody(items()) });
    renderAt("/Documentation/Audit-Schedule?view=calendar&month=2026-11&state=missed");
    await screen.findByRole("grid", { name: "Audit calendar, November 2026" });
    expect(last("GET /audit-schedule").path).not.toContain("state=");
  });

  it("moves between months and back to now", async () => {
    routeApi({ "GET /audit-schedule": scheduleBody([]) });
    renderAt("/Documentation/Audit-Schedule?view=calendar&month=2026-11");
    await screen.findByRole("grid", { name: "Audit calendar, November 2026" });
    await userEvent.click(screen.getByRole("button", { name: "Next month" }));
    expect(await screen.findByRole("grid", { name: "Audit calendar, December 2026" })).toBeInTheDocument();
    expect(last("GET /audit-schedule").path).toContain("from=2026-12-01");
    await userEvent.click(screen.getByRole("button", { name: "Previous month" }));
    await userEvent.click(screen.getByRole("button", { name: "Previous month" }));
    expect(await screen.findByRole("grid", { name: "Audit calendar, October 2026" })).toBeInTheDocument();
    expect(last("GET /audit-schedule").path).toContain("to=2026-10-31");
  });

  it("starts an unscheduled audit from the schedule", async () => {
    routeApi({ "GET /audit-schedule": scheduleBody([]), "POST /audit-records": { id: "r9", reference: "AR-26-0009" } });
    renderAt("/Documentation/Audit-Schedule");
    await userEvent.click(await screen.findByRole("button", { name: /Start an unscheduled audit/ }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.selectOptions(await within(dialog).findByLabelText(/Audit/), "a1");
    await userEvent.click(within(dialog).getByRole("button", { name: "Start audit" }));
    await waitFor(() => expect(last("POST /audit-records")?.body).toEqual({ auditId: "a1" }));
  });
});
