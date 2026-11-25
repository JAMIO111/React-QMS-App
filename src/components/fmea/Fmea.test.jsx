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
vi.mock("../../contexts/ConfirmationModalProvider", () => ({ useConfirm: () => async () => true }));
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
const LEVELS = (word) => Array.from({ length: 10 }, (_, i) => ({ label: `${word} ${i + 1}` }));
const MODEL = { id: "m1", version: 1, method: "rpn", rpnHighFrom: 200, rpnMediumFrom: 100, severityFloor: 9, scale: { severity: LEVELS("Sev"), occurrence: LEVELS("Occ"), detection: LEVELS("Det") }, latestVersion: 1, isLatest: true };
const cause = (over = {}) => ({ id: "c1", text: "Tool wear", preventionControls: "Tool life counter", detectionControls: null, occurrence: 5, detection: 6, severityUsed: 8, rpn: 240, priority: "high", needsAttention: true, noActionReason: null, position: 1, fromBase: false, ...over });
const NET = {
  items: [
    {
      id: "i1", kind: "item", elementType: null, name: "Bracket machining", description: null, operationCode: null, machine: null, part: null, position: 1, fromBase: false, functions: [],
      children: [
        {
          id: "i2", kind: "step", elementType: null, name: "OP10 Turn", description: null, operationCode: "OP10", machine: null, part: null, position: 1, fromBase: false, children: [],
          functions: [
            {
              id: "f1", text: "Turn the bore to 25.00", requirement: null, characteristicKey: null, position: 1, fromBase: false,
              failureModes: [
                {
                  id: "m1", text: "Bore oversize", specialClass: "critical", position: 1, fromBase: false,
                  effects: [{ id: "e1", level: "own_plant", text: "Scrap", severity: 4, position: 1, fromBase: false }, { id: "e2", level: "end_user", text: "Leaks", severity: 8, position: 2, fromBase: false }],
                  causes: [cause()],
                },
              ],
            },
          ],
        },
      ],
    },
  ],
  counts: { items: 2, functions: 1, failureModes: 1, effects: 2, causes: 1, needAttention: 1, unrated: 0 },
};
const revision = (over = {}) => ({
  id: "r2", fmeaId: "f1", fmea: { id: "f1", number: "FMEA-001", kind: "process", title: "Machining of the bracket", status: "active" }, sequence: 2, letter: null, status: "draft",
  author: { id: "u1", name: "Ada" }, approver: null, changeSummary: null, previousRevisionId: "r1", submittedAt: null, returnedComment: null, returnedAt: null, returnedBy: null, approvalComment: null,
  approvedAt: null, approvedBy: null, effectiveFrom: null, supersededAt: null, withdrawReason: null, discardReason: null,
  team: [{ id: "t1", kind: "member", personId: "u1", name: "Ada", jobTitle: null, role: "lead" }],
  links: [{ kind: "part", id: "p1", code: null, reference: "BR-1", name: "Bracket", readable: true }],
  net: NET, model: MODEL, base: null, rowVersion: "100",
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
    if (path === "/fmea-items/i2/functions") {
      current = revision({ net: { ...NET, counts: { ...NET.counts, functions: 2 } } });
      return current;
    }
    if (path === "/fmea-causes/c1" && opts?.method === "DELETE") {
      current = revision({ net: { ...NET, counts: { ...NET.counts, causes: 0, needAttention: 0 } } });
      return current;
    }
    if (path === "/fmea-revisions/r2/use-latest-model") {
      current = revision({ model: { ...MODEL, version: 2, latestVersion: 2, isLatest: true } });
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

describe("starting from a base", () => {
  it("sends the FMEA in force it is copied from", async () => {
    renderAt("/FMEA", <FmeaRegisterPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Start an FMEA" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("combobox", { name: /Start from an FMEA in force/ }));
    await userEvent.click(await screen.findByRole("option", { name: /FMEA-001 · Machining of the bracket/ }));
    await userEvent.type(within(dialog).getByLabelText(/Title/), "Machining (customer B)");
    await userEvent.click(within(dialog).getByRole("button", { name: "Start the FMEA" }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/fmeas", expect.objectContaining({ method: "POST", body: expect.objectContaining({ baseFmeaId: "f1", title: "Machining (customer B)" }) })));
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

  describe("the analysis", () => {
    it("shows the structure as a tree with the effects, the causes and what the database worked out", async () => {
      open();
      const tree = await screen.findByRole("list", { name: "Structure" });
      expect(within(tree).getByText("Bracket machining")).toBeInTheDocument();
      expect(within(tree).getByText("OP10 Turn")).toBeInTheDocument();
      expect(within(tree).getByText("Turn the bore to 25.00")).toBeInTheDocument();
      expect(within(tree).getByText("Critical")).toBeInTheDocument();
      const causes = within(tree).getByRole("region", { name: "Causes of Bore oversize" });
      expect(within(causes).getByText("High · RPN 240")).toBeInTheDocument();
      expect(within(causes).getByText("Needs attention")).toBeInTheDocument();
      expect(within(causes).getByText("8 · Sev 8")).toBeInTheDocument();
      expect(screen.getByLabelText("Analysis figures")).toHaveTextContent("2 items · 1 failure mode · 1 cause · 1 needs attention · 0 not rated");
      expect(screen.getByText(/Rated with model version 1 \(RPN: high from 200, medium from 100; severity 9 or more always needs attention\)/)).toBeInTheDocument();
    });

    it("adds a function through the server and waits for its answer", async () => {
      open();
      const tree = await screen.findByRole("list", { name: "Structure" });
      const actions = within(tree).getAllByRole("button", { name: "Actions" });
      await userEvent.click(actions[1]); // the step's menu
      await userEvent.click(await screen.findByRole("menuitem", { name: "Add a function" }));
      const dialog = await screen.findByRole("dialog");
      await userEvent.type(within(dialog).getByLabelText(/^Function/), "Chamfer the edge");
      await userEvent.click(within(dialog).getByRole("button", { name: "Add" }));
      await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/fmea-items/i2/functions", expect.objectContaining({ method: "POST", body: expect.objectContaining({ text: "Chamfer the edge" }) })));
    });

    it("offers to score again on the latest model, and no controls to a reader", async () => {
      current = revision({ model: { ...MODEL, isLatest: false, latestVersion: 2 } });
      open();
      await userEvent.click(await screen.findByRole("button", { name: "Use version 2 and score again" }));
      await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/fmea-revisions/r2/use-latest-model", expect.objectContaining({ method: "POST" })));
    });

    it("shows where an analysis started from when it was copied from a base", async () => {
      current = revision({ base: { fmeaId: "f0", number: "FMEA-000", title: "Generic machining", revisionId: "r0", letter: "A" } });
      open();
      const note = await screen.findByText(/This analysis began as a copy of/);
      expect(note).toHaveTextContent("FMEA-000 rev A");
      expect(within(note.closest("div")).getByRole("link", { name: "FMEA-000 rev A" })).toHaveAttribute("href", "/FMEA/f0/revisions/r0");
    });

    it("gives a reader the analysis without any way to change it", async () => {
      held = ["fmea.read"];
      current = revision({ canEdit: false, status: "effective", letter: "B", problems: [] });
      open();
      const tree = await screen.findByRole("list", { name: "Structure" });
      expect(within(tree).queryByRole("button", { name: "Actions" })).toBeNull();
      expect(screen.queryByRole("button", { name: /^Add a process item/ })).toBeNull();
    });
  });
});
