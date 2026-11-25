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
});
