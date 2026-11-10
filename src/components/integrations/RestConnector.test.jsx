import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

let permissions;
const apiFetch = vi.fn();
vi.mock("../../lib/api-client", async (importOriginal) => ({ ...(await importOriginal()), apiFetch: (...a) => apiFetch(...a) }));
vi.mock("../../contexts/OrganisationProvider", () => ({ useOrganisation: () => ({ organisationId: "org-1" }) }));
vi.mock("../../hooks/useQmsApi", () => ({
  usePermissions: () => ({ can: (p) => permissions.includes(p) }),
  useOrganisationDetails: () => ({ data: { settings: { advancedImports: false } } }),
  useUpdateOrganisation: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("../../contexts/ToastProvider", () => ({ useToast: () => ({ showToast: vi.fn() }) }));

import SettingsIntegrations from "../Settings/SettingsIntegrations";
import ConnectionPage from "./ConnectionPage";
import RunPage from "./RunPage";
import { restEntitiesToRows, restRecordProblem, restRowsToEntities } from "../../lib/integrations";

const providers = [
  { key: "csv", name: "CSV / Excel file", description: "Import files", kind: "file", authTypes: [], capabilities: [], status: "available" },
  { key: "rest_api", name: "REST API", description: "Read from an API", kind: "api", authTypes: ["bearer"], capabilities: [], status: "available" },
];
const conn = (over = {}) => ({
  id: "c1", provider: { key: "rest_api", name: "REST API", kind: "api" }, name: "Sage 200", externalSystem: "sage-200", status: "draft",
  config: { baseUrl: "https://erp.example.com/api", authType: "bearer" }, lastTest: null, readyAt: null, readyBy: null, activatedAt: null, activatedBy: null,
  createdAt: "2026-11-09T09:00:00Z", createdBy: { id: "u1", name: "Ada Owner" }, ...over,
});
const detail = (over = {}) => ({ ...conn(), credential: null, problems: ["Store a credential"], runnable: [], canActivate: false, events: [{ action: "created", fromStatus: null, toStatus: "draft", note: "REST API", at: "2026-11-09T09:00:00Z", by: { id: "u1", name: "Ada Owner" } }], ...over });

const noRuns = { data: [], page: 1, pageSize: 20, total: 0 };
const run = (over = {}) => ({
  id: "r1", connection: { id: "c1", name: "Sage 200" }, entityType: "supplier", kind: "full", trigger: "user", status: "partial",
  requestedBy: { id: "u1", name: "Ada Owner" }, requestedAt: "2026-11-09T10:00:00Z", startedAt: "2026-11-09T10:00:01Z", finishedAt: "2026-11-09T10:00:05Z",
  counts: { total: 4, rejected: 1, unchanged: 0, created: 2, updated: 0, failed: 1, superseded: 0 }, attempts: 0, nextAttemptAt: null, errorSummary: null,
  cancelReason: null, cancelledBy: null, fetchDone: true, cursorStart: null, cursorNext: "4", errors: [],
  rowsNow: { staged: 0, previewed: 0, unchanged: 0, applied: 2, rejected: 1, failed: 1, superseded: 0 }, drain: null, ...over,
});
const calls = [];
const routeApi = (routes) =>
  apiFetch.mockImplementation(async (path, opts = {}) => {
    const k = `${opts.method ?? "GET"} ${path.split("?")[0]}`;
    calls.push({ k, body: opts.body });
    if (!(k in routes)) throw new Error(`unexpected ${k}`);
    return typeof routes[k] === "function" ? routes[k](path, opts) : routes[k];
  });
const renderAt = (at) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[at]}>
        <Routes>
          <Route path="/Settings/Integrations" element={<SettingsIntegrations />} />
          <Route path="/Settings/Integrations/:id" element={<ConnectionPage />} />
          <Route path="/Settings/Integrations/:id/runs/:runId" element={<RunPage />} />
        </Routes>
        <div id="modal-root" />
      </MemoryRouter>
    </QueryClientProvider>
  );

beforeEach(() => {
  permissions = ["integrations.read", "integrations.manage", "integrations.run", "integrations.approve"];
  calls.length = 0;
  apiFetch.mockReset();
});

describe("REST connection settings", () => {
  it("turns record rows into the entities setting and back, only with what was given", () => {
    const entities = {
      machine: { path: "/v1/machines", recordsPath: "data", paging: { style: "page", pageSize: 50, pageParam: "p" }, incremental: { param: "since", field: "updatedAt" } },
      supplier: { path: "/odata/Vendors", recordsPath: "value", paging: { style: "next_link", nextLinkPath: "@odata.nextLink" } },
      part: { path: "/parts", paging: { style: "next_link", nextLinkPath: "header" } },
    };
    expect(restRowsToEntities(restEntitiesToRows(entities))).toEqual(entities);
    const [row] = restEntitiesToRows({ part: { path: "parts" } });
    expect(restRecordProblem(row)).toBe("The path starts with /");
    expect(restRecordProblem({ ...row, path: "/p", style: "cursor" })).toBe("Say where the answer gives the next cursor");
    expect(restRecordProblem({ ...row, path: "/p", incremental: true, incParam: "since" })).toMatch(/parameter and the field/);
  });

  it("adds a kind of record with its paging to a new REST connection", async () => {
    routeApi({
      "GET /integrations/connections": { data: [] },
      "GET /integrations/runs": { data: [], page: 1, pageSize: 8, total: 0 },
      "GET /integrations/allowed-hosts": { hosts: [], canManage: true },
      "GET /integrations/providers": { data: providers },
      "GET /integrations/conflicts": { data: [], page: 1, pageSize: 1, total: 0, openCount: 0 },
      "POST /integrations/connections": conn({ id: "c9" }),
    });
    renderAt("/Settings/Integrations");
    await userEvent.click(await screen.findByRole("button", { name: /Connect an API/ }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByRole("textbox", { name: /^Name/ }), "Plant ERP");
    await userEvent.type(within(dialog).getByRole("textbox", { name: /^Address/ }), "https://erp.example.com/api");
    await userEvent.click(within(dialog).getByRole("button", { name: /Add a kind of record/ }));
    const group = within(dialog).getByRole("group", { name: "Record from the API" });
    await userEvent.click(within(group).getByRole("combobox", { name: /Kind of record/ }));
    await userEvent.click(await screen.findByRole("option", { name: "Machines" }));
    expect(within(dialog).getByRole("button", { name: "Save" })).toBeDisabled();
    const machines = within(dialog).getByRole("group", { name: "Machines from the API" });
    await userEvent.type(within(machines).getByRole("textbox", { name: /^Path/ }), "/v1/machines");
    await userEvent.type(within(machines).getByRole("textbox", { name: /Where the list is/ }), "data");
    await userEvent.click(within(machines).getByRole("switch", { name: /Incremental imports/ }));
    await userEvent.type(within(machines).getByRole("textbox", { name: /Parameter to send/ }), "updated_since");
    await userEvent.type(within(machines).getByRole("textbox", { name: /Field whose highest value/ }), "updatedAt");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls.find((c) => c.k === "POST /integrations/connections")?.body).toMatchObject({
      providerKey: "rest_api",
      config: { baseUrl: "https://erp.example.com/api", authType: "none", entities: { machine: { path: "/v1/machines", recordsPath: "data", incremental: { param: "updated_since", field: "updatedAt" } } } },
    }));
  });
});

describe("Allowed hosts", () => {
  const home = (hosts, canManage = true) => ({
    "GET /integrations/connections": { data: [] },
    "GET /integrations/runs": { data: [], page: 1, pageSize: 8, total: 0 },
    "GET /integrations/allowed-hosts": { hosts, canManage },
    "GET /integrations/providers": { data: providers },
    "GET /integrations/conflicts": { data: [], page: 1, pageSize: 1, total: 0, openCount: 0 },
  });

  it("adds and removes hosts at once", async () => {
    let answer;
    routeApi({ ...home(["partner.example.org"]), "PUT /integrations/allowed-hosts": () => new Promise((r) => { answer = r; }) });
    renderAt("/Settings/Integrations");
    expect(await screen.findByText("partner.example.org")).toBeInTheDocument();
    await userEvent.type(screen.getByRole("textbox", { name: /Add a host/ }), "https://ERP.example.com/api");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(await screen.findByText("erp.example.com")).toBeInTheDocument();
    expect(calls.find((c) => c.k === "PUT /integrations/allowed-hosts").body).toEqual({ hosts: ["partner.example.org", "erp.example.com"] });
    answer({ hosts: ["erp.example.com", "partner.example.org"], canManage: true });
  });

  it("is read-only without the right to manage integrations", async () => {
    routeApi(home(["partner.example.org"], false));
    renderAt("/Settings/Integrations");
    expect(await screen.findByText("partner.example.org")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: /Add a host/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove partner.example.org" })).not.toBeInTheDocument();
  });
});

describe("An API connection's page", () => {
  const api = detail({
    status: "active", runnable: ["machine", "part"], importable: ["machine", "part"], writable: ["machine", "part"],
    config: { ...conn().config, entities: { machine: { path: "/v1/machines", incremental: { param: "since", field: "updatedAt" } }, part: { path: "/v1/parts" } } },
  });

  it("reads a sample of what the API sends", async () => {
    routeApi({
      "GET /integrations/connections/c1": api,
      "GET /integrations/providers": { data: providers },
      "GET /integrations/runs": noRuns,
      "POST /integrations/connections/c1/sample": { columns: ["id", "code", "meta.line"], rows: [{ r: 1, v: { id: "M1", code: "PRESS-1", "meta.line": "L1" } }] },
    });
    renderAt("/Settings/Integrations/c1");
    await userEvent.click(await screen.findByRole("button", { name: "Read a sample" }));
    const table = await screen.findByRole("table", { name: "Sample from the API" });
    expect(within(table).getByText("meta.line")).toBeInTheDocument();
    expect(within(table).getByText("PRESS-1")).toBeInTheDocument();
    expect(calls.find((c) => c.k === "POST /integrations/connections/c1/sample").body).toEqual({ entityType: "machine" });
  });

  it("offers only the configured records, and imports only with a template", async () => {
    routeApi({
      "GET /integrations/connections/c1": api,
      "GET /integrations/providers": { data: providers },
      "GET /integrations/runs": noRuns,
      "GET /integrations/templates": (path) => ({ data: path.includes("entityType=machine") ? [{ id: "t1", name: "ERP machines", entityType: "machine", currentVersion: 2, lastUsedAt: null }] : [] }),
      "POST /integrations/connections/c1/runs": run({ id: "r5", kind: "incremental", entityType: "machine" }),
      "GET /integrations/runs/r5": run({ id: "r5", kind: "incremental", entityType: "machine" }),
      "GET /integrations/runs/r5/rows": { data: [], page: 1, pageSize: 50, total: 0 },
    });
    renderAt("/Settings/Integrations/c1");
    await userEvent.click(await screen.findByRole("button", { name: "Run an import" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("combobox", { name: /Records/ }));
    expect((await screen.findAllByRole("option")).map((o) => o.textContent)).toEqual(["Machines", "Parts"]);
    await userEvent.click(screen.getByRole("option", { name: "Parts" }));
    expect(await within(dialog).findByText(/no import template for parts yet/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Full" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Incremental" })).toBeDisabled();
    await userEvent.click(within(dialog).getByRole("combobox", { name: /Records/ }));
    await userEvent.click(await screen.findByRole("option", { name: "Machines" }));
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Incremental" })).toBeEnabled());
    await userEvent.click(within(dialog).getByRole("button", { name: "Incremental" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Run" }));
    await waitFor(() => expect(calls.find((c) => c.k === "POST /integrations/connections/c1/runs")?.body).toEqual({ entityType: "machine", kind: "incremental", templateId: "t1" }));
  });
});
