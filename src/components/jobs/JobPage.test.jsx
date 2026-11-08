import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

let permissions;
let job;
const apiFetch = vi.fn();
vi.mock("../../lib/api-client", async (importOriginal) => ({ ...(await importOriginal()), apiFetch: (...a) => apiFetch(...a) }));
vi.mock("../../contexts/OrganisationProvider", () => ({ useOrganisation: () => ({ organisationId: "org-1" }) }));
vi.mock("../../hooks/useQmsApi", () => ({ usePermissions: () => ({ can: (p) => permissions.includes(p) }), useSites: () => ({ data: { data: [] } }), useOrganisationDetails: () => ({ data: undefined }) }));
vi.mock("../../contexts/ToastProvider", () => ({ useToast: () => ({ showToast: vi.fn() }) }));

import JobPage from "./JobPage";

const requirement = {
  id: "q-vis",
  sequence: 1,
  characteristicKey: "VISUAL",
  charNumber: null,
  name: "No chatter marks",
  operationCode: "OP-10",
  dataType: "attribute",
  applicable: true,
  applicability: "All parts in scope",
  nominal: null,
  lowerLimit: null,
  upperLimit: null,
  unitCode: null,
  method: null,
  gaugeType: null,
  criticality: "minor",
  chartType: null,
  sampling: [{ triggerType: "first_off", intervalValue: null, sampleSize: 1 }],
  reactions: [],
};
const baseJob = (over = {}) => ({
  id: "j1",
  reference: "IPI-26-0007",
  status: "in_progress",
  result: null,
  part: { id: "p1", partNumber: "ROD-1", name: "Rod" },
  partRevision: "A",
  plan: { id: "cp1", planCode: "CP-ROD", revisionCode: "A" },
  operationCode: "OP-10",
  site: { id: "s1", name: "Plant A" },
  machine: { id: "m1", code: "CNC-1", name: "Lathe 1" },
  workOrder: null,
  lot: null,
  lotSize: 200,
  serial: null,
  triggerType: "first_off",
  startedAt: new Date(Date.now() - 5 * 60000).toISOString(),
  startedBy: { id: "u1", name: "Sam Operator" },
  failures: 0,
  completedAt: null,
  completedBy: null,
  abandonReason: null,
  requirements: [requirement],
  schedule: [{ number: 1, position: 1, trigger: "first_off", requirementIds: ["q-vis"] }],
  samples: [],
  measurements: [],
  ncrs: [],
  ...over,
});

const renderIt = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={["/Jobs/j1"]}>
        <Routes>
          <Route path="/Jobs/:id" element={<JobPage />} />
          <Route path="/" element={<p>Dashboard</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );

const patches = () => apiFetch.mock.calls.filter(([, o]) => o?.method === "PATCH");

beforeEach(() => {
  permissions = ["inspection.read", "inspection.record"];
  job = baseJob();
  apiFetch.mockReset();
  apiFetch.mockImplementation(async (path, opts = {}) => {
    if (path === "/inspections/j1") return job;
    if (path.startsWith("/gauges")) return { data: [], page: 1, pageSize: 200, total: 0 };
    if (path === "/jobs/j1" && opts.method === "PATCH") {
      job = { ...job, ...Object.fromEntries(Object.entries(opts.body).map(([k, v]) => [k, v === "" ? null : v])) };
      return job;
    }
    if (path === "/inspections/j1/samples") return job;
    if (path === "/jobs/j1/revisions") return { days: 30, partRevisionSuperseded: false, planRevisionSuperseded: false, data: [] };
    throw new Error(`unexpected ${opts.method ?? "GET"} ${path}`);
  });
});

describe("the job hub", () => {
  it("shows the job at a glance: part, machine, status, elapsed time, the plan and the checks to record", async () => {
    renderIt();
    expect(await screen.findByRole("heading", { level: 1, name: "ROD-1 · CNC-1" })).toBeInTheDocument();
    expect(screen.getByText(/IPI-26-0007 · running 5m/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "CP-ROD rev A" })).toBeInTheDocument();
    expect(screen.getByRole("form", { name: "New sample" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save sample" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Complete inspection" })).toBeInTheDocument();
  });

  it("saves the work order and the quantity as each field is left, and only when changed", async () => {
    const user = userEvent.setup();
    renderIt();
    const wo = await screen.findByLabelText("Work order");
    await user.type(wo, "WO-5001");
    expect(patches()).toHaveLength(0);
    await user.tab();
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(patches()[0][0]).toBe("/jobs/j1");
    expect(patches()[0][1].body).toEqual({ workOrder: "WO-5001" });
    const qty = screen.getByLabelText("Quantity (parts)");
    expect(qty).toHaveValue("200");
    await user.clear(qty);
    await user.type(qty, "250");
    await user.tab();
    await waitFor(() => expect(patches()).toHaveLength(2));
    expect(patches()[1][1].body).toEqual({ lotSize: 250 });
    await user.click(wo);
    await user.tab(); // left unchanged: nothing more is sent
    expect(patches()).toHaveLength(2);
  });

  it("refuses a quantity that is not a whole number and puts the saved one back", async () => {
    const user = userEvent.setup();
    renderIt();
    const qty = await screen.findByLabelText("Quantity (parts)");
    await user.clear(qty);
    await user.type(qty, "12x");
    await user.tab();
    expect(patches()).toHaveLength(0);
    await waitFor(() => expect(qty).toHaveValue("200"));
  });

  it("puts the old value back and says why when saving fails", async () => {
    const user = userEvent.setup();
    renderIt();
    const wo = await screen.findByLabelText("Work order");
    apiFetch.mockImplementation(async (path, opts = {}) => {
      if (path === "/inspections/j1") return job;
      if (path.startsWith("/gauges")) return { data: [] };
      if (opts.method === "PATCH") throw Object.assign(new Error("Inspection IPI-26-0007 is completed"), { status: 409 });
      throw new Error(`unexpected ${path}`);
    });
    await user.type(wo, "WO-1");
    await user.tab();
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText("Work order")).toHaveValue(""));
  });

  it("is read-only for someone who cannot record, and for a job that has ended", async () => {
    permissions = ["inspection.read"];
    renderIt();
    expect(await screen.findByLabelText("Work order")).toBeDisabled();
    expect(screen.queryByRole("form", { name: "New sample" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Complete inspection" })).toBeNull();
  });

  it("shows a finished job with its result, no entry form and a way back", async () => {
    job = baseJob({ status: "completed", result: "pass", completedAt: new Date().toISOString(), completedBy: { id: "u1", name: "Sam Operator" } });
    renderIt();
    expect(await screen.findByText("Pass")).toBeInTheDocument();
    expect(screen.getByLabelText("Work order")).toBeDisabled();
    expect(screen.queryByRole("form", { name: "New sample" })).toBeNull();
    expect(screen.getByRole("link", { name: /back to the dashboard/i })).toBeInTheDocument();
  });
});
