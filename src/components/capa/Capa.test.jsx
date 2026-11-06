import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

let permissions;
const apiFetch = vi.fn();
vi.mock("../../lib/api-client", async (importOriginal) => ({ ...(await importOriginal()), apiFetch: (...a) => apiFetch(...a) }));
vi.mock("../../contexts/OrganisationProvider", () => ({ useOrganisation: () => ({ organisationId: "org-1" }) }));
vi.mock("../../hooks/useQmsApi", () => ({ usePermissions: () => ({ can: (p) => permissions.includes(p) }) }));
vi.mock("../ncr/Pickers", () => ({
  TextAreaField: ({ label, value, onChange }) => <textarea aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} />,
  NcrPicker: ({ label, onChange }) => <button type="button" onClick={() => onChange("n9", { id: "n9", name: "NC-26-009 · Burrs" })}>{label}: pick NC-26-009</button>,
}));

import CapaRegisterPage from "./CapaRegisterPage";
import CapaPage from "./CapaPage";
import NcrCapaCard from "./NcrCapaCard";

const STEP_KEYS = ["d0", "d1", "d2", "d3", "d4", "d5", "d6", "d7", "d8"];
const steps = (done = 0, problems = {}) =>
  STEP_KEYS.map((step, i) => ({ step, completed: i < done, completedAt: i < done ? "2026-11-05T10:00:00Z" : null, completedBy: i < done ? { id: "u1", name: "Ada Owner" } : null, note: null, reopenedAt: null, reopenReason: null, problems: i < done ? [] : (problems[step] ?? []) }));
const summary = (over = {}) => ({
  id: "c1", reference: "CAPA-000001", method: "8d", title: "8D: Cracked bar stock", stage: "open", stageReason: null, source: "supplier", severity: "major", externalReference: null,
  owner: { membershipId: "m1", name: "Ada Owner" }, dueDate: "2026-12-01", overdue: false, currentStep: "d0", stepsDone: 0, ncrCount: 1, createdAt: "2026-11-05T09:00:00Z", closedAt: null, ...over,
});
const detail = (over = {}) => ({
  ...summary(),
  problemStatement: "Cracks on lot 77",
  createdBy: { id: "u1", name: "Ada Owner" },
  updatedAt: "2026-11-05T09:00:00Z",
  steps: steps(0, { d1: ["Add at least two people to the team"], d2: ["This step is not available yet"] }),
  team: [{ id: "t1", membershipId: "m1", userId: "u1", name: "Ada Owner", company: null, email: null, role: "leader", external: false, endedAt: null }],
  ncrs: [{ id: "l1", nonconformanceId: "n1", reference: "NC-26-001", title: "Cracked bar stock", stage: "open", source: "supplier", severity: "major", linkedAt: "2026-11-05T09:00:00Z", linkedBy: { id: "u1", name: "Ada Owner" }, endedAt: null, endReason: null }],
  ...over,
});
const people = { data: [{ membershipId: "m1", userId: "u1", name: "Ada Owner" }, { membershipId: "m2", userId: "u2", name: "Eve Engineer" }] };

const renderAt = (url, ui) => {
  let where = "";
  const Where = () => ((where = useLocation().pathname + useLocation().search), null);
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="/CAPA" element={<><CapaRegisterPage /><Where /></>} />
          <Route path="/CAPA/:id" element={<><CapaPage /><Where /></>} />
          <Route path="/CAPA/:id/:step" element={<><CapaPage /><Where /></>} />
          <Route path="/Non-Conformance/:type/:id" element={<><div>NC page</div>{ui}<Where /></>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return () => where;
};
/** Answers the reads every 8D page makes; `main` answers the rest. */
const respond = (main) => async (path, opts = {}) => {
  if (path === "/capas/people") return people;
  return typeof main === "function" ? main(path, opts) : main;
};

beforeEach(() => {
  apiFetch.mockReset();
  permissions = ["capa.read", "capa.manage"];
});

describe("8D register", () => {
  it("lists 8Ds with stage, progress, owner, due date and NC count, and filters through the URL", async () => {
    apiFetch.mockResolvedValue({ data: [summary(), summary({ id: "c2", reference: "CAPA-000002", title: "Burrs", stage: "actions_in_progress", stepsDone: 4, currentStep: "d4", overdue: true, dueDate: "2026-10-01", ncrCount: 3, externalReference: "SCAR-14" })] });
    const where = renderAt("/CAPA");
    const table = await screen.findByRole("table", { name: "8Ds" });
    expect(within(table).getByRole("link", { name: "CAPA-000001" })).toHaveAttribute("href", "/CAPA/c1/d0");
    expect(within(table).getByRole("link", { name: "CAPA-000002" })).toHaveAttribute("href", "/CAPA/c2/d4");
    expect(within(table).getByText("Actions in progress")).toBeInTheDocument();
    expect(within(table).getByText("D4 · 4/9")).toBeInTheDocument();
    expect(within(table).getByText(/Overdue/)).toBeInTheDocument();
    expect(within(table).getByText("SCAR-14")).toBeInTheDocument();
    expect(apiFetch).toHaveBeenCalledWith("/capas?stage=running", { organisationId: "org-1" });
    await userEvent.click(screen.getByLabelText("Only 8Ds I own"));
    await waitFor(() => expect(where()).toBe("/CAPA?owner=me"));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/capas?stage=running&owner=me", { organisationId: "org-1" }));
  });

  it("starts an 8D from the register and opens D0; there is no button without capa.manage", async () => {
    let body;
    apiFetch.mockImplementation(respond((path, opts = {}) => (opts.method === "POST" ? ((body = opts.body), detail({ id: "new1" })) : { data: [] })));
    const where = renderAt("/CAPA");
    await userEvent.click(await screen.findByRole("button", { name: "Start an 8D" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "Start 8D" })).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText(/Title/), "Recurring burrs");
    await userEvent.click(within(dialog).getByRole("button", { name: "Start 8D" }));
    await waitFor(() => expect(where()).toBe("/CAPA/new1/d0"));
    expect(body).toMatchObject({ title: "Recurring burrs", source: "internal" });
  });

  it("offers no start button to a reader", async () => {
    permissions = ["capa.read"];
    apiFetch.mockResolvedValue({ data: [] });
    renderAt("/CAPA");
    expect(await screen.findByText("No 8Ds match.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start an 8D" })).toBeNull();
  });
});

describe("8D step page", () => {
  it("opens the step the 8D is at, with the stepper marking done, current and the step on screen", async () => {
    apiFetch.mockImplementation(respond(() => detail({ stepsDone: 1, currentStep: "d1", steps: steps(1, { d1: ["Add at least two people to the team"] }) })));
    const where = renderAt("/CAPA/c1");
    await screen.findByRole("heading", { name: /D1 · Form the team/ });
    expect(where()).toBe("/CAPA/c1/d1");
    const nav = screen.getByRole("navigation", { name: "8D steps" });
    expect(within(nav).getAllByRole("link")).toHaveLength(9);
    expect(within(nav).getByRole("link", { name: /Team/ })).toHaveAttribute("aria-current", "step");
    expect(within(within(nav).getByRole("link", { name: /Initiate/ })).getByLabelText("Complete")).toBeInTheDocument();
    expect(within(nav).getByRole("link", { name: /Team/ })).toHaveTextContent("In progress");
    expect(screen.getByText("CAPA-000001")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "NC-26-001" })).toHaveAttribute("href", "/Non-Conformance/Supplier/n1");
  });

  it("D0 saves only what changed, and lists linked non-conformances", async () => {
    let body;
    apiFetch.mockImplementation(respond((path, opts = {}) => (opts.method === "PATCH" ? ((body = opts.body), detail({ title: "New title" })) : detail())));
    renderAt("/CAPA/c1/d0");
    const form = await screen.findByRole("form", { name: "8D details" });
    const save = within(form).getByRole("button", { name: "Save changes" });
    expect(save).toBeDisabled();
    const title = within(form).getByLabelText(/Title/);
    await userEvent.clear(title);
    await userEvent.type(title, "New title");
    await userEvent.click(save);
    await waitFor(() => expect(body).toEqual({ title: "New title" }));
    const list = screen.getByRole("list", { name: "Linked non-conformances" });
    expect(within(list).getByRole("link", { name: "NC-26-001" })).toHaveAttribute("href", "/Non-Conformance/Supplier/n1");
  });

  it("D0 links another NC and ends a link with a reason", async () => {
    const calls = [];
    apiFetch.mockImplementation(respond((path, opts = {}) => (opts.method ? (calls.push([opts.method, path, opts.body]), detail()) : detail())));
    renderAt("/CAPA/c1/d0");
    await userEvent.click(await screen.findByRole("button", { name: "Link a non-conformance" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "Link" })).toBeDisabled();
    await userEvent.click(within(dialog).getByRole("button", { name: /pick NC-26-009/ }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Link" }));
    await waitFor(() => expect(calls).toContainEqual(["POST", "/capas/c1/ncrs", { ncrId: "n9" }]));
    await userEvent.click(screen.getByRole("button", { name: "End link to NC-26-001" }));
    const end = screen.getByRole("dialog");
    await userEvent.type(within(end).getByLabelText(/Why is it no longer part/), "Linked by mistake");
    await userEvent.click(within(end).getByRole("button", { name: "End link" }));
    await waitFor(() => expect(calls).toContainEqual(["POST", "/capa-ncr-links/l1/unlink", { reason: "Linked by mistake" }]));
  });

  it("shows what is still needed, completes the step when ready and moves to the next", async () => {
    const calls = [];
    let completed = false;
    apiFetch.mockImplementation(respond((path, opts = {}) => {
      if (opts.method === "POST") {
        calls.push([path, opts.body]);
        completed = true;
        return detail({ stepsDone: 1, currentStep: "d1", steps: steps(1, { d1: ["Add at least two people to the team"] }) });
      }
      return completed ? detail({ stepsDone: 1, currentStep: "d1", steps: steps(1, { d1: ["Add at least two people to the team"] }) }) : detail();
    }));
    const where = renderAt("/CAPA/c1/d0");
    const status = await screen.findByRole("status", { name: "Still needed" });
    expect(status).toHaveTextContent("Everything D0 needs is in place.");
    await userEvent.click(screen.getByRole("button", { name: "Complete D0 and continue" }));
    await waitFor(() => expect(calls).toEqual([["/capas/c1/complete-step", { step: "d0" }]]));
    await waitFor(() => expect(where()).toBe("/CAPA/c1/d1"));
    expect(await screen.findByRole("heading", { name: /D1 · Form the team/ })).toBeInTheDocument();
  });

  it("lists what is missing and disables completing; an earlier step does not have to be done first", async () => {
    apiFetch.mockImplementation(respond(() => detail({ steps: steps(0, { d0: [], d1: ["Name a team leader", "Add at least two people to the team"] }) })));
    renderAt("/CAPA/c1/d1");
    const status = await screen.findByRole("status", { name: "Still needed" });
    expect(within(status).queryByText(/first/)).toBeNull();
    expect(within(status).getByText("Name a team leader")).toBeInTheDocument();
    expect(within(status).getByText("Add at least two people to the team")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Complete D1 and continue" })).toBeDisabled();
  });

  it("a complete step says who completed it and reopens, with a reason", async () => {
    const calls = [];
    apiFetch.mockImplementation(respond((path, opts = {}) => (opts.method ? (calls.push([path, opts.body]), detail()) : detail({ stepsDone: 2, currentStep: "d2", steps: steps(2) }))));
    renderAt("/CAPA/c1/d1");
    expect(await screen.findByText(/D1 was completed by Ada Owner on/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Complete D1/ })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Reopen D1" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "Reopen D1" })).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText(/Why is D1 being reopened/), "A member left");
    await userEvent.click(within(dialog).getByRole("button", { name: "Reopen D1" }));
    await waitFor(() => expect(calls).toEqual([["/capas/c1/reopen-step", { step: "d1", reason: "A member left" }]]));
  });

  it("a reader sees everything but cannot change or complete anything", async () => {
    permissions = ["capa.read"];
    apiFetch.mockImplementation(respond(() => detail()));
    renderAt("/CAPA/c1/d0");
    const form = await screen.findByRole("form", { name: "8D details" });
    expect(within(form).getByLabelText(/Title/)).toBeDisabled();
    expect(within(form).queryByRole("button", { name: "Save changes" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Complete D0/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Link a non-conformance" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel 8D" })).toBeNull();
    expect(apiFetch).not.toHaveBeenCalledWith("/capas/people", expect.anything());
  });

  it("cancels with a reason; a cancelled 8D is read-only and can be reopened", async () => {
    const calls = [];
    apiFetch.mockImplementation(respond((path, opts = {}) => (opts.method ? (calls.push([path, opts.body]), detail()) : detail())));
    renderAt("/CAPA/c1/d0");
    await userEvent.click(await screen.findByRole("button", { name: "Cancel 8D" }));
    await userEvent.type(within(screen.getByRole("dialog")).getByLabelText(/Why is this 8D being cancelled/), "Raised twice");
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel 8D" }));
    await waitFor(() => expect(calls).toEqual([["/capas/c1/cancel", { reason: "Raised twice" }]]));
  });

  it("a cancelled 8D shows its reason, is read-only and offers to reopen it", async () => {
    apiFetch.mockImplementation(respond(() => detail({ stage: "cancelled", stageReason: "Raised twice" })));
    renderAt("/CAPA/c1/d0");
    expect(await screen.findByText(/Cancelled: Raised twice/)).toBeInTheDocument();
    expect(screen.getByText(/This 8D is cancelled. Reopen it to make changes./)).toBeInTheDocument();
    expect(within(screen.getByRole("form", { name: "8D details" })).getByLabelText(/Title/)).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reopen 8D" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel 8D" })).toBeNull();
  });
});

describe("D1 team", () => {
  it("adds a member with a role, changes a role, removes someone and adds an external contact", async () => {
    const calls = [];
    const team = [
      { id: "t1", membershipId: "m1", userId: "u1", name: "Ada Owner", company: null, email: null, role: "leader", external: false, endedAt: null },
      { id: "t2", membershipId: null, userId: null, name: "Sam Supplier", company: "Bar Co", email: "sam@barco.test", role: "supplier_contact", external: true, endedAt: null },
    ];
    apiFetch.mockImplementation(respond((path, opts = {}) => (opts.method ? (calls.push([opts.method, path, opts.body]), detail({ team })) : detail({ team }))));
    renderAt("/CAPA/c1/d1");
    const list = await screen.findByRole("list", { name: "Team members" });
    expect(within(list).getByText("External")).toBeInTheDocument();
    expect(within(list).getByText("Bar Co · sam@barco.test")).toBeInTheDocument();

    // Add a member of the organisation as champion.
    const form = screen.getByRole("form", { name: "Add a team member" });
    expect(within(form).getByRole("button", { name: "Add" })).toBeDisabled();
    await userEvent.click(within(form).getByRole("combobox", { name: "Add a member of the organisation" }));
    expect(screen.queryByRole("option", { name: "Ada Owner" })).toBeNull(); // already on the team
    await userEvent.click(screen.getByRole("option", { name: "Eve Engineer" }));
    await userEvent.click(within(form).getByRole("combobox", { name: "Role" }));
    await userEvent.click(screen.getByRole("option", { name: /Champion/ }));
    await userEvent.click(within(form).getByRole("button", { name: "Add" }));
    await waitFor(() => expect(calls).toContainEqual(["POST", "/capas/c1/team", { membershipId: "m2", role: "champion" }]));

    // Remove someone.
    await userEvent.click(screen.getByRole("button", { name: "Remove Sam Supplier from the team" }));
    await waitFor(() => expect(calls).toContainEqual(["PATCH", "/capa-team/t2", { ended: true }]));

    // Add an external contact.
    await userEvent.click(screen.getByRole("button", { name: "Add an external contact" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "Add contact" })).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText(/Name/), "Pat Customer");
    await userEvent.type(within(dialog).getByLabelText("Company"), "Big Co");
    await userEvent.click(within(dialog).getByRole("button", { name: "Add contact" }));
    await waitFor(() => expect(calls).toContainEqual(["POST", "/capas/c1/team", { externalName: "Pat Customer", role: "supplier_contact", externalCompany: "Big Co" }]));
  });

  it("shows people who left in a closed list and a reader gets no controls", async () => {
    permissions = ["capa.read"];
    const team = [
      { id: "t1", membershipId: "m1", userId: "u1", name: "Ada Owner", company: null, email: null, role: "leader", external: false, endedAt: null },
      { id: "t3", membershipId: "m3", userId: "u3", name: "Lee Left", company: null, email: null, role: "member", external: false, endedAt: "2026-11-05T10:00:00Z" },
    ];
    apiFetch.mockImplementation(respond(() => detail({ team })));
    renderAt("/CAPA/c1/d1");
    expect(await screen.findByText("1 left the team")).toBeInTheDocument();
    expect(screen.queryByRole("form", { name: "Add a team member" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Remove/ })).toBeNull();
    expect(screen.getByText("Leader")).toBeInTheDocument();
  });
});

describe("NC page 8D card", () => {
  const ncr = { id: "n1", reference: "NC-26-001", stage: "open", deletedAt: null };
  const card = (url = "/Non-Conformance/Supplier/n1") => renderAt(url, <NcrCapaCard ncr={ncr} />);

  it("starts a new 8D from the non-conformance and opens D0", async () => {
    let body;
    apiFetch.mockImplementation(respond((path, opts = {}) => (opts.method === "POST" ? ((body = opts.body), detail({ id: "new1" })) : { data: [] })));
    const where = card();
    expect(await screen.findByText("No 8D addresses this non-conformance yet.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Start a new 8D" }));
    await waitFor(() => expect(where()).toBe("/CAPA/new1/d0"));
    expect(body).toEqual({ fromNcrId: "n1" });
  });

  it("links it to an existing running 8D, leaving out those it is already in", async () => {
    const calls = [];
    apiFetch.mockImplementation(respond((path, opts = {}) => {
      if (opts.method) return calls.push([opts.method, path, opts.body]), detail();
      if (path.startsWith("/capas?")) return { data: [summary(), summary({ id: "c2", reference: "CAPA-000002", title: "Burrs", currentStep: "d3" })] };
      return { data: [] };
    }));
    card();
    await userEvent.click(await screen.findByRole("button", { name: "Link to an existing 8D" }));
    const dialog = screen.getByRole("dialog");
    await userEvent.click(within(dialog).getByRole("combobox", { name: "8D" }));
    await userEvent.click(await screen.findByRole("option", { name: /CAPA-000002/ }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Link" }));
    await waitFor(() => expect(calls).toContainEqual(["POST", "/capas/c2/ncrs", { ncrId: "n1" }]));
    expect(apiFetch).toHaveBeenCalledWith("/capas?stage=running", { organisationId: "org-1" });
  });

  it("lists the 8Ds it is in, with stage and progress, and unlinks with a reason", async () => {
    const calls = [];
    apiFetch.mockImplementation(respond((path, opts = {}) => {
      if (opts.method) return calls.push([opts.method, path, opts.body]), detail();
      if (path === "/ncrs/n1/capas") return { data: [{ linkId: "l1", capaId: "c1", reference: "CAPA-000001", title: "8D: Cracked bar stock", stage: "actions_in_progress", currentStep: "d4", stepsDone: 4, linkedAt: "2026-11-05T09:00:00Z" }] };
      return { data: [] };
    }));
    card();
    const list = await screen.findByRole("list", { name: "8Ds for this non-conformance" });
    expect(within(list).getByRole("link", { name: "CAPA-000001" })).toHaveAttribute("href", "/CAPA/c1/d4");
    expect(within(list).getByText("Actions in progress")).toBeInTheDocument();
    expect(within(list).getByText("D4 · 4/9")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start another 8D" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Unlink CAPA-000001" }));
    const dialog = screen.getByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText(/no longer part of this 8D/), "Wrong 8D");
    await userEvent.click(within(dialog).getByRole("button", { name: "Unlink" }));
    await waitFor(() => expect(calls).toContainEqual(["POST", "/capa-ncr-links/l1/unlink", { reason: "Wrong 8D" }]));
  });

  it("readers see the 8Ds but cannot start or link; people without capa.read see nothing", async () => {
    permissions = ["capa.read"];
    apiFetch.mockImplementation(respond(() => ({ data: [] })));
    card();
    expect(await screen.findByText("You can read 8Ds but not start them.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start a new 8D" })).toBeNull();
  });

  it("is hidden entirely without capa.read", async () => {
    permissions = [];
    apiFetch.mockResolvedValue({ data: [] });
    card();
    await screen.findByText("NC page");
    expect(screen.queryByLabelText("8D investigation")).toBeNull();
    expect(apiFetch).not.toHaveBeenCalled();
  });
});
