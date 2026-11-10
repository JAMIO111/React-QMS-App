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
import { missingSummary } from "../../lib/integrations";

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

const setting = (over = {}) => ({
  entityType: "machine", writeMode: "add_update", matchExisting: false, onMissing: "nothing", schedule: "manual", saved: true, fixed: false,
  canDeactivate: true, tracksMissing: true, template: null, scheduledBy: null, lastScheduledAt: null, scheduleProblem: null, ...over,
});
const api = detail({ status: "active", runnable: ["machine"], importable: ["machine"], writable: ["machine"], config: { ...conn().config, entities: { machine: { path: "/v1/machines" } } } });
const missing = (over = {}) => ({
  id: "m1", connection: { id: "c1", name: "Sage 200" }, entityType: "machine", externalId: "M2", record: { id: "mc2", label: "PRESS-2 — Press 2", active: true },
  status: "held", reason: "3 of 10 imported records would be made inactive at once (more than 20%): confirm them", detectedRunId: "r1", detectedAt: "2026-11-10T04:00:00Z",
  decidedAt: null, decidedBy: null, decisionNote: null, canDecide: true, canDeactivate: true, ...over,
});
const pageRoutes = (extra = {}) => ({
  "GET /integrations/connections/c1": api,
  "GET /integrations/providers": { data: providers },
  "GET /integrations/runs": noRuns,
  "GET /integrations/connections/c1/settings": { data: [setting()] },
  "GET /integrations/templates": { data: [{ id: "t1", name: "Plant machines", entityType: "machine", currentVersion: 2 }] },
  "GET /integrations/missing-records": { data: [], page: 1, pageSize: 200, total: 0, openCount: 0 },
  "GET /integrations/connections/c1/attention": { data: [], total: 0 },
  ...extra,
});

describe("daily schedules", () => {
  it("turns a daily import on with a template, at once", async () => {
    let answer;
    routeApi(pageRoutes({ "PUT /integrations/connections/c1/settings": () => new Promise((r) => { answer = r; }) }));
    renderAt("/Settings/Integrations/c1");
    const row = await screen.findByRole("listitem", { name: "Machines schedule" });
    expect(within(row).getByRole("button", { name: "Daily" })).toBeDisabled();
    await userEvent.click(within(row).getByRole("combobox", { name: /Import template/ }));
    await userEvent.click(await screen.findByRole("option", { name: /Plant machines/ }));
    await waitFor(() => expect(calls.find((c) => c.k === "PUT /integrations/connections/c1/settings")?.body).toEqual({ entityType: "machine", templateId: "t1" }));
    answer(setting({ templateId: "t1", template: { id: "t1", name: "Plant machines", version: 2, archived: false } }));
  });

  it("says when the last daily import did not start, and who it runs as", async () => {
    routeApi(pageRoutes({ "GET /integrations/connections/c1/settings": { data: [setting({ schedule: "daily", template: { id: "t1", name: "Plant machines", version: 2, archived: false }, scheduledBy: { id: "u1", name: "Ada Owner" }, scheduleProblem: "The person who scheduled it may no longer run this import" })] } }));
    renderAt("/Settings/Integrations/c1");
    const row = await screen.findByRole("listitem", { name: "Machines schedule" });
    expect(within(row).getByText(/as Ada Owner/)).toBeInTheDocument();
    expect(within(row).getByText("The last daily import did not start")).toBeInTheDocument();
  });
});

describe("records no longer in the source", () => {
  it("keeps chosen records active with a reason, and makes others inactive", async () => {
    let open = [missing(), missing({ id: "m2", externalId: "M3", record: { id: "mc3", label: "PRESS-3 — Press 3", active: true } })];
    routeApi(pageRoutes({
      "GET /integrations/missing-records": () => ({ data: open, page: 1, pageSize: 200, total: open.length, openCount: open.length }),
      "POST /integrations/missing-records/decide": (_p, o) => {
        open = open.filter((m) => !o.body.ids.includes(m.id));
        return { decided: o.body.ids.length };
      },
    }));
    renderAt("/Settings/Integrations/c1");
    const list = await screen.findByRole("list", { name: "Records no longer in the source" });
    expect(screen.getByText("Held for you")).toBeInTheDocument();
    await userEvent.click(within(list).getByRole("checkbox", { name: /PRESS-2/ }));
    await userEvent.click(screen.getByRole("button", { name: "Keep active" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByRole("textbox", { name: /Why do they stay active/ }), "Moved to another cell");
    await userEvent.click(within(dialog).getByRole("button", { name: "Keep active" }));
    await waitFor(() => expect(calls.find((c) => c.k === "POST /integrations/missing-records/decide")?.body).toEqual({ ids: ["m1"], deactivate: false, note: "Moved to another cell" }));
    await waitFor(() => expect(within(list).queryByRole("checkbox", { name: /PRESS-2/ })).not.toBeInTheDocument());
    await userEvent.click(within(list).getByRole("checkbox", { name: /PRESS-3/ }));
    await userEvent.click(screen.getByRole("button", { name: "Make inactive" }));
    await waitFor(() => expect(calls.filter((c) => c.k === "POST /integrations/missing-records/decide")[1].body).toEqual({ ids: ["m2"], deactivate: true }));
  });

  it("summarises a run's disappeared records in words", () => {
    expect(missingSummary({ deactivated: 1, held: 3, listed: 0, returned: 2 })).toBe("No longer in the source: 1 made inactive · 3 held for a person · 2 came back");
    expect(missingSummary({ skipped: "Some rows had no identifier" })).toBe("Some rows had no identifier");
    expect(missingSummary({ deactivated: 0, held: 0, listed: 0, returned: 0 })).toBeNull();
  });
});

describe("rows that need a person", () => {
  it("ignores a rejected row with a reason", async () => {
    let rows = [{ id: "i1", runId: "r1", externalId: "M99", sourceRow: null, status: "rejected", errors: [{ field: "code", message: "Code is required" }], payload: null, createdAt: "2026-11-10T04:00:00Z", ignored: null }];
    routeApi(pageRoutes({
      "GET /integrations/connections/c1/attention": (path) => (path.includes("ignored=only") ? { data: [], total: 0 } : { data: rows, total: rows.length }),
      "POST /integrations/connections/c1/rows/ignore": () => {
        rows = [];
        return { changed: 1 };
      },
    }));
    renderAt("/Settings/Integrations/c1");
    expect(await screen.findByText("Code is required")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("checkbox", { name: "Choose M99" }));
    await userEvent.click(screen.getByRole("button", { name: "Ignore 1" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByRole("textbox", { name: /Why are they ignored/ }), "A test machine");
    await userEvent.click(within(dialog).getByRole("button", { name: "Ignore" }));
    await waitFor(() => expect(calls.find((c) => c.k === "POST /integrations/connections/c1/rows/ignore")?.body).toEqual({ rowIds: ["i1"], reason: "A test machine" }));
    await waitFor(() => expect(screen.queryByText("Code is required")).not.toBeInTheDocument());
  });
});

describe("import health", () => {
  it("lists every connection's kinds of record with what waits", async () => {
    routeApi({
      "GET /integrations/connections": { data: [] },
      "GET /integrations/runs": { data: [], page: 1, pageSize: 8, total: 0 },
      "GET /integrations/allowed-hosts": { hosts: [], canManage: true },
      "GET /integrations/providers": { data: providers },
      "GET /integrations/conflicts": { data: [], page: 1, pageSize: 1, total: 0, openCount: 0 },
      "GET /integrations/health": {
        data: [{ connectionId: "c1", connectionName: "Sage 200", connectionStatus: "active", providerKind: "api", entityType: "machine", schedule: "daily", onMissing: "deactivate", template: null,
          lastScheduledAt: null, scheduleProblem: null, lastRun: { id: "r1", kind: "full", trigger: "schedule", status: "partial", requestedAt: "2026-11-10T04:00:00Z", finishedAt: "2026-11-10T04:01:00Z", errorSummary: null, nextAttemptAt: null },
          lastSuccessAt: "2026-11-10T04:01:00Z", failedInARow: 0, rowsNeedingAction: 2, missingWaiting: 3, missingHeld: 3, conflictsOpen: 0, state: "attention" }],
        counts: { ok: 0, attention: 1, failing: 0 },
      },
    });
    renderAt("/Settings/Integrations");
    const row = await screen.findByRole("listitem", { name: "Sage 200: Machines" });
    expect(within(row).getByText("Needs a look")).toBeInTheDocument();
    expect(within(row).getByText(/2 rows to look at · 3 no longer in the source/)).toBeInTheDocument();
  });

  it("lists the connections, each with its provider's logo, above import health", async () => {
    const api = { id: "c1", provider: { key: "rest_api", name: "REST API", kind: "api" }, name: "Sage 200", externalSystem: "sage-200", status: "active" };
    const file = { id: "c2", provider: { key: "csv", name: "CSV / Excel file", kind: "file" }, name: "Supplier file", externalSystem: "files", status: "active" };
    routeApi({
      "GET /integrations/connections": { data: [api, file] },
      "GET /integrations/runs": { data: [], page: 1, pageSize: 8, total: 0 },
      "GET /integrations/allowed-hosts": { hosts: [], canManage: true },
      "GET /integrations/providers": { data: providers },
      "GET /integrations/conflicts": { data: [], page: 1, pageSize: 1, total: 0, openCount: 0 },
      "GET /integrations/health": {
        data: [{ connectionId: "c1", connectionName: "Sage 200", connectionStatus: "active", providerKind: "api", entityType: "machine", schedule: "manual", onMissing: "nothing", template: null,
          lastScheduledAt: null, scheduleProblem: null, lastRun: null, lastSuccessAt: null, failedInARow: 0, rowsNeedingAction: 0, missingWaiting: 0, missingHeld: 0, conflictsOpen: 0, state: "ok" }],
        counts: { ok: 1, attention: 0, failing: 0 },
      },
    });
    renderAt("/Settings/Integrations");
    const list = await screen.findByRole("list", { name: "Connections" });
    const rows = within(list).getAllByRole("listitem");
    expect(within(rows[0]).getByRole("img", { name: "REST API logo" })).toBeInTheDocument();
    expect(within(rows[0]).getByRole("link", { name: "Sage 200" })).toBeInTheDocument();
    const health = await screen.findByRole("listitem", { name: "Sage 200: Machines" });
    // The connections card comes before the import health card on the page.
    expect(list.compareDocumentPosition(health) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
