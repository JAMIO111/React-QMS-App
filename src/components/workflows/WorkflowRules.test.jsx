import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";

const mutate = vi.fn();
const testRule = vi.fn();
const U = "21111111-2222-3333-4444-555555555555";
const NC = "31111111-2222-3333-4444-555555555555";
const triggers = [
  {
    eventType: "ncr.created",
    entityType: "nonconformance",
    label: "A non-conformance is raised",
    fields: [
      { key: "severity", label: "Severity", type: "ordered", options: [{ value: "minor", label: "Minor" }, { value: "major", label: "Major" }, { value: "critical", label: "Critical" }] },
      { key: "category", label: "Category (code)", type: "text" },
    ],
  },
  { eventType: "capa.created", label: "An 8D is started", fields: [{ key: "severity", label: "Severity", type: "ordered", options: [{ value: "minor", label: "Minor" }] }] },
];
const saved = {
  id: "r1", reference: "WF-001", name: "Major NCs", description: null, status: "active", statusReason: null, version: 2, trigger: "ncr.created",
  triggerLabel: "A non-conformance is raised",
  conditions: { all: [{ field: "severity", op: "gte", value: "major" }] },
  actions: [{ type: "task", assignee: { kind: "person", userId: U }, title: "Check the containment", dueDays: 2 }],
  labels: { [U]: "Ann Smith" },
  versions: [
    { version: 2, trigger: "ncr.created", conditions: { all: [{ field: "severity", op: "gte", value: "major" }] }, actions: [{ type: "task", assignee: { kind: "person", userId: U }, title: "Check the containment", dueDays: 2 }], reason: "Add a task", by: "Bob", at: "2026-11-12T09:00:00Z" },
    { version: 1, trigger: "ncr.created", conditions: { all: [] }, actions: [{ type: "notify", recipients: [{ kind: "record_owner" }], message: "Look" }], reason: null, by: "Bob", at: "2026-11-10T09:00:00Z" },
  ],
  runs: [{ id: "w1", version: 2, status: "done", results: { 0: { reference: "TSK-26-0001", created: true, ok: true } }, record: { kind: "nonconformance", id: NC, label: "NCR-26-0004 · Burr", path: `/Non-Conformance/Register/${NC}` }, at: "2026-11-12T10:00:00Z" }],
};
let rule = saved;
let rules = [{ id: "r1", reference: "WF-001", name: "Major NCs", status: "active", version: 2, triggerLabel: "A non-conformance is raised", runs: 3, lastRunAt: "2026-11-12T10:00:00Z" }];
let permissions = ["workflows.read", "workflows.manage"];
let testResult = null;
const events = [
  { eventId: 41, at: "2026-11-12T08:00:00Z", record: { kind: "nonconformance", id: NC, label: "NCR-26-0004 · Burr", path: `/Non-Conformance/Register/${NC}` }, facts: [{ field: "severity", label: "Severity", value: "major", words: "Major" }] },
];

vi.mock("../../contexts/ToastProvider", () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock("../../hooks/useQmsApi", () => ({
  usePermissions: () => ({ can: (p) => permissions.includes(p), isLoading: false }),
  useSites: () => ({ data: { data: [] } }),
  useRoles: () => ({ data: { data: [{ id: "role-1", name: "Quality manager" }] } }),
  useAllDepartments: () => ({ data: { data: [] } }),
}));
vi.mock("../../hooks/useCustomFields", () => ({ useCustomFieldPeople: () => ({ data: [{ id: U, name: "Ann Smith" }] }) }));
vi.mock("../../hooks/useCalibration", () => ({ useGaugeTypes: () => ({ data: [] }) }));
vi.mock("../../hooks/useProcessControl", () => ({ usePartFamilies: () => ({ data: { items: [] } }), useMachines: () => ({ data: { items: [] } }) }));
vi.mock("../../hooks/useWorkflows", () => ({
  useWorkflowTriggers: () => ({ data: triggers, isLoading: false }),
  useWorkflowRules: () => ({ data: rules, isLoading: false }),
  useWorkflowRule: (id) => ({ data: id ? rule : undefined, isLoading: false }),
  useWorkflowRuleMutation: () => ({ mutate, isPending: false, error: null, variables: null }),
  useWorkflowTestEvents: () => ({ data: events, isLoading: false }),
  useTestWorkflowRule: () => ({ mutate: testRule, isPending: false, error: null, data: testResult }),
}));

import WorkflowsPage from "./WorkflowsPage";
import WorkflowRulePage from "./WorkflowRulePage";

const show = (path) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/Settings/Workflows" element={<WorkflowsPage />} />
        <Route path="/Settings/Workflows/:id" element={<WorkflowRulePage />} />
      </Routes>
    </MemoryRouter>,
  );

beforeEach(() => {
  mutate.mockReset();
  testRule.mockReset();
  rule = saved;
  permissions = ["workflows.read", "workflows.manage"];
  testResult = null;
});

describe("Settings → Workflows", () => {
  it("lists the rules with what starts them, status, version and runs", () => {
    show("/Settings/Workflows");
    const row = screen.getByRole("link", { name: "Major NCs" }).closest("tr");
    expect(within(row).getByText("A non-conformance is raised")).toBeInTheDocument();
    expect(within(row).getByText("Active")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /New rule/ })).toHaveAttribute("href", "/Settings/Workflows/new");
  });

  it("offers no new rule without workflows.manage", () => {
    permissions = ["workflows.read"];
    show("/Settings/Workflows");
    expect(screen.queryByRole("link", { name: /New rule/ })).not.toBeInTheDocument();
  });

  it("builds a new rule from forms and saves it", async () => {
    const user = userEvent.setup();
    show("/Settings/Workflows/new");
    const save = screen.getByRole("button", { name: "Save and turn on" });
    expect(save).toBeDisabled();
    expect(screen.getByText(/Still needed: give the rule a name/)).toBeInTheDocument();
    await user.type(screen.getByLabelText("Name"), "Major NCs to QM");
    await user.click(screen.getByLabelText("What starts the rule"));
    await user.click(screen.getByRole("option", { name: "A non-conformance is raised" }));
    await user.click(screen.getByRole("button", { name: "Add a condition" }));
    await user.click(screen.getByLabelText("Severity: value"));
    await user.click(screen.getByRole("option", { name: "Major" }));
    await user.type(screen.getByLabelText("Message"), "Have a look");
    await user.click(save);
    expect(mutate).toHaveBeenCalledWith(
      {
        action: "create",
        body: {
          name: "Major NCs to QM",
          trigger: "ncr.created",
          conditions: { all: [{ field: "severity", op: "gte", value: "major" }] },
          actions: [{ type: "notify", recipients: [{ kind: "record_owner" }], message: "Have a look" }],
        },
      },
      expect.any(Object),
    );
  });

  it("adds a hold on the lot and a timer that chases if the NC is still not closed", async () => {
    const user = userEvent.setup();
    show("/Settings/Workflows/new");
    await user.type(screen.getByLabelText("Name"), "Hold and chase");
    await user.click(screen.getByLabelText("What starts the rule"));
    await user.click(screen.getByRole("option", { name: "A non-conformance is raised" }));
    const first = screen.getByRole("listitem", { name: "Action 1" });
    await user.click(within(first).getByRole("button", { name: "Hold the lot" }));
    await user.type(within(first).getByLabelText("Why the lot is held"), "Suspect material");
    await user.click(screen.getByRole("button", { name: "Add an action" }));
    const second = screen.getByRole("listitem", { name: "Action 2" });
    await user.click(within(second).getByRole("button", { name: "Later, if still…" }));
    const days = within(second).getByLabelText("After (days)");
    await user.clear(days);
    await user.type(days, "2");
    await user.type(within(second).getByLabelText("Message"), "Still open");
    await user.click(screen.getByRole("button", { name: "Save and turn on" }));
    expect(mutate.mock.lastCall[0].body.actions).toEqual([
      { type: "hold_lot", reason: "Suspect material" },
      { type: "later", afterDays: 2, conditions: { all: [] }, actions: [{ type: "notify", recipients: [{ kind: "record_owner" }], message: "Still open" }] },
    ]);
  });

  it("asks why when what a rule does changes, but not for a new name", async () => {
    const user = userEvent.setup();
    show("/Settings/Workflows/r1");
    const name = screen.getByLabelText("Name");
    await user.clear(name);
    await user.type(name, "Major NCs (QM)");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(mutate).toHaveBeenLastCalledWith({ action: "update", id: "r1", body: { name: "Major NCs (QM)", description: null } }, expect.any(Object));

    await user.clear(screen.getByLabelText("Task"));
    await user.type(screen.getByLabelText("Task"), "Contain the lot");
    expect(screen.getByText("This will be version 3.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save" }));
    const dialog = screen.getByRole("dialog", { name: "Save as version 3" });
    await user.type(within(dialog).getByLabelText("Why is this changing?"), "Say what to do");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    const body = mutate.mock.lastCall[0].body;
    expect(body).toMatchObject({ reason: "Say what to do", trigger: "ncr.created", actions: [{ type: "task", title: "Contain the lot", dueDays: 2 }] });
  });

  it("shows what each version did and why, and what the rule did", () => {
    show("/Settings/Workflows/r1");
    const versions = screen.getByRole("list", { name: "Versions" });
    expect(within(versions).getByText("Why: Add a task")).toBeInTheDocument();
    expect(within(versions).getByText("Give Ann Smith a task: “Check the containment” (due in 2 days)")).toBeInTheDocument();
    expect(within(versions).getByText("if Severity is at least Major")).toBeInTheDocument();
    const runs = screen.getByRole("list", { name: "Runs" });
    expect(within(runs).getByRole("link", { name: "NCR-26-0004 · Burr" })).toHaveAttribute("href", `/Non-Conformance/Register/${NC}`);
    expect(within(runs).getByText("1: task TSK-26-0001")).toBeInTheDocument();
  });

  it("tests the rule as written against a recent event and says whom it would reach", async () => {
    const user = userEvent.setup();
    const view = show("/Settings/Workflows/r1");
    await user.click(screen.getByLabelText("Test against"));
    await user.click(screen.getByRole("option", { name: /NCR-26-0004 · Burr/ }));
    await user.click(screen.getByRole("button", { name: "Run the test" }));
    expect(testRule).toHaveBeenCalledWith(expect.objectContaining({ eventId: 41, trigger: "ncr.created", conditions: saved.conditions }));
    testResult = {
      eventId: 41, matched: true, record: events[0].record, labels: {},
      conditions: { all: [{ field: "severity", label: "Severity", op: "gte", value: "major", holds: true }], any: [] },
      actions: [{ index: 0, type: "task", total: 1, wouldTell: 1, people: [{ userId: U, name: "Ann Smith", told: true }] }],
    };
    view.rerender(
      <MemoryRouter initialEntries={["/Settings/Workflows/r1"]}>
        <Routes>
          <Route path="/Settings/Workflows/:id" element={<WorkflowRulePage />} />
        </Routes>
      </MemoryRouter>,
    );
    await user.click(screen.getByLabelText("Test against"));
    await user.click(screen.getByRole("option", { name: /NCR-26-0004 · Burr/ }));
    expect(await screen.findByText("The rule would run")).toBeInTheDocument();
    expect(screen.getByText("Would go to Ann Smith.")).toBeInTheDocument();
  });

  it("retires a rule with a reason, and shows everything read-only without workflows.manage", async () => {
    const user = userEvent.setup();
    show("/Settings/Workflows/r1");
    await user.click(screen.getByRole("button", { name: "Retire" }));
    const dialog = screen.getByRole("dialog", { name: "Retire this rule" });
    await user.type(within(dialog).getByLabelText("Why is it being retired?"), "Not needed");
    await user.click(within(dialog).getByRole("button", { name: "Retire" }));
    expect(mutate).toHaveBeenCalledWith({ action: "status", id: "r1", body: { status: "retired", reason: "Not needed" } }, expect.any(Object));
  });

  it("is read-only for someone who only reads workflows", () => {
    permissions = ["workflows.read"];
    show("/Settings/Workflows/r1");
    expect(screen.getByLabelText("Name")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
    expect(screen.queryByText("Test the rule")).not.toBeInTheDocument();
  });
});
