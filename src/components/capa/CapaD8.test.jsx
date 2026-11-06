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
vi.mock("../ui/FileDrop", () => ({ AttachmentDrop: ({ title, canEdit }) => <div role="region" aria-label={title}>{canEdit ? "can add files" : "read only files"}</div> }));
vi.mock("../ncr/Pickers", () => ({
  TextAreaField: ({ label, value, onChange, disabled }) => <textarea aria-label={label} value={value} disabled={disabled} onChange={(e) => onChange(e)} />,
  NcrPicker: () => <div />,
}));

import CapaPage from "./CapaPage";
import CapaReportPage from "./CapaReportPage";

const KEYS = ["d0", "d1", "d2", "d3", "d4", "d5", "d6", "d7", "d8"];
const steps = (problems = {}, done = []) => KEYS.map((step) => ({ step, completed: done.includes(step), completedAt: done.includes(step) ? "2026-11-05T09:00:00Z" : null, completedBy: done.includes(step) ? { id: "u1", name: "Ada Owner" } : null, note: null, reopenedAt: null, reopenReason: null, problems: problems[step] ?? [] }));
const base = (over = {}) => ({
  id: "c1", reference: "CAPA-000001", method: "8d", title: "Burrs on the bore", stage: "verified_effective", stageReason: null, source: "internal", severity: null, externalReference: null,
  owner: null, dueDate: null, overdue: false, currentStep: "d8", stepsDone: 8, ncrCount: 0, createdAt: "2026-11-05T09:00:00Z", closedAt: null,
  problemStatement: "Burrs on every third part", createdBy: null, updatedAt: "2026-11-05T09:00:00Z", problem: { who: null, what: "Burrs", where: "Line 2", when: "Monday", why: null, how: null, howMany: null },
  d3NoContainmentReason: "Nothing shipped", d7LessonsLearned: "Tool life belongs in every plan", d7NoPreventiveReason: null, d8Recognition: null, closedBy: null,
  analyses: [], rootCauses: [{ id: "r1", kind: "occurrence", description: "No tool life limit", verified: true, verificationMethod: "Trial", verificationNote: null }],
  actions: [{ id: "a1", phase: "corrective", description: "Fit a counter", rootCauseId: "r1", owner: { teamMemberId: "t1", name: "Eve Engineer" }, dueDate: "2026-12-01", overdue: false, status: "done", doneAt: "2026-11-04T09:00:00Z", doneBy: null, evidenceNote: "Fitted", cancelReason: null }],
  verifications: [{ id: "v1", effective: true, method: "Audit of 5 lots", notes: null, verifiedBy: { id: "u1", name: "Ada Owner" }, verifiedAt: "2026-11-05T12:00:00Z" }], verificationState: "effective",
  team: [{ id: "t1", membershipId: "m1", userId: "u1", name: "Eve Engineer", company: null, email: null, role: "leader", external: false, endedAt: null }], ncrs: [],
  steps: steps({}, KEYS.slice(0, 8)), ...over,
});
const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
const renderPage = (url) =>
  render(
    <QueryClientProvider client={client()}>
      <MemoryRouter initialEntries={[url]}><Routes><Route path="/CAPA/:id/report" element={<CapaReportPage />} /><Route path="/CAPA/:id/:step" element={<CapaPage />} /></Routes></MemoryRouter>
    </QueryClientProvider>,
  );
const respond = (main) => async (path, opts = {}) => (path === "/capas/people" ? { data: [] } : path.endsWith("/attachments?deleted=include") ? { data: [{ id: "f1", fileName: "audit.pdf", deletedAt: null }, { id: "f2", fileName: "gone.pdf", deletedAt: "2026-11-05T00:00:00Z" }] } : main(path, opts));

beforeEach(() => {
  apiFetch.mockReset();
  permissions = ["capa.read", "capa.manage", "capa.verify"];
});

describe("D8: close the 8D", () => {
  it("closes with a recognition note", async () => {
    let call;
    apiFetch.mockImplementation(respond((path, opts) => (opts.method === "POST" ? ((call = [path, opts.body]), base()) : base())));
    renderPage("/CAPA/c1/d8");
    await userEvent.click(await screen.findByRole("button", { name: "Close 8D" }));
    const dialog = screen.getByRole("dialog", { name: "Close CAPA-000001?" });
    await userEvent.type(within(dialog).getByLabelText(/Recognition of the team/), "Thank you");
    await userEvent.click(within(dialog).getByRole("button", { name: "Close 8D" }));
    await waitFor(() => expect(call).toEqual(["/capas/c1/close", { recognition: "Thank you" }]));
    expect(screen.queryByRole("button", { name: /Complete D8/ })).toBeNull();
  });

  it("cannot close while something is missing, and lists it", async () => {
    apiFetch.mockImplementation(respond(() => base({ stage: "actions_in_progress", steps: steps({ d8: ["Complete D6 first", "The corrective actions must be verified as effective before the 8D can be closed"] }, KEYS.slice(0, 5)) })));
    renderPage("/CAPA/c1/d8");
    expect(await screen.findByRole("button", { name: "Close 8D" })).toBeDisabled();
    expect(screen.getByRole("status", { name: "Still needed" })).toHaveTextContent("Complete D6 first");
  });

  it("without the verify permission there is no close button", async () => {
    permissions = ["capa.read", "capa.manage"];
    apiFetch.mockImplementation(respond(() => base()));
    renderPage("/CAPA/c1/d8");
    expect(await screen.findByText(/Everything is in place/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Close 8D" })).toBeNull();
  });

  it("a closed 8D shows who closed it and the recognition; files are read-only", async () => {
    apiFetch.mockImplementation(respond(() => base({ stage: "closed", closedAt: "2026-11-06T10:00:00Z", closedBy: { id: "u1", name: "Ada Owner" }, d8Recognition: "Thank you", steps: steps({}, KEYS) })));
    renderPage("/CAPA/c1/d8");
    expect(await screen.findByText(/Closed by Ada Owner/)).toBeInTheDocument();
    expect(screen.getByText(/Recognition:/).parentElement).toHaveTextContent("Thank you");
    expect(screen.getByRole("region", { name: "Evidence files" })).toHaveTextContent("read only files");
    expect(screen.queryByRole("button", { name: "Close 8D" })).toBeNull();
  });
});

describe("the printable report", () => {
  it("shows the whole 8D, step by step, with the evidence file names", async () => {
    apiFetch.mockImplementation(respond(() => base({ stage: "closed", closedAt: "2026-11-06T10:00:00Z", closedBy: { id: "u1", name: "Ada Owner" }, d8Recognition: "Thank you", steps: steps({}, KEYS) })));
    renderPage("/CAPA/c1/report");
    expect(await screen.findByRole("heading", { name: /CAPA-000001 · Burrs on the bore/ })).toBeInTheDocument();
    for (const code of ["D0", "D1", "D2", "D3", "D4", "D5", "D6", "D7", "D8"]) expect(screen.getByRole("region", { name: new RegExp(`^${code} `) })).toBeInTheDocument();
    expect(screen.getByText("Burrs on every third part")).toBeInTheDocument();
    expect(screen.getByText(/Nothing shipped/)).toBeInTheDocument();
    expect(screen.getByText("Audit of 5 lots", { exact: false })).toBeInTheDocument();
    expect(screen.getByText(/Tool life belongs in every plan/)).toBeInTheDocument();
    expect(screen.getByText("audit.pdf")).toBeInTheDocument();
    expect(screen.queryByText("gone.pdf")).toBeNull();
    expect(screen.getByRole("button", { name: "Print or save as PDF" })).toBeInTheDocument();
  });
});
