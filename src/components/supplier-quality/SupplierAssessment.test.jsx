import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

let permissions;
const apiFetch = vi.fn();
vi.mock("../../lib/api-client", async (importOriginal) => ({ ...(await importOriginal()), apiFetch: (...a) => apiFetch(...a) }));
vi.mock("../../contexts/OrganisationProvider", () => ({ useOrganisation: () => ({ organisationId: "org-1" }) }));
vi.mock("../../hooks/useQmsApi", () => ({ usePermissions: () => ({ can: (p) => permissions.includes(p) }) }));
vi.mock("../../contexts/ToastProvider", () => ({ useToast: () => ({ showToast: vi.fn() }) }));

import { ApprovalCard, AssessmentsCard } from "./Approvals";
import AssessmentPage from "./AssessmentPage";
import AssessmentTemplatesCard from "./AssessmentTemplates";
import { questionKey } from "../../lib/supplierQualification";

const supplier = { id: "s1", code: "ACME", name: "Acme Metals", approvalStatus: "pending_approval" };
const decision = (over = {}) => ({
  id: "d1", supplierId: "s1", fromStatus: "pending_approval", target: "approved", rationale: "Passed the assessment", conditions: null, reviewOn: null, exceptionReason: null,
  assessment: { id: "a1", reference: "SA-26-0001", result: "pass", score: 92 }, status: "proposed", proposedBy: { id: "u1", name: "Eng Ineer" }, proposedAt: "2026-11-02T09:00:00Z",
  decidedBy: null, decidedAt: null, decisionNote: null, canDecide: false, ...over,
});
const summary = (over = {}) => ({ id: "a1", reference: "SA-26-0001", supplierId: "s1", templateName: "Supplier qualification questionnaire", templateVersion: 1, passMark: 75, status: "completed", startedAt: "2026-11-01T09:00:00Z", startedBy: null, completedAt: "2026-11-01T10:00:00Z", score: 92, result: "pass", criticalFailures: 0, ...over });
const template = (over = {}) => ({
  id: "t1", name: "Supplier qualification questionnaire", description: "Before approval", active: true, versionId: "tv1", version: 1, passMark: 75,
  questions: [{ key: "qms", section: "Quality", text: "Certified?", answerType: "yes_no", weight: 5, critical: true, evidenceRequired: true, passRating: null }, { key: "capacity", section: "Supply", text: "Capacity?", answerType: "rating", weight: 3, critical: false, evidenceRequired: false, passRating: 3 }],
  versions: [{ version: 1, createdAt: "2026-11-01T09:00:00Z", createdBy: null, reason: "Default template", passMark: 75, questions: 2 }], ...over,
});
const detail = (over = {}) => ({
  ...summary({ status: "in_progress", completedAt: null, score: null, result: null, criticalFailures: null }), supplier: { id: "s1", code: "ACME", name: "Acme Metals" }, completedBy: null, summary: null, abandonReason: null,
  questions: [
    { key: "qms", section: "Quality", text: "Certified?", answerType: "yes_no", weight: 5, critical: true, evidenceRequired: true, passRating: null, response: null },
    { key: "capacity", section: "Supply", text: "Capacity?", answerType: "rating", weight: 3, critical: false, evidenceRequired: false, passRating: 3, response: null },
  ],
  progress: { scored: 2, answered: 0, problems: ["Answer: Certified?", "Answer: Capacity?"], score: null, criticalFailures: 0, passMark: 75, result: null }, ...over,
});
const calls = [];
const routeApi = (routes = {}) =>
  apiFetch.mockImplementation(async (path, opts = {}) => {
    const k = `${opts.method ?? "GET"} ${path.split("?")[0]}`;
    calls.push({ k, path, body: opts.body });
    if (!(k in routes)) throw new Error(`unexpected ${k}`);
    return typeof routes[k] === "function" ? routes[k](path, opts) : routes[k];
  });
const Where = () => <p data-testid="where">{useLocation().pathname}</p>;
const renderUi = (ui, url = "/") =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[url]}>
        <Routes><Route path="/Suppliers/:supplierId/assessments/:id" element={<><AssessmentPage /><Where /></>} /><Route path="*" element={<>{ui}<Where /></>} /></Routes>
        <div id="modal-root" />
      </MemoryRouter>
    </QueryClientProvider>
  );

beforeEach(() => {
  permissions = ["supplier_quality.read", "supplier_quality.manage", "supplier_quality.approve", "supplier_quality.configure"];
  calls.length = 0;
  apiFetch.mockReset();
});

describe("questionKey", () => {
  it("makes a short stable key from the wording and avoids the ones taken", () => {
    expect(questionKey("Is there a certified quality system in place?")).toBe("is_there_a_certified_quality");
    expect(questionKey("Certified?", ["certified"])).toBe("certified_2");
    expect(questionKey("")).toBe("question");
  });
});

describe("the approval card", () => {
  it("shows a waiting proposal; its proposer cannot decide it and is told so", async () => {
    routeApi({ "GET /supplier-quality/suppliers/s1/approval-decisions": { data: [decision()] }, "GET /supplier-quality/suppliers/s1/assessments": { data: [summary()] } });
    renderUi(<ApprovalCard supplier={supplier} canManage canApprove />);
    expect(await screen.findByText("Proposal waiting for a decision: approve")).toBeInTheDocument();
    expect(screen.getByText("Passed the assessment")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Decide" })).toBeNull();
    expect(screen.getByText("You proposed this, so someone else must decide it.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Propose approval" })).toBeNull(); // one proposal at a time
  });

  it("offers Decide to someone else and sends the decision with a note", async () => {
    routeApi({
      "GET /supplier-quality/suppliers/s1/approval-decisions": { data: [decision({ canDecide: true, exceptionReason: "Sole source" })] },
      "GET /supplier-quality/suppliers/s1/assessments": { data: [summary()] },
      "POST /supplier-quality/supplier-approval-decisions/d1/decide": decision({ status: "approved" }),
    });
    renderUi(<ApprovalCard supplier={supplier} canManage canApprove />);
    await userEvent.click(await screen.findByRole("button", { name: "Decide" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Sole source")).toBeInTheDocument();
    const submit = within(dialog).getByRole("button", { name: "Approve" });
    expect(submit).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText(/Note/), "Reviewed the evidence");
    await userEvent.click(submit);
    await waitFor(() => expect(calls.find((c) => c.k.endsWith("/decide"))?.body).toEqual({ approve: true, note: "Reviewed the evidence" }));
  });

  it("proposes approval from a passing assessment without an exception", async () => {
    routeApi({
      "GET /supplier-quality/suppliers/s1/approval-decisions": { data: [] },
      "GET /supplier-quality/suppliers/s1/assessments": { data: [summary()] },
      "POST /supplier-quality/suppliers/s1/approval-decisions": decision(),
    });
    renderUi(<ApprovalCard supplier={supplier} canManage canApprove={false} />);
    await userEvent.click(await screen.findByRole("button", { name: "Propose approval" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).queryByLabelText(/Exception reason/)).toBeNull();
    const submit = within(dialog).getByRole("button", { name: "Propose" });
    expect(submit).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText(/Rationale/), "Passed the assessment");
    await userEvent.click(submit);
    await waitFor(() => expect(calls.find((c) => c.k === "POST /supplier-quality/suppliers/s1/approval-decisions")?.body).toEqual({ target: "approved", rationale: "Passed the assessment", assessmentId: "a1" }));
  });

  it("asks for an exception reason when there is no passing assessment", async () => {
    routeApi({
      "GET /supplier-quality/suppliers/s1/approval-decisions": { data: [] },
      "GET /supplier-quality/suppliers/s1/assessments": { data: [summary({ result: "fail", score: 50 })] },
      "POST /supplier-quality/suppliers/s1/approval-decisions": decision(),
    });
    renderUi(<ApprovalCard supplier={supplier} canManage canApprove={false} />);
    await userEvent.click(await screen.findByRole("button", { name: "Propose approval" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("The assessment did not pass")).toBeInTheDocument();
    await userEvent.type(within(dialog).getByLabelText(/Rationale/), "Sole source");
    const submit = within(dialog).getByRole("button", { name: "Propose" });
    expect(submit).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText(/Exception reason/), "Sole source for a legacy part");
    await userEvent.click(submit);
    await waitFor(() => expect(calls.find((c) => c.k === "POST /supplier-quality/suppliers/s1/approval-decisions")?.body).toMatchObject({ exceptionReason: "Sole source for a legacy part", assessmentId: "a1" }));
  });

  it("lists earlier decisions and offers nothing to a reader", async () => {
    permissions = ["supplier_quality.read"];
    routeApi({ "GET /supplier-quality/suppliers/s1/approval-decisions": { data: [decision({ status: "rejected", decidedBy: { id: "u2", name: "Quality Manager" }, decidedAt: "2026-11-03T09:00:00Z", decisionNote: "Not enough evidence" })] }, "GET /supplier-quality/suppliers/s1/assessments": { data: [] } });
    renderUi(<ApprovalCard supplier={supplier} canManage={false} canApprove={false} />);
    const list = await screen.findByRole("list", { name: "Earlier decisions" });
    expect(within(list).getByText("Rejected")).toBeInTheDocument();
    expect(within(list).getByText(/Not enough evidence/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Propose approval" })).toBeNull();
  });
});

describe("the assessments card", () => {
  it("lists assessments with their result and starts a new one from a template, then opens it", async () => {
    routeApi({
      "GET /supplier-quality/suppliers/s1/assessments": { data: [summary()] },
      "GET /supplier-quality/assessment-templates": { data: [template(), template({ id: "t2", name: "Switched off", active: false })] },
      "POST /supplier-quality/suppliers/s1/assessments": detail(),
    });
    const open = vi.fn();
    renderUi(<AssessmentsCard supplier={supplier} canManage onOpen={open} />);
    const list = await screen.findByRole("list", { name: "Assessments" });
    expect(within(list).getByText("Pass · 92")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Start assessment" }));
    const dialog = screen.getByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Start" }));
    await waitFor(() => expect(calls.find((c) => c.k === "POST /supplier-quality/suppliers/s1/assessments")?.body).toEqual({ templateVersionId: "tv1" }));
    await waitFor(() => expect(open).toHaveBeenCalledWith("a1"));
  });

  it("offers Continue instead of a second start while one is running", async () => {
    routeApi({ "GET /supplier-quality/suppliers/s1/assessments": { data: [summary({ status: "in_progress", result: null, score: null })] }, "GET /supplier-quality/assessment-templates": { data: [template()] } });
    const open = vi.fn();
    renderUi(<AssessmentsCard supplier={supplier} canManage onOpen={open} />);
    await userEvent.click(await screen.findByRole("button", { name: "Continue" }));
    expect(open).toHaveBeenCalledWith("a1");
    expect(screen.queryByRole("button", { name: "Start assessment" })).toBeNull();
  });
});

describe("the assessment page", () => {
  it("shows what is still needed, saves each answer and enables Complete only when nothing is missing", async () => {
    let current = detail();
    routeApi({
      "GET /supplier-quality/supplier-assessments/a1": () => current,
      "GET /supplier-quality/suppliers/s1/documents": { data: [{ id: "doc1", status: "current", title: "ISO certificate", fileName: "iso.pdf" }] },
      "PUT /supplier-quality/supplier-assessments/a1/responses": (_p, o) => {
        const q = o.body.questionKey;
        current = detail({
          questions: current.questions.map((x) => (x.key === q ? { ...x, response: { answer: o.body.answer ?? null, rating: o.body.rating ?? null, note: o.body.note ?? null, document: o.body.documentId ? { id: o.body.documentId, title: "ISO certificate", fileName: "iso.pdf" } : null, result: o.body.answer === "no" ? "fail" : "pass", answeredAt: "2026-11-02T09:00:00Z" } } : x)),
          progress: { scored: 2, answered: q === "capacity" ? 2 : 1, problems: q === "capacity" ? [] : ["Answer: Capacity?"], score: 100, criticalFailures: 0, passMark: 75, result: "pass" },
        });
        return current;
      },
    });
    renderUi(null, "/Suppliers/s1/assessments/a1");
    expect(await screen.findByRole("heading", { name: /SA-26-0001/ })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Still needed" })).toHaveTextContent("Answer: Certified?");
    expect(screen.getByRole("button", { name: "Complete" })).toBeDisabled();
    await userEvent.click(within(screen.getByRole("radiogroup", { name: "Certified? answer" })).getByRole("radio", { name: "Yes" }));
    await waitFor(() => expect(calls.find((c) => c.k === "PUT /supplier-quality/supplier-assessments/a1/responses")?.body).toMatchObject({ questionKey: "qms", answer: "yes" }));
    // the evidence combo appears once the answer is given
    await userEvent.click(await screen.findByRole("combobox", { name: "Evidence" }));
    await userEvent.click(screen.getByRole("option", { name: /ISO certificate/ }));
    await waitFor(() => expect(calls.filter((c) => c.k.startsWith("PUT")).at(-1).body).toMatchObject({ questionKey: "qms", documentId: "doc1" }));
    await userEvent.click(within(screen.getByRole("radiogroup", { name: "Capacity? rating" })).getByRole("radio", { name: "5" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Complete" })).toBeEnabled());
    expect(screen.getByText("Everything is answered")).toBeInTheDocument();
  });

  it("shows an answer at once, and takes it back with a message when the save is refused", async () => {
    let release;
    routeApi({
      "GET /supplier-quality/supplier-assessments/a1": () => detail(),
      "GET /supplier-quality/suppliers/s1/documents": { data: [] },
      "PUT /supplier-quality/supplier-assessments/a1/responses": () => new Promise((_ok, fail) => { release = () => fail(new Error("Refused")); }),
    });
    renderUi(null, "/Suppliers/s1/assessments/a1");
    const group = await screen.findByRole("radiogroup", { name: "Certified? answer" });
    await userEvent.click(within(group).getByRole("radio", { name: "Yes" }));
    // the answer is on screen while the request is still out
    expect(within(group).getByRole("radio", { name: "Yes" })).toHaveAttribute("aria-checked", "true");
    await waitFor(() => expect(release).toBeTypeOf("function"));
    release();
    await waitFor(() => expect(within(screen.getByRole("radiogroup", { name: "Certified? answer" })).getByRole("radio", { name: "Yes" })).toHaveAttribute("aria-checked", "false"));
  });

  it("warns when the chosen evidence document is out of date", async () => {
    const base = detail();
    const withAnswer = detail({ questions: base.questions.map((x) => (x.key === "qms" ? { ...x, response: { answer: "yes", rating: null, note: null, document: { id: "doc2", title: "Old ISO certificate", fileName: "old.pdf" }, result: "pass", answeredAt: "2026-11-02T09:00:00Z" } } : x)) });
    routeApi({
      "GET /supplier-quality/supplier-assessments/a1": () => withAnswer,
      "GET /supplier-quality/suppliers/s1/documents": { data: [{ id: "doc2", status: "current", title: "Old ISO certificate", fileName: "old.pdf", expiry: { state: "expired", daysLeft: -12 } }] },
    });
    renderUi(null, "/Suppliers/s1/assessments/a1");
    expect(await screen.findByText("This document is out of date")).toBeInTheDocument();
    expect(screen.getByText(/expired 12 days ago/)).toBeInTheDocument();
  });

  it("completes with a summary and shows a failure without a note as still needed", async () => {
    routeApi({
      "GET /supplier-quality/supplier-assessments/a1": detail({ progress: { scored: 2, answered: 2, problems: [], score: 88.5, criticalFailures: 1, passMark: 75, result: "fail" } }),
      "GET /supplier-quality/suppliers/s1/documents": { data: [] },
      "POST /supplier-quality/supplier-assessments/a1/complete": detail({ status: "completed", score: 88.5, result: "fail", criticalFailures: 1 }),
    });
    renderUi(null, "/Suppliers/s1/assessments/a1");
    await userEvent.click(await screen.findByRole("button", { name: "Complete" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("This will score 88.5 (fail)")).toBeInTheDocument();
    expect(dialog).toHaveTextContent(/1 critical question failed/);
    await userEvent.type(within(dialog).getByLabelText(/Summary/), "Calibration not in place");
    await userEvent.click(within(dialog).getByRole("button", { name: "Complete assessment" }));
    await waitFor(() => expect(calls.find((c) => c.k.endsWith("/complete"))?.body).toEqual({ summary: "Calibration not in place" }));
  });

  it("is read-only once completed, and shows the result", async () => {
    routeApi({
      "GET /supplier-quality/supplier-assessments/a1": detail({
        status: "completed", score: 100, result: "pass", criticalFailures: 0, completedAt: "2026-11-02T10:00:00Z", completedBy: { id: "u1", name: "Eng Ineer" }, summary: "All good",
        questions: [{ key: "qms", section: "Quality", text: "Certified?", answerType: "yes_no", weight: 5, critical: true, evidenceRequired: true, passRating: null, response: { answer: "yes", rating: null, note: "Certificate seen", document: { id: "doc1", title: "ISO certificate", fileName: "iso.pdf" }, result: "pass", answeredAt: "2026-11-02T09:00:00Z" } }],
        progress: { scored: 1, answered: 1, problems: [], score: 100, criticalFailures: 0, passMark: 75, result: "pass" },
      }),
      "GET /supplier-quality/suppliers/s1/documents": { data: [] },
    });
    renderUi(null, "/Suppliers/s1/assessments/a1");
    expect(await screen.findByText(/Passed with a score of 100/)).toBeInTheDocument();
    expect(screen.getByText("Certificate seen")).toBeInTheDocument();
    expect(screen.getByText("Evidence: ISO certificate")).toBeInTheDocument();
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(screen.queryByRole("button", { name: "Complete" })).toBeNull();
  });

  it("abandons with a reason and returns to the supplier", async () => {
    routeApi({
      "GET /supplier-quality/supplier-assessments/a1": detail(),
      "GET /supplier-quality/suppliers/s1/documents": { data: [] },
      "POST /supplier-quality/supplier-assessments/a1/abandon": detail({ status: "abandoned", abandonReason: "Wrong supplier" }),
    });
    renderUi(null, "/Suppliers/s1/assessments/a1");
    await userEvent.click(await screen.findByRole("button", { name: "Abandon" }));
    const dialog = screen.getByRole("dialog");
    const submit = within(dialog).getByRole("button", { name: "Abandon" });
    expect(submit).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText(/Why is it being abandoned/), "Wrong supplier");
    await userEvent.click(submit);
    await waitFor(() => expect(calls.find((c) => c.k.endsWith("/abandon"))?.body).toEqual({ reason: "Wrong supplier" }));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/Suppliers/s1"));
  });
});

describe("the assessment templates card", () => {
  it("lists templates with their versions and switches one off", async () => {
    routeApi({ "GET /supplier-quality/assessment-templates": { data: [template()] }, "PATCH /supplier-quality/assessment-templates/t1": template({ active: false }) });
    renderUi(<AssessmentTemplatesCard canConfigure />);
    const list = await screen.findByRole("list", { name: "Assessment templates" });
    expect(within(list).getByText(/2 questions · pass mark 75/)).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "Versions of Supplier qualification questionnaire" })).getByText(/Default template/)).toBeInTheDocument();
    await userEvent.click(within(list).getByRole("switch", { name: /is in use/ }));
    await waitFor(() => expect(calls.find((c) => c.k.startsWith("PATCH"))?.body).toEqual({ active: false }));
  });

  it("saves a new version with a reason, keeping the keys of existing questions", async () => {
    routeApi({ "GET /supplier-quality/assessment-templates": { data: [template()] }, "POST /supplier-quality/assessment-templates/t1/versions": template({ version: 2 }) });
    renderUi(<AssessmentTemplatesCard canConfigure />);
    await userEvent.click(await screen.findByRole("button", { name: "Change questions" }));
    const dialog = screen.getByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save new version" }));
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Say why the template is changing");
    await userEvent.click(within(dialog).getByRole("button", { name: "Add question" }));
    await userEvent.type(within(dialog).getByLabelText("Question 3 wording"), "Do you audit your suppliers?");
    const pass = within(dialog).getByLabelText(/Pass mark/);
    await userEvent.clear(pass);
    await userEvent.type(pass, "80");
    await userEvent.type(within(dialog).getByLabelText(/Why is it changing/), "Added a supplier control question");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save new version" }));
    await waitFor(() => expect(calls.find((c) => c.k.endsWith("/versions"))).toBeTruthy());
    const body = calls.find((c) => c.k.endsWith("/versions")).body;
    expect(body.questions.map((q) => q.key)).toEqual(["qms", "capacity", "do_you_audit_your_suppliers"]);
    expect(body).toMatchObject({ passMark: 80, reason: "Added a supplier control question" });
    expect(body.questions[1]).toMatchObject({ answerType: "rating", passRating: 3 });
  });

  it("shows no controls without supplier_quality.configure", async () => {
    permissions = ["supplier_quality.read"];
    routeApi({ "GET /supplier-quality/assessment-templates": { data: [template()] } });
    renderUi(<AssessmentTemplatesCard canConfigure={false} />);
    await screen.findByRole("list", { name: "Assessment templates" });
    expect(screen.queryByRole("button", { name: "New template" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Change questions" })).toBeNull();
  });
});
