import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const apiFetch = vi.fn();
let permissions;
vi.mock("../../lib/api-client", async (importOriginal) => ({ ...(await importOriginal()), apiFetch: (...a) => apiFetch(...a) }));
vi.mock("../../contexts/OrganisationProvider", () => ({ useOrganisation: () => ({ organisationId: "org-1" }) }));
vi.mock("../../hooks/useQmsApi", () => ({ usePermissions: () => ({ can: (p) => permissions.includes(p) }) }));
vi.mock("../../hooks/useProcessControl", () => ({
  useMachines: () => ({ data: { items: [{ id: "m1", code: "CNC-1", name: "Lathe 1" }, { id: "m2", code: "CNC-2", name: "Lathe 2" }] }, isFetching: false }),
}));
vi.mock("../ncr/Pickers", () => ({
  PartPicker: ({ label, onChange }) => (
    <button type="button" onClick={() => onChange("p1", { id: "p1", name: "ROD-1" })}>
      pick part ({label})
    </button>
  ),
}));

import StartJobCard from "./StartJobCard";

const preview = (over = {}) => ({
  machine: { id: "m1", code: "CNC-1", name: "Lathe 1" },
  part: { id: "p1", partNumber: "ROD-1", name: "Rod" },
  site: { id: "s1", name: "Plant A" },
  siteProblem: null,
  status: "ok",
  problems: [],
  operations: [{ code: "OP-10", name: "Turning" }],
  needsOperation: false,
  operationCode: "OP-10",
  needsLotSize: false,
  partRevision: "A",
  plan: { planCode: "CP-ROD", revisionCode: "A" },
  requirementCount: 3,
  ...over,
});
let previewResult;
let mine;

const renderIt = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <Routes>
          <Route path="/" element={<StartJobCard />} />
          <Route path="/Jobs/:id" element={<p>Hub of {location.pathname}</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );

const choose = async (user) => {
  await user.click(screen.getByRole("button", { name: "Start new job" }));
  await user.click(screen.getByRole("combobox", { name: /machine/i }));
  await user.click(await screen.findByText("CNC-1 · Lathe 1"));
  await user.click(screen.getByRole("button", { name: /pick part/i }));
};

beforeEach(() => {
  localStorage.clear();
  permissions = ["inspection.record"];
  previewResult = preview();
  mine = { data: [], total: 0 };
  apiFetch.mockReset();
  apiFetch.mockImplementation(async (path, opts = {}) => {
    if (path.startsWith("/jobs/preview")) return previewResult;
    if (path === "/jobs/mine") return mine;
    if (path === "/jobs" && opts.method === "POST") return { id: "job-1", ...opts.body };
    throw new Error(`unexpected ${path}`);
  });
});

describe("the dashboard job card", () => {
  it("is for people who can record inspections only", () => {
    permissions = ["ncr.read"];
    renderIt();
    expect(screen.queryByRole("region", { name: "Jobs" })).toBeNull();
  });

  it("lists the person's running jobs to resume", async () => {
    mine = { total: 1, data: [{ id: "job-9", reference: "IPI-26-0009", part: { partNumber: "ROD-1" }, machine: { code: "CNC-1" }, workOrder: "WO-5", startedAt: new Date(Date.now() - 125 * 60000).toISOString() }] };
    renderIt();
    const link = await screen.findByRole("link", { name: /ROD-1 · CNC-1 · WO-5/ });
    expect(link).toHaveAttribute("href", "/Jobs/job-9");
    expect(link).toHaveTextContent("2h 05m");
  });
});

describe("the start pop-up", () => {
  it("asks only for the machine and the part, shows what was worked out, and starts with the machine and part", async () => {
    const user = userEvent.setup();
    renderIt();
    await choose(user);
    expect(await screen.findByText(/Plant A · CP-ROD rev A · part rev A/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/operation/i)).toBeNull();
    expect(screen.queryByLabelText(/quantity/i)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Start job" }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/jobs", expect.objectContaining({ method: "POST", body: { machineId: "m1", partId: "p1", operationCode: "OP-10" } })));
    expect(JSON.parse(localStorage.getItem("fortress.lastMachine"))["org-1"]).toEqual({ id: "m1", name: "Lathe 1" });
  });

  it("asks for the operation only when the plan has several, and for the quantity only when checks are sampled every N parts", async () => {
    previewResult = preview({ needsOperation: true, operationCode: null, needsLotSize: true, operations: [{ code: "OP-10", name: "Turning" }, { code: "OP-20", name: "Milling" }] });
    const user = userEvent.setup();
    renderIt();
    await choose(user);
    const start = await screen.findByRole("button", { name: "Start job" });
    expect(start).toBeDisabled();
    await user.selectOptions(screen.getByLabelText(/operation/i), "OP-20");
    expect(start).toBeDisabled(); // still needs the quantity
    await user.type(screen.getByLabelText(/quantity/i), "250");
    await waitFor(() => expect(start).toBeEnabled());
    await user.click(start);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/jobs", expect.objectContaining({ body: { machineId: "m1", partId: "p1", operationCode: "OP-20", lotSize: 250 } })));
  });

  it("explains in the resolver's words why the job cannot start, and keeps Start off", async () => {
    previewResult = preview({ status: "blocked", problems: [{ code: "no_plan", message: "No effective revision of CP-ROD." }] });
    const user = userEvent.setup();
    renderIt();
    await choose(user);
    expect(await screen.findByText("No effective revision of CP-ROD.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start job" })).toBeDisabled();
  });

  it("opens on the machine used last on this device", async () => {
    localStorage.setItem("fortress.lastMachine", JSON.stringify({ "org-1": { id: "m1", name: "Lathe 1" } }));
    const user = userEvent.setup();
    renderIt();
    await user.click(screen.getByRole("button", { name: "Start new job" }));
    expect(screen.getByRole("combobox", { name: /machine/i })).toHaveValue("CNC-1 · Lathe 1");
  });
});
