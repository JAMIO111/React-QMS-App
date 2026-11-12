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
};
const draftRow = { ...row, id: "r2", reference: "RSK-002", kind: "opportunity", title: "Second CMM shift", status: "draft", inherent: null };
const assessment = { id: "a1", phase: "inherent", likelihood: 4, consequence: 4, likelihoodLabel: "Likely", consequenceLabel: "Major", score: 16, band: "high", rationale: "Two stoppages last year", assessedOn: "2026-11-10", assessedBy: "Ann Owner", current: true, modelVersion: 1, createdAt: "2026-11-10T08:00:00Z" };
let risk = { ...row, assessments: [assessment], canManage: true, canEdit: true };

vi.mock("../../hooks/useQmsApi", () => ({
  usePermissions: () => ({ can: (p) => permissions.includes(p), isLoading: false }),
  useSites: () => ({ data: { data: [{ id: "s1", name: "Leeds", code: "LDS" }] } }),
  useAllDepartments: () => ({ data: { data: [{ id: "d1", name: "Machining", code: "MC", siteId: "s1" }] } }),
}));
vi.mock("../../contexts/ToastProvider", () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock("../../contexts/AuthProvider", () => ({ useAuth: () => ({ user: { id: "u1" } }) }));
vi.mock("../../hooks/useCustomFields", () => ({ useCustomFieldPeople: () => ({ data: [{ id: "u1", name: "Ann Owner" }, { id: "u2", name: "Bob Bloggs" }] }) }));
vi.mock("../../hooks/useRisk", () => ({
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

beforeEach(() => {
  mutate.mockReset();
  toggle.mockReset();
  listCalls.length = 0;
  permissions = ["risk.read", "risk.manage"];
  risk = { ...row, assessments: [assessment], canManage: true, canEdit: true };
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
    expect(screen.getByText(/High — above the level your organisation accepts/)).toBeInTheDocument();
    expect(screen.getByText("Two stoppages last year")).toBeInTheDocument();
    expect(screen.getByText("4 · Likely")).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "Where it sits on the matrix" })).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Assessment history" })).not.toBeInTheDocument();
  });

  it("assesses by choosing a cell: the score and band show at once, and the reasoning is needed", async () => {
    risk = { ...draftRow, assessments: [], canManage: true, canEdit: true };
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
    risk = { ...row, assessments: [{ ...assessment, id: "a2", score: 8, likelihood: 2, band: "medium", likelihoodLabel: "Unlikely", rationale: "Second foundry on trial" }, { ...assessment, current: false }], canManage: true, canEdit: true };
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
    risk = { ...row, assessments: [assessment], canManage: false, canEdit: false };
    at("/Risk/Register/r1", "/Risk/Register/:id", <RiskPage />);
    expect(screen.queryByRole("button", { name: /Assess|Edit|Retire/ })).not.toBeInTheDocument();
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
