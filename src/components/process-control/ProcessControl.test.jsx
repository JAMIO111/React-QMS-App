import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

let permissions;
const apiFetch = vi.fn();
vi.mock("../../lib/api-client", async (importOriginal) => ({ ...(await importOriginal()), apiFetch: (...a) => apiFetch(...a) }));
vi.mock("../../contexts/OrganisationProvider", () => ({ useOrganisation: () => ({ organisationId: "org-1" }) }));
vi.mock("../../hooks/useQmsApi", () => ({
  usePermissions: () => ({ can: (p) => permissions.includes(p) }),
  useSites: () => ({ data: { data: [{ id: "s1", name: "Plant A" }] } }),
  useMe: () => ({ data: { profile: { id: "u1", firstName: "Ada", surname: "Owner" } } }),
  useMembers: () => ({ data: { data: [] } }),
}));
vi.mock("../../contexts/ToastProvider", () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock("../../contexts/ConfirmationModalProvider", () => ({ useConfirm: () => async () => true }));

import ControlPlansPage from "./ControlPlansPage";
import ControlPlanPage from "./ControlPlanPage";
import RevisionPage from "./RevisionPage";
import MachinesPage from "../master-data/MachinesPage";
import PartFamilyPage from "../master-data/PartFamilyPage";
import PartDetailPage from "../master-data/PartDetailPage";

const page = (data, nextCursor = null) => ({ data, nextCursor });
const person = { id: "u1", name: "Ada Owner" };
const rev = (over) => ({
  id: "cr1",
  controlPlanId: "cp1",
  revisionCode: "A",
  status: "draft",
  changeReason: null,
  effectiveFrom: null,
  effectiveUntil: null,
  supersedesRevision: null,
  createdAt: "2026-11-04T10:00:00Z",
  createdBy: person,
  submittedAt: null,
  submittedBy: null,
  approvedAt: null,
  approvedBy: null,
  reviewComment: null,
  obsoleteReason: null,
  ...over,
});
const plan = (revisions) => ({
  id: "cp1",
  planCode: "CP-HCR-001",
  title: "Rods – turning",
  description: null,
  owner: person,
  active: true,
  families: ["HCR"],
  effectiveRevision: revisions.find((r) => r.status === "effective")?.revisionCode ?? null,
  openRevision: null,
  updatedAt: "2026-11-04T10:00:00Z",
  applicability: [{ id: "ap1", partFamily: { id: "f1", code: "HCR", name: "Rods" }, part: null, site: null, operationCode: "OP-020" }],
  revisions,
});

const routeApi = (routes) =>
  apiFetch.mockImplementation(async (path, opts = {}) => {
    const k = `${opts.method ?? "GET"} ${path.split("?")[0]}`;
    if (!(k in routes)) throw new Error(`unexpected ${k}`);
    return typeof routes[k] === "function" ? routes[k](path, opts) : routes[k];
  });

const renderAt = (url) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="/Process-Control/Plans" element={<ControlPlansPage />} />
          <Route path="/Process-Control/Plans/:id" element={<ControlPlanPage />} />
          <Route path="/Process-Control/Plans/:planId/revisions/:revisionId" element={<RevisionPage />} />
          <Route path="/Machines" element={<MachinesPage />} />
          <Route path="/Part-Families/:id" element={<PartFamilyPage />} />
          <Route path="/Parts/:id" element={<PartDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );

beforeEach(() => {
  apiFetch.mockReset();
  permissions = ["master_data.read", "master_data.manage", "process_control.read", "process_control.manage", "process_control.approve"];
});

describe("Control plans register", () => {
  it("lists plans with effective and in-progress revisions", async () => {
    routeApi({
      "GET /part-families": page([]),
      "GET /control-plans": page([
        { ...plan([]), effectiveRevision: "B", openRevision: { revisionCode: "C", status: "pending_approval" } },
      ]),
    });
    renderAt("/Process-Control/Plans");
    expect(await screen.findByRole("link", { name: "CP-HCR-001" })).toHaveAttribute("href", "/Process-Control/Plans/cp1");
    const table = screen.getByRole("region", { name: "Control plans" });
    expect(within(table).getByText("Awaiting approval")).toBeInTheDocument();
    expect(within(table).getByText("HCR")).toBeInTheDocument();
  });

  it("creates a plan for a family", async () => {
    let body;
    routeApi({
      "GET /part-families": page([{ id: "f1", code: "HCR", name: "Rods", active: true, partCount: 2, planCount: 0 }]),
      "GET /control-plans": page([]),
      "POST /control-plans": (_p, opts) => ((body = opts.body), plan([rev()])),
      "GET /control-plans/cp1": plan([rev()]),
    });
    renderAt("/Process-Control/Plans");
    await userEvent.click(await screen.findByRole("button", { name: "New plan" }));
    const dialog = screen.getByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText("Plan code"), "CP-HCR-001");
    await userEvent.type(within(dialog).getByLabelText("Title"), "Rods – turning");
    await userEvent.selectOptions(await within(dialog).findByLabelText("Part family"), "f1");
    await userEvent.click(within(dialog).getByRole("button", { name: "Create plan" }));
    expect(await screen.findByRole("heading", { name: /CP-HCR-001/ })).toBeInTheDocument();
    expect(body).toEqual({ planCode: "CP-HCR-001", title: "Rods – turning", description: "", revisionCode: "A", partFamilyId: "f1" });
  });

  it("hides New plan from readers", async () => {
    permissions = ["process_control.read"];
    routeApi({ "GET /part-families": page([]), "GET /control-plans": page([]) });
    renderAt("/Process-Control/Plans");
    expect(await screen.findByText("No control plans yet.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New plan" })).toBeNull();
  });
});

describe("Control plan page", () => {
  const routes = (revisions, extra = {}) => ({
    "GET /control-plans/cp1": plan(revisions),
    "GET /part-families": page([]),
    ...extra,
  });

  it("shows the scope and offers draft actions to authors", async () => {
    permissions = ["process_control.read", "process_control.manage"];
    routeApi(routes([rev({ reviewComment: "Add the OD check" })]));
    renderAt("/Process-Control/Plans/cp1");
    const scope = await screen.findByRole("table", { name: "Scope" });
    expect(within(scope).getByText("OP-020")).toBeInTheDocument();
    const revisions = screen.getByRole("table", { name: "Revisions" });
    expect(within(revisions).getByText("“Add the OD check”")).toBeInTheDocument();
    expect(within(revisions).getByRole("button", { name: "Submit for approval" })).toBeInTheDocument();
    expect(within(revisions).getByRole("button", { name: "Discard" })).toBeInTheDocument();
    expect(within(revisions).queryByRole("button", { name: "Approve" })).toBeNull();
    // A draft is open, so no second revision can be started.
    expect(screen.queryByRole("button", { name: "New revision" })).toBeNull();
  });

  it("approves a pending revision with a comment, superseding the effective one", async () => {
    let sent;
    routeApi(
      routes([rev({ id: "cr2", revisionCode: "B", status: "pending_approval", changeReason: "Tighter OD", submittedAt: "2026-11-04T11:00:00Z", submittedBy: person }), rev({ status: "effective", effectiveFrom: "2026-11-01T00:00:00Z" })], {
        "POST /control-plan-revisions/cr2/transitions": (_p, opts) => ((sent = opts.body), rev({ id: "cr2", revisionCode: "B", status: "effective" })),
      })
    );
    renderAt("/Process-Control/Plans/cp1");
    await userEvent.click(await screen.findByRole("button", { name: "Approve" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("It becomes effective straight away and revision A is superseded.")).toBeInTheDocument();
    await userEvent.type(within(dialog).getByLabelText("Comment"), "Looks good");
    await userEvent.click(within(dialog).getByRole("button", { name: "Approve" }));
    expect(sent).toEqual({ action: "approve", comment: "Looks good" });
  });

  it("needs a reason to make a revision obsolete", async () => {
    let sent;
    routeApi(
      routes([rev({ status: "effective", effectiveFrom: "2026-11-01T00:00:00Z" })], {
        "POST /control-plan-revisions/cr1/transitions": (_p, opts) => ((sent = opts.body), rev({ status: "obsolete" })),
      })
    );
    renderAt("/Process-Control/Plans/cp1");
    await userEvent.click(await screen.findByRole("button", { name: "Make obsolete" }));
    const dialog = screen.getByRole("dialog");
    const confirm = within(dialog).getByRole("button", { name: "Make obsolete" });
    expect(confirm).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText("Reason"), "Product discontinued");
    await userEvent.click(confirm);
    expect(sent).toEqual({ action: "obsolete", reason: "Product discontinued" });
  });

  it("offers no lifecycle actions to readers", async () => {
    permissions = ["process_control.read"];
    routeApi(routes([rev({ status: "pending_approval" })]));
    renderAt("/Process-Control/Plans/cp1");
    const revisions = await screen.findByRole("table", { name: "Revisions" });
    expect(within(revisions).queryAllByRole("button")).toHaveLength(0);
    expect(screen.getByLabelText("Title")).toBeDisabled();
  });
});

describe("Machines", () => {
  it("adds a machine at a site", async () => {
    let body;
    routeApi({
      "GET /machines": page([]),
      "POST /machines": (_p, opts) => ((body = opts.body), { id: "m1", ...opts.body, site: null, active: true }),
    });
    renderAt("/Machines");
    await userEvent.click(await screen.findByRole("button", { name: "Add machine" }));
    const dialog = screen.getByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText("Code"), "LATHE-01");
    await userEvent.type(within(dialog).getByLabelText("Name"), "CNC lathe");
    await userEvent.selectOptions(within(dialog).getByLabelText("Site"), "s1");
    await userEvent.click(within(dialog).getByRole("button", { name: "Add machine" }));
    expect(body).toEqual({ code: "LATHE-01", name: "CNC lathe", siteId: "s1", workCentre: "", description: "" });
  });
});

describe("Part family page", () => {
  it("lists the family's parts and plans", async () => {
    routeApi({
      "GET /part-families/f1": {
        id: "f1",
        code: "HCR",
        name: "Rods",
        description: "Same route",
        active: true,
        partCount: 1,
        planCount: 1,
        parts: [{ id: "p1", partNumber: "HCR-100", name: "Rod 100", active: true, currentRevision: "A" }],
        plans: [{ id: "cp1", planCode: "CP-HCR-001", title: "Rods – turning", active: true, effectiveRevision: "B", scope: "All parts" }],
      },
    });
    renderAt("/Part-Families/f1");
    expect(await screen.findByRole("link", { name: "HCR-100" })).toHaveAttribute("href", "/Parts/p1");
    expect(screen.getByRole("link", { name: "CP-HCR-001" })).toHaveAttribute("href", "/Process-Control/Plans/cp1");
  });
});

describe("Part specification values", () => {
  const part = {
    id: "p1",
    partNumber: "HCR-100",
    name: "Rod 100",
    description: null,
    customer: null,
    partFamily: { id: "f1", code: "HCR", name: "Rods" },
    active: true,
    currentRevision: "A",
    revisions: [
      { id: "r2", partId: "p1", revision: "B", drawingRef: null, changeSummary: null, status: "draft", releasedAt: null, createdAt: "2026-11-04T10:00:00Z" },
      { id: "r1", partId: "p1", revision: "A", drawingRef: null, changeSummary: null, status: "released", releasedAt: "2026-11-01T10:00:00Z", createdAt: "2026-11-01T10:00:00Z" },
    ],
  };
  const value = (id, revisionId, nominal) => ({ id, partRevisionId: revisionId, characteristicKey: "LENGTH", description: null, nominal, lowerLimit: nominal - 0.1, upperLimit: nominal + 0.1, unitCode: "mm", notes: null });

  it("edits values on the draft and locks the released revision", async () => {
    routeApi({
      "GET /parts/p1": part,
      "GET /customers": page([]),
      "GET /part-families": page([{ id: "f1", code: "HCR", name: "Rods", active: true }]),
      "GET /units": { data: [{ code: "mm", name: "Millimetre", quantityKind: "length" }] },
      "GET /part-revisions/r2/characteristics": { data: [value("v2", "r2", 100.5)] },
      "GET /part-revisions/r1/characteristics": { data: [value("v1", "r1", 100)] },
    });
    renderAt("/Parts/p1");
    const draftTable = await screen.findByRole("table", { name: "Specification values of revision B" });
    expect(within(draftTable).getByText("100.5")).toBeInTheDocument();
    expect(within(draftTable).getByRole("button", { name: "Edit LENGTH" })).toBeInTheDocument();
    expect(screen.getByLabelText("Part family")).toHaveValue("f1");

    await userEvent.selectOptions(screen.getByLabelText("Revision"), "r1");
    const released = await screen.findByRole("table", { name: "Specification values of revision A" });
    expect(within(released).queryByRole("button")).toBeNull();
    expect(screen.getByText(/Revision A is released; its values are locked/)).toBeInTheDocument();
  });
});

describe("Revision page", () => {
  const characteristic = (over) => ({
    id: "c1",
    operationId: "o1",
    characteristicKey: "OD",
    sequence: 10,
    charNumber: "3",
    name: "Outer diameter",
    dataType: "variable",
    valueSource: "plan",
    appliesTo: "all",
    nominal: 25,
    lowerLimit: 24.95,
    upperLimit: 25.05,
    unitCode: "mm",
    specKey: null,
    method: "Micrometer, 3 positions",
    gaugeType: { id: "g1", name: "Micrometer 0-25" },
    criticality: "critical",
    spcEligible: true,
    chartType: "xbar_r",
    subgroupSize: 5,
    decimals: 2,
    notes: null,
    parts: [],
    sampling: [{ id: "s1", triggerType: "every_n_minutes", intervalValue: 30, sampleSize: 5 }],
    reactions: [],
    ...over,
  });
  const detail = (over) => ({
    ...rev({ id: "cr2", revisionCode: "B", supersedesRevision: { id: "cr1", revisionCode: "A" } }),
    plan: { id: "cp1", planCode: "CP-HCR-001", title: "Rods", active: true },
    operations: [
      {
        id: "o1",
        operationCode: "OP-020",
        sequence: 20,
        name: "CNC turning",
        machine: null,
        workCentre: "Turning",
        notes: null,
        characteristics: [
          characteristic({}),
          characteristic({ id: "c2", characteristicKey: "GROOVE_POS", name: "Groove position", charNumber: null, valueSource: "part_spec", specKey: "GROOVE_POS", nominal: null, lowerLimit: null, upperLimit: null, appliesTo: "selected", parts: [{ id: "p2", partNumber: "HCR-200" }], spcEligible: false, chartType: null, subgroupSize: null, sampling: [], gaugeType: null, method: null, criticality: "major" }),
        ],
      },
    ],
    reactions: [],
    scopeParts: [
      { id: "p1", partNumber: "HCR-100", name: "Rod 100" },
      { id: "p2", partNumber: "HCR-200", name: "Rod 200" },
    ],
    ...over,
  });
  const comparison = {
    base: { id: "cr1", revisionCode: "A" },
    target: { id: "cr2", revisionCode: "B" },
    operations: [],
    characteristics: [{ characteristicKey: "OD", name: "Outer diameter", change: "changed", tolerance: "tightened", fields: [{ field: "upperLimit", label: "Upper limit", from: "25.1", to: "25.05" }] }],
    reactions: [],
    summary: { added: 0, removed: 0, changed: 1 },
  };

  it("shows characteristics as operators read them, with the changes from the previous revision", async () => {
    routeApi({ "GET /control-plan-revisions/cr2": detail(), "GET /control-plan-revisions/cr2/comparison": comparison });
    renderAt("/Process-Control/Plans/cp1/revisions/cr2");
    const table = await screen.findByRole("table", { name: "Characteristics at OP-020" });
    expect(within(table).getByText("25.00 (24.95 – 25.05) mm")).toBeInTheDocument();
    expect(within(table).getByText("From part: GROOVE_POS (mm)")).toBeInTheDocument();
    expect(within(table).getByText("HCR-200")).toBeInTheDocument();
    expect(within(table).getByText("Every 30 min × 5")).toBeInTheDocument();
    expect(within(table).getByText("X-bar/R, n = 5")).toBeInTheDocument();
    expect(await screen.findByText("Tolerance tightened")).toBeInTheDocument();
    expect(screen.getByText("0 added · 1 changed · 0 removed")).toBeInTheDocument();
  });

  it("adds a conditional part-specific characteristic", async () => {
    let body;
    routeApi({
      "GET /control-plan-revisions/cr2": detail(),
      "GET /control-plan-revisions/cr2/comparison": comparison,
      "GET /units": { data: [{ code: "mm", name: "Millimetre", quantityKind: "length" }] },
      "GET /gauge-types": { data: [] },
      "POST /control-plan-revisions/cr2/characteristics": (_p, opts) => ((body = opts.body), detail()),
    });
    renderAt("/Process-Control/Plans/cp1/revisions/cr2");
    await userEvent.click(await screen.findByRole("button", { name: "Characteristic" }));
    const dialog = screen.getByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText("Key"), "LENGTH");
    await userEvent.type(within(dialog).getByLabelText("Name"), "Overall length");
    await userEvent.click(within(dialog).getByRole("radio", { name: /Part-specific/ }));
    await userEvent.type(within(dialog).getByLabelText("Specification key"), "LENGTH");
    await userEvent.click(within(dialog).getByRole("radio", { name: /Selected parts only/ }));
    await userEvent.click(within(dialog).getByRole("checkbox", { name: "HCR-100" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Save characteristic" }));
    expect(body).toMatchObject({
      operationId: "o1",
      characteristicKey: "LENGTH",
      sequence: 20,
      name: "Overall length",
      dataType: "variable",
      valueSource: "part_spec",
      specKey: "LENGTH",
      unitCode: "mm",
      nominal: null,
      appliesTo: "selected",
      partIds: ["p1"],
      sampling: [{ triggerType: "first_off", intervalValue: null, sampleSize: 1 }],
      spcEligible: false,
    });
  });

  it("is read-only once the revision is no longer a draft", async () => {
    routeApi({ "GET /control-plan-revisions/cr2": detail({ status: "effective" }), "GET /control-plan-revisions/cr2/comparison": comparison });
    renderAt("/Process-Control/Plans/cp1/revisions/cr2");
    await screen.findByRole("table", { name: "Characteristics at OP-020" });
    expect(screen.getByText(/This revision is locked/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add operation" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit OD" })).toBeNull();
  });
});

describe("Requirement preview", () => {
  const resolution = (over) => ({
    status: "ok",
    problems: [],
    resolvedAt: "2026-11-04T12:00:00Z",
    part: { id: "p1", partNumber: "HCR-100", name: "Rod 100" },
    partFamily: { id: "f1", code: "HCR", name: "Rods" },
    partRevision: { id: "r1", revision: "A", drawingRef: null, status: "released" },
    operationCode: null,
    siteId: null,
    plan: { id: "cp1", planCode: "CP-HCR-001", title: "Rods" },
    planRevision: { id: "cr1", revisionCode: "A" },
    candidatePlans: [],
    requirements: [
      { planCharacteristicId: "c1", characteristicKey: "LENGTH", charNumber: null, name: "Overall length", operationCode: "OP-020", operationName: "Turning", machineId: null, dataType: "variable", valueSource: "part_spec", specKey: "LENGTH", partRevisionCharacteristicId: "v1", applicable: true, applicability: "All parts in scope", resolved: true, nominal: 100, lowerLimit: 99.9, upperLimit: 100.1, unitCode: "mm", method: null, gaugeType: null, criticality: "major", spcEligible: false, chartType: null, subgroupSize: null, decimals: null, sampling: [], reactions: [] },
      { planCharacteristicId: "c2", characteristicKey: "GROOVE_POS", charNumber: null, name: "Groove position", operationCode: "OP-030", operationName: "Grooving", machineId: null, dataType: "variable", valueSource: "part_spec", specKey: "GROOVE_POS", partRevisionCharacteristicId: null, applicable: false, applicability: "Only for HCR-200", resolved: true, nominal: null, lowerLimit: null, upperLimit: null, unitCode: "mm", method: null, gaugeType: null, criticality: "major", spcEligible: false, chartType: null, subgroupSize: null, decimals: null, sampling: [], reactions: [] },
    ],
    ...over,
  });

  it("resolves a part from the plan's scope, showing part values and excluded checks", async () => {
    const seen = [];
    routeApi({
      "GET /control-plans/cp1": { ...plan([rev({ status: "effective", effectiveFrom: "2026-11-01T00:00:00Z" })]), scopeParts: [{ id: "p1", partNumber: "HCR-100", name: "Rod 100" }] },
      "GET /part-families": page([]),
      "GET /control-plan-resolution": (path) => (seen.push(path), resolution()),
    });
    renderAt("/Process-Control/Plans/cp1");
    await userEvent.selectOptions(await screen.findByLabelText("Part"), "p1");
    expect(await screen.findByText("Ready for inspection")).toBeInTheDocument();
    const table = screen.getByRole("table", { name: "Requirements for HCR-100" });
    expect(within(table).getByText("100 (99.9 – 100.1) mm")).toBeInTheDocument();
    expect(within(table).getByText(/Not applicable: Only for HCR-200/)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Operation"), "op-020");
    await userEvent.click(screen.getByRole("button", { name: "Apply" }));
    await screen.findByText("Ready for inspection");
    expect(seen.at(-1)).toContain("operationCode=op-020");
  });

  it("explains why an inspection could not start", async () => {
    routeApi({
      "GET /control-plans/cp1": { ...plan([]), scopeParts: [{ id: "p1", partNumber: "HCR-100", name: "Rod 100" }] },
      "GET /part-families": page([]),
      "GET /control-plan-resolution": resolution({
        status: "blocked",
        problems: [{ code: "ambiguous_plan", message: "More than one control plan applies (CP-HCR-001, CP-HCR-002); narrow their scope" }],
        requirements: [],
      }),
    });
    renderAt("/Process-Control/Plans/cp1");
    await userEvent.selectOptions(await screen.findByLabelText("Part"), "p1");
    expect(await screen.findByText("An inspection could not start")).toBeInTheDocument();
    expect(screen.getByText(/More than one control plan applies/)).toBeInTheDocument();
  });
});
