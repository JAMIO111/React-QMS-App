import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("../../lib/api-client", async (orig) => ({ ...(await orig()), apiFetch: vi.fn() }));
vi.mock("../../contexts/OrganisationProvider", () => ({ useOrganisation: () => ({ organisationId: "org-1" }) }));
vi.mock("../../contexts/ToastProvider", () => ({ useToast: () => ({ showToast: vi.fn() }) }));
let held = ["fmea.read", "fmea.manage"];
vi.mock("../ncr/Pickers", () => ({ PartyPicker: () => null, PartPicker: () => null, MachinePicker: () => null, RemoteComboBox: () => null }));
vi.mock("../../hooks/useQmsApi", () => ({ usePermissions: () => ({ can: (p) => held.includes(p), isLoading: false }) }));

import { apiFetch } from "../../lib/api-client";
import FmeaPage from "./FmeaPage";
import FmeaRegisterPage from "./FmeaRegisterPage";
import RevisionPage from "./RevisionPage";

const summary = (over = {}) => ({
  id: "f1", number: "FMEA-001", kind: "process", title: "Machining of the bracket", scopeText: "Turning and drilling", status: "active", owner: { id: "u1", name: "Ada" }, customer: null,
  currentRevisionId: "r1", currentLetter: "A", currentEffectiveFrom: "2026-11-01", openRevisionId: null, openStatus: null, openLetter: null, waitingForMe: false, reviewMonths: null,
  nextReviewOn: "2027-11-01", reviewOverdue: false, teamCount: 2, withdrawReason: null, createdAt: "2026-11-01T10:00:00Z", updatedAt: "2026-11-01T10:00:00Z", ...over,
});
const revision = (over = {}) => ({
  id: "r2", fmeaId: "f1", fmea: { id: "f1", number: "FMEA-001", kind: "process", title: "Machining of the bracket", status: "active" }, sequence: 2, letter: null, status: "draft",
  author: { id: "u1", name: "Ada" }, approver: null, changeSummary: null, previousRevisionId: "r1", submittedAt: null, returnedComment: null, returnedAt: null, returnedBy: null, approvalComment: null,
  approvedAt: null, approvedBy: null, effectiveFrom: null, supersededAt: null, withdrawReason: null, discardReason: null,
  team: [{ id: "t1", kind: "member", personId: "u1", name: "Ada", jobTitle: null, role: "lead" }],
  links: [{ kind: "part", id: "p1", code: null, reference: "BR-1", name: "Bracket", readable: true }],
  problems: ["Say what changed and why", "Name the approver"], canEdit: true, canDecide: false, canRecall: false, createdAt: "2026-11-02T10:00:00Z", updatedAt: "2026-11-02T10:00:00Z", ...over,
});

const renderAt = (path, ui) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
};

let current;
beforeEach(() => {
  held = ["fmea.read", "fmea.manage"];
  apiFetch.mockReset();
  current = revision();
  apiFetch.mockImplementation(async (path, opts) => {
    if (path.startsWith("/fmeas?")) return { data: [summary(), summary({ id: "f2", number: "FMEA-002", kind: "design", title: "Bracket design", status: "draft", currentLetter: null, waitingForMe: true })], page: 1, pageSize: 50, total: 2 };
    if (path === "/fmeas" && opts?.method === "POST") return summary({ id: "f9", number: "FMEA-009" });
    if (path === "/fmea-people") return { data: [{ id: "u1", name: "Ada", canApprove: true }, { id: "u2", name: "Quinn", canApprove: true }] };
    if (path === "/employees/lookup") return { data: [] };
    if (path === "/fmeas/f1") return { ...summary(), revisions: [{ id: "r1", sequence: 1, letter: "A", status: "effective", changeSummary: null, author: { id: "u1", name: "Ada" }, approver: null, effectiveFrom: "2026-11-01" }], inProgress: null, nextLetter: "B", canManage: true, canApprove: true, canStartRevision: true, canWithdraw: true };
    if (path === "/fmea-revisions/r2" && !opts?.method) return current;
    if (path === "/fmea-revisions/r2/approver") {
      current = revision({ approver: { id: opts.body.approverId, name: "Quinn" }, problems: ["Say what changed and why"] });
      return current;
    }
    if (path === "/fmea-revisions/r2/approve") return revision({ status: "effective", letter: "B" });
    return {};
  });
});

describe("the register", () => {
  it("lists FMEAs with what they are, and flags the one waiting for the reader", async () => {
    renderAt("/FMEA", <FmeaRegisterPage />);
    const table = await screen.findByRole("table", { name: "FMEAs" });
    expect(within(table).getByRole("link", { name: "FMEA-001" })).toHaveAttribute("href", "/FMEA/f1");
    expect(within(table).getByText(/^Rev A from/)).toBeInTheDocument();
    expect(within(table).getByText("Waiting for you")).toBeInTheDocument();
    expect(within(table).getByText("Design FMEA")).toBeInTheDocument();
  });

  it("offers Start an FMEA only to people who may prepare them, and sends the new FMEA", async () => {
    held = ["fmea.read"];
    const first = renderAt("/FMEA", <FmeaRegisterPage />);
    await screen.findByRole("table", { name: "FMEAs" });
    expect(screen.queryByRole("button", { name: "Start an FMEA" })).toBeNull();
    first.unmount();

    held = ["fmea.read", "fmea.manage"];
    renderAt("/FMEA", <FmeaRegisterPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Start an FMEA" }));
    await userEvent.type(screen.getByLabelText(/Title/), "Casting of the housing");
    await userEvent.click(screen.getByRole("button", { name: "Start the FMEA" }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/fmeas", expect.objectContaining({ method: "POST", body: expect.objectContaining({ kind: "process", title: "Casting of the housing" }) })));
  });
});

describe("an FMEA", () => {
  it("shows its details and revisions and offers a new revision", async () => {
    renderAt("/FMEA/f1", (
      <Routes>
        <Route path="/FMEA/:id" element={<FmeaPage />} />
      </Routes>
    ));
    expect(await screen.findByText("Machining of the bracket")).toBeInTheDocument();
    const list = screen.getByRole("list", { name: "Revisions" });
    expect(within(list).getByRole("link", { name: "rev A" })).toHaveAttribute("href", "/FMEA/f1/revisions/r1");
    expect(screen.getByRole("button", { name: "Start a new revision" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Withdraw" })).toBeInTheDocument();
  });
});

describe("a revision", () => {
  const open = () =>
    renderAt("/FMEA/f1/revisions/r2", (
      <Routes>
        <Route path="/FMEA/:id/revisions/:revisionId" element={<RevisionPage />} />
      </Routes>
    ));

  it("lists what is still needed and keeps Submit shut until nothing is", async () => {
    open();
    const needed = await screen.findByRole("list", { name: "Still needed" });
    expect(within(needed).getByText("Name the approver")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Submit for approval" })).toBeDisabled();
    expect(screen.getByRole("list", { name: "Team" })).toHaveTextContent("Team lead");
    expect(screen.getByRole("list", { name: "What it covers" })).toHaveTextContent("BR-1 · Bracket");
  });

  it("names the approver from those who can approve and are not the preparer", async () => {
    open();
    await userEvent.click(await screen.findByRole("button", { name: "Name the approver" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("combobox", { name: /Approver/ }));
    expect(screen.queryByRole("option", { name: "Ada" })).toBeNull();
    await userEvent.click(await screen.findByRole("option", { name: "Quinn" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/fmea-revisions/r2/approver", expect.objectContaining({ method: "PUT", body: { approverId: "u2" } })));
  });

  it("offers the named approver Approve and Send back, and approves from a date", async () => {
    current = revision({ status: "pending_approval", letter: "B", canEdit: false, canDecide: true, canRecall: true, approver: { id: "u2", name: "Quinn" }, problems: [] });
    open();
    expect(await screen.findByText(/The revision is frozen while it waits/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Submit for approval" })).toBeNull();
    expect(screen.getByRole("button", { name: "Send back" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/fmea-revisions/r2/approve", expect.objectContaining({ method: "POST", body: expect.objectContaining({ effectiveFrom: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) }) })));
  });

  it("shows a read-only reader no controls", async () => {
    held = ["fmea.read"];
    current = revision({ status: "effective", letter: "B", canEdit: false, canDecide: false, canRecall: false, problems: [], approver: { id: "u2", name: "Quinn" }, effectiveFrom: "2026-11-02", approvedAt: "2026-11-02T10:00:00Z", approvedBy: { id: "u2", name: "Quinn" } });
    open();
    expect(await screen.findByText(/; in force from/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Change" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Discard draft" })).toBeNull();
  });
});
