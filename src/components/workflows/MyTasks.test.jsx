import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

const mutate = vi.fn();
const NC = "11111111-2222-3333-4444-555555555555";
const task = (extra = {}) => ({
  id: "t1", reference: "TSK-26-0001", title: "Check the containment", detail: "Look at the lot on hold", ruleName: "Major NCs",
  record: { kind: "nonconformance", id: NC, label: "INC-26-0004 · Burr on flange", path: `/Non-Conformance/Register/${NC}` },
  dueOn: "2026-11-14", overdue: false, status: "open", doneNote: null, doneAt: null, createdAt: "2026-11-12T09:00:00Z", ...extra,
});
let mine = { data: [task()], openCount: 1, overdueCount: 0 };
let asked = [];

vi.mock("../Breadcrumb", () => ({ default: () => null }));
vi.mock("../../contexts/ToastProvider", () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock("../../hooks/useWorkflows", () => ({
  useMyTasks: (status) => {
    asked.push(status);
    return { data: mine, isLoading: false };
  },
  useTaskMutation: () => ({ mutate, isPending: false, error: null }),
}));

import MyTasksPage from "./MyTasksPage";

const show = () =>
  render(
    <MemoryRouter>
      <MyTasksPage />
    </MemoryRouter>,
  );

beforeEach(() => {
  mutate.mockReset();
  asked = [];
  mine = { data: [task()], openCount: 1, overdueCount: 0 };
});

describe("My tasks", () => {
  it("lists my open tasks with the record they are about, the rule and when they are due", () => {
    show();
    expect(screen.getByText("1 open")).toBeInTheDocument();
    expect(screen.getByText("Check the containment")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "INC-26-0004 · Burr on flange" })).toHaveAttribute("href", `/Non-Conformance/Register/${NC}`);
    expect(screen.getByText(/from the rule “Major NCs”/)).toBeInTheDocument();
    expect(screen.getByText(/due 14 Nov 2026/)).toBeInTheDocument();
  });

  it("marks a task done with an optional note", async () => {
    const user = userEvent.setup();
    show();
    await user.click(screen.getByRole("button", { name: "Mark done: Check the containment" }));
    await user.type(screen.getByLabelText("What was done (optional)"), "Lot sorted");
    await user.click(screen.getByRole("button", { name: "Mark done" }));
    expect(mutate).toHaveBeenCalledWith({ action: "complete", id: "t1", body: { note: "Lot sorted" } }, expect.any(Object));
  });

  it("shows overdue, reopens a done task and switches between open, done and all", async () => {
    const user = userEvent.setup();
    mine = { data: [task({ overdue: true }), task({ id: "t2", title: "Tell the customer", status: "done", doneNote: "Emailed" })], openCount: 1, overdueCount: 1 };
    show();
    expect(screen.getByText("1 open · 1 overdue")).toBeInTheDocument();
    expect(screen.getByText("overdue")).toBeInTheDocument();
    expect(screen.getByText("Done: Emailed")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Reopen: Tell the customer" }));
    expect(mutate).toHaveBeenCalledWith({ action: "reopen", id: "t2" }, expect.any(Object));
    await user.click(screen.getByRole("button", { name: "All" }));
    expect(asked).toContain("all");
  });

  it("says so when nothing is waiting", () => {
    mine = { data: [], openCount: 0, overdueCount: 0 };
    show();
    expect(screen.getByText("No task is waiting for you.")).toBeInTheDocument();
  });
});
