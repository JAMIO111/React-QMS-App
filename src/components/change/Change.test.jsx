import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("../../lib/api-client", async (orig) => ({ ...(await orig()), apiFetch: vi.fn() }));
vi.mock("../../contexts/OrganisationProvider", () => ({ useOrganisation: () => ({ organisationId: "org-1" }) }));
vi.mock("../../contexts/ToastProvider", () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock("../../contexts/AuthProvider", () => ({ useAuth: () => ({ user: { id: "u1" } }) }));
const permissions = new Set(["change.read", "change.manage"]);
vi.mock("../../hooks/useQmsApi", () => ({ usePermissions: () => ({ can: (p) => permissions.has(p), isLoading: false }) }));
vi.mock("../../lib/breadcrumbs", () => ({ useBreadcrumbNames: () => {} }));

import { apiFetch } from "../../lib/api-client";
import { cutInWords, draftProblems, formatDay, linksBody, linkWords, sameLink, stageLabel, stepState } from "../../lib/change";
import ChangePage from "./ChangePage";
import ChangeNoticePage from "./ChangeNoticePage";
import ChangeRegisterPage from "./ChangeRegisterPage";

const type = { id: "t1", key: "process", label: "Process", description: null, sequence: 1, active: true, needsCustomerApproval: true, changes: 1 };
const summary = {
  id: "c1", reference: "ECR-26-0001", title: "Move bracket to CNC 7", stage: "draft", urgency: "expedited", type: { id: "t1", label: "Process", needsCustomerApproval: true },
  raisedBy: { id: "u1", name: "Ada Owner" }, originKind: "ncr", linkCount: 1, fileCount: 0, createdAt: "2026-11-24T10:00:00Z", updatedAt: "2026-11-24T10:00:00Z",
};
const detail = {
  ...summary, description: "Run it on machine 7", reason: null, rowVersion: "1",
  links: [{ kind: "part", id: "p1", code: null, reference: "BR-100", name: "Bracket", readable: true }],
  origin: { kind: "ncr", id: "n1", reference: "NC-26-0012", name: "Cracked weld", readable: true },
  attachments: [], cancelReason: null, cancelledAt: null, cancelledBy: null, canManage: true, canEdit: true, canCancel: true, canAddFiles: true,
  reviewRound: 0, returnReason: null, submittedAt: null, approvedAt: null, approvedBy: null, typeNeedsCustomerApproval: true,
  customerApproval: { status: null, reference: null, on: null, waivedReason: null },
  cutIn: { kind: "none", date: null, order: null, lot: null, serial: null, stockAction: null, stockNote: null },
  impacts: [], board: [], signoffs: [], problems: ["Say why"],
  canEditType: true, canSubmit: true, canAssess: false, canSendToBoard: false, canRecall: false, canSetCutIn: true, canSetCustomerApproval: true,
};
const area = (over) => ({ id: "i1", areaId: "a1", key: "design", label: "Design and drawing", description: "The drawing", status: "not_assessed", note: null, assessedAt: null, assessedBy: null, ...over });
const assessing = { ...detail, stage: "assessment", canSubmit: false, canAssess: true, canSendToBoard: true, problems: ["1 impact area still to assess"], impacts: [area({}), area({ id: "i2", areaId: "a2", key: "process", label: "Process and control plan", status: "not_affected" })] };
const withBoard = { ...detail, stage: "approval", reviewRound: 1, canSubmit: false, canRecall: true, canEdit: false, problems: [],
  board: [{ id: "b1", function: { id: "f1", label: "Quality" }, signer: { id: "u2", name: "Quinn Manager" } }],
  signoffs: [{ id: "s1", round: 1, function: { id: "f1", label: "Quality" }, signer: { id: "u2", name: "Quinn Manager" }, status: "pending", comment: null, decidedAt: null, canDecide: true }] };
const approved = { ...withBoard, stage: "approved", canRecall: false, approvedAt: "2026-11-25T10:00:00Z", approvedBy: "Quinn Manager",
  signoffs: [{ ...withBoard.signoffs[0], status: "approved", comment: "Agreed", decidedAt: "2026-11-25T10:00:00Z", canDecide: false }],
  cutIn: { kind: "date", date: "2026-12-01", order: null, lot: null, serial: null, stockAction: "use_up", stockNote: "Finish the batch" },
  customerApproval: { status: "approved", reference: "ACME-77", on: "2026-11-26", waivedReason: null } };

const renderAt = (path, element, route = path) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path={route} element={element} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
};

let current = detail;
beforeEach(() => {
  current = detail;
  apiFetch.mockReset();
  permissions.clear();
  ["change.read", "change.manage"].forEach((p) => permissions.add(p));
  apiFetch.mockImplementation(async (path) => {
    if (path.startsWith("/change-types")) return { data: [type] };
    if (path.startsWith("/changes/c1/attachments")) return { data: [] };
    if (path.startsWith("/change-functions")) return { data: [{ id: "f1", key: "quality", label: "Quality", description: null, active: true }] };
    if (path.startsWith("/change-signers")) return { data: [{ id: "u2", name: "Quinn Manager", canApprove: true }, { id: "u3", name: "Vic Viewer", canApprove: false }] };
    if (path.startsWith("/changes/c1")) return current;
    if (path.startsWith("/changes?")) return { data: [summary], page: 1, pageSize: 50, total: 1 };
    return {};
  });
});

describe("the change register", () => {
  it("lists changes with their stage, type and where they came from", async () => {
    renderAt("/Change", <ChangeRegisterPage />);
    const table = await screen.findByRole("table", { name: "Changes" });
    expect(within(table).getByRole("link", { name: "ECR-26-0001" })).toHaveAttribute("href", "/Change/c1");
    expect(within(table).getByText("Move bracket to CNC 7")).toBeInTheDocument();
    expect(within(table).getByText("Expedited")).toBeInTheDocument();
    expect(within(table).getByText("Non-conformance")).toBeInTheDocument();
    expect(within(table).getByText("Draft")).toBeInTheDocument();
  });

  it("offers to raise a change only to people who may manage them", async () => {
    renderAt("/Change", <ChangeRegisterPage />);
    expect(await screen.findByRole("button", { name: "Raise a change" })).toBeInTheDocument();
  });

  it("hides that button from a reader", async () => {
    permissions.delete("change.manage");
    renderAt("/Change", <ChangeRegisterPage />);
    await screen.findByRole("table", { name: "Changes" });
    expect(screen.queryByRole("button", { name: "Raise a change" })).not.toBeInTheDocument();
  });

  it("asks the server for in-progress changes by default and for all when chosen", async () => {
    renderAt("/Change", <ChangeRegisterPage />);
    await screen.findByRole("table", { name: "Changes" });
    await userEvent.click(screen.getByRole("button", { name: "All" }));
    await waitFor(() => expect(apiFetch.mock.calls.some(([path]) => path.startsWith("/changes?") && path.includes("stage=all"))).toBe(true));
  });
});

describe("the change page", () => {
  it("shows what is changing, where it came from, what it covers and what is still needed", async () => {
    renderAt("/Change/c1", <ChangePage />, "/Change/:id");
    expect(await screen.findByRole("heading", { name: "ECR-26-0001" })).toBeInTheDocument();
    expect(screen.getByText("Run it on machine 7")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /NC-26-0012 · Cracked weld/ })).toHaveAttribute("href", "/Non-Conformance/Register/n1");
    expect(screen.getByRole("link", { name: /BR-100 · Bracket/ })).toHaveAttribute("href", "/Parts/p1");
    const needed = screen.getByRole("list", { name: "Still needed" });
    expect(within(needed).getByText("Say why")).toBeInTheDocument();
    expect(within(needed).queryByText("Say what is changing")).not.toBeInTheDocument();
  });

  it("says a change came in through the portal and who sent it, without a link", async () => {
    current = { ...detail, originKind: "portal_request", origin: { kind: "portal_request", id: "r1", parentId: null, reference: "Customer request", name: "Wayne Ltd · Pat Quality", readable: true } };
    renderAt("/Change/c1", <ChangePage />, "/Change/:id");
    expect(await screen.findByText(/Sent in through the portal:/)).toBeInTheDocument();
    expect(screen.getByText("Customer request · Wayne Ltd · Pat Quality")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Wayne Ltd/ })).toBeNull();
  });

  it("offers editing and cancelling to a manager, and neither to a reader", async () => {
    renderAt("/Change/c1", <ChangePage />, "/Change/:id");
    expect(await screen.findByRole("button", { name: "Edit details" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel change" })).toBeInTheDocument();
  });

  it("offers nothing to change on a change that has left draft", async () => {
    apiFetch.mockImplementation(async (path) => {
      if (path.startsWith("/changes/c1/attachments")) return { data: [] };
      if (path.startsWith("/changes/c1")) return { ...detail, stage: "cancelled", canEdit: false, canCancel: false, canAddFiles: false, cancelReason: "Raised twice", cancelledAt: "2026-11-24T11:00:00Z" };
      return {};
    });
    renderAt("/Change/c1", <ChangePage />, "/Change/:id");
    expect(await screen.findByText(/Raised twice/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit details" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel change" })).not.toBeInTheDocument();
  });

  it("cancels with a reason sent to the server", async () => {
    renderAt("/Change/c1", <ChangePage />, "/Change/:id");
    await userEvent.click(await screen.findByRole("button", { name: "Cancel change" }));
    const reason = screen.getByLabelText("Why is it cancelled?");
    await userEvent.type(reason, "Raised twice");
    await userEvent.click(screen.getByRole("button", { name: "Cancel the change" }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/changes/c1/cancel", expect.objectContaining({ method: "POST", body: { reason: "Raised twice" } })));
  });
});

describe("moving a change on", () => {
  it("shows the stages and offers to submit a draft only when nothing is missing", async () => {
    renderAt("/Change/c1", <ChangePage />, "/Change/:id");
    const stages = await screen.findByRole("list", { name: "Stages" });
    expect(within(stages).getByText("Draft").closest("li")).toHaveAttribute("aria-current", "step");
    expect(screen.getByRole("button", { name: "Submit for assessment" })).toBeDisabled();
    current = { ...detail, problems: [] };
    renderAt("/Change/c1", <ChangePage />, "/Change/:id");
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Submit for assessment" }).some((b) => !b.disabled)).toBe(true));
  });

  it("submits for assessment", async () => {
    current = { ...detail, problems: [] };
    renderAt("/Change/c1", <ChangePage />, "/Change/:id");
    await userEvent.click(await screen.findByRole("button", { name: "Submit for assessment" }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/changes/c1/submit", expect.objectContaining({ method: "POST" })));
  });

  it("answers an impact area at once, and asks how when it is affected", async () => {
    current = assessing;
    renderAt("/Change/c1", <ChangePage />, "/Change/:id");
    const list = await screen.findByRole("list", { name: "Impact assessment" });
    expect(within(list).getByText("Design and drawing")).toBeInTheDocument();
    const toggle = within(list).getByRole("group", { name: "Process and control plan impact" });
    await userEvent.click(within(toggle).getByRole("button", { name: "Not assessed" }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/changes/c1/impacts", expect.objectContaining({ method: "PUT", body: { areaId: "a2", status: "not_assessed", note: null } })));
    const design = within(list).getByRole("group", { name: "Design and drawing impact" });
    await userEvent.click(within(design).getByRole("button", { name: "Affected" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "Save" })).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText("How it is affected"), "New note on the drawing");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/changes/c1/impacts", expect.objectContaining({ body: { areaId: "a1", status: "affected", note: "New note on the drawing" } })));
  });

  it("sends an assessed change to the board and says what is still needed", async () => {
    current = assessing;
    renderAt("/Change/c1", <ChangePage />, "/Change/:id");
    expect(await screen.findByRole("button", { name: "Send to the board" })).toBeDisabled();
    expect(within(screen.getByRole("list", { name: "Still needed" })).getByText("1 impact area still to assess")).toBeInTheDocument();
  });

  it("lets the named signer approve, or send back with a reason", async () => {
    current = withBoard;
    renderAt("/Change/c1", <ChangePage />, "/Change/:id");
    expect(await screen.findByText("Waiting for 1 sign-off(s).")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Send back" }));
    let dialog = await screen.findByRole("dialog");
    const confirm = within(dialog).getByRole("button", { name: "Send it back" });
    expect(confirm).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText("Why are you sending it back?"), "Needs a control plan change");
    await userEvent.click(confirm);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/change-signoffs/s1/decide", expect.objectContaining({ method: "POST", body: { approve: false, comment: "Needs a control plan change" } })));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/change-signoffs/s1/decide", expect.objectContaining({ body: { approve: true, comment: null } })));
  });

  it("shows the decision, the cut-in point and the customer's approval once approved, and links to the notice", async () => {
    current = approved;
    renderAt("/Change/c1", <ChangePage />, "/Change/:id");
    expect(await screen.findByText(/Approved .* by Quinn Manager/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Change notice" })).toHaveAttribute("href", "/Change/c1/notice");
    expect(screen.getByText(`From ${formatDay("2026-12-01")}`)).toBeInTheDocument();
    expect(screen.getByText("Use up what we have — Finish the batch")).toBeInTheDocument();
    expect(screen.getByText("ACME-77")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
  });

  it("shows why a change was sent back to assessment", async () => {
    current = { ...assessing, returnReason: "Quality: Needs a control plan change", reviewRound: 1 };
    renderAt("/Change/c1", <ChangePage />, "/Change/:id");
    expect(await screen.findByText(/Quality: Needs a control plan change/)).toBeInTheDocument();
  });
});

describe("the change notice", () => {
  it("prints what changed, the impact, who agreed and from when", async () => {
    current = { ...approved, impacts: [area({ status: "affected", note: "New note on the drawing" }), area({ id: "i2", areaId: "a2", label: "Process and control plan", status: "not_affected" })] };
    renderAt("/Change/c1/notice", <ChangeNoticePage />, "/Change/:id/notice");
    const notice = await screen.findByRole("article", { name: "Change notice" });
    expect(within(notice).getByText("Engineering change notice")).toBeInTheDocument();
    expect(within(notice).getByText(/New note on the drawing/)).toBeInTheDocument();
    expect(within(notice).getByText(/Quality/)).toBeInTheDocument();
    expect(within(notice).getByText(`From ${formatDay("2026-12-01")}`)).toBeInTheDocument();
    expect(within(notice).getByText(/Approved · their reference ACME-77/)).toBeInTheDocument();
  });

  it("is still the notice while the change is carried out, checked and after it is closed", async () => {
    for (const stage of ["implementing", "verifying", "closed"]) {
      current = { ...approved, stage };
      const { unmount } = renderAt("/Change/c1/notice", <ChangeNoticePage />, "/Change/:id/notice");
      const notice = await screen.findByRole("article", { name: "Change notice" });
      expect(within(notice).getByText("Engineering change notice")).toBeInTheDocument();
      expect(within(notice).queryByText(/Not approved/)).not.toBeInTheDocument();
      unmount();
    }
  });

  it("says plainly that an unapproved change is a draft of the notice", async () => {
    current = assessing;
    renderAt("/Change/c1/notice", <ChangeNoticePage />, "/Change/:id/notice");
    expect(await screen.findByText(/Not approved: this is a draft of the notice/)).toBeInTheDocument();
  });
});

describe("helpers", () => {
  it("names what a draft still needs", () => {
    expect(draftProblems({ description: null, reason: null, links: [] })).toHaveLength(3);
    expect(draftProblems({ description: "a", reason: "b", links: [{}] })).toEqual([]);
  });
  it("words and compares links, and builds the body the server wants", () => {
    const part = { kind: "part", id: "p1", code: null, reference: "BR-100", name: "Bracket", readable: true };
    expect(linkWords(part)).toBe("BR-100 · Bracket");
    expect(linkWords({ ...part, readable: false })).toBe("a record you cannot open");
    expect(linkWords({ kind: "operation_code", code: "OP10" })).toBe("OP10");
    expect(sameLink({ kind: "operation_code", code: "op10" }, { kind: "operation_code", code: "OP10" })).toBe(true);
    expect(linksBody([part, { kind: "operation_code", id: null, code: "OP10" }])).toEqual([{ kind: "part", id: "p1" }, { kind: "operation_code", code: "OP10" }]);
  });
  it("works out the stepper and the cut-in words", () => {
    expect(stepState("assessment", "draft")).toBe("done");
    expect(stepState("assessment", "assessment")).toBe("current");
    expect(stepState("assessment", "approved")).toBe("todo");
    expect(stepState("cancelled", "draft")).toBe("other");
    expect(cutInWords({ kind: "none" })).toBeNull();
    expect(cutInWords({ kind: "lot", lot: { id: "l", label: "LOT-9" } })).toBe("From lot LOT-9");
    expect(cutInWords({ kind: "order", order: null })).toBe("From production order (one you cannot open)");
  });
  it("labels stages", () => {
    expect(stageLabel("cancelled")).toBe("Cancelled");
    expect(stageLabel("whatever")).toBe("whatever");
  });
});
