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
import MyActionsPage from "./MyActionsPage";

const summary = (over = {}) => ({
  id: "f1", number: "FMEA-001", kind: "process", title: "Machining of the bracket", scopeText: "Turning and drilling", status: "active", owner: { id: "u1", name: "Ada" }, customer: null,
  currentRevisionId: "r1", currentLetter: "A", currentEffectiveFrom: "2026-11-01", openRevisionId: null, openStatus: null, openLetter: null, waitingForMe: false, reviewMonths: null,
  nextReviewOn: "2027-11-01", reviewOverdue: false, teamCount: 2, withdrawReason: null, createdAt: "2026-11-01T10:00:00Z", updatedAt: "2026-11-01T10:00:00Z", ...over,
});
const LEVELS = (word) => Array.from({ length: 10 }, (_, i) => ({ label: `${word} ${i + 1}` }));
const MODEL = { id: "m1", version: 1, method: "rpn", rpnHighFrom: 200, rpnMediumFrom: 100, severityFloor: 9, scale: { severity: LEVELS("Sev"), occurrence: LEVELS("Occ"), detection: LEVELS("Det") }, latestVersion: 1, isLatest: true };
const cause = (over = {}) => ({ id: "c1", text: "Tool wear", preventionControls: "Tool life counter", detectionControls: null, occurrence: 5, detection: 6, severityUsed: 8, rpn: 240, priority: "high", needsAttention: true, noActionReason: null, position: 1, fromBase: false, actions: [], ...over });
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
  counts: { items: 2, functions: 1, failureModes: 1, effects: 2, causes: 1, needAttention: 1, unrated: 0, openActions: 0, doneActions: 0, overdueActions: 0 },
};
const revision = (over = {}) => ({
  id: "r2", fmeaId: "f1", fmea: { id: "f1", number: "FMEA-001", kind: "process", title: "Machining of the bracket", status: "active" }, sequence: 2, letter: null, status: "draft",
  author: { id: "u1", name: "Ada" }, approver: null, changeSummary: null, previousRevisionId: "r1", submittedAt: null, returnedComment: null, returnedAt: null, returnedBy: null, approvalComment: null,
  approvedAt: null, approvedBy: null, effectiveFrom: null, supersededAt: null, withdrawReason: null, discardReason: null,
  team: [{ id: "t1", kind: "member", personId: "u1", name: "Ada", jobTitle: null, role: "lead" }],
  links: [{ kind: "part", id: "p1", code: null, reference: "BR-1", name: "Bracket", readable: true }],
  net: NET, model: MODEL, base: null, rowVersion: "100",
  problems: ["Say what changed and why", "Name the approver"], canEdit: true, canAct: true, canDecide: false, canRecall: false, createdAt: "2026-11-02T10:00:00Z", updatedAt: "2026-11-02T10:00:00Z", ...over,
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
    if (path === "/fmeas/f1") return { ...summary(), revisions: [{ id: "r1", sequence: 1, letter: "A", status: "effective", changeSummary: null, author: { id: "u1", name: "Ada" }, approver: null, effectiveFrom: "2026-11-01" }], inProgress: null, nextLetter: "B", canManage: true, canApprove: true, canStartRevision: true, canWithdraw: true, adoptableActions: 0, reviews: [], canReview: true };
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
    if (path === "/fmea-causes/c1/actions") return revision();
    if (path === "/fmea-actions/a1/complete") return { id: "a1", status: "done", evidenceNote: opts.body.note, revisedOccurrence: opts.body.revisedOccurrence ?? null, revisedRpn: 192, revisedPriority: "medium" };
    if (path === "/fmea-actions/a1/reopen") return { id: "a1", status: "open", evidenceNote: null, revisedRpn: null };
    if (path.startsWith("/fmea-actions/mine")) {
      return {
        data: [{ id: "a1", kind: "prevention", description: "Change the tool every 50 parts", dueOn: "2020-01-01", status: "open", fmeaId: "f1", fmeaNumber: "FMEA-001", fmeaTitle: "Machining of the bracket", fmeaKind: "process", revisionId: "r1", revisionLetter: "A", revisionStatus: "effective", causeText: "Tool wear", occurrence: 8, detection: 8, adopted: false }],
        openCount: 1, overdueCount: 1,
      };
    }
    if (path === "/fmea-model") return { version: 1, config: { scales: { process: { severity: LEVELS("Sev"), occurrence: LEVELS("Occ"), detection: LEVELS("Det") } } }, versions: [], canChange: false };
    if (path === "/fmeas/f1/revisions") return { ...summary(), inProgress: { id: "r2", status: "draft", letter: null, sequence: 2 }, revisions: [], reviews: [] };
    if (path === "/fmeas/f1/reviews") return { ...summary(), inProgress: null, revisions: [], reviews: [{ id: "v1", outcome: "no_change", note: opts.body.note, revisionLetter: "A", startedLetter: null, wasDueOn: null, nextReviewOn: "2028-01-01", by: { id: "u1", name: "Ada" }, at: "2026-11-25T10:00:00Z" }] };
    if (path === "/fmea-revisions/r2/compare") {
      return {
        comparable: true, older: { id: "r1", letter: "A", sequence: 1 }, newer: { id: "r2", letter: null, sequence: 2 },
        counts: { added: 1, removed: 0, changed: 1, same: 4 },
        changes: [
          { kind: "cause", change: "changed", rowId: "c1", label: "Tool wear", path: ["Bracket machining", "OP10 Turn", "Bore oversize"], fields: [{ field: "occurrence", from: 8, to: 3 }, { field: "priority", from: "high", to: "medium" }] },
          { kind: "cause", change: "added", rowId: "c9", label: "Coolant dirty", path: ["Bracket machining", "OP10 Turn", "Bore oversize"], fields: [] },
        ],
      };
    }
    if (path === "/fmea-revisions/r2/base-changes") return { hasBase: false };
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

describe("actions, My actions, comparing and the review (FM4)", () => {
  const open = () =>
    renderAt("/FMEA/f1/revisions/r2", (
      <Routes>
        <Route path="/FMEA/:id/revisions/:revisionId" element={<RevisionPage />} />
      </Routes>
    ));
  const action = (over = {}) => ({
    id: "a1", causeId: "c1", revisionId: "r2", kind: "prevention", description: "Change the tool every 50 parts", owner: { kind: "member", id: "u2", name: "Quinn" }, dueOn: "2030-01-01", status: "open",
    overdue: false, evidenceNote: null, doneAt: null, doneBy: null, revisedOccurrence: null, revisedDetection: null, revisedRpn: null, revisedPriority: null, revisedNeedsAttention: null,
    cancelReason: null, adopted: false, carried: false, isMine: false, canComplete: true, canReopen: false, canEdit: true, createdAt: "2026-11-02T10:00:00Z", ...over,
  });

  it("gives an action to a cause with the owner and a due date ready, and sends it", async () => {
    open();
    const group = await screen.findByRole("group", { name: "Actions for Tool wear" });
    await userEvent.click(within(group).getByRole("button", { name: "Add an action" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText(/^What is to be done/), "Change the tool every 50 parts");
    await userEvent.click(within(dialog).getByRole("combobox", { name: /^Who does it/ }));
    await userEvent.click(await screen.findByRole("option", { name: /Quinn/ }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Add the action" }));
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        "/fmea-causes/c1/actions",
        expect.objectContaining({ method: "POST", body: expect.objectContaining({ kind: "prevention", description: "Change the tool every 50 parts", ownerUserId: "u2", dueOn: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) }) }),
      ),
    );
  });

  it("shows an action under its cause, and finishes it with what was found and the revised rating", async () => {
    current = revision({ net: { ...NET, items: [{ ...NET.items[0], children: [{ ...NET.items[0].children[0], functions: [{ ...NET.items[0].children[0].functions[0], failureModes: [{ ...NET.items[0].children[0].functions[0].failureModes[0], causes: [cause({ actions: [action()] })] }] }] }] }] } });
    open();
    const group = await screen.findByRole("group", { name: "Actions for Tool wear" });
    expect(within(group).getByText("Change the tool every 50 parts")).toBeInTheDocument();
    expect(within(group).getByText(/Quinn/)).toBeInTheDocument();
    await userEvent.click(within(group).getByRole("button", { name: "Finish" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "Mark as done" })).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText(/^What was found/), "Tool changed every 50 parts for a month");
    await userEvent.click(within(dialog).getByRole("combobox", { name: /^Occurrence now/ }));
    await userEvent.click(await screen.findByRole("option", { name: /^3 · Occ 3/ }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Mark as done" }));
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith("/fmea-actions/a1/complete", expect.objectContaining({ method: "POST", body: expect.objectContaining({ note: "Tool changed every 50 parts for a month", revisedOccurrence: 3 }) })),
    );
  });

  it("shows a late action as late, and a finished one with what it comes to and a way to reopen it", async () => {
    const done = action({ id: "a2", status: "done", evidenceNote: "Gauged for a month", revisedOccurrence: 3, revisedRpn: 192, revisedPriority: "medium", canComplete: false, canReopen: true, canEdit: false, doneBy: { id: "u2", name: "Quinn" }, doneAt: "2026-11-20T10:00:00Z" });
    const late = action({ overdue: true, dueOn: "2020-01-01" });
    current = revision({ net: { ...NET, items: [{ ...NET.items[0], children: [{ ...NET.items[0].children[0], functions: [{ ...NET.items[0].children[0].functions[0], failureModes: [{ ...NET.items[0].children[0].functions[0].failureModes[0], causes: [cause({ actions: [late, done] })] }] }] }] }] } });
    open();
    const group = await screen.findByRole("group", { name: "Actions for Tool wear" });
    expect(within(group).getByText(/Late: was due/)).toBeInTheDocument();
    expect(within(group).getByText(/Gauged for a month/)).toBeInTheDocument();
    expect(within(group).getByText(/O 5 → 3 · RPN 192 · Medium/)).toBeInTheDocument();
    expect(within(group).getByRole("button", { name: "Reopen" })).toBeInTheDocument();
  });

  it("offers a reader no way to add, change or cancel an action", async () => {
    held = ["fmea.read"];
    current = revision({ canEdit: false, canAct: false, status: "effective", letter: "B", problems: [], net: { ...NET, items: [{ ...NET.items[0], children: [{ ...NET.items[0].children[0], functions: [{ ...NET.items[0].children[0].functions[0], failureModes: [{ ...NET.items[0].children[0].functions[0].failureModes[0], causes: [cause({ actions: [action({ canEdit: false, canComplete: false })] })] }] }] }] }] } });
    open();
    const group = await screen.findByRole("group", { name: "Actions for Tool wear" });
    expect(within(group).queryByRole("button", { name: "Add an action" })).toBeNull();
    expect(within(group).queryByRole("button", { name: /Change the action/ })).toBeNull();
    expect(within(group).queryByRole("button", { name: "Finish" })).toBeNull();
  });

  it("shows what changed since the last revision only when asked, field by field", async () => {
    open();
    await userEvent.click(await screen.findByRole("button", { name: "Show what changed" }));
    const list = await screen.findByRole("list", { name: "Changes" });
    expect(screen.getByLabelText("Comparison figures")).toHaveTextContent("1 added · 0 removed · 1 changed · 4 unchanged");
    expect(within(list).getByText("Tool wear")).toBeInTheDocument();
    expect(within(list).getByText(/Occurrence:/)).toHaveTextContent("Occurrence: 8 → 3");
    expect(within(list).getByText(/Priority:/)).toHaveTextContent("Priority: High → Medium");
    expect(within(list).getByText("Coolant dirty")).toBeInTheDocument();
  });

  it("tells a part FMEA that its base has moved on, and lists what changed there on request", async () => {
    current = revision({ base: { fmeaId: "f0", number: "FMEA-000", title: "Generic machining", revisionId: "r0", letter: "A" } });
    const base = { hasBase: true, readable: true, moved: true, base: { fmeaId: "f0", number: "FMEA-000", title: "Generic machining", copiedLetter: "A", currentLetter: "B" }, counts: { added: 0, removed: 0, changed: 1, same: 5 }, changes: [{ kind: "cause", change: "changed", rowId: "x", label: "Tool wear", path: ["Bracket"], fields: [{ field: "occurrence", from: 8, to: 4 }] }] };
    const original = apiFetch.getMockImplementation();
    apiFetch.mockImplementation(async (path, opts) => (path === "/fmea-revisions/r2/base-changes" ? base : original(path, opts)));
    open();
    expect(await screen.findByText("The base has moved on")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Show what changed in the base" }));
    expect(await screen.findByRole("list", { name: "Changes in the base" })).toHaveTextContent("Occurrence: 8 → 4");
  });

  describe("on the FMEA", () => {
    const openFmea = () =>
      renderAt("/FMEA/f1", (
        <Routes>
          <Route path="/FMEA/:id" element={<FmeaPage />} />
          <Route path="/FMEA/:id/revisions/:revisionId" element={<div>the revision</div>} />
        </Routes>
      ));

    it("asks whether to take the finished actions in when starting a revision, and sends the choice", async () => {
      const original = apiFetch.getMockImplementation();
      apiFetch.mockImplementation(async (path, opts) => (path === "/fmeas/f1" ? { ...(await original(path, opts)), adoptableActions: 2 } : original(path, opts)));
      openFmea();
      await userEvent.click(await screen.findByRole("button", { name: "Start a new revision" }));
      const dialog = await screen.findByRole("dialog");
      expect(dialog).toHaveTextContent("2 finished actions have not been taken into the analysis yet");
      await userEvent.click(within(dialog).getByRole("button", { name: "Start the revision" }));
      await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/fmeas/f1/revisions", expect.objectContaining({ method: "POST", body: { adopt: true } })));
      expect(await screen.findByText("the revision")).toBeInTheDocument();
    });

    it("starts a revision at once when no finished action is waiting", async () => {
      openFmea();
      await userEvent.click(await screen.findByRole("button", { name: "Start a new revision" }));
      await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/fmeas/f1/revisions", expect.objectContaining({ method: "POST" })));
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("records a review with what was checked", async () => {
      openFmea();
      await userEvent.click(await screen.findByRole("button", { name: "Record a review" }));
      const dialog = await screen.findByRole("dialog");
      expect(within(dialog).getByRole("button", { name: "Record the review" })).toBeDisabled();
      await userEvent.type(within(dialog).getByLabelText(/^What you checked/), "Checked against this year's scrap data");
      await userEvent.click(within(dialog).getByRole("button", { name: "Record the review" }));
      await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/fmeas/f1/reviews", expect.objectContaining({ method: "POST", body: { outcome: "no_change", note: "Checked against this year's scrap data" } })));
    });
  });

  describe("My actions", () => {
    it("lists the actions given to me, late ones flagged, and finishes one with the ratings of its scale", async () => {
      renderAt("/FMEA/My-Actions", <MyActionsPage />);
      const list = await screen.findByRole("list", { name: "My FMEA actions" });
      expect(within(list).getByText("Change the tool every 50 parts")).toBeInTheDocument();
      expect(within(list).getByRole("link", { name: /FMEA-001 · Machining of the bracket · rev A/ })).toHaveAttribute("href", "/FMEA/f1/revisions/r1");
      expect(screen.getByText("1 action is late.")).toBeInTheDocument();
      await userEvent.click(within(list).getByRole("button", { name: "Finish" }));
      const dialog = await screen.findByRole("dialog");
      await userEvent.type(within(dialog).getByLabelText(/^What was found/), "Done on both lathes");
      await userEvent.click(within(dialog).getByRole("button", { name: "Mark as done" }));
      await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/fmea-actions/a1/complete", expect.objectContaining({ method: "POST", body: expect.objectContaining({ note: "Done on both lathes" }) })));
    });
  });
});
