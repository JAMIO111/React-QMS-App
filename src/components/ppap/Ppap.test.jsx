import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("../../lib/api-client", async (orig) => ({ ...(await orig()), apiFetch: vi.fn() }));
vi.mock("../../contexts/OrganisationProvider", () => ({ useOrganisation: () => ({ organisationId: "org-1" }) }));
vi.mock("../../contexts/ToastProvider", () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock("../../contexts/SearchProvider", () => ({ useGlobalSearch: () => ({ debouncedSearchTerm: "", setSearchTerm: vi.fn() }) }));
vi.mock("../../hooks/useQmsApi", () => ({ usePermissions: () => ({ can: () => true, isLoading: false }) }));
vi.mock("../ncr/Pickers", () => ({ PartyPicker: () => null, PartPicker: () => null, RevisionPicker: () => null, MachinePicker: () => null, RemoteComboBox: () => null }));
vi.mock("../../lib/breadcrumbs", async (orig) => ({ ...(await orig()), useBreadcrumbNames: () => {} }));
vi.mock("../../api/supabaseApi", () => ({ uploadFileToSupabase: vi.fn(), generateSignedUrl: vi.fn() }));

import { apiFetch } from "../../lib/api-client";
import PpapPage from "./PpapPage";
import PpapRegisterPage from "./PpapRegisterPage";

const element = (over = {}) => ({
  id: "e1", key: "design_records", ordinal: 1, label: "Design records", requirement: "required", requirementEdited: false, status: "not_started", note: null,
  waiver: null, evidence: [], liveEvidence: 0, ...over,
});
const submission = (over = {}) => ({
  id: "p1", reference: "PPAP-26-0001", direction: "submitted", status: "in_preparation", level: 3, reason: "new_part", notes: null,
  part: { id: "part1", partNumber: "BR-100", name: "Bracket" }, partRevision: { id: "pr1", label: "B", status: "released" },
  customer: { id: "c1", name: "Acme", code: "ACM" }, site: null, owner: { id: "u1", name: "Ada" }, requirementSetId: "rs1", requirementSet: { id: "rs1", version: 1 },
  replacesId: null, progress: { required: 2, done: 0 }, readyAt: null, submittedAt: null, withdrawReason: null, createdAt: "2026-11-25T09:00:00.000Z", updatedAt: "2026-11-25T09:00:00.000Z",
  elements: [element(), element({ id: "e2", key: "dfmea", ordinal: 4, label: "Design FMEA", requirement: "required" }), element({ id: "e3", key: "master_sample", ordinal: 15, label: "Master sample", requirement: "retain" })],
  problems: ["Design records needs evidence", "Design FMEA needs evidence"], editable: true, canApprove: true, canMarkReady: false, canReopen: false, canWithdraw: true, ...over,
});

const wrap = (ui, path) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/PPAP" element={ui} />
          <Route path="/PPAP/:id" element={ui} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );

beforeEach(() => apiFetch.mockReset());

describe("the PPAP register", () => {
  it("lists submissions with how far each one is", async () => {
    apiFetch.mockImplementation(async (path) => {
      if (path?.startsWith("/ppaps?")) return { data: [submission()], page: 1, pageSize: 25, total: 1 };
      if (path?.startsWith("/saved-filters")) return { data: [], limit: 5 };
      return {};
    });
    wrap(<PpapRegisterPage />, "/PPAP");
    const table = await screen.findByRole("region", { name: "PPAP submissions" });
    expect(await within(table).findByRole("link", { name: "PPAP-26-0001" })).toHaveAttribute("href", "/PPAP/p1");
    expect(within(table).getByText("Acme")).toBeInTheDocument();
    expect(within(table).getByText(/0 of 2 required elements/)).toBeInTheDocument();
  });
});

describe("a PPAP submission", () => {
  const load = (over) => apiFetch.mockImplementation(async (path, opts) => (path === "/ppaps/p1" && !opts?.method ? submission(over) : {}));

  it("shows what is still needed and keeps Mark ready off until nothing is", async () => {
    load();
    wrap(<PpapPage />, "/PPAP/p1");
    expect(await screen.findByRole("heading", { name: "PPAP-26-0001" })).toBeInTheDocument();
    const needed = screen.getByRole("list", { name: "Still needed" });
    expect(within(needed).getByText("Design records needs evidence")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Mark ready" })[0]).toBeDisabled();
    expect(screen.getByText("0 of 2 required elements")).toBeInTheDocument();
  });

  it("opens an element to show its evidence and the ways to add to it", async () => {
    load({ elements: [element({ evidence: [{ id: "v1", kind: "file", fileName: "drawing.pdf", storagePath: "org-1/ppap/p1/x-drawing.pdf", contentType: "application/pdf", sizeBytes: 2048, description: "Rev B drawing", addedBy: { id: "u1", name: "Ada" }, addedAt: "2026-11-25T09:00:00.000Z", removedAt: null, removeReason: null }], liveEvidence: 1 })] });
    wrap(<PpapPage />, "/PPAP/p1");
    await userEvent.click(await screen.findByRole("button", { name: "Show Design records" }));
    const files = screen.getByRole("list", { name: "Evidence for Design records" });
    expect(within(files).getByText("drawing.pdf")).toBeInTheDocument();
    expect(within(files).getByText("Rev B drawing")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add a file" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Waive…" })).toBeInTheDocument();
  });

  it("marks an element ready through the server and waits for its answer", async () => {
    load();
    wrap(<PpapPage />, "/PPAP/p1");
    await userEvent.click(await screen.findByRole("button", { name: "Show Design records" }));
    const after = submission({ elements: [element({ status: "ready", liveEvidence: 1 })] });
    apiFetch.mockImplementation(async (path) => (path === "/ppap-elements/e1" || path === "/ppaps/p1" ? after : {}));
    const row = screen.getByRole("button", { name: "Hide Design records" }).closest("li");
    await userEvent.click(within(row).getByRole("button", { name: "Mark ready" }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/ppap-elements/e1", expect.objectContaining({ method: "PATCH", body: { status: "ready" } })));
  });

  it("asks for a reason of substance before waiving", async () => {
    load();
    wrap(<PpapPage />, "/PPAP/p1");
    await userEvent.click(await screen.findByRole("button", { name: "Show Design records" }));
    await userEvent.click(screen.getByRole("button", { name: "Waive…" }));
    const dialog = await screen.findByRole("dialog", { name: /Waive Design records/ });
    const submit = within(dialog).getByRole("button", { name: "Waive it" });
    expect(submit).toBeDisabled();
    await userEvent.type(within(dialog).getByRole("textbox"), "short");
    expect(submit).toBeDisabled();
    await userEvent.type(within(dialog).getByRole("textbox"), " and now it is long enough");
    expect(submit).toBeEnabled();
  });

  it("is read-only once ready, offers to go back to preparation, and hides editing", async () => {
    load({ status: "ready", editable: false, canMarkReady: false, canReopen: true, problems: [] });
    wrap(<PpapPage />, "/PPAP/p1");
    expect(await screen.findByText(/Every required element has evidence or a waiver/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Back to preparation" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Show Design records" }));
    expect(screen.queryByRole("button", { name: "Add a file" })).toBeNull();
  });
  const linkEvidence = (over = {}) => ({
    id: "v9", kind: "link", fileName: null, storagePath: null, contentType: null, sizeBytes: null, description: "The study", addedBy: { id: "u1", name: "Ada" },
    addedAt: "2026-11-25T09:00:00.000Z", removedAt: null, removeReason: null,
    link: { targetKind: "plan_characteristic", targetId: "pc1", frozenAt: null, frozenLabel: null, frozenStatus: null,
      state: { available: true, ok: true, status: "effective", label: "Diameter on CP-001 rev B", changedSince: false }, study: { ok: false, problem: "Ppk 1.21 is below the agreed 1.67", text: "Ppk 1.21 over 150 readings; the agreed minimum is 1.67" } },
    ...over,
  });

  it("shows a linked record with how it stands now and what its study found", async () => {
    load({ elements: [element({ key: "initial_process_studies", label: "Initial process studies", evidence: [linkEvidence()], liveEvidence: 1 })] });
    wrap(<PpapPage />, "/PPAP/p1");
    await userEvent.click(await screen.findByRole("button", { name: "Show Initial process studies" }));
    const list = screen.getByRole("list", { name: "Evidence for Initial process studies" });
    expect(within(list).getByText("Diameter on CP-001 rev B")).toBeInTheDocument();
    expect(within(list).getByText("Needs attention")).toBeInTheDocument();
    expect(within(list).getByText(/It Ppk 1.21 is below the agreed 1.67/)).toBeInTheDocument();
    expect(within(list).getByText(/over 150 readings/)).toBeInTheDocument();
  });

  it("does not show a record the person cannot read as passing", async () => {
    load({ elements: [element({ evidence: [linkEvidence({ link: { targetKind: "part_revision", targetId: "r1", frozenAt: null, frozenLabel: null, frozenStatus: null, state: { available: false, ok: false, label: null }, study: null } })], liveEvidence: 1 })] });
    wrap(<PpapPage />, "/PPAP/p1");
    await userEvent.click(await screen.findByRole("button", { name: "Show Design records" }));
    expect(screen.getByText("Not shown")).toBeInTheDocument();
    expect(screen.getByText(/not allowed to read this record/)).toBeInTheDocument();
  });

  it("says when a frozen link has changed since it was submitted", async () => {
    load({ elements: [element({ evidence: [linkEvidence({ link: { targetKind: "control_plan_revision", targetId: "c1", frozenAt: "2026-11-26T09:00:00.000Z", frozenLabel: "CP-001 rev A", frozenStatus: "effective", state: { available: true, ok: true, status: "superseded", label: "CP-001 rev A", changedSince: true }, study: null } })], liveEvidence: 1 })] });
    wrap(<PpapPage />, "/PPAP/p1");
    await userEvent.click(await screen.findByRole("button", { name: "Show Design records" }));
    expect(screen.getByText(/Frozen when submitted: CP-001 rev A \(effective\)/)).toBeInTheDocument();
    expect(screen.getByText(/it has changed since/)).toBeInTheDocument();
  });

  it("links a record chosen from what fits, and refuses nothing silently", async () => {
    load();
    wrap(<PpapPage />, "/PPAP/p1");
    await userEvent.click(await screen.findByRole("button", { name: "Show Design records" }));
    apiFetch.mockImplementation(async (path, opts) => {
      if (path?.startsWith("/ppap-candidates")) return { data: [{ id: "pr1", kind: "part_revision", label: "BR-100 rev B", status: "released", ok: true, problem: null, linked: false }] };
      if (path === "/ppap-elements/e1/links" && opts?.method === "POST") return submission();
      return submission();
    });
    await userEvent.click(screen.getByRole("button", { name: "Link a record" }));
    const dialog = await screen.findByRole("dialog", { name: /Link a record: Design records/ });
    await userEvent.click(await within(dialog).findByRole("button", { name: "Link BR-100 rev B" }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/ppap-elements/e1/links", expect.objectContaining({ method: "POST", body: { kind: "part_revision", targetId: "pr1" } })));
  });

  it("offers no linking for the warrant, which is made, not linked", async () => {
    load({ elements: [element({ key: "part_submission_warrant", label: "Part Submission Warrant" })] });
    wrap(<PpapPage />, "/PPAP/p1");
    await userEvent.click(await screen.findByRole("button", { name: "Show Part Submission Warrant" }));
    expect(screen.queryByRole("button", { name: "Link a record" })).toBeNull();
  });
});
