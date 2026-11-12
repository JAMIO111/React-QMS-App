import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { cellBand, isAcceptable, modelProblems, nextBand, scoreWords } from "../../lib/risk";
import { menuStructure } from "../../MenuStructure";
import { ShieldAlertIcon } from "@/components/icons";

let permissions = [];
const mutate = vi.fn();
const toggle = vi.fn();
const listCalls = [];

const band = (l, c) => (l * c <= 4 ? "low" : l * c <= 9 ? "medium" : l * c <= 16 ? "high" : "critical");
const config = {
  likelihood: ["Rare", "Unlikely", "Possible", "Likely", "Almost certain"].map((label) => ({ label })),
  consequence: ["Negligible", "Minor", "Moderate", "Major", "Severe"].map((label) => ({ label })),
  bands: [1, 2, 3, 4, 5].map((l) => [1, 2, 3, 4, 5].map((c) => band(l, c))),
  acceptanceBand: "medium",
  reviewMonths: { low: 12, medium: 6, high: 3, critical: 1 },
};
let model = { id: "m1", version: 1, config, reason: null, current: true, canChange: true, versions: [{ id: "m1", version: 1, current: true, reason: null, createdAt: "2026-11-01T08:00:00Z", createdBy: null }] };
const categories = [
  { id: "c1", key: "process", label: "Process", description: null, sequence: 1, active: true, risks: 1 },
  { id: "c2", key: "supplier", label: "Supplier", description: "Bought-in parts and services", sequence: 2, active: true, risks: 0 },
];
const row = {
  id: "r1", reference: "RSK-001", kind: "risk", title: "Single source for castings", category: { id: "c1", label: "Process" }, description: null,
  cause: "One approved foundry", effect: "Line stop", owner: { id: "u1", name: "Ann Owner" }, site: null, department: null, status: "open",
  inherent: { id: "a1", likelihood: 4, consequence: 4, score: 16, band: "high", assessedOn: "2026-11-10", modelVersion: 1 },
  retiredReason: null, retiredAt: null, createdAt: "2026-11-09T08:00:00Z", updatedAt: "2026-11-10T08:00:00Z",
  residual: null, band: "high", strategy: null, treatmentPlan: null, openActions: 0, nextReviewOn: "2027-02-10", reviewOverdue: false, outcome: null, closeNote: null, closedAt: null, closedBy: null, reopenReason: null,
};
const draftRow = { ...row, id: "r2", reference: "RSK-002", kind: "opportunity", title: "Second CMM shift", status: "draft", inherent: null };
const assessment = { id: "a1", phase: "inherent", likelihood: 4, consequence: 4, likelihoodLabel: "Likely", consequenceLabel: "Major", score: 16, band: "high", rationale: "Two stoppages last year", assessedOn: "2026-11-10", assessedBy: "Ann Owner", current: true, modelVersion: 1, createdAt: "2026-11-10T08:00:00Z" };
const detail = {
  assessments: [assessment], actions: [], reviews: [], acceptances: [], links: [], origin: null, problems: ["Choose what will be done about the risk"],
  acceptance: { acceptanceBand: "medium", above: true, accepted: false, waiting: false }, canManage: true, canApprove: true, canEdit: true,
};
let risk = { ...row, ...detail };

vi.mock("../../hooks/useQmsApi", () => ({
  usePermissions: () => ({ can: (p) => permissions.includes(p), isLoading: false }),
  useSites: () => ({ data: { data: [{ id: "s1", name: "Leeds", code: "LDS" }] } }),
  useAllDepartments: () => ({ data: { data: [{ id: "d1", name: "Machining", code: "MC", siteId: "s1" }] } }),
}));
vi.mock("../../contexts/ToastProvider", () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock("../../contexts/AuthProvider", () => ({ useAuth: () => ({ user: { id: "u1" } }) }));
vi.mock("../../hooks/useCustomFields", () => ({ useCustomFieldPeople: () => ({ data: [{ id: "u1", name: "Ann Owner" }, { id: "u2", name: "Bob Bloggs" }] }) }));
vi.mock("../ncr/Pickers", () => {
  const Stub = ({ label }) => <span>{label} picker</span>;
  return { NcrPicker: Stub, PartPicker: Stub, PartyPicker: Stub, MachinePicker: Stub, RemoteComboBox: Stub };
});
vi.mock("../../hooks/useProcessControl", () => ({ usePartFamilies: () => ({ data: { items: [] } }) }));
vi.mock("../../contexts/OrganisationProvider", () => ({ useOrganisation: () => ({ organisationId: "o1" }) }));
let linked = { data: [], canRaise: true };
let draft = null;
vi.mock("../../hooks/useRisk", () => ({
  useLinkedRisks: () => ({ data: linked, isLoading: false }),
  useRiskDraft: () => ({ data: draft, isLoading: false }),
  useRiskModel: () => ({ data: model, isLoading: false }),
  useRiskCategories: () => ({ data: { data: categories }, isLoading: false }),
  useRisks: (params) => (listCalls.push(params), { data: { data: [row, draftRow], page: 1, pageSize: 50, total: 2 }, isLoading: false }),
  useRisk: () => ({ data: risk, isLoading: false }),
  useRiskMutation: () => ({ mutate, isPending: false, error: null }),
  useToggleRiskCategory: () => ({ mutate: toggle }),
}));

import RiskRegisterPage from "./RiskRegisterPage";
import RiskPage from "./RiskPage";
import RiskMatrix from "./RiskMatrix";
import SettingsRisk from "../Settings/SettingsRisk";
import LinkedRisks from "./LinkedRisks";

beforeEach(() => {
  mutate.mockReset();
  toggle.mockReset();
  listCalls.length = 0;
  permissions = ["risk.read", "risk.manage"];
  risk = { ...row, ...detail };
  model = { ...model, canChange: true };
});

const at = (path, route, element) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path={route} element={element} />
      </Routes>
    </MemoryRouter>,
  );

describe("risk register", () => {
  it("lists risks with their score and band in words, and filters by level", async () => {
    at("/Risk/Register", "/Risk/Register", <RiskRegisterPage />);
    const table = screen.getByRole("table", { name: "Risks" });
    expect(within(table).getByRole("link", { name: "RSK-001" })).toHaveAttribute("href", "/Risk/Register/r1");
    expect(within(table).getByText("16 · High")).toBeInTheDocument();
    expect(within(table).getByText("Not assessed")).toBeInTheDocument();
    expect(within(table).getByText("Opportunity")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("combobox", { name: "Level" }));
    await userEvent.click(screen.getByRole("option", { name: "High" }));
    expect(listCalls.at(-1)).toMatchObject({ band: "high" });
    await userEvent.click(screen.getByRole("button", { name: "Retired" }));
    expect(listCalls.at(-1)).toMatchObject({ status: "retired" });
  });

  it("offers Raise a risk only to managers, and raises one owned by the person by default", async () => {
    permissions = ["risk.read"];
    const { unmount } = at("/Risk/Register", "/Risk/Register", <RiskRegisterPage />);
    expect(screen.queryByRole("button", { name: "Raise a risk" })).not.toBeInTheDocument();
    unmount();
    permissions = ["risk.read", "risk.manage"];
    at("/Risk/Register", "/Risk/Register", <RiskRegisterPage />);
    await userEvent.click(screen.getByRole("button", { name: "Raise a risk" }));
    const dialog = screen.getByRole("dialog");
    const save = within(dialog).getByRole("button", { name: "Raise it" });
    expect(save).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText("Title"), "Tool wear on op 20");
    await userEvent.click(within(dialog).getByRole("combobox", { name: /Category/ }));
    await userEvent.click(screen.getByRole("option", { name: /Supplier/ }));
    await userEvent.type(within(dialog).getByLabelText("Cause"), "No tool life counter");
    await userEvent.click(save);
    expect(mutate.mock.calls[0][0]).toEqual({
      action: "create",
      body: { kind: "risk", categoryId: "c2", title: "Tool wear on op 20", description: null, cause: "No tool life counter", effect: null, ownerId: "u1", siteId: null, departmentId: null },
    });
  });
});

describe("risk page", () => {
  it("shows where it sits on the matrix, the reasoning and that it is above what is accepted", () => {
    at("/Risk/Register/r1", "/Risk/Register/:id", <RiskPage />);
    expect(screen.getByRole("heading", { name: "RSK-001" })).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "Still needed" })).getByText("Choose what will be done about the risk")).toBeInTheDocument();
    expect(screen.getByText("Two stoppages last year")).toBeInTheDocument();
    expect(screen.getByText("4 · Likely")).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "Where it sits on the matrix" })).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Assessment history" })).not.toBeInTheDocument();
  });

  it("assesses by choosing a cell: the score and band show at once, and the reasoning is needed", async () => {
    risk = { ...draftRow, ...detail, assessments: [], problems: ["Assess the opportunity"] };
    at("/Risk/Register/r2", "/Risk/Register/:id", <RiskPage />);
    expect(screen.getByText("Not assessed yet")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Assess it" }));
    const dialog = screen.getByRole("dialog");
    const save = within(dialog).getByRole("button", { name: "Record the assessment" });
    expect(save).toBeDisabled();
    await userEvent.click(within(dialog).getByRole("button", { name: "Possible and Major: 12, High" }));
    expect(within(dialog).getByText(/Possible × Major/)).toHaveTextContent("12");
    expect(save).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText("Why this score?"), "Modest gain");
    await userEvent.click(save);
    expect(mutate).toHaveBeenCalledWith({ action: "assess", id: "r2", body: { likelihood: 3, consequence: 4, rationale: "Modest gain" } }, expect.anything());
  });

  it("keeps every assessment in the history, and says when the matrix has moved on", () => {
    risk = { ...row, ...detail, assessments: [{ ...assessment, id: "a2", score: 8, likelihood: 2, band: "medium", likelihoodLabel: "Unlikely", rationale: "Second foundry on trial" }, { ...assessment, current: false }] };
    model = { ...model, version: 2 };
    at("/Risk/Register/r1", "/Risk/Register/:id", <RiskPage />);
    const history = screen.getByRole("list", { name: "Assessment history" });
    expect(within(history).getAllByRole("listitem")).toHaveLength(2);
    expect(within(history).getByText(/Medium · current/)).toBeInTheDocument();
    expect(screen.getByText(/the matrix is now version 2/)).toBeInTheDocument();
    model = { ...model, version: 1 };
  });

  it("retires with a reason, brings back, and offers nothing to a reader", async () => {
    const { unmount } = at("/Risk/Register/r1", "/Risk/Register/:id", <RiskPage />);
    await userEvent.click(screen.getByRole("button", { name: "Retire" }));
    const dialog = screen.getByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText("Why?"), "Second foundry approved");
    await userEvent.click(within(dialog).getByRole("button", { name: "Retire" }));
    expect(mutate).toHaveBeenCalledWith({ action: "retire", id: "r1", body: { reason: "Second foundry approved" } }, expect.anything());
    unmount();
    risk = { ...risk, status: "retired", retiredReason: "Second foundry approved", retiredAt: "2026-11-11T08:00:00Z", canEdit: false };
    const second = at("/Risk/Register/r1", "/Risk/Register/:id", <RiskPage />);
    expect(screen.queryByRole("button", { name: /Assess/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Bring back" }));
    expect(mutate).toHaveBeenLastCalledWith({ action: "reactivate", id: "r1" }, expect.anything());
    second.unmount();
    risk = { ...row, ...detail, canManage: false, canApprove: false, canEdit: false };
    at("/Risk/Register/r1", "/Risk/Register/:id", <RiskPage />);
    expect(screen.queryByRole("button", { name: /Assess|Edit|Retire/ })).not.toBeInTheDocument();
  });
});

describe("treatment, acceptance and reviews (RK2)", () => {
  const openRisk = (over = {}) => {
    risk = { ...row, ...detail, ...over };
    return at("/Risk/Register/r1", "/Risk/Register/:id", <RiskPage />);
  };
  const action = { id: "x1", description: "Trial the second foundry", owner: { id: "u2", name: "Bob Bloggs" }, dueDate: "2020-01-01", status: "open", doneNote: null, doneAt: null, doneBy: null, cancelReason: null, cancelledAt: null, cancelledBy: null, mine: false, createdAt: "2026-11-10T08:00:00Z" };
  const residual = { id: "a9", likelihood: 3, consequence: 4, score: 12, band: "high", assessedOn: "2026-11-12", modelVersion: 1 };
  const residualDetail = { ...assessment, id: "a9", phase: "residual", likelihood: 3, likelihoodLabel: "Possible", score: 12, rationale: "Second foundry approved" };

  it("chooses the approach from those that fit a risk, and adds an action given to a person", async () => {
    openRisk();
    await userEvent.click(screen.getByRole("button", { name: "Choose the approach" }));
    let dialog = screen.getByRole("dialog");
    await userEvent.click(within(dialog).getByRole("combobox", { name: /Approach/ }));
    expect(screen.queryByRole("option", { name: /Exploit/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("option", { name: /Mitigate/ }));
    await userEvent.type(within(dialog).getByLabelText("The plan"), "Qualify a second foundry");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(mutate).toHaveBeenLastCalledWith({ action: "setTreatment", id: "r1", body: { strategy: "mitigate", plan: "Qualify a second foundry" } }, expect.anything());
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await userEvent.click(screen.getByRole("button", { name: "Add an action" }));
    dialog = screen.getByRole("dialog");
    const add = within(dialog).getByRole("button", { name: "Add action" });
    expect(add).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText("What is to be done"), "Audit the foundry");
    await userEvent.click(add);
    expect(mutate).toHaveBeenLastCalledWith({ action: "addAction", id: "r1", body: { description: "Audit the foundry", ownerId: "u1", dueDate: null } }, expect.anything());
  });

  it("lists actions with who has them, flags a late one, and closes one with what was done", async () => {
    openRisk({ strategy: "mitigate", status: "treating", openActions: 1, actions: [action, { ...action, id: "x2", description: "Hold stock", status: "done", doneNote: "Eight weeks held", doneAt: "2026-11-11T08:00:00Z", doneBy: "Ann Owner", dueDate: null }] });
    const list = screen.getByRole("list", { name: "Actions" });
    const first = within(list).getByText("Trial the second foundry").closest("li");
    expect(first).toHaveTextContent("Open");
    expect(first).toHaveTextContent("Overdue");
    expect(first).toHaveTextContent("Bob Bloggs");
    expect(within(list).getByText(/Eight weeks held/)).toBeInTheDocument();
    await userEvent.click(within(first).getByRole("button", { name: "Mark done: Trial the second foundry" }));
    const dialog = screen.getByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText("What was done"), "Trial passed");
    await userEvent.click(within(dialog).getByRole("button", { name: "Mark done" }));
    expect(mutate).toHaveBeenLastCalledWith({ action: "completeAction", id: "x1", body: { note: "Trial passed" } }, expect.anything());
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await userEvent.click(screen.getByRole("button", { name: "Reopen action: Hold stock" }));
    expect(mutate).toHaveBeenLastCalledWith({ action: "reopenAction", id: "x2" }, expect.anything());
  });

  it("lets the person an action was given to close it, and nothing else, without managing risks", () => {
    openRisk({ strategy: "mitigate", status: "treating", canManage: false, canApprove: false, canEdit: false, actions: [{ ...action, mine: true }] });
    expect(screen.getByRole("button", { name: "Mark done: Trial the second foundry" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Edit action|Cancel action|Add an action|Choose the approach|Record a review|Close/ })).not.toBeInTheDocument();
  });

  it("assesses what is left after treatment as a residual assessment", async () => {
    openRisk({ strategy: "mitigate", status: "treating", problems: ["Assess what is left after treatment"] });
    await userEvent.click(screen.getByRole("button", { name: "Assess what is left" }));
    const dialog = screen.getByRole("dialog", { name: /What is left of RSK-001/ });
    await userEvent.click(within(dialog).getByRole("button", { name: "Possible and Major: 12, High" }));
    await userEvent.type(within(dialog).getByLabelText("Why this score?"), "Second foundry approved");
    await userEvent.click(within(dialog).getByRole("button", { name: "Record the assessment" }));
    expect(mutate).toHaveBeenLastCalledWith({ action: "assess", id: "r1", body: { likelihood: 3, consequence: 4, rationale: "Second foundry approved", phase: "residual" } }, expect.anything());
  });

  it("proposes accepting what is left, and only someone else decides", async () => {
    const proposed = { id: "p1", status: "proposed", band: "high", rationale: "Second source approved; volume next quarter", proposedBy: "Ann Owner", proposedAt: "2026-11-12T08:00:00Z", decidedBy: null, decidedAt: null, decisionNote: null, inForce: true, canDecide: false, canWithdraw: true };
    const base = { strategy: "mitigate", status: "treating", residual, assessments: [residualDetail, assessment] };
    const first = openRisk(base);
    await userEvent.click(screen.getByRole("button", { name: "Propose accepting it" }));
    let dialog = screen.getByRole("dialog");
    const propose = within(dialog).getByRole("button", { name: "Propose" });
    await userEvent.type(within(dialog).getByLabelText("Why accept it as it stands?"), "short");
    expect(propose).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText("Why accept it as it stands?"), " but now long enough");
    await userEvent.click(propose);
    expect(mutate).toHaveBeenLastCalledWith({ action: "proposeAcceptance", id: "r1", body: { rationale: "short but now long enough" } }, expect.anything());
    first.unmount();
    // the proposer sees it waiting, with no Decide
    const mine = openRisk({ ...base, acceptance: { ...detail.acceptance, waiting: true }, acceptances: [proposed], problems: ["The acceptance is waiting for an approver"] });
    expect(screen.getByText("You proposed it, so someone else decides.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Decide…" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Propose accepting it" })).not.toBeInTheDocument();
    mine.unmount();
    // another approver decides, with a note
    openRisk({ ...base, acceptance: { ...detail.acceptance, waiting: true }, acceptances: [{ ...proposed, canDecide: true }] });
    await userEvent.click(screen.getByRole("button", { name: "Decide…" }));
    dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "Approve" })).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText("Your note"), "Until volume is reached");
    await userEvent.click(within(dialog).getByRole("button", { name: "Approve" }));
    expect(mutate).toHaveBeenLastCalledWith({ action: "decideAcceptance", id: "p1", body: { approve: true, note: "Until volume is reached" } }, expect.anything());
  });

  it("says when the review is overdue, records a review, and closes with an outcome", async () => {
    openRisk({ strategy: "mitigate", status: "monitoring", residual: { ...residual, band: "medium", score: 6 }, band: "medium", problems: [], acceptance: { ...detail.acceptance, above: false }, reviewOverdue: true, nextReviewOn: "2026-11-01",
      reviews: [{ id: "v1", outcome: "no_change", note: "Both foundries delivering", wasDueOn: "2026-08-01", nextReviewOn: "2026-11-01", reviewedOn: "2026-08-02", reviewedBy: "Ann Owner" }] });
    expect(screen.getAllByText(/Review overdue/).length).toBeGreaterThan(0);
    expect(within(screen.getByRole("list", { name: "Reviews" })).getByText("Both foundries delivering")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Record a review" }));
    let dialog = screen.getByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText("What you looked at and found"), "Nothing has changed");
    await userEvent.click(within(dialog).getByRole("button", { name: "Record the review" }));
    expect(mutate).toHaveBeenLastCalledWith({ action: "review", id: "r1", body: { note: "Nothing has changed" } }, expect.anything());
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    dialog = screen.getByRole("dialog");
    await userEvent.click(within(dialog).getByRole("combobox", { name: /Closed as/ }));
    await userEvent.click(screen.getByRole("option", { name: /Treated/ }));
    await userEvent.type(within(dialog).getByLabelText("Closing note"), "Two sources at volume");
    await userEvent.click(within(dialog).getByRole("button", { name: "Close it" }));
    expect(mutate).toHaveBeenLastCalledWith({ action: "close", id: "r1", body: { outcome: "treated", note: "Two sources at volume" } }, expect.anything());
  });

  it("shows a closed risk as it was left, and reopens it with a reason", async () => {
    openRisk({ status: "closed", outcome: "accepted", closeNote: "Lived with", closedAt: "2026-11-12T08:00:00Z", closedBy: "Ann Owner", nextReviewOn: null, canEdit: false, problems: [] });
    expect(screen.getByText("Closed: accepted")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Assess|Add an action|Close$/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Reopen" }));
    const dialog = screen.getByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText("Why is it reopened?"), "The supplier withdrew");
    await userEvent.click(within(dialog).getByRole("button", { name: "Reopen" }));
    expect(mutate).toHaveBeenLastCalledWith({ action: "reopen", id: "r1", body: { reason: "The supplier withdrew" } }, expect.anything());
  });

  it("offers an opportunity its own approaches and no acceptance", async () => {
    openRisk({ kind: "opportunity", acceptance: { ...detail.acceptance, above: false }, problems: ["Choose what will be done about the opportunity"] });
    expect(screen.queryByRole("heading", { name: "Acceptance" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Choose the approach" }));
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("combobox", { name: /Approach/ }));
    expect(screen.getByRole("option", { name: /Exploit/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Mitigate/ })).not.toBeInTheDocument();
  });
});

describe("links and raising from a record (RK3)", () => {
  const ncLink = { kind: "ncr", id: "n1", code: null, reference: "NC-0012", name: "Cracked weld", readable: true };
  const partLink = { kind: "part", id: "p1", code: null, reference: "BR-100", name: "Bracket", readable: true };

  it("shows where the risk came from and what it is linked to, each to its page; a record the reader may not open is named only by its kind", () => {
    risk = { ...row, ...detail, origin: ncLink, links: [ncLink, partLink, { kind: "capa", id: "c9", code: null, reference: null, name: null, readable: false }, { kind: "operation_code", id: null, code: "OP20", reference: "OP20", name: null, readable: true }] };
    at("/Risk/Register/r1", "/Risk/Register/:id", <RiskPage />);
    expect(screen.getByText(/Raised from non-conformance/)).toBeInTheDocument();
    const list = screen.getByRole("list", { name: "Linked records" });
    expect(within(list).getByRole("link", { name: /NC-0012 · Cracked weld/ })).toHaveAttribute("href", "/Non-Conformance/Register/n1");
    expect(within(list).getByRole("link", { name: /BR-100 · Bracket/ })).toHaveAttribute("href", "/Parts/p1");
    expect(within(list).getByText("A 8d you cannot open")).toBeInTheDocument();
    expect(within(list).getByText("OP20")).toBeInTheDocument();
  });

  it("changes the links: the record it was raised from cannot be taken off; an operation is typed in", async () => {
    risk = { ...row, ...detail, origin: ncLink, links: [ncLink, partLink] };
    at("/Risk/Register/r1", "/Risk/Register/:id", <RiskPage />);
    await userEvent.click(screen.getByRole("button", { name: "Change links" }));
    const dialog = screen.getByRole("dialog");
    const list = within(dialog).getByRole("list", { name: "Links" });
    expect(within(list).getByText("Raised from this")).toBeInTheDocument();
    expect(within(list).queryByRole("button", { name: /Remove NC-0012/ })).not.toBeInTheDocument();
    await userEvent.click(within(list).getByRole("button", { name: "Remove BR-100 · Bracket" }));
    await userEvent.click(within(dialog).getByRole("combobox", { name: /Add a link to/ }));
    await userEvent.click(screen.getByRole("option", { name: "Operation" }));
    await userEvent.type(within(dialog).getByLabelText("Operation code"), " OP30 ");
    await userEvent.click(within(dialog).getByRole("button", { name: "Add" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Save links" }));
    expect(mutate).toHaveBeenLastCalledWith({ action: "setLinks", id: "r1", body: { links: [{ kind: "ncr", id: "n1" }, { kind: "operation_code", code: "OP30" }] } }, expect.anything());
  });

  it("lists the risks linked to a record and raises one from it, prefilled, with the suggested links unless taken off", async () => {
    permissions = ["risk.read", "risk.manage"];
    linked = { data: [{ ...row, band: "high", reviewOverdue: false }], canRaise: true };
    draft = { kind: "risk", categoryId: "c2", title: "Cracked weld", description: "Crack at the weld toe", cause: null, effect: null, source: { kind: "ncr", id: "n1", reference: "NC-0012", title: "Cracked weld" }, links: [ncLink, partLink] };
    render(<MemoryRouter><LinkedRisks kind="ncr" id="n1" /></MemoryRouter>);
    const list = screen.getByRole("list", { name: "Linked risks" });
    expect(within(list).getByRole("link", { name: "RSK-001" })).toHaveAttribute("href", "/Risk/Register/r1");
    expect(within(list).getByText("High")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Raise a risk" }));
    const dialog = screen.getByRole("dialog", { name: "Raise a risk from NC-0012" });
    expect(within(dialog).getByLabelText(/^Title/)).toHaveValue("Cracked weld");
    expect(within(within(dialog).getByRole("list", { name: "Also linked" })).getByText(/BR-100/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Do not link BR-100 · Bracket" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Raise it" }));
    expect(mutate).toHaveBeenLastCalledWith(
      { action: "create", body: expect.objectContaining({ title: "Cracked weld", categoryId: "c2", raisedFrom: { kind: "ncr", id: "n1" }, links: [] }) },
      expect.anything(),
    );
  });

  it("offers no Raise a risk without the right, nothing at all to someone who may not read risks, and none on a supplier", () => {
    permissions = ["risk.read"];
    linked = { data: [], canRaise: false };
    const first = render(<MemoryRouter><LinkedRisks kind="ncr" id="n1" /></MemoryRouter>);
    expect(screen.getByText("No risk is linked to this yet.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Raise a risk" })).not.toBeInTheDocument();
    first.unmount();
    linked = { data: [], canRaise: true };
    const second = render(<MemoryRouter><LinkedRisks kind="supplier" id="s1" /></MemoryRouter>);
    expect(screen.queryByRole("button", { name: "Raise a risk" })).not.toBeInTheDocument();
    second.unmount();
    permissions = [];
    const { container } = render(<MemoryRouter><LinkedRisks kind="ncr" id="n1" /></MemoryRouter>);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("settings: risk", () => {
  it("shows the matrix and the categories, switching one off at once", async () => {
    render(<SettingsRisk />);
    expect(screen.getByRole("table", { name: "Risk matrix" })).toBeInTheDocument();
    expect(screen.getByText("Up to medium")).toBeInTheDocument();
    const list = screen.getByRole("list", { name: "Risk categories" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    await userEvent.click(within(list).getByRole("switch", { name: "Switch Supplier off" }));
    expect(toggle).toHaveBeenCalledWith({ id: "c2", active: false }, expect.anything());
  });

  it("changes a cell's band and saves a new version with a reason (approvers only)", async () => {
    model = { ...model, canChange: false };
    const { unmount } = render(<SettingsRisk />);
    expect(screen.queryByRole("button", { name: "Change the matrix" })).not.toBeInTheDocument();
    unmount();
    model = { ...model, canChange: true };
    render(<SettingsRisk />);
    await userEvent.click(screen.getByRole("button", { name: "Change the matrix" }));
    const dialog = screen.getByRole("dialog");
    const save = within(dialog).getByRole("button", { name: "Save as version 2" });
    expect(save).toBeDisabled();
    await userEvent.click(within(dialog).getByRole("button", { name: "Likelihood 3, consequence 3: Medium. Change" }));
    expect(within(dialog).getByRole("button", { name: "Likelihood 3, consequence 3: High. Change" })).toBeInTheDocument();
    expect(save).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText("Why is the matrix changing?"), "Tighter on customer impact");
    await userEvent.click(save);
    const sent = mutate.mock.calls[0][0];
    expect(sent.action).toBe("saveModel");
    expect(sent.body.reason).toBe("Tighter on customer impact");
    expect(sent.body.config.bands[2][2]).toBe("high");
    expect(sent.body.config.reviewMonths).toEqual({ low: 12, medium: 6, high: 3, critical: 1 });
  });
});

describe("matrix and helpers", () => {
  it("says every cell in words, most likely at the top", () => {
    render(<RiskMatrix config={config} />);
    const rows = screen.getAllByRole("row");
    expect(rows[0]).toHaveTextContent("5 Almost certain");
    expect(screen.getByText("Almost certain and Severe: 25, Critical")).toBeInTheDocument();
    expect(screen.getByText("Rare and Negligible: 1, Low")).toBeInTheDocument();
  });

  it("works out bands, what is acceptable and what stops a matrix being saved", () => {
    expect(cellBand(config, 4, 4)).toBe("high");
    expect(isAcceptable(config, "medium")).toBe(true);
    expect(isAcceptable(config, "high")).toBe(false);
    expect(nextBand("critical")).toBe("low");
    expect(scoreWords({ likelihood: 4, consequence: 4, score: 16, band: "high" })).toBe("4 × 4 = 16 · High");
    expect(scoreWords(null)).toBe("Not assessed");
    expect(modelProblems(config)).toEqual([]);
    expect(modelProblems({ ...config, likelihood: config.likelihood.map((l, i) => (i === 1 ? { label: " rare " } : l)), reviewMonths: { ...config.reviewMonths, high: 0 } })).toEqual([
      "The levels of likelihood need different labels",
      "The review interval for high is 1 to 60 months",
    ]);
  });

  it("is in the menu with its icon, for people who may read risks", () => {
    const item = menuStructure.find((m) => m.name === "Risk");
    expect(item).toMatchObject({ permission: "risk.read", path: "/Risk", icon: ShieldAlertIcon });
    expect(item.subMenu.map((s) => s.path)).toEqual(["/Risk/Register"]);
  });
});
