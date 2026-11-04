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
