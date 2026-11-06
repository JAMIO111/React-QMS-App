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
  TextAreaField: ({ label, value, onChange, disabled }) => <textarea aria-label={label} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} />,
  NcrPicker: () => <div />,
}));

import CapaPage from "./CapaPage";

const KEYS = ["d0", "d1", "d2", "d3", "d4", "d5", "d6", "d7", "d8"];
const steps = (problems = {}) => KEYS.map((step) => ({ step, completed: false, completedAt: null, completedBy: null, note: null, reopenedAt: null, reopenReason: null, problems: problems[step] ?? [] }));
const team = [
  { id: "t1", membershipId: "m1", userId: "u1", name: "Ada Owner", company: null, email: null, role: "leader", external: false, endedAt: null },
  { id: "t2", membershipId: "m2", userId: "u2", name: "Eve Engineer", company: null, email: null, role: "member", external: false, endedAt: null },
  { id: "t3", membershipId: null, userId: null, name: "Sam Supplier", company: "Bar Co", email: null, role: "supplier_contact", external: true, endedAt: null },
  { id: "t4", membershipId: "m4", userId: "u4", name: "Lee Left", company: null, email: null, role: "member", external: false, endedAt: "2026-11-05T10:00:00Z" },
];
const base = () => ({
  id: "c1", reference: "CAPA-000001", method: "8d", title: "8D: Cracked bar stock", stage: "open", stageReason: null, source: "supplier", severity: "major", externalReference: null,
  owner: { membershipId: "m1", name: "Ada Owner" }, dueDate: null, overdue: false, currentStep: "d2", stepsDone: 2, ncrCount: 1, createdAt: "2026-11-05T09:00:00Z", closedAt: null,
  problemStatement: "Cracks on lot 77", createdBy: { id: "u1", name: "Ada Owner" }, updatedAt: "2026-11-05T09:00:00Z",
  problem: { who: null, what: "Cracked bar stock", where: "Plant A", when: null, why: null, how: null, howMany: "3 of 10 inspected" },
  d3NoContainmentReason: null, analyses: [], actions: [], steps: steps({ d2: ["Say when it was found (the When of 5W2H)"], d3: ["Add an interim containment action, or say why none is needed"] }), team, ncrs: [],
});
const action = (over = {}) => ({ id: "a1", phase: "interim", description: "Quarantine lot 77", rootCauseId: null, owner: { teamMemberId: "t2", name: "Eve Engineer" }, dueDate: "2026-11-09", overdue: false, status: "open", doneAt: null, doneBy: null, evidenceNote: null, cancelReason: null, createdAt: "2026-11-05T09:30:00Z", ...over });
const people = { data: [{ membershipId: "m1", userId: "u1", name: "Ada Owner" }] };

const renderAt = (url) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[url]}>
        <Routes><Route path="/CAPA/:id/:step" element={<CapaPage />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
const respond = (main) => async (path, opts = {}) => (path === "/capas/people" ? people : typeof main === "function" ? main(path, opts) : main);

beforeEach(() => {
  apiFetch.mockReset();
  permissions = ["capa.read", "capa.manage"];
});

describe("D2: describe the problem", () => {
  it("shows the 5W2H answers, marking what is needed, and the problem statement", async () => {
    apiFetch.mockImplementation(respond(() => base()));
    renderAt("/CAPA/c1/d2");
    const answers = await screen.findByLabelText("5W2H answers");
    expect(within(answers).getByText("Cracked bar stock")).toBeInTheDocument();
    expect(within(answers).getByText("3 of 10 inspected")).toBeInTheDocument();
    expect(within(answers).getAllByText("Not described yet")).toHaveLength(4);
    expect(screen.getByText("Cracks on lot 77")).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Still needed" })).toHaveTextContent("Say when it was found (the When of 5W2H)");
    expect(screen.getByRole("button", { name: "Complete D2 and continue" })).toBeDisabled();
  });

  it("the 5W2H opens as a modal and saves only the answers that changed", async () => {
    let body;
    apiFetch.mockImplementation(respond((path, opts = {}) => (opts.method === "PATCH" ? ((body = opts.body), base()) : base())));
    renderAt("/CAPA/c1/d2");
    await userEvent.click(await screen.findByRole("button", { name: "Open 5W2H" }));
    const dialog = screen.getByRole("dialog", { name: "5W2H: describe the problem" });
    expect(within(dialog).getByLabelText("What")).toHaveValue("Cracked bar stock");
    await userEvent.type(within(dialog).getByLabelText("When"), "Since Monday");
    await userEvent.type(within(dialog).getByLabelText("How many"), " (lot 77)");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save 5W2H" }));
    await waitFor(() => expect(body).toEqual({ d2When: "Since Monday", d2HowMany: "3 of 10 inspected (lot 77)" }));
  });

  it("an Is / Is-Not comparison opens as a modal with the standard questions and is saved with its rows", async () => {
    let call;
    apiFetch.mockImplementation(respond((path, opts = {}) => (opts.method === "POST" ? ((call = [path, opts.body]), base()) : base())));
    renderAt("/CAPA/c1/d2");
    expect(await screen.findByText(/No comparison yet/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "New Is / Is-Not comparison" }));
    const dialog = screen.getByRole("dialog", { name: "Is / Is-Not comparison" });
    const table = within(dialog).getByRole("table", { name: "Is / Is-Not rows" });
    expect(within(table).getAllByRole("row")).toHaveLength(1 + 4 + 8); // header, four dimension headings, eight questions
    await userEvent.type(within(dialog).getByLabelText("Which part, product or process has the problem? — IS"), "Rod 100");
    await userEvent.type(within(dialog).getByLabelText("Which part, product or process has the problem? — IS NOT"), "Rod 200");
    await userEvent.type(within(dialog).getByLabelText("Where is it found: site, line, machine? — changed"), "New tool");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save comparison" }));
    await waitFor(() => expect(call?.[0]).toBe("/capas/c1/analyses"));
    expect(call[1]).toMatchObject({ kind: "is_is_not", title: "Is / Is-Not" });
    expect(call[1].data.rows).toHaveLength(8);
    expect(call[1].data.rows[0]).toEqual({ key: "what_object", dimension: "what", question: "Which part, product or process has the problem?", is: "Rod 100", isNot: "Rod 200", distinctive: "", changes: "" });
    expect(call[1].data.rows.find((r) => r.key === "where_place").changes).toBe("New tool");
  });

  it("lists saved comparisons, reopens one with its answers, and removes one", async () => {
    const calls = [];
    const analysis = { id: "an1", kind: "is_is_not", title: "Is / Is-Not, lot 77", step: "d2", createdBy: { id: "u1", name: "Ada Owner" }, createdAt: "2026-11-05T09:00:00Z", updatedAt: "2026-11-05T09:00:00Z",
      data: { rows: [{ key: "what_object", dimension: "what", question: "Which part, product or process has the problem?", is: "Rod 100", isNot: "Rod 200", distinctive: "", changes: "" }] } };
    apiFetch.mockImplementation(respond((path, opts = {}) => (opts.method ? (calls.push([opts.method, path, opts.body]), base()) : { ...base(), analyses: [analysis] })));
    renderAt("/CAPA/c1/d2");
    const list = await screen.findByRole("list", { name: "Is / Is-Not comparisons" });
    expect(within(list).getByText("1 of 8 questions answered · by Ada Owner")).toBeInTheDocument();
    await userEvent.click(within(list).getByRole("button", { name: "Open Is / Is-Not, lot 77" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByLabelText("Which part, product or process has the problem? — IS")).toHaveValue("Rod 100");
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await userEvent.click(within(list).getByRole("button", { name: "Remove Is / Is-Not, lot 77" }));
    await userEvent.type(within(screen.getByRole("dialog")).getByLabelText(/Why is it being removed/), "Duplicate");
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(calls).toContainEqual(["DELETE", "/capa-analyses/an1", undefined]));
  });

  it("a reader sees the answers but has no tools to open", async () => {
    permissions = ["capa.read"];
    apiFetch.mockImplementation(respond(() => ({ ...base(), analyses: [{ id: "an1", kind: "is_is_not", title: "Is / Is-Not", step: "d2", data: { rows: [] }, createdBy: null, createdAt: "2026-11-05T09:00:00Z", updatedAt: "2026-11-05T09:00:00Z" }] })));
    renderAt("/CAPA/c1/d2");
    await screen.findByLabelText("5W2H answers");
    expect(screen.queryByRole("button", { name: "Open 5W2H" })).toBeNull();
    expect(screen.queryByRole("button", { name: "New Is / Is-Not comparison" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Remove Is/ })).toBeNull();
    expect(screen.getByRole("button", { name: "View Is / Is-Not" })).toBeInTheDocument();
  });

  it("a completed D2 can still be edited: nothing locks", async () => {
    apiFetch.mockImplementation(respond(() => ({ ...base(), steps: steps().map((s) => (s.step === "d2" ? { ...s, completed: true, completedAt: "2026-11-05T10:00:00Z", completedBy: { id: "u1", name: "Ada Owner" } } : s)) })));
    renderAt("/CAPA/c1/d2");
    expect(await screen.findByText(/D2 was completed by Ada Owner/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open 5W2H" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "New Is / Is-Not comparison" })).toBeEnabled();
  });
});

describe("D3: interim containment", () => {
  it("lists actions with owner, due date, status and evidence, and the progress", async () => {
    apiFetch.mockImplementation(respond(() => ({
      ...base(),
      actions: [action(), action({ id: "a2", description: "Sort 100%", status: "done", doneAt: "2026-11-05T11:00:00Z", doneBy: { id: "u1", name: "Ada Owner" }, evidenceNote: "1,200 sorted", owner: null, dueDate: null }),
        action({ id: "a3", description: "Check customer stock", status: "cancelled", cancelReason: "No stock", owner: null, dueDate: null })],
    })));
    renderAt("/CAPA/c1/d3");
    const list = await screen.findByRole("list", { name: "Containment actions" });
    expect(screen.getByText("1 of 2 done")).toBeInTheDocument();
    expect(within(list).getByText(/Owner: Eve Engineer · Due 9 Nov 2026/)).toBeInTheDocument();
    expect(within(list).getByText(/Done by Ada Owner on 5 Nov 2026/)).toBeInTheDocument();
    expect(within(list).getByText("1,200 sorted")).toBeInTheDocument();
    expect(within(list).getByText("No stock")).toBeInTheDocument();
    expect(within(list).getByText("Cancelled")).toBeInTheDocument();
  });

  it("adds an action with an owner from the team (not someone who left) and a due date", async () => {
    let call;
    apiFetch.mockImplementation(respond((path, opts = {}) => (opts.method === "POST" ? ((call = [path, opts.body]), base()) : base())));
    renderAt("/CAPA/c1/d3");
    expect(await screen.findByText(/No containment action yet/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Add containment action" }));
    const dialog = screen.getByRole("dialog", { name: "Add an action" });
    expect(within(dialog).getByRole("button", { name: "Add action" })).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText("What will be done"), "Quarantine lot 77");
    await userEvent.click(within(dialog).getByRole("combobox", { name: "Owner" }));
    expect(screen.queryByRole("option", { name: /Lee Left/ })).toBeNull();
    expect(screen.getByRole("option", { name: /Sam Supplier/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("option", { name: /Eve Engineer/ }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Add action" }));
    await waitFor(() => expect(call).toEqual(["/capas/c1/actions", { phase: "interim", description: "Quarantine lot 77", ownerTeamMemberId: "t2", dueDate: null }]));
  });

  it("marks an action done with evidence, edits it, cancels another with a reason, and reopens one", async () => {
    const calls = [];
    apiFetch.mockImplementation(respond((path, opts = {}) => (opts.method ? (calls.push([opts.method, path, opts.body]), base()) : { ...base(), actions: [action(), action({ id: "a3", description: "Old action", status: "cancelled", cancelReason: "No need" })] })));
    renderAt("/CAPA/c1/d3");
    await userEvent.click(await screen.findByRole("button", { name: "Mark done: Quarantine lot 77" }));
    const done = screen.getByRole("dialog", { name: "Mark the action done" });
    await userEvent.type(within(done).getByLabelText(/What was done, and the evidence/), "In the cage");
    await userEvent.click(within(done).getByRole("button", { name: "Mark done" }));
    await waitFor(() => expect(calls).toContainEqual(["POST", "/capa-actions/a1/complete", { evidenceNote: "In the cage" }]));

    await userEvent.click(screen.getByRole("button", { name: "Edit: Quarantine lot 77" }));
    const edit = screen.getByRole("dialog", { name: "Edit action" });
    const text = within(edit).getByLabelText("What will be done");
    await userEvent.clear(text);
    await userEvent.type(text, "Quarantine lots 77 and 78");
    await userEvent.click(within(edit).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls).toContainEqual(["PATCH", "/capa-actions/a1", { description: "Quarantine lots 77 and 78", ownerTeamMemberId: "t2", dueDate: "2026-11-09" }]));

    await userEvent.click(screen.getByRole("button", { name: "Cancel: Quarantine lot 77" }));
    await userEvent.type(within(screen.getByRole("dialog")).getByLabelText(/Why is it no longer needed/), "Customer has no stock");
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel action" }));
    await waitFor(() => expect(calls).toContainEqual(["POST", "/capa-actions/a1/cancel", { reason: "Customer has no stock" }]));

    await userEvent.click(screen.getByRole("button", { name: "Reopen: Old action" }));
    await waitFor(() => expect(calls).toContainEqual(["POST", "/capa-actions/a3/reopen", undefined]));
  });

  it("saves a reason when no containment is needed", async () => {
    let body;
    apiFetch.mockImplementation(respond((path, opts = {}) => (opts.method === "PATCH" ? ((body = opts.body), base()) : base())));
    renderAt("/CAPA/c1/d3");
    const form = await screen.findByRole("form", { name: "No containment" });
    const save = within(form).getByRole("button", { name: "Save reason" });
    expect(save).toBeDisabled();
    await userEvent.type(within(form).getByLabelText("Why no containment is needed"), "No product left the plant");
    await userEvent.click(save);
    await waitFor(() => expect(body).toEqual({ d3NoContainmentReason: "No product left the plant" }));
  });

  it("a reader sees the actions but cannot change them", async () => {
    permissions = ["capa.read"];
    apiFetch.mockImplementation(respond(() => ({ ...base(), actions: [action()] })));
    renderAt("/CAPA/c1/d3");
    await screen.findByRole("list", { name: "Containment actions" });
    expect(screen.queryByRole("button", { name: /Add containment action|Mark done|Edit:|Cancel:/ })).toBeNull();
    expect(within(screen.getByRole("form", { name: "No containment" })).getByLabelText("Why no containment is needed")).toBeDisabled();
  });
});
