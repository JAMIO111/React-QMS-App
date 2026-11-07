import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

let permissions;
const apiFetch = vi.fn();
vi.mock("../../lib/api-client", async (importOriginal) => ({ ...(await importOriginal()), apiFetch: (...a) => apiFetch(...a) }));
vi.mock("../../contexts/OrganisationProvider", () => ({ useOrganisation: () => ({ organisationId: "org-1" }) }));
vi.mock("../../hooks/useQmsApi", () => ({ usePermissions: () => ({ can: (p) => permissions.includes(p) }) }));
vi.mock("../ncr/Pickers", () => ({
  TextAreaField: ({ label, value, onChange, disabled }) => <textarea aria-label={label} value={value} disabled={disabled} onChange={(e) => onChange(e)} />,
  NcrPicker: () => <div />,
}));

import CapaPage from "./CapaPage";

const KEYS = ["d0", "d1", "d2", "d3", "d4", "d5", "d6", "d7", "d8"];
const steps = (problems = {}) => KEYS.map((step) => ({ step, completed: false, completedAt: null, completedBy: null, note: null, reopenedAt: null, reopenReason: null, problems: problems[step] ?? [] }));
const cause = (over = {}) => ({ id: "r1", kind: "occurrence", description: "No tool life limit", sourceAnalysisId: null, verified: false, verifiedAt: null, verifiedBy: null, verificationMethod: null, verificationNote: null, createdAt: "2026-11-05T09:00:00Z", ...over });
const whysAnalysis = (over = {}) => ({ id: "w1", kind: "five_whys", title: "5 Whys: occurrence", step: "d4", createdBy: { id: "u1", name: "Ada Owner" }, createdAt: "2026-11-05T09:00:00Z", updatedAt: "2026-11-05T09:00:00Z",
  data: { kind: "occurrence", problem: "Burrs on the bore", whys: [{ because: "The tool was worn" }, { because: "Nobody tracks tool life" }], rootCause: "No tool life limit" }, ...over });
const fishAnalysis = () => ({ id: "f1", kind: "ishikawa", title: "Ishikawa diagram", step: "d4", createdBy: null, createdAt: "2026-11-05T09:00:00Z", updatedAt: "2026-11-05T09:00:00Z",
  data: { effect: "Burrs on the bore", categories: [{ key: "machine", causes: [{ id: "c1", text: "Worn boring bar", probable: true }, { id: "c2", text: "Loose fixture", probable: false }] }, { key: "method", causes: [] }] } });
const base = () => ({
  id: "c1", reference: "CAPA-000001", method: "8d", title: "Burrs on the bore", stage: "open", stageReason: null, source: "internal", severity: null, externalReference: null,
  owner: null, dueDate: null, overdue: false, currentStep: "d4", stepsDone: 4, ncrCount: 0, createdAt: "2026-11-05T09:00:00Z", closedAt: null,
  problemStatement: "Burrs", createdBy: null, updatedAt: "2026-11-05T09:00:00Z", problem: { who: null, what: "Burrs on the bore", where: null, when: null, why: null, how: null, howMany: null },
  d3NoContainmentReason: null, analyses: [], rootCauses: [], actions: [], team: [], ncrs: [],
  steps: steps({ d4: ["Record at least one occurrence root cause (why the problem happened)"] }),
});
const renderAt = (url) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[url]}><Routes><Route path="/CAPA/:id/:step" element={<CapaPage />} /></Routes></MemoryRouter>
    </QueryClientProvider>,
  );
const respond = (main) => async (path, opts = {}) => (path === "/capas/people" ? { data: [] } : typeof main === "function" ? main(path, opts) : main);

beforeEach(() => {
  apiFetch.mockReset();
  permissions = ["capa.read", "capa.manage"];
});

describe("D4: root causes", () => {
  it("lists causes by kind with their verification, source and what is still needed", async () => {
    apiFetch.mockImplementation(respond(() => ({
      ...base(),
      analyses: [whysAnalysis()],
      rootCauses: [
        cause({ verified: true, verifiedAt: "2026-11-05T12:00:00Z", verifiedBy: { id: "u1", name: "Ada Owner" }, verificationMethod: "Trial with a new tool", verificationNote: "Burrs stopped", sourceAnalysisId: "w1" }),
        cause({ id: "r2", kind: "systemic", description: "No tool monitoring in the control plan" }),
      ],
      steps: steps({ d4: ["Verify the 1 root cause not yet verified"] }),
    })));
    renderAt("/CAPA/c1/d4");
    const list = await screen.findByRole("list", { name: "Root causes" });
    expect(screen.getByText("1 of 2 verified")).toBeInTheDocument();
    expect(within(list).getByText("Occurrence")).toBeInTheDocument();
    expect(within(list).getByText("Systemic")).toBeInTheDocument();
    expect(within(list).getByText(/Verified/)).toHaveTextContent("Verified");
    expect(within(list).getByText(/Trial with a new tool/)).toBeInTheDocument();
    expect(within(list).getByText("From 5 Whys: occurrence")).toBeInTheDocument();
    expect(within(list).getByText("Not verified yet")).toBeInTheDocument();
    expect(screen.getByText(/Also record why it escaped detection/)).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Still needed" })).toHaveTextContent("Verify the 1 root cause not yet verified");
  });

  it("adds a root cause of a chosen kind", async () => {
    let call;
    apiFetch.mockImplementation(respond((path, opts = {}) => (opts.method === "POST" ? ((call = [path, opts.body]), base()) : base())));
    renderAt("/CAPA/c1/d4");
    expect(await screen.findByText(/No root cause yet/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Add a root cause" }));
    const dialog = screen.getByRole("dialog", { name: "Add a root cause" });
    expect(within(dialog).getByRole("button", { name: "Add root cause" })).toBeDisabled();
    await userEvent.click(within(dialog).getByRole("combobox", { name: "Kind" }));
    await userEvent.click(screen.getByRole("option", { name: /Escape/ }));
    await userEvent.type(within(dialog).getByLabelText("The root cause"), "Final inspection samples 1 in 50");
    await userEvent.click(within(dialog).getByRole("button", { name: "Add root cause" }));
    await waitFor(() => expect(call).toEqual(["/capas/c1/root-causes", { kind: "escape", description: "Final inspection samples 1 in 50" }]));
  });

  it("verifies a cause with a method and a note; withdraws a verification; edits; removes after confirming", async () => {
    const calls = [];
    apiFetch.mockImplementation(respond((path, opts = {}) => (opts.method ? (calls.push([opts.method, path, opts.body]), base()) : { ...base(), rootCauses: [cause(), cause({ id: "r2", description: "Verified one", verified: true, verifiedAt: "2026-11-05T12:00:00Z", verifiedBy: { id: "u1", name: "Ada Owner" }, verificationMethod: "Test" })] })));
    renderAt("/CAPA/c1/d4");
    await userEvent.click(await screen.findByRole("button", { name: "Verify: No tool life limit" }));
    const dialog = screen.getByRole("dialog", { name: "Verify the root cause" });
    expect(within(dialog).getByRole("button", { name: "Mark as verified" })).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText("How was it verified?"), "Trial with a new tool");
    await userEvent.type(within(dialog).getByLabelText(/What was found/), "Burrs stopped");
    await userEvent.click(within(dialog).getByRole("button", { name: "Mark as verified" }));
    await waitFor(() => expect(calls).toContainEqual(["PATCH", "/capa-root-causes/r1", { verified: true, verificationMethod: "Trial with a new tool", verificationNote: "Burrs stopped" }]));

    await userEvent.click(screen.getByRole("button", { name: "Withdraw verification of: Verified one" }));
    await waitFor(() => expect(calls).toContainEqual(["PATCH", "/capa-root-causes/r2", { verified: false }]));

    await userEvent.click(screen.getByRole("button", { name: "Edit: Verified one" }));
    const edit = screen.getByRole("dialog", { name: "Edit root cause" });
    expect(within(edit).getByText(/withdraws its verification/)).toBeInTheDocument();
    await userEvent.click(within(edit).getByRole("button", { name: "Cancel" }));

    await userEvent.click(screen.getByRole("button", { name: "Remove: No tool life limit" }));
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(calls).toContainEqual(["DELETE", "/capa-root-causes/r1", undefined]));
  });

  it("a reader sees causes and verifications but has no buttons", async () => {
    permissions = ["capa.read"];
    apiFetch.mockImplementation(respond(() => ({ ...base(), rootCauses: [cause()], analyses: [whysAnalysis()] })));
    renderAt("/CAPA/c1/d4");
    await screen.findByRole("list", { name: "Root causes" });
    expect(screen.queryByRole("button", { name: /Add a root cause|New Ishikawa|New 5 Whys|Verify:|Edit:|Remove/ })).toBeNull();
    expect(screen.getByRole("button", { name: "View 5 Whys: occurrence" })).toBeInTheDocument();
  });

  it("a completed D4 is read-only until it is reopened", async () => {
    apiFetch.mockImplementation(respond(() => ({ ...base(), rootCauses: [cause()], steps: steps().map((s) => (s.step === "d4" ? { ...s, completed: true, completedAt: "2026-11-05T10:00:00Z", completedBy: { id: "u1", name: "Ada Owner" } } : s)) })));
    renderAt("/CAPA/c1/d4");
    expect(await screen.findByText(/D4 was completed by Ada Owner/)).toBeInTheDocument();
    expect(screen.getByText(/D4 is complete, so it is read-only/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add a root cause" })).toBeNull();
    expect(screen.queryByRole("button", { name: "New Ishikawa diagram" })).toBeNull();
    expect(screen.getByRole("button", { name: "Reopen D4" })).toBeEnabled();
  });
});

describe("D4: 5 Whys", () => {
  it("builds a chain of whys, each asked about the answer before, and saves it with the chosen kind", async () => {
    let call;
    apiFetch.mockImplementation(respond((path, opts = {}) => (opts.method === "POST" ? ((call = [path, opts.body]), base()) : base())));
    renderAt("/CAPA/c1/d4");
    await userEvent.click(await screen.findByRole("button", { name: "New 5 Whys" }));
    const dialog = screen.getByRole("dialog", { name: "5 Whys" });
    expect(within(dialog).getByLabelText("The problem")).toHaveValue("Burrs on the bore");
    expect(within(dialog).getAllByRole("listitem")).toHaveLength(3);
    await userEvent.type(within(dialog).getByLabelText("Because (why 1)"), "The tool was worn");
    expect(within(dialog).getByText(/Why 2: why did “The tool was worn” happen\?/)).toBeInTheDocument();
    await userEvent.type(within(dialog).getByLabelText("Because (why 2)"), "Nobody tracks tool life");
    await userEvent.click(within(dialog).getByRole("button", { name: "Add another why" }));
    expect(within(dialog).getAllByRole("listitem")).toHaveLength(4);
    await userEvent.click(within(dialog).getByRole("button", { name: "Remove the last why" }));
    expect(within(dialog).getByRole("button", { name: "Remove the last why" })).toBeDisabled(); // at the minimum of three
    await userEvent.type(within(dialog).getByLabelText("The root cause"), "No tool life limit");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save analysis" }));
    await waitFor(() => expect(call?.[0]).toBe("/capas/c1/analyses"));
    expect(call[1]).toEqual({ kind: "five_whys", title: "5 Whys", data: { kind: "occurrence", problem: "Burrs on the bore", whys: [{ because: "The tool was worn" }, { because: "Nobody tracks tool life" }], rootCause: "No tool life limit" } });
  });

  it("saves and records its conclusion as a root cause of the chosen kind, linked to the analysis", async () => {
    const calls = [];
    let analyses = [];
    apiFetch.mockImplementation(respond((path, opts = {}) => {
      if (opts.method === "POST" && path.endsWith("/analyses")) {
        calls.push([path, opts.body]);
        analyses = [whysAnalysis({ id: "new-w", title: "Why it escaped", data: opts.body.data })];
        return { ...base(), analyses };
      }
      if (opts.method === "POST") return calls.push([path, opts.body]), { ...base(), analyses };
      return { ...base(), analyses };
    }));
    renderAt("/CAPA/c1/d4");
    await userEvent.click(await screen.findByRole("button", { name: "New 5 Whys" }));
    const dialog = screen.getByRole("dialog", { name: "5 Whys" });
    const record = within(dialog).getByRole("button", { name: "Save and record as root cause" });
    expect(record).toBeDisabled();
    await userEvent.clear(within(dialog).getByLabelText("Title"));
    await userEvent.type(within(dialog).getByLabelText("Title"), "Why it escaped");
    await userEvent.click(within(dialog).getByRole("combobox", { name: "This chain explains" }));
    await userEvent.click(screen.getByRole("option", { name: /Escape/ }));
    await userEvent.type(within(dialog).getByLabelText("Because (why 1)"), "Sampling is 1 in 50");
    await userEvent.type(within(dialog).getByLabelText("The root cause"), "Sampling plan too thin");
    await userEvent.click(record);
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[0][0]).toBe("/capas/c1/analyses");
    expect(calls[0][1].data.kind).toBe("escape");
    expect(calls[1]).toEqual(["/capas/c1/root-causes", { kind: "escape", description: "Sampling plan too thin", sourceAnalysisId: "new-w" }]);
  });

  it("reopens a saved chain with its answers, and will not record the same conclusion twice", async () => {
    apiFetch.mockImplementation(respond(() => ({ ...base(), analyses: [whysAnalysis()], rootCauses: [cause({ sourceAnalysisId: "w1" })] })));
    renderAt("/CAPA/c1/d4");
    await userEvent.click(await screen.findByRole("button", { name: "Open 5 Whys: occurrence" }));
    const dialog = screen.getByRole("dialog", { name: "5 Whys" });
    expect(within(dialog).getByLabelText("Because (why 1)")).toHaveValue("The tool was worn");
    expect(within(dialog).getByLabelText("The root cause")).toHaveValue("No tool life limit");
    expect(within(dialog).getByRole("button", { name: "Already a root cause" })).toBeDisabled();
  });
});

describe("D4: Ishikawa diagram", () => {
  it("shows the six categories, adds causes, stars probable ones, draws the diagram, and saves the data", async () => {
    let call;
    apiFetch.mockImplementation(respond((path, opts = {}) => (opts.method === "POST" ? ((call = [path, opts.body]), base()) : base())));
    renderAt("/CAPA/c1/d4");
    await userEvent.click(await screen.findByRole("button", { name: "New Ishikawa diagram" }));
    const dialog = screen.getByRole("dialog", { name: "Ishikawa diagram" });
    for (const name of ["Man", "Machine", "Material", "Method", "Measurement", "Environment"]) expect(within(dialog).getByRole("region", { name })).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Effect (the problem)")).toHaveValue("Burrs on the bore");
    await userEvent.type(within(dialog).getByLabelText("Add a cause under Machine"), "Worn boring bar{enter}");
    await userEvent.type(within(dialog).getByLabelText("Add a cause under Method"), "No tool life limit");
    await userEvent.click(within(dialog).getByRole("button", { name: "Add to Method" }));
    await userEvent.click(within(dialog).getByRole("button", { name: 'Mark "Worn boring bar" as probable' }));
    expect(within(dialog).getByRole("img", { name: "Ishikawa diagram: Burrs on the bore" })).toHaveTextContent("Worn boring bar");
    expect(within(dialog).queryByRole("button", { name: /Record .* as a root cause/ })).toBeNull(); // save first
    await userEvent.click(within(dialog).getByRole("button", { name: "Save diagram" }));
    await waitFor(() => expect(call?.[0]).toBe("/capas/c1/analyses"));
    expect(call[1].kind).toBe("ishikawa");
    const machine = call[1].data.categories.find((c) => c.key === "machine");
    expect(machine.causes).toEqual([expect.objectContaining({ text: "Worn boring bar", probable: true })]);
    expect(call[1].data.categories.find((c) => c.key === "method").causes[0].text).toBe("No tool life limit");
    expect(call[1].data.categories).toHaveLength(6);
  });

  it("a saved diagram offers to record a cause as a root cause, once", async () => {
    const calls = [];
    apiFetch.mockImplementation(respond((path, opts = {}) => (opts.method ? (calls.push([path, opts.body]), base()) : { ...base(), analyses: [fishAnalysis()], rootCauses: [cause({ description: "Loose fixture", sourceAnalysisId: "f1" })] })));
    renderAt("/CAPA/c1/d4");
    expect(await screen.findByText("2 causes, 1 probable")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Open Ishikawa diagram" }));
    const dialog = screen.getByRole("dialog", { name: "Ishikawa diagram" });
    expect(within(dialog).getByRole("button", { name: 'Record "Loose fixture" as a root cause' })).toHaveTextContent("Recorded");
    expect(within(dialog).getByRole("button", { name: 'Record "Loose fixture" as a root cause' })).toBeDisabled();
    await userEvent.click(within(dialog).getByRole("button", { name: 'Record "Worn boring bar" as a root cause' }));
    await waitFor(() => expect(calls).toContainEqual(["/capas/c1/root-causes", { kind: "occurrence", description: "Worn boring bar", sourceAnalysisId: "f1" }]));
  });

  it("removes an analysis after confirming; the causes recorded from it stay", async () => {
    const calls = [];
    apiFetch.mockImplementation(respond((path, opts = {}) => (opts.method ? (calls.push([opts.method, path]), base()) : { ...base(), analyses: [fishAnalysis()] })));
    renderAt("/CAPA/c1/d4");
    await userEvent.click(await screen.findByRole("button", { name: "Remove Ishikawa diagram" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/Root causes recorded from it stay/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(calls).toContainEqual(["DELETE", "/capa-analyses/f1"]));
  });
});
