import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";

const mutate = vi.fn();
const saveInput = vi.fn();
const input = (section, title, extra = {}) => ({
  id: `i-${section}`, section, title, commentaryOnly: false, available: true, snapshot: { figures: [], lists: [] }, gatheredAt: "2026-11-12T09:00:00Z", gatheredBy: "Ann Owner",
  commentary: null, reviewed: false, reviewedAt: null, reviewedBy: null, ...extra,
});
const base = {
  id: "m1", reference: "MR-26-01", title: "H1 review", periodFrom: "2026-01-01", periodTo: "2026-06-30", plannedOn: "2026-07-15", heldOn: null,
  chair: { id: "u1", name: "Ann Owner" }, status: "planned", sectionsReviewed: 0, sections: 3, decisionCount: 0, actionCount: 0, openActions: 0,
  completedAt: null, completedBy: null, cancelReason: null, cancelledAt: null, cancelledBy: null, createdAt: "2026-11-01T09:00:00Z",
  minutes: null, noDecisionNote: null, problems: ["Start the review"], canManage: true, canEdit: true, canHold: false,
  inputs: [], attendees: [], decisions: [], actions: [],
};
const held = {
  ...base, status: "in_progress", heldOn: "2026-11-12", canHold: true,
  problems: ["Record a decision, or say why none was needed"],
  attendees: [{ id: "t1", userId: "u1", name: "Ann Owner", outsider: false, role: "Chair", attendance: "present" }, { id: "t2", userId: null, name: "Dr Jones", outsider: true, role: null, attendance: "present" }],
  inputs: [
    input("audit_results", "Audit results", { snapshot: { figures: [{ label: "Pass rate", value: 92.5, unit: "%" }, { label: "Done", value: 4, note: "1 missed" }], lists: [{ title: "Highest risks", items: [{ label: "RSK-001 · Castings", value: 16, link: "/Risk/Register/r1" }] }] } }),
    input("resources", "Adequacy of resources", { available: false, snapshot: null }),
    input("context", "Changes in external and internal issues", { commentaryOnly: true, available: null, snapshot: null, gatheredAt: null }),
  ],
  actions: [{ id: "x1", decisionId: null, description: "Get three quotes", owner: { id: "u2", name: "Bob" }, dueDate: "2030-01-31", status: "open", doneNote: null, doneAt: null, doneBy: null, cancelReason: null, mine: true }],
};
let review = base;
let list = { data: [base], canManage: true };
let permissions = ["management_review.read"];
let mine = { data: [], openCount: 0, overdueCount: 0 };
let overview = null;

vi.mock("../Breadcrumb", () => ({ default: () => null }));
vi.mock("../documents/DocumentEditor", () => ({ default: ({ label }) => <div>{label} editor</div> }));
vi.mock("../../contexts/ToastProvider", () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock("../../contexts/AuthProvider", () => ({ useAuth: () => ({ user: { id: "u1" } }) }));
vi.mock("../../hooks/useCustomFields", () => ({ useCustomFieldPeople: () => ({ data: [{ id: "u1", name: "Ann Owner" }, { id: "u2", name: "Bob" }] }) }));
vi.mock("../../hooks/useManagementReview", () => ({
  useManagementReviews: () => ({ data: list, isLoading: false }),
  useManagementReview: () => ({ data: review, isLoading: false }),
  useReviewMutation: () => ({ mutate, isPending: false, error: null }),
  useReviewInput: () => ({ mutate: saveInput }),
  useMyReviewActions: () => ({ data: mine, isLoading: false }),
  useManagementReviewOverview: () => ({ data: overview }),
}));
vi.mock("../../hooks/useQmsApi", () => ({ usePermissions: () => ({ can: (p) => permissions.includes(p), isLoading: false }) }));

import ReviewsPage from "./ReviewsPage";
import ReviewPage from "./ReviewPage";
import ReviewReportPage from "./ReviewReportPage";
import MyReviewActionsPage from "./MyReviewActionsPage";
import ManagementReviewCard from "./ManagementReviewCard";

beforeEach(() => {
  mutate.mockReset();
  saveInput.mockReset();
  review = base;
  list = { data: [base], canManage: true };
  permissions = ["management_review.read"];
  overview = null;
});

const at = (path, route, element) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path={route} element={element} />
      </Routes>
    </MemoryRouter>,
  );

describe("management reviews", () => {
  it("lists the reviews and plans a new one", async () => {
    at("/Management-Review/Reviews", "/Management-Review/Reviews", <ReviewsPage />);
    const row = within(screen.getByRole("table", { name: "Management reviews" })).getAllByRole("row")[1];
    expect(row).toHaveTextContent("MR-26-01 · H1 review");
    expect(row).toHaveTextContent("Planned 15 Jul 2026");
    expect(row).toHaveTextContent("0 of 3");
    await userEvent.click(screen.getByRole("button", { name: /Plan a review/ }));
    expect(screen.getByRole("button", { name: "Plan it" })).toBeDisabled();
  });

  it("starts a planned review, which gathers its inputs", async () => {
    at("/Management-Review/Reviews/m1", "/Management-Review/Reviews/:id", <ReviewPage />);
    expect(screen.getByText(/Starting the review gathers every input/)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Inputs" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Start the review" }));
    expect(mutate).toHaveBeenCalledWith({ action: "start", id: "m1" }, expect.anything());
  });

  it("shows each gathered section in words, says when one is not available, and ticks a section reviewed at once", async () => {
    review = held;
    at("/Management-Review/Reviews/m1", "/Management-Review/Reviews/:id", <ReviewPage />);
    const audits = screen.getByRole("region", { name: "Audit results" });
    expect(within(audits).getByText("92.5%")).toBeInTheDocument();
    expect(within(audits).getByText("1 missed")).toBeInTheDocument();
    expect(within(audits).getByRole("link", { name: "RSK-001 · Castings" })).toHaveAttribute("href", "/Risk/Register/r1");
    expect(within(screen.getByRole("region", { name: "Adequacy of resources" })).getByText(/Not available to you/)).toBeInTheDocument();
    await userEvent.click(within(audits).getByRole("checkbox", { name: /Reviewed in the meeting/ }));
    expect(saveInput).toHaveBeenCalledWith({ inputId: "i-audit_results", commentary: null, reviewed: true }, expect.anything());
    const context = screen.getByRole("region", { name: "Changes in external and internal issues" });
    expect(within(context).getByRole("checkbox")).toBeDisabled();
    await userEvent.type(within(context).getByLabelText("Commentary"), "New customer in aerospace");
    expect(within(context).getByRole("checkbox")).toBeEnabled();
  });

  it("completes with a note when no decision was needed", async () => {
    review = held;
    at("/Management-Review/Reviews/m1", "/Management-Review/Reviews/:id", <ReviewPage />);
    await userEvent.click(screen.getByRole("button", { name: "Complete" }));
    await userEvent.type(screen.getByLabelText("Why no decision was needed"), "Everything on track");
    await userEvent.click(screen.getByRole("button", { name: "Complete the review" }));
    expect(mutate).toHaveBeenCalledWith({ action: "complete", id: "m1", body: { noDecisionNote: "Everything on track" } }, expect.anything());
  });

  it("does not offer Complete while sections are still to review", () => {
    review = { ...held, problems: ["2 input sections are not reviewed yet", "Record a decision, or say why none was needed"] };
    at("/Management-Review/Reviews/m1", "/Management-Review/Reviews/:id", <ReviewPage />);
    expect(screen.getByRole("button", { name: "Complete" })).toBeDisabled();
    expect(screen.getByText("2 input sections are not reviewed yet")).toBeInTheDocument();
  });

  it("is read-only once completed, but its own action can still be closed", async () => {
    review = { ...held, status: "completed", canEdit: false, canHold: false, canManage: false, completedAt: "2026-11-12T12:00:00Z", completedBy: "Ann Owner", problems: [] };
    at("/Management-Review/Reviews/m1", "/Management-Review/Reviews/:id", <ReviewPage />);
    expect(screen.queryByRole("button", { name: "Complete" })).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.getByText(/The record is frozen/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Mark done" }));
    await userEvent.type(screen.getByLabelText("What was done"), "Quotes in");
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Mark done" }));
    expect(mutate).toHaveBeenCalledWith({ action: "completeAction", id: "x1", body: { note: "Quotes in" } }, expect.anything());
  });

  it("prints the whole review as one report", () => {
    review = held;
    at("/Management-Review/Reviews/m1/report", "/Management-Review/Reviews/:id/report", <ReviewReportPage />);
    const report = screen.getByRole("article", { name: "Management review report" });
    expect(within(report).getByText(/Not completed: this is a draft/)).toBeInTheDocument();
    expect(within(report).getByText("Dr Jones (from outside) — present")).toBeInTheDocument();
    expect(within(report).getByRole("region", { name: "Audit results" })).toHaveTextContent("92.5%");
    expect(within(report).getByRole("table", { name: "Actions" })).toHaveTextContent("Get three quotes");
  });

  it("lists my review actions and closes one, naming the review even when I may not open it", async () => {
    permissions = [];
    mine = {
      data: [{ id: "x1", description: "Get three quotes", status: "open", dueDate: "2026-01-31", overdue: true, doneNote: null, doneAt: null, review: { id: "m1", reference: "MR-26-01", title: "H1 review", status: "completed" } }],
      openCount: 1, overdueCount: 1,
    };
    at("/Management-Review/My-Actions", "/Management-Review/My-Actions", <MyReviewActionsPage />);
    expect(screen.getByText("1 open · 1 overdue")).toBeInTheDocument();
    const item = within(screen.getByRole("list", { name: "My review actions" })).getByRole("listitem");
    expect(item).toHaveTextContent("MR-26-01 · H1 review · due 31 Jan 2026");
    expect(within(item).queryByRole("link")).not.toBeInTheDocument();
    expect(within(item).getByText("overdue")).toBeInTheDocument();
    await userEvent.click(within(item).getByRole("button", { name: "Mark done: Get three quotes" }));
    await userEvent.type(screen.getByLabelText("What was done"), "Quotes in");
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Mark done" }));
    expect(mutate).toHaveBeenCalledWith({ action: "completeAction", id: "x1", body: { note: "Quotes in" } }, expect.anything());
  });

  it("sums management review up on the home page, and warns when none was completed in the last year", () => {
    overview = {
      next: { id: "m2", reference: "MR-26-02", title: "H2 review", status: "planned", plannedOn: "2027-01-20", heldOn: null },
      lastCompleted: { id: "m1", reference: "MR-25-01", title: "2025 review", heldOn: "2025-09-01", daysAgo: 437 },
      actions: { open: 3, overdue: 1 },
      objectives: { total: 4, onTarget: 3, offTarget: 1, noValue: 0 },
    };
    at("/", "/", <ManagementReviewCard />);
    const card = screen.getByRole("region", { name: "Management review" });
    expect(within(card).getByRole("link", { name: "MR-26-02 · H2 review" })).toHaveAttribute("href", "/Management-Review/Reviews/m2");
    expect(within(card).getByText("Over a year ago")).toBeInTheDocument();
    expect(within(card).getByText("1 overdue")).toBeInTheDocument();
    expect(within(card).getByText("3 of 4")).toBeInTheDocument();
  });

  it("shows no card to someone who may not read management reviews", () => {
    permissions = [];
    overview = { next: null, lastCompleted: null, actions: { open: 0, overdue: 0 }, objectives: { total: 0, onTarget: 0, offTarget: 0, noValue: 0 } };
    const { container } = at("/", "/", <ManagementReviewCard />);
    expect(container).toBeEmptyDOMElement();
  });
});
