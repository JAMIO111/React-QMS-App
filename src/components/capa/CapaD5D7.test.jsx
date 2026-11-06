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

const KEYS = ["d0", "d1", "d2", "d3", "d4", "d5", "d6", "d7", "d8"];
const steps = (problems = {}) => KEYS.map((step) => ({ step, completed: false, completedAt: null, completedBy: null, note: null, reopenedAt: null, reopenReason: null, problems: problems[step] ?? [] }));
const cause = (over = {}) => ({ id: "r1", kind: "occurrence", description: "No tool life limit", sourceAnalysisId: null, verified: true, verifiedAt: "2026-11-05T09:00:00Z", verifiedBy: null, verificationMethod: "Trial", verificationNote: null, createdAt: "2026-11-05T09:00:00Z", ...over });
const action = (over = {}) => ({ id: "a1", phase: "corrective", description: "Fit a tool life counter", rootCauseId: "r1", owner: null, dueDate: null, overdue: false, status: "open", doneAt: null, doneBy: null, evidenceNote: null, cancelReason: null, ...over });
const base = (over = {}) => ({
  id: "c1", reference: "CAPA-000001", method: "8d", title: "Burrs on the bore", stage: "actions_in_progress", stageReason: null, source: "internal", severity: null, externalReference: null,
  owner: null, dueDate: null, overdue: false, currentStep: "d5", stepsDone: 4, ncrCount: 0, createdAt: "2026-11-05T09:00:00Z", closedAt: null,
  problemStatement: "Burrs", createdBy: null, updatedAt: "2026-11-05T09:00:00Z", problem: { who: null, what: "Burrs", where: null, when: null, why: null, how: null, howMany: null },
  d3NoContainmentReason: null, d7LessonsLearned: null, d7NoPreventiveReason: null, analyses: [], rootCauses: [cause(), cause({ id: "r2", kind: "systemic", description: "No monitoring" })],
  actions: [], verifications: [], verificationState: "none", team: [], ncrs: [], steps: steps(), ...over,
});
const renderAt = (url) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[url]}><Routes><Route path="/CAPA/:id/:step" element={<CapaPage />} /></Routes></MemoryRouter>
    </QueryClientProvider>,
  );
const respond = (main) => async (path, opts = {}) => (path === "/capas/people" ? { data: [] } : main(path, opts));

beforeEach(() => {
  apiFetch.mockReset();
  permissions = ["capa.read", "capa.manage", "capa.verify"];
});

describe("D5: corrective actions", () => {
  it("shows each root cause with how many corrective actions it has", async () => {
    apiFetch.mockImplementation(respond(() => base({ actions: [action()] })));
    renderAt("/CAPA/c1/d5");
    const causes = await screen.findByRole("list", { name: "Root causes" });
    expect(within(causes).getByText("1 corrective action")).toBeInTheDocument();
    expect(within(causes).getByText("No corrective action")).toBeInTheDocument();
    expect(screen.getByText(/Addresses: No tool life limit/)).toBeInTheDocument();
  });

  it("adds a corrective action linked to a root cause", async () => {
    let call;
    apiFetch.mockImplementation(respond((path, opts) => (opts.method === "POST" ? ((call = [path, opts.body]), base()) : base())));
    renderAt("/CAPA/c1/d5");
    await userEvent.click(await screen.findByRole("button", { name: "Add corrective action" }));
    const dialog = screen.getByRole("dialog", { name: "Add an action" });
    await userEvent.type(within(dialog).getByLabelText("What will be done"), "Fit a tool life counter");
    await userEvent.click(within(dialog).getByRole("combobox", { name: "Root cause it addresses" }));
    await userEvent.click(screen.getByRole("option", { name: /No tool life limit/ }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Add action" }));
    await waitFor(() => expect(call?.[0]).toBe("/capas/c1/actions"));
    expect(call[1]).toMatchObject({ phase: "corrective", description: "Fit a tool life counter", rootCauseId: "r1" });
  });
});

describe("D6: implement and verify", () => {
  it("says where the verification stands and lists earlier ones", async () => {
    apiFetch.mockImplementation(respond(() => base({
      actions: [action({ status: "done" })], verificationState: "stale",
      verifications: [{ id: "v1", effective: false, method: "Audit of 5 lots", notes: "Burrs again", verifiedBy: { id: "u1", name: "Ada Owner" }, verifiedAt: "2026-11-05T12:00:00Z" }],
    })));
    renderAt("/CAPA/c1/d6");
    expect(await screen.findByText(/actions changed after the last verification/)).toBeInTheDocument();
    const list = screen.getByRole("list", { name: "Verifications" });
    expect(within(list).getByText("Not effective")).toBeInTheDocument();
    expect(within(list).getByText("Burrs again")).toBeInTheDocument();
  });

  it("records a verification; a failure needs a note", async () => {
    let call;
    apiFetch.mockImplementation(respond((path, opts) => (opts.method === "POST" ? ((call = [path, opts.body]), base()) : base({ actions: [action({ status: "done" })] }))));
    renderAt("/CAPA/c1/d6");
    await userEvent.click(await screen.findByRole("button", { name: "Verify effectiveness" }));
    const dialog = screen.getByRole("dialog", { name: "Verify the corrective actions" });
    const submit = within(dialog).getByRole("button", { name: "Record verification" });
    expect(submit).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText("How effectiveness was checked"), "Audit of 5 lots");
    await userEvent.click(within(dialog).getByLabelText(/No, it came back/));
    expect(submit).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText("What was found"), "Burrs again");
    await userEvent.click(submit);
    await waitFor(() => expect(call).toEqual(["/capas/c1/verifications", { effective: false, method: "Audit of 5 lots", notes: "Burrs again" }]));
  });

  it("without the verify permission there is no verify button", async () => {
    permissions = ["capa.read", "capa.manage"];
    apiFetch.mockImplementation(respond(() => base()));
    renderAt("/CAPA/c1/d6");
    expect(await screen.findByText("Not verified yet")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Verify effectiveness" })).toBeNull();
  });
});

describe("D7: prevent recurrence", () => {
  it("saves lessons learned and a reason for no preventive action", async () => {
    const calls = [];
    apiFetch.mockImplementation(respond((path, opts) => (opts.method === "PATCH" ? (calls.push([path, opts.body]), base()) : base())));
    renderAt("/CAPA/c1/d7");
    await userEvent.type(await screen.findByLabelText("What was learned"), "Tool life in every plan");
    await userEvent.click(screen.getByRole("button", { name: "Save lessons" }));
    await waitFor(() => expect(calls).toContainEqual(["/capas/c1", { d7LessonsLearned: "Tool life in every plan" }]));
    await userEvent.type(screen.getByLabelText("Why no preventive action is needed"), "Nothing else exposed");
    await userEvent.click(screen.getByRole("button", { name: "Save reason" }));
    await waitFor(() => expect(calls).toContainEqual(["/capas/c1", { d7NoPreventiveReason: "Nothing else exposed" }]));
  });

  it("a reader cannot edit", async () => {
    permissions = ["capa.read"];
    apiFetch.mockImplementation(respond(() => base({ d7LessonsLearned: "Remember" })));
    renderAt("/CAPA/c1/d7");
    expect(await screen.findByLabelText("What was learned")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Add preventive action" })).toBeNull();
  });
});
