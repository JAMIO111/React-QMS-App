import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

let permissions;
const apiFetch = vi.fn();
vi.mock("../../lib/api-client", async (importOriginal) => ({ ...(await importOriginal()), apiFetch: (...a) => apiFetch(...a) }));
vi.mock("../../contexts/OrganisationProvider", () => ({ useOrganisation: () => ({ organisationId: "org-1" }) }));
vi.mock("../../hooks/useQmsApi", () => ({ usePermissions: () => ({ can: (p) => permissions.includes(p) }) }));
vi.mock("../ncr/Pickers", () => ({
  TextAreaField: ({ label, value, onChange, disabled }) => <textarea aria-label={label} value={value} disabled={disabled} onChange={(e) => onChange(e)} />,
  NcrPicker: () => <div />,
}));

import CapaPage from "./CapaPage";
import MyActionsPage from "./MyActionsPage";

const KEYS = ["d0", "d1", "d2", "d3", "d4", "d5", "d6", "d7", "d8"];
const steps = (done = []) => KEYS.map((step) => ({ step, completed: done.includes(step), completedAt: done.includes(step) ? "2026-11-05T09:00:00Z" : null, completedBy: done.includes(step) ? { id: "u1", name: "Ada Owner" } : null, note: null, reopenedAt: null, reopenReason: null, problems: [] }));
const action = (over = {}) => ({ id: "a1", phase: "interim", description: "Quarantine lot 77", rootCauseId: null, owner: { teamMemberId: "t2", name: "Eve Engineer" }, dueDate: "2026-12-09", overdue: false, status: "open", doneAt: null, doneBy: null, evidenceNote: null, cancelReason: null, isAssignee: true, createdAt: "2026-11-05T09:30:00Z", ...over });
const base = (over = {}) => ({
  id: "c1", reference: "CAPA-000001", method: "8d", title: "Burrs on the bore", stage: "actions_in_progress", stageReason: null, source: "internal", severity: null, externalReference: null,
  owner: null, dueDate: null, overdue: false, currentStep: "d3", stepsDone: 0, ncrCount: 0, createdAt: "2026-11-05T09:00:00Z", closedAt: null,
  problemStatement: "Burrs", createdBy: null, updatedAt: "2026-11-05T09:00:00Z", problem: { who: null, what: "Burrs", where: null, when: null, why: null, how: null, howMany: null },
  d3NoContainmentReason: null, d7LessonsLearned: null, d7NoPreventiveReason: null, d8Recognition: null, closedBy: null, analyses: [], rootCauses: [], actions: [action()],
  verifications: [], verificationState: "none", team: [{ id: "t2", membershipId: "m2", userId: "u2", name: "Eve Engineer", company: null, email: null, role: "member", external: false, endedAt: null }], ncrs: [],
  steps: steps(), ...over,
});
const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
const renderPage = (url) =>
  render(
    <QueryClientProvider client={client()}>
      <MemoryRouter initialEntries={[url]}><Routes><Route path="/CAPA/My-Actions" element={<MyActionsPage />} /><Route path="/CAPA/:id/:step" element={<CapaPage />} /></Routes></MemoryRouter>
    </QueryClientProvider>,
  );
const respond = (main) => async (path, opts = {}) => (path === "/capas/people" ? { data: [] } : main(path, opts));

beforeEach(() => {
  apiFetch.mockReset();
  permissions = ["capa.read"];
});

describe("the actionee", () => {
  it("with capa.read only, updates the findings and closes their own action, and cannot edit, add or cancel", async () => {
    const calls = [];
    apiFetch.mockImplementation(respond((path, opts = {}) => (opts.method ? (calls.push([opts.method, path, opts.body]), base()) : base({ actions: [action(), action({ id: "a2", description: "Sort lot 78", isAssignee: false, owner: { teamMemberId: "t3", name: "Sam" } })] }))));
    renderPage("/CAPA/c1/d3");
    expect(await screen.findByText(/\(you\)/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add containment action" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Edit:/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Cancel:/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Update findings: Sort lot 78" })).toBeNull(); // someone else's action

    await userEvent.click(screen.getByRole("button", { name: "Update findings: Quarantine lot 77" }));
    const findings = screen.getByRole("dialog", { name: "Update the findings" });
    await userEvent.type(within(findings).getByLabelText(/Findings/), "60 of 120 quarantined");
    await userEvent.click(within(findings).getByRole("button", { name: "Save findings" }));
    await waitFor(() => expect(calls).toContainEqual(["PATCH", "/capa-actions/a1", { evidenceNote: "60 of 120 quarantined" }]));

    await userEvent.click(screen.getByRole("button", { name: "Close action: Quarantine lot 77" }));
    const close = screen.getByRole("dialog", { name: "Close the action" });
    expect(within(close).getByRole("button", { name: "Close action" })).toBeDisabled();
    await userEvent.type(within(close).getByLabelText(/Findings/), "All 120 quarantined");
    await userEvent.click(within(close).getByRole("button", { name: "Close action" }));
    await waitFor(() => expect(calls).toContainEqual(["POST", "/capa-actions/a1/complete", { evidenceNote: "All 120 quarantined" }]));
  });

  it("a manager sees every action's buttons, including reassign and cancel, and the action dialog is wide", async () => {
    permissions = ["capa.read", "capa.manage"];
    apiFetch.mockImplementation(respond(() => base({ actions: [action({ isAssignee: false })] })));
    renderPage("/CAPA/c1/d3");
    expect(await screen.findByRole("button", { name: "Update findings: Quarantine lot 77" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Cancel: Quarantine lot 77" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Edit: Quarantine lot 77" })).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: "Add containment action" }));
    expect(screen.getByRole("dialog", { name: "Add an action" }).className).toContain("max-w-2xl");
  });

  it("when the step is complete the actions are read-only, with the reason, until it is reopened", async () => {
    permissions = ["capa.read", "capa.manage"];
    apiFetch.mockImplementation(respond(() => base({ steps: steps(["d3"]) })));
    renderPage("/CAPA/c1/d3");
    expect(await screen.findByText(/D3 is complete, so these actions are read-only/)).toBeInTheDocument();
    for (const name of ["Update findings: Quarantine lot 77", "Close action: Quarantine lot 77", "Edit: Quarantine lot 77", "Cancel: Quarantine lot 77", "Add containment action"]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
    expect(screen.getByRole("button", { name: "Reopen D3" })).toBeEnabled();
  });

  it("corrective actions are planned in D5 (add, edit) and carried out in D6 (findings, close), each locked by its own step", async () => {
    permissions = ["capa.read", "capa.manage"];
    const corrective = action({ phase: "corrective", description: "Fit a counter", isAssignee: false });
    apiFetch.mockImplementation(respond((path) => base({ actions: [corrective], steps: steps(path === "x" ? [] : ["d5"]) })));
    renderPage("/CAPA/c1/d6");
    expect(await screen.findByRole("button", { name: "Close action: Fit a counter" })).toBeEnabled(); // D5 complete, D6 open: can be worked
    expect(screen.queryByRole("button", { name: "Edit: Fit a counter" })).toBeNull(); // but the plan is locked
    expect(screen.getByRole("button", { name: "Reassign: Fit a counter" })).toBeEnabled(); // who and when can still move
  });
});

describe("My actions", () => {
  it("lists my actions with their 8D, updates findings and closes without opening the 8D", async () => {
    const calls = [];
    const row = { id: "a1", capaId: "c1", capaReference: "CAPA-000001", capaTitle: "Burrs on the bore", phase: "interim", description: "Quarantine lot 77", dueDate: "2020-01-01", overdue: true, status: "open", evidenceNote: null, doneAt: null, locked: false, assignedAt: "2026-11-05T09:30:00Z" };
    apiFetch.mockImplementation(async (path, opts = {}) => (opts.method ? (calls.push([opts.method, path, opts.body]), base()) : { data: [row, { ...row, id: "a2", description: "Locked one", locked: true }], openCount: 2 }));
    renderPage("/CAPA/My-Actions");
    const list = await screen.findByRole("list", { name: "My actions" });
    expect(within(list).getAllByRole("link", { name: /CAPA-000001 · Burrs on the bore/ })[0]).toHaveAttribute("href", "/CAPA/c1/d3");
    expect(within(list).getAllByText(/overdue/).length).toBeGreaterThan(0);
    expect(within(list).getByText(/read-only/)).toBeInTheDocument(); // the locked one
    expect(within(list).queryByRole("button", { name: "Close action: Locked one" })).toBeNull();
    await userEvent.click(within(list).getByRole("button", { name: "Close action: Quarantine lot 77" }));
    const dialog = screen.getByRole("dialog", { name: "Close the action" });
    await userEvent.type(within(dialog).getByLabelText(/Findings/), "Done and tagged");
    await userEvent.click(within(dialog).getByRole("button", { name: "Close action" }));
    await waitFor(() => expect(calls).toContainEqual(["POST", "/capa-actions/a1/complete", { evidenceNote: "Done and tagged" }]));
  });

  it("says when there is nothing to do", async () => {
    apiFetch.mockResolvedValue({ data: [], openCount: 0 });
    renderPage("/CAPA/My-Actions");
    expect(await screen.findByText(/Nothing to do/)).toBeInTheDocument();
  });
});
