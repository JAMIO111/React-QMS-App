import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

let containment;
let dispositions;
const apiFetch = vi.fn();
vi.mock("../../lib/api-client", async (importOriginal) => ({ ...(await importOriginal()), apiFetch: (...a) => apiFetch(...a) }));
vi.mock("../../contexts/OrganisationProvider", () => ({ useOrganisation: () => ({ organisationId: "org-1" }) }));
vi.mock("../../contexts/ToastProvider", () => ({ useToast: () => ({ showToast: vi.fn() }) }));

import NcrContainment from "./NcrContainment";
import NcrDispositions from "./NcrDispositions";
import StageBar from "./StageBar";

const action = (over) => ({
  id: "a1",
  nonconformanceId: "n1",
  kind: "quarantine",
  description: "Quarantine lot 77 in the cage",
  owner: { id: "e1", name: "Ada Lovelace" },
  dueDate: "2026-12-01",
  quantityContained: 120,
  status: "open",
  doneNote: null,
  doneAt: null,
  doneBy: null,
  cancelReason: null,
  createdAt: "2026-11-05T09:00:00Z",
  createdBy: { id: "u1", name: "Sam" },
  ...over,
});
const disp = (over) => ({
  id: "d1",
  nonconformanceId: "n1",
  decision: "scrap",
  quantity: 6,
  instructions: "Scrap 6 and record the lot",
  reference: null,
  status: "proposed",
  approvedAt: null,
  approvedBy: null,
  approvalNote: null,
  cancelledAt: null,
  cancelledBy: null,
  cancelReason: null,
  createdAt: "2026-11-05T09:00:00Z",
  createdBy: { id: "u1", name: "Sam" },
  ...over,
});
const sent = (path, method = "POST") => apiFetch.mock.calls.filter(([p, o]) => p === path && (o?.method ?? "GET") === method);

const renderIt = (ui) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>
  );

beforeEach(() => {
  containment = { actions: [action({})], notNeededReason: null, resolved: false, problems: ["1 containment action is still open"] };
  dispositions = { data: [disp({})], affected: 10, approvedQuantity: 0, proposedQuantity: 6, remaining: 4, canApprove: true, settled: false, problems: ["1 proposed disposition is still to approve or cancel", "approved dispositions cover 0 of the 10 affected"] };
  apiFetch.mockReset();
  apiFetch.mockImplementation(async (path, opts = {}) => {
    const k = `${opts.method ?? "GET"} ${path}`;
    if (k === "GET /ncrs/n1/containment") return containment;
    if (k === "GET /ncrs/n1/dispositions") return dispositions;
    if (k === "GET /employees/lookup") return { data: [{ id: "e1", name: "Ada Lovelace", jobTitle: null, active: true }] };
    if (opts.method === "POST" || opts.method === "PUT" || opts.method === "PATCH") return {};
    throw new Error(`unexpected ${k}`);
  });
});

describe("containment", () => {
  it("lists the actions with owner, due date and quantity, and says what is still needed", async () => {
    renderIt(<NcrContainment ncrId="n1" canEdit />);
    const list = await screen.findByRole("list", { name: "Containment actions" });
    const item = within(list).getByText("Quarantine lot 77 in the cage").closest("li");
    expect(item).toHaveTextContent("Open");
    expect(item).toHaveTextContent("Owner Ada Lovelace");
    expect(item).toHaveTextContent("120 contained");
    expect(screen.getByRole("status")).toHaveTextContent("Still needed before this can be contained: 1 containment action is still open");
  });

  it("shows a done action's evidence with who and when, and says containment is resolved", async () => {
    containment = { actions: [action({ status: "done", doneNote: "118 quarantined, none shipped", doneAt: "2026-11-06T10:00:00Z", doneBy: { id: "u2", name: "Quinn" } })], notNeededReason: null, resolved: true, problems: [] };
    renderIt(<NcrContainment ncrId="n1" canEdit />);
    expect(await screen.findByText(/Done 06 Nov 2026 by Quinn:/)).toBeInTheDocument();
    expect(screen.getByText(/118 quarantined, none shipped/)).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Containment is resolved.");
    expect(screen.getByRole("button", { name: "Reopen" })).toBeInTheDocument();
  });

  it("adds an action with its kind, description, owner and quantity", async () => {
    const user = userEvent.setup();
    renderIt(<NcrContainment ncrId="n1" canEdit />);
    await user.click(await screen.findByRole("button", { name: "Add containment action" }));
    const dialog = screen.getByRole("dialog", { name: "Add a containment action" });
    const add = within(dialog).getByRole("button", { name: "Add action" });
    expect(add).toBeDisabled();
    await user.selectOptions(within(dialog).getByLabelText(/What kind of action/), "sort");
    await user.type(within(dialog).getByLabelText(/What is being done/), "  Sort the remaining stock  ");
    await user.selectOptions(within(dialog).getByLabelText("Owner"), "e1");
    await user.type(within(dialog).getByLabelText("Quantity contained"), "40");
    await user.click(add);
    await waitFor(() => expect(sent("/ncrs/n1/containment-actions")).toHaveLength(1));
    expect(sent("/ncrs/n1/containment-actions")[0][1].body).toEqual({ kind: "sort", description: "Sort the remaining stock", ownerEmployeeId: "e1", dueDate: null, quantityContained: 40 });
  });

  it("needs a note before an action is marked done", async () => {
    const user = userEvent.setup();
    renderIt(<NcrContainment ncrId="n1" canEdit />);
    await user.click(await screen.findByRole("button", { name: "Done…" }));
    const dialog = screen.getByRole("dialog", { name: "Mark the action done" });
    const done = within(dialog).getByRole("button", { name: "Mark done" });
    expect(done).toBeDisabled();
    await user.type(within(dialog).getByLabelText(/What was done and what was found/), "120 quarantined");
    await user.click(done);
    await waitFor(() => expect(sent("/ncr-containment-actions/a1/complete")).toHaveLength(1));
    expect(sent("/ncr-containment-actions/a1/complete")[0][1].body).toEqual({ note: "120 quarantined", quantityContained: 120 });
  });

  it("cancels with a reason and reopens a done action", async () => {
    const user = userEvent.setup();
    renderIt(<NcrContainment ncrId="n1" canEdit />);
    await user.click(await screen.findByRole("button", { name: "Cancel" }));
    const dialog = screen.getByRole("dialog", { name: "Cancel this containment action?" });
    await user.type(within(dialog).getByLabelText(/Why is it being cancelled/), "Covered by another action");
    await user.click(within(dialog).getByRole("button", { name: "Cancel action" }));
    await waitFor(() => expect(sent("/ncr-containment-actions/a1/cancel")).toHaveLength(1));
    expect(sent("/ncr-containment-actions/a1/cancel")[0][1].body).toEqual({ reason: "Covered by another action" });
  });

  it("records, shows and clears the reason that no containment is needed", async () => {
    const user = userEvent.setup();
    containment = { actions: [], notNeededReason: null, resolved: false, problems: ["record a containment action, or say why none is needed"] };
    const { unmount } = renderIt(<NcrContainment ncrId="n1" canEdit />);
    expect(await screen.findByText("No containment actions yet.")).toBeInTheDocument();
    const save = screen.getByRole("button", { name: "Save reason" });
    expect(save).toBeDisabled();
    await user.type(screen.getByLabelText("Or say why no containment is needed"), "Found at first-off");
    await user.click(save);
    await waitFor(() => expect(sent("/ncrs/n1/containment-reason", "PUT")).toHaveLength(1));
    expect(sent("/ncrs/n1/containment-reason", "PUT")[0][1].body).toEqual({ reason: "Found at first-off" });
    unmount();
    containment = { actions: [], notNeededReason: "Found at first-off", resolved: true, problems: [] };
    renderIt(<NcrContainment ncrId="n1" canEdit />);
    expect(await screen.findByText(/No containment needed because:/)).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("none was needed");
    await user.click(screen.getByRole("button", { name: "Clear" }));
    await waitFor(() => expect(sent("/ncrs/n1/containment-reason", "PUT")).toHaveLength(2));
    expect(sent("/ncrs/n1/containment-reason", "PUT")[1][1].body).toEqual({ reason: null });
  });

  it("saves the reason with Enter, and never renders a form of its own (the NC page's form contains it)", async () => {
    const user = userEvent.setup();
    containment = { actions: [], notNeededReason: null, resolved: false, problems: ["record a containment action, or say why none is needed"] };
    const { container } = renderIt(<NcrContainment ncrId="n1" canEdit />);
    await user.type(await screen.findByLabelText("Or say why no containment is needed"), "Nothing left the cell{Enter}");
    await waitFor(() => expect(sent("/ncrs/n1/containment-reason", "PUT")).toHaveLength(1));
    expect(sent("/ncrs/n1/containment-reason", "PUT")[0][1].body).toEqual({ reason: "Nothing left the cell" });
    expect(container.querySelector("form")).toBeNull();
  });

  it("is read-only without edit rights", async () => {
    renderIt(<NcrContainment ncrId="n1" canEdit={false} />);
    await screen.findByRole("list", { name: "Containment actions" });
    for (const name of [/Add containment action/, "Done…", "Cancel", /Edit containment action/, "Save reason"]) expect(screen.queryByRole("button", { name })).toBeNull();
  });
});

describe("dispositions", () => {
  it("summarises the quantities and what is still needed", async () => {
    renderIt(<NcrDispositions ncrId="n1" canEdit />);
    const q = await screen.findByLabelText("Quantities");
    expect(within(q).getByText("Affected").nextSibling).toHaveTextContent("10");
    expect(within(q).getByText("Approved").nextSibling).toHaveTextContent("0");
    expect(within(q).getByText("Proposed").nextSibling).toHaveTextContent("6");
    expect(within(q).getByText("Still to decide").nextSibling).toHaveTextContent("4");
    expect(screen.getByRole("status")).toHaveTextContent("1 proposed disposition is still to approve or cancel; approved dispositions cover 0 of the 10 affected");
  });

  it("proposes a disposition, starting from what is left and refusing more than that", async () => {
    const user = userEvent.setup();
    renderIt(<NcrDispositions ncrId="n1" canEdit />);
    await user.click(await screen.findByRole("button", { name: "Propose a disposition" }));
    const dialog = screen.getByRole("dialog", { name: "Propose a disposition" });
    expect(within(dialog).getByLabelText(/^Quantity/)).toHaveValue("4");
    await user.type(within(dialog).getByLabelText(/Instructions/), "Rework at op 20");
    await user.selectOptions(within(dialog).getByLabelText(/Decision/), "rework");
    const qty = within(dialog).getByLabelText(/^Quantity/);
    await user.clear(qty);
    await user.type(qty, "5");
    expect(within(dialog).getByText("Enter a number above 0 and up to 4")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Propose" })).toBeDisabled();
    await user.clear(qty);
    await user.type(qty, "4");
    await user.click(within(dialog).getByRole("button", { name: "Propose" }));
    await waitFor(() => expect(sent("/ncrs/n1/dispositions")).toHaveLength(1));
    expect(sent("/ncrs/n1/dispositions")[0][1].body).toEqual({ decision: "rework", quantity: 4, instructions: "Rework at op 20", reference: null });
  });

  it("asks for the customer's approval reference when the decision is a concession", async () => {
    const user = userEvent.setup();
    renderIt(<NcrDispositions ncrId="n1" canEdit />);
    await user.click(await screen.findByRole("button", { name: "Propose a disposition" }));
    const dialog = screen.getByRole("dialog", { name: "Propose a disposition" });
    await user.selectOptions(within(dialog).getByLabelText(/Decision/), "concession");
    expect(within(dialog).getByText(/The customer's written approval: needed before a concession can be approved/)).toBeInTheDocument();
  });

  it("approves a proposed disposition with an optional note, for approvers only", async () => {
    const user = userEvent.setup();
    const { unmount } = renderIt(<NcrDispositions ncrId="n1" canEdit />);
    await user.click(await screen.findByRole("button", { name: "Approve…" }));
    const dialog = screen.getByRole("dialog", { name: "Approve this disposition" });
    await user.type(within(dialog).getByLabelText("Note (optional)"), "Agreed with the customer");
    await user.click(within(dialog).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(sent("/ncr-dispositions/d1/approve")).toHaveLength(1));
    expect(sent("/ncr-dispositions/d1/approve")[0][1].body).toEqual({ note: "Agreed with the customer" });
    unmount();
    dispositions = { ...dispositions, canApprove: false };
    renderIt(<NcrDispositions ncrId="n1" canEdit />);
    await screen.findByRole("list", { name: "Dispositions" });
    expect(screen.queryByRole("button", { name: "Approve…" })).toBeNull();
    expect(screen.getByText("Proposed dispositions are approved by someone with approval rights.")).toBeInTheDocument();
  });

  it("freezes an approved disposition: no edit, and only an approver can cancel it, with a reason", async () => {
    const user = userEvent.setup();
    dispositions = { ...dispositions, data: [disp({ status: "approved", approvedAt: "2026-11-06T10:00:00Z", approvedBy: { id: "u2", name: "Quinn" }, approvalNote: "Agreed" })], approvedQuantity: 6, proposedQuantity: 0 };
    const { unmount } = renderIt(<NcrDispositions ncrId="n1" canEdit />);
    const item = (await screen.findByText("Scrap 6 and record the lot")).closest("li");
    expect(item).toHaveTextContent("approved 06 Nov 2026 by Quinn: Agreed");
    expect(within(item).queryByRole("button", { name: /Edit/ })).toBeNull();
    await user.click(within(item).getByRole("button", { name: "Cancel Scrap of 6" }));
    const dialog = screen.getByRole("dialog", { name: "Cancel this approved disposition?" });
    await user.type(within(dialog).getByLabelText(/Why is it being cancelled/), "Customer wants rework");
    await user.click(within(dialog).getByRole("button", { name: "Cancel disposition" }));
    await waitFor(() => expect(sent("/ncr-dispositions/d1/cancel")).toHaveLength(1));
    unmount();
    dispositions = { ...dispositions, canApprove: false };
    renderIt(<NcrDispositions ncrId="n1" canEdit />);
    const again = (await screen.findByText("Scrap 6 and record the lot")).closest("li");
    expect(within(again).queryByRole("button", { name: /Cancel/ })).toBeNull();
  });

  it("offers no new disposition when everything affected already has one", async () => {
    dispositions = { ...dispositions, remaining: 0, proposedQuantity: 10 };
    renderIt(<NcrDispositions ncrId="n1" canEdit />);
    expect(await screen.findByRole("button", { name: "Propose a disposition" })).toBeDisabled();
    expect(screen.getByText("Everything affected already has a disposition.")).toBeInTheDocument();
  });
});

describe("the stage bar", () => {
  const ncr = (stage) => ({ id: "n1", stage, stageReason: null, deletedAt: null });
  const gates = { contained: ["1 containment action is still open"], investigating: ["1 containment action is still open"], dispositioned: ["approved dispositions cover 0 of the 10 affected"], awaitingClosure: [], closed: [] };

  it("lists what is still needed for the next stage", () => {
    render(<StageBar ncr={ncr("open")} gates={gates} canUpdate dirty={false} pending={false} onMove={() => {}} onCancel={() => {}} onReopen={() => {}} />);
    const box = screen.getByLabelText("Needed for the next stage");
    expect(box).toHaveTextContent("Before this can move to Contained:");
    expect(box).toHaveTextContent("1 containment action is still open");
  });

  it("says nothing when nothing is needed, and not for the first step out of draft", () => {
    const { rerender } = render(<StageBar ncr={ncr("dispositioned")} gates={gates} canUpdate dirty={false} pending={false} onMove={() => {}} onCancel={() => {}} onReopen={() => {}} />);
    expect(screen.queryByLabelText("Needed for the next stage")).toBeNull(); // awaiting closure needs nothing
    rerender(<StageBar ncr={ncr("draft")} gates={gates} canUpdate dirty={false} pending={false} onMove={() => {}} onCancel={() => {}} onReopen={() => {}} />);
    expect(screen.queryByLabelText("Needed for the next stage")).toBeNull();
  });
});
