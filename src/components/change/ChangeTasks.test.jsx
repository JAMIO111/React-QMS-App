import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("../../lib/api-client", async (orig) => ({ ...(await orig()), apiFetch: vi.fn() }));
vi.mock("../../contexts/OrganisationProvider", () => ({ useOrganisation: () => ({ organisationId: "org-1" }) }));
vi.mock("../../contexts/ToastProvider", () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock("../../contexts/AuthProvider", () => ({ useAuth: () => ({ user: { id: "u1" } }) }));
vi.mock("../../hooks/useQmsApi", () => ({ usePermissions: () => ({ can: () => true, isLoading: false }) }));
vi.mock("../../lib/breadcrumbs", async (orig) => ({ ...(await orig()), useBreadcrumbNames: () => {} }));

import { apiFetch } from "../../lib/api-client";
import { linkStateLabel, reviewLabel, taskLabel, taskLinkKindLabel, taskLinkPath } from "../../lib/change";
import ChangePage from "./ChangePage";
import MyChangesPage from "./MyChangesPage";

const base = {
  id: "c1", reference: "ECR-26-0001", title: "Move bracket to CNC 7", stage: "implementing", urgency: "normal", type: { id: "t1", label: "Process", needsCustomerApproval: false },
  raisedBy: { id: "u1", name: "Ada Owner" }, originKind: null, linkCount: 1, fileCount: 0, createdAt: "2026-11-24T10:00:00Z", updatedAt: "2026-11-24T10:00:00Z",
  description: "Run it on machine 7", reason: "Capacity", rowVersion: "1", links: [{ kind: "part", id: "p1", code: null, reference: "BR-100", name: "Bracket", readable: true }],
  origin: null, attachments: [], cancelReason: null, cancelledAt: null, cancelledBy: null, canManage: true, canEdit: false, canCancel: true, canAddFiles: true,
  reviewRound: 1, returnReason: null, submittedAt: "2026-11-24T11:00:00Z", approvedAt: "2026-11-25T10:00:00Z", approvedBy: "Quinn Manager", typeNeedsCustomerApproval: false,
  customerApproval: { status: "not_needed", reference: null, on: null, waivedReason: null },
  cutIn: { kind: "none", date: null, order: null, lot: null, serial: null, stockAction: null, stockNote: null },
  impacts: [{ id: "i1", areaId: "a1", key: "design", label: "Design and drawing", description: "x", status: "affected", note: "New note", assessedAt: "2026-11-24T12:00:00Z", assessedBy: "Ada Owner" }],
  board: [], signoffs: [], problems: [], closedAt: null, closedBy: null, reviews: [],
  canEditType: false, canSubmit: false, canAssess: false, canSendToBoard: false, canRecall: false, canSetCutIn: true, canSetCustomerApproval: true,
  canAddTask: true, canReview: false,
  tasks: [
    { id: "t1", description: "Release the new drawing revision", status: "open", owner: { id: "u2", name: "Quinn Manager" }, dueOn: "2099-01-01", overdue: false, area: { id: "a1", label: "Design and drawing" },
      resultNote: null, doneAt: null, doneBy: null, cancelReason: null, reopenReason: null, createdAt: "2026-11-26T10:00:00Z", isMine: false,
      link: { kind: "part_revision", id: "r1", readable: true, label: "BR-100 · rev B", status: "draft", state: "pending", parentId: "p1" },
      canComplete: true, canEdit: true, canCancel: true, canReopen: false },
    { id: "t2", description: "Tell the line leaders", status: "done", owner: { id: "u3", name: "Vic Viewer" }, dueOn: null, overdue: false, area: null, resultNote: "Told them all", doneAt: "2026-11-27T10:00:00Z",
      doneBy: "Vic Viewer", cancelReason: null, reopenReason: null, createdAt: "2026-11-26T10:00:00Z", isMine: false, link: null, canComplete: false, canEdit: false, canCancel: false, canReopen: true },
    { id: "t3", description: "Update the control plan", status: "open", owner: { id: "u1", name: "Ada Owner" }, dueOn: "2020-01-01", overdue: true, area: null, resultNote: null, doneAt: null, doneBy: null,
      cancelReason: null, reopenReason: null, createdAt: "2026-11-26T10:00:00Z", isMine: true, link: null, canComplete: true, canEdit: true, canCancel: true, canReopen: false },
  ],
};

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

let current = base;
beforeEach(() => {
  current = base;
  apiFetch.mockReset();
  apiFetch.mockImplementation(async (path) => {
    if (path.startsWith("/change-types")) return { data: [] };
    if (path.startsWith("/change-areas")) return { data: [{ id: "a1", key: "design", label: "Design and drawing", description: null, sequence: 1, active: true }] };
    if (path.startsWith("/change-signers")) return { data: [{ id: "u2", name: "Quinn Manager", canApprove: true }, { id: "u3", name: "Vic Viewer", canApprove: false }] };
    if (path.startsWith("/changes/c1/attachments")) return { data: [] };
    if (path.startsWith("/changes/mine/count")) return { signoffs: 1, tasks: 1, overdue: 0, total: 2 };
    if (path.startsWith("/changes/mine")) return {
      signoffs: [{ id: "s1", changeId: "c9", reference: "ECR-26-0009", title: "New fixture", urgency: "expedited", functionLabel: "Quality" }],
      tasks: [{ id: "t3", description: "Update the control plan", dueOn: "2020-01-01", overdue: true, changeId: "c1", reference: "ECR-26-0001", title: "Move bracket to CNC 7", linkKind: "control_plan_revision", linkState: "pending" }],
      raised: [{ id: "c1", reference: "ECR-26-0001", title: "Move bracket to CNC 7", stage: "implementing", urgency: "normal" }],
      counts: { signoffs: 1, tasks: 1, overdue: 1, total: 2 },
    };
    if (path.startsWith("/change-tasks/") || path.endsWith("/reviews") || path.endsWith("/tasks")) return current;
    if (path.startsWith("/changes/c1")) return current;
    return {};
  });
});

describe("the tasks card", () => {
  it("lists each task with who, when, the record it changes and where that record stands", async () => {
    renderAt("/Change/c1", <ChangePage />, "/Change/:id");
    const list = await screen.findByRole("list", { name: "Tasks" });
    const first = within(list).getByText("Release the new drawing revision").closest("li");
    expect(within(first).getByText("Quinn Manager")).toBeInTheDocument();
    expect(within(first).getByRole("link", { name: "BR-100 · rev B" })).toHaveAttribute("href", "/Parts/p1");
    expect(within(first).getByText("Not in force yet")).toBeInTheDocument();
    expect(within(first).getByText("(draft)")).toBeInTheDocument();
    const done = within(list).getByText("Tell the line leaders").closest("li");
    expect(within(done).getByText(/Done .* by Vic Viewer — Told them all/)).toBeInTheDocument();
    expect(within(done).getByRole("button", { name: /Reopen task/ })).toBeInTheDocument();
    const late = within(list).getByText("Update the control plan").closest("li");
    expect(within(late).getByText(/Overdue, was due/)).toBeInTheDocument();
    expect(within(late).getByRole("button", { name: "Start a revision" })).toBeInTheDocument();
    expect(within(first).queryByRole("button", { name: "Start a revision" })).toBeNull();
  });

  it("finishes a task with a note, and the server decides whether it may be", async () => {
    renderAt("/Change/c1", <ChangePage />, "/Change/:id");
    const list = await screen.findByRole("list", { name: "Tasks" });
    const row = within(list).getByText("Release the new drawing revision").closest("li");
    await userEvent.click(within(row).getByRole("button", { name: "Done" }));
    const dialog = await screen.findByRole("dialog", { name: "Mark as done" });
    expect(within(dialog).getByText(/has to be in force first/)).toBeInTheDocument();
    await userEvent.type(within(dialog).getByLabelText("What was done (optional)"), "Rev B released");
    await userEvent.click(within(dialog).getByRole("button", { name: "Mark as done" }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/change-tasks/t1/complete", expect.objectContaining({ method: "POST", body: { note: "Rev B released" } })));
  });

  it("cancels a task only with a reason", async () => {
    renderAt("/Change/c1", <ChangePage />, "/Change/:id");
    const list = await screen.findByRole("list", { name: "Tasks" });
    const row = within(list).getByText("Update the control plan").closest("li");
    await userEvent.click(within(row).getByRole("button", { name: /Cancel task/ }));
    const dialog = await screen.findByRole("dialog", { name: "Cancel the task" });
    const submit = within(dialog).getByRole("button", { name: "Cancel the task" });
    expect(submit).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText("Why is it cancelled?"), "Not needed");
    await userEvent.click(submit);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/change-tasks/t3/cancel", expect.objectContaining({ body: { reason: "Not needed" } })));
  });

  it("adds a task: what and who are needed", async () => {
    renderAt("/Change/c1", <ChangePage />, "/Change/:id");
    await userEvent.click(await screen.findByRole("button", { name: "Add a task" }));
    const dialog = await screen.findByRole("dialog", { name: "Add a task" });
    const add = within(dialog).getByRole("button", { name: "Add task" });
    expect(add).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText(/What has to be done/), "Retrain the operators");
    expect(add).toBeDisabled();
    await userEvent.click(within(dialog).getByRole("combobox", { name: /Who does it/ }));
    await userEvent.click(await screen.findByRole("option", { name: "Quinn Manager" }));
    expect(add).toBeEnabled();
    await userEvent.click(add);
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith("/changes/c1/tasks", expect.objectContaining({ method: "POST", body: { description: "Retrain the operators", ownerId: "u2", dueOn: null, areaId: null } })),
    );
  });

  it("points a task at a revision that already exists: the record first, then which of its revisions", async () => {
    const before = apiFetch.getMockImplementation();
    apiFetch.mockImplementation(async (path, ...rest) => {
      if (path.startsWith("/parts") || path.startsWith("/control-plans?") || path.startsWith("/documents?")) return { data: [], page: 1, pageSize: 20, total: 0 };
      if (path.startsWith("/fmeas?")) return { data: [{ id: "f1", number: "FMEA-001", title: "Machining the bracket", currentLetter: "A" }], page: 1, pageSize: 20, total: 1 };
      if (path === "/fmeas/f1")
        return {
          id: "f1", number: "FMEA-001",
          revisions: [
            { id: "fr1", sequence: 1, letter: "A", status: "effective" },
            { id: "fr2", sequence: 2, letter: null, status: "draft" },
            { id: "fr0", sequence: 0, letter: null, status: "discarded" },
          ],
        };
      return before(path, ...rest);
    });
    renderAt("/Change/c1", <ChangePage />, "/Change/:id");
    const list = await screen.findByRole("list", { name: "Tasks" });
    const row = within(list).getByText("Update the control plan").closest("li");
    await userEvent.click(within(row).getByRole("button", { name: /Link a revision to task/ }));
    const dialog = await screen.findByRole("dialog", { name: "Link a revision" });
    const submit = within(dialog).getByRole("button", { name: "Link the revision" });
    expect(submit).toBeDisabled();
    await userEvent.click(within(dialog).getByRole("combobox", { name: /What the task changes/ }));
    await userEvent.click(await screen.findByRole("option", { name: /^FMEA revision/ }));
    await userEvent.click(within(dialog).getByRole("combobox", { name: /^FMEA/ }));
    await userEvent.click(await screen.findByRole("option", { name: /FMEA-001 · Machining the bracket/ }));
    await userEvent.click(await within(dialog).findByRole("combobox", { name: /Which revision/ }));
    // a discarded revision is not offered; the one in force and the draft are
    expect(await screen.findByRole("option", { name: /Rev A/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Draft 2/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Draft 0/ })).toBeNull();
    await userEvent.click(screen.getByRole("option", { name: /Draft 2/ }));
    expect(submit).toBeEnabled();
    await userEvent.click(submit);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/change-tasks/t3/link", expect.objectContaining({ method: "PUT", body: { link: { kind: "fmea_revision", id: "fr2" } } })));
  });

  it("offers no editing buttons to someone who may only finish their own task", async () => {
    current = { ...base, canManage: false, canAddTask: false, tasks: [{ ...base.tasks[2], canEdit: false, canCancel: false }] };
    renderAt("/Change/c1", <ChangePage />, "/Change/:id");
    const list = await screen.findByRole("list", { name: "Tasks" });
    expect(within(list).getByRole("button", { name: "Done" })).toBeInTheDocument();
    expect(within(list).queryByRole("button", { name: /Cancel task/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add a task" })).toBeNull();
  });
});

describe("the effectiveness check", () => {
  const verifying = { ...base, stage: "verifying", canReview: true, tasks: [{ ...base.tasks[1] }], problems: ["The customer has not approved it: record their approval, or waive it with a reason"] };

  it("shows what stands in the way and records the check as effective or not", async () => {
    current = verifying;
    renderAt("/Change/c1", <ChangePage />, "/Change/:id");
    const needed = await screen.findByRole("list", { name: "Still needed to close" });
    expect(within(needed).getByText(/customer has not approved/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Record the check" }));
    const dialog = await screen.findByRole("dialog", { name: "Check the change worked" });
    await userEvent.click(within(dialog).getByRole("combobox", { name: /Did it work/ }));
    await userEvent.click(await screen.findByRole("option", { name: /No, it is not effective/ }));
    await userEvent.type(within(dialog).getByLabelText(/What did you check/), "Scrap rate still high");
    await userEvent.click(within(dialog).getByRole("button", { name: "Send it back" }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/changes/c1/reviews", expect.objectContaining({ method: "POST", body: { effective: false, note: "Scrap rate still high" } })));
  });

  it("shows the record of checks and that the change is closed", async () => {
    current = { ...base, stage: "closed", closedAt: "2026-12-02T10:00:00Z", closedBy: "Quinn Manager", canAddTask: false, canReview: false,
      reviews: [{ id: "v2", result: "effective", note: "Scrap back to normal", reviewedAt: "2026-12-02T10:00:00Z", reviewedBy: "Quinn Manager" }, { id: "v1", result: "not_effective", note: "Still seeing burrs", reviewedAt: "2026-11-30T10:00:00Z", reviewedBy: "Quinn Manager" }] };
    renderAt("/Change/c1", <ChangePage />, "/Change/:id");
    const checks = await screen.findByRole("list", { name: "Checks" });
    expect(within(checks).getAllByRole("listitem")).toHaveLength(2);
    expect(within(checks).getByText("Not effective")).toBeInTheDocument();
    expect(within(checks).getByText("Still seeing burrs")).toBeInTheDocument();
    expect(screen.getByText(/Closed .* by Quinn Manager/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Record the check" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add a task" })).toBeNull();
  });
});

describe("my changes", () => {
  it("lists sign-offs, tasks and the changes I raised, each to its change", async () => {
    renderAt("/Change/Mine", <MyChangesPage />);
    const signoffs = await screen.findByRole("list", { name: "Sign-offs waiting for me" });
    expect(within(signoffs).getByRole("link", { name: "ECR-26-0009 · New fixture" })).toHaveAttribute("href", "/Change/c9");
    expect(within(signoffs).getByText("expedited")).toBeInTheDocument();
    const tasks = screen.getByRole("list", { name: "My change tasks" });
    expect(within(tasks).getByText("Update the control plan")).toBeInTheDocument();
    expect(within(tasks).getByText("overdue")).toBeInTheDocument();
    expect(within(tasks).getByText(/control plan revision: not in force yet/)).toBeInTheDocument();
    const raised = screen.getByRole("list", { name: "Changes I raised" });
    expect(within(raised).getByText("Implementing")).toBeInTheDocument();
  });

  it("says when nothing needs the person", async () => {
    apiFetch.mockImplementation(async () => ({ signoffs: [], tasks: [], raised: [], counts: { signoffs: 0, tasks: 0, overdue: 0, total: 0 } }));
    renderAt("/Change/Mine", <MyChangesPage />);
    expect(await screen.findByText("Nothing needs you at the moment.")).toBeInTheDocument();
  });
});

describe("helpers", () => {
  it("words task and record states", () => {
    expect(taskLabel("open")).toBe("Open");
    expect(taskLabel("done")).toBe("Done");
    expect(linkStateLabel("in_force")).toBe("In force");
    expect(linkStateLabel("none")).toBe("");
    expect(taskLinkKindLabel("control_plan_revision")).toBe("Control plan revision");
    expect(reviewLabel("not_effective")).toBe("Not effective");
  });
  it("finds the page of a task's record, and none when it cannot be opened", () => {
    expect(taskLinkPath({ readable: true, kind: "part_revision", id: "r1", parentId: "p1" })).toBe("/Parts/p1");
    expect(taskLinkPath({ readable: true, kind: "control_plan_revision", id: "r2", parentId: "pl1" })).toBe("/Process-Control/Plans/pl1/revisions/r2");
    expect(taskLinkPath({ readable: true, kind: "document_revision", id: "r3", parentId: "d1" })).toBe("/Documentation/Documents/d1/revisions/r3");
    expect(taskLinkPath({ readable: true, kind: "risk", id: "k1" })).toBe("/Risk/Register/k1");
    expect(taskLinkPath({ readable: false, kind: "risk", id: "k1" })).toBeNull();
    expect(taskLinkPath(null)).toBeNull();
  });
});
