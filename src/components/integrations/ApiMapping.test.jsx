import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

let permissions;
const apiFetch = vi.fn();
const toast = vi.fn();
vi.mock("../../lib/api-client", async (importOriginal) => ({ ...(await importOriginal()), apiFetch: (...a) => apiFetch(...a) }));
vi.mock("../../contexts/OrganisationProvider", () => ({ useOrganisation: () => ({ organisationId: "org-1" }) }));
vi.mock("../../hooks/useQmsApi", () => ({
  usePermissions: () => ({ can: (p) => permissions.includes(p) }),
  useOrganisationDetails: () => ({ data: { settings: { advancedImports: false } } }),
}));
vi.mock("../../contexts/ToastProvider", () => ({ useToast: () => ({ showToast: toast }) }));

import { ApiClientError } from "../../lib/api-client";
import { apiMappingPath } from "../../lib/integrations";
import ApiMappingPage from "./ApiMappingPage";
import ApiSampleCard from "./ApiSampleCard";
import RunPage from "./RunPage";

const catalogue = {
  data: [
    {
      entityType: "machine", label: "Machines", keyHint: "Usually the machine code",
      fields: [
        { key: "code", label: "Code", type: "text", required: true, maxLength: 40, options: null, description: null },
        { key: "name", label: "Name", type: "text", required: true, maxLength: 200, options: null, description: null },
        { key: "notes", label: "Notes", type: "text", required: false, maxLength: 2000, options: null, description: null },
      ],
    },
  ],
};
const conn = (over = {}) => ({
  id: "c1", provider: { key: "rest_api", name: "REST API", kind: "api" }, name: "Mock API", externalSystem: "mock", status: "active",
  config: { baseUrl: "https://api.example.com", authType: "none", entities: { machine: { path: "/machines", recordsPath: "items" } } },
  lastTest: null, readyAt: null, readyBy: null, activatedAt: "2026-11-10T09:00:00Z", activatedBy: null, createdAt: "2026-11-10T09:00:00Z",
  createdBy: { id: "u1", name: "Ada Owner" }, credential: null, problems: [], runnable: ["machine"], importable: ["machine"], writable: ["machine"],
  fileConnection: false, canActivate: false, events: [], ...over,
});
// What the API's first page looks like once flattened: nested fields with dots.
const apiSample = {
  columns: ["id", "code", "title", "dimensions.width"],
  rows: [
    { r: 1, v: { id: "7", code: "CNC-1", title: "Lathe", "dimensions.width": "1.2" } },
    { r: 2, v: { id: "8", code: "CNC-2", title: "Mill", "dimensions.width": "2.4" } },
  ],
};
const template = (over = {}) => ({
  id: "t1", entityType: "machine", name: "Machines from Mock API", description: null, currentVersion: 1, archived: null, createdBy: { id: "u1", name: "Ada Owner" },
  createdAt: "2026-11-10T09:10:00Z", updatedAt: "2026-11-10T09:10:00Z", runCount: 1, lastUsedAt: "2026-11-10T10:00:00Z", ...over,
});
const templateDetail = () => ({
  ...template(), canManage: true,
  current: {
    version: 1, keyField: "code", fields: [{ target: "code", source: "code" }, { target: "name", source: "title" }], sourceSettings: {}, expectedColumns: apiSample.columns,
    settings: { writeMode: "add_update", matchExisting: false }, reason: null, current: true, createdBy: { id: "u1", name: "Ada Owner" }, createdAt: "2026-11-10T09:10:00Z", runCount: 1,
  },
});
const previewFor = (_path, { body }) => {
  const values = apiSample.rows[0].v;
  return {
    columns: apiSample.columns,
    columnCheck: { missing: [], unused: apiSample.columns.filter((h) => !body.fields.some((f) => f.source === h) && h !== body.keyField) },
    problems: [],
    rows: [{ row: 1, externalId: values[body.keyField] ?? null, errors: [], fields: body.fields.map((f) => ({ target: f.target, label: f.target, taken: values[f.source] ?? "", steps: [], value: values[f.source] ?? "", error: null })) }],
  };
};
const run = (over = {}) => ({
  id: "r9", connection: { id: "c1", name: "Mock API" }, entityType: "machine", kind: "preview", trigger: "user", status: "succeeded", requestedBy: null, requestedAt: "2026-11-10T10:00:00Z",
  startedAt: null, finishedAt: null, counts: { total: 2, rejected: 0, unchanged: 0, created: 2, updated: 0, failed: 0, superseded: 0, skipped: 0 }, attempts: 0, nextAttemptAt: null,
  errorSummary: null, cancelReason: null, cancelledBy: null, fetchDone: true, file: null, mappingVersion: null, template: { id: "t1", name: "Machines from Mock API", version: 1 },
  settings: null, cursorStart: null, cursorNext: null, errors: [], rowsNow: {}, drain: null, ...over,
});

const calls = [];
const routeApi = (routes) =>
  apiFetch.mockImplementation(async (path, opts = {}) => {
    const k = `${opts.method ?? "GET"} ${path.split("?")[0]}`;
    calls.push({ k, path, body: opts.body });
    if (!(k in routes)) throw new Error(`unexpected ${k}`);
    return typeof routes[k] === "function" ? routes[k](path, opts) : routes[k];
  });
const base = (templates = [], over = {}) => ({
  "GET /integrations/connections/c1": conn(),
  "GET /integrations/entities": catalogue,
  "POST /integrations/connections/c1/sample": apiSample,
  "GET /integrations/templates": { data: templates },
  "GET /integrations/templates/t1": templateDetail(),
  "POST /integrations/templates/preview": previewFor,
  "POST /integrations/connections/c1/runs": { id: "r9" },
  "GET /integrations/runs/r9": run(),
  "GET /integrations/runs/r9/rows": { data: [], page: 1, pageSize: 50, total: 0 },
  // This connection's earlier imports: the one with template t1 is what the page starts from.
  "GET /integrations/runs": { data: templates.length ? [run({ kind: "full" })] : [], page: 1, pageSize: 20, total: templates.length ? 1 : 0 },
  ...over,
});
const renderAt = (at) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[at]}>
        <Routes>
          <Route path="/Settings/Integrations/:id/map" element={<ApiMappingPage />} />
          <Route path="/Settings/Integrations/:id/runs/:runId" element={<RunPage />} />
          <Route path="/Settings/Integrations/:id" element={<ApiSampleCard connection={conn()} />} />
        </Routes>
        <div id="modal-root" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
const lastPreview = () => calls.filter((c) => c.k === "POST /integrations/templates/preview").at(-1)?.body;
const page = "/Settings/Integrations/c1/map?entity=machine";

beforeEach(() => {
  permissions = ["integrations.read", "integrations.run", "integrations.manage"];
  calls.length = 0;
  apiFetch.mockReset();
  toast.mockReset();
});

describe("mapping an API connection's fields", () => {
  it("reads the API's first page, matches fields by name, shows the server's examples, then saves a new template and imports with it", async () => {
    routeApi(base());
    renderAt(page);
    const code = await screen.findByRole("listitem", { name: "Code" });
    expect(within(code).getByRole("combobox", { name: "Column for Code" })).toHaveValue("code");
    expect(calls.find((c) => c.k === "POST /integrations/connections/c1/sample").body).toEqual({ entityType: "machine" });
    expect(screen.getByText(/4 fields in the first 2 records/)).toBeInTheDocument();
    // The preview reads the API on the server, against the connection rather than a file.
    await waitFor(() => expect(lastPreview()).toMatchObject({ entityType: "machine", connectionId: "c1", keyField: "id" }), { timeout: 3000 });
    expect(lastPreview().fileId).toBeUndefined();
    await waitFor(() => expect(within(code).getByLabelText("Example for Code")).toHaveTextContent("CNC-1"));
    // "Name" is not sent by the API: it is required, so importing waits for it.
    const name = screen.getByRole("listitem", { name: "Name" });
    expect(name).toHaveAttribute("data-missing");
    expect(screen.getByRole("button", { name: "Import" })).toBeDisabled();
    await userEvent.click(within(name).getByRole("combobox", { name: "Column for Name" }));
    await userEvent.click(await screen.findByRole("option", { name: /^title/ }));
    await userEvent.click(screen.getByRole("button", { name: "Import" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByLabelText("Template name")).toHaveValue("Machines from Mock API");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save and import" }));
    await waitFor(() =>
      expect(calls.find((c) => c.k === "POST /integrations/templates").body).toEqual({
        entityType: "machine", name: "Machines from Mock API", keyField: "id",
        fields: [{ target: "code", source: "code" }, { target: "name", source: "title" }],
        settings: { writeMode: "add_only", matchExisting: false }, expectedColumns: apiSample.columns,
      }),
    );
  }, 10000);

  it("starts from the template used last; unchanged, a preview runs with it and nothing is saved", async () => {
    routeApi(base([template()]));
    renderAt(page);
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Start from" })).toHaveValue("Machines from Mock API"));
    expect(await screen.findByText("Version 1, unchanged")).toBeInTheDocument();
    expect(within(screen.getByRole("listitem", { name: "Name" })).getByRole("combobox", { name: "Column for Name" })).toHaveValue("title");
    await userEvent.click(screen.getByRole("button", { name: "Preview" }));
    await waitFor(() => expect(calls.find((c) => c.k === "POST /integrations/connections/c1/runs").body).toEqual({ entityType: "machine", kind: "preview", templateId: "t1" }));
    expect(calls.some((c) => c.k === "POST /integrations/templates" || c.k.startsWith("POST /integrations/templates/t1"))).toBe(false);
  });

  it("never starts from a template made for another source: a file's template is offered, not chosen", async () => {
    // "Machines from a file" was used most recently, but never by this connection: its columns are a file's, not what the API sends.
    routeApi(base([template({ id: "tf", name: "Machines from a file", lastUsedAt: "2026-11-10T12:00:00Z" })], { "GET /integrations/runs": { data: [], page: 1, pageSize: 20, total: 0 } }));
    renderAt(page);
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Start from" })).toHaveValue("Start a new mapping"));
    expect(within(await screen.findByRole("listitem", { name: "Code" })).getByRole("combobox", { name: "Column for Code" })).toHaveValue("code");
    expect(calls.some((c) => c.k === "GET /integrations/templates/tf")).toBe(false);
  });

  it("previews before the connection is active, but importing waits for it", async () => {
    routeApi(base([template()], { "GET /integrations/connections/c1": conn({ status: "draft" }) }));
    renderAt(page);
    expect(await screen.findByText(/Activate the connection to import/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Import" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Preview" })).toBeEnabled();
  });

  it("says when the API sent no records, and when it could not be read", async () => {
    routeApi(base([], { "POST /integrations/connections/c1/sample": { columns: [], rows: [] } }));
    const { unmount } = renderAt(page);
    expect(await screen.findByText("The API sent no records")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Import" })).toBeNull();
    unmount();
    routeApi(base([], { "POST /integrations/connections/c1/sample": () => { throw new ApiClientError({ status: 502, code: "connector_error", message: "The server could not be reached (ETIMEDOUT)" }); } }));
    renderAt(page);
    expect(await screen.findByText("The API could not be read")).toBeInTheDocument();
    expect(screen.getByText(/ETIMEDOUT/)).toBeInTheDocument();
  });

  it("is reached from the connection's sample card, and only for records the connection is set up for", async () => {
    expect(apiMappingPath("c1", "machine")).toBe("/Settings/Integrations/c1/map?entity=machine");
    expect(apiMappingPath("c1", "machine", "t1")).toBe("/Settings/Integrations/c1/map?entity=machine&template=t1");
    routeApi(base());
    renderAt("/Settings/Integrations/c1");
    expect(await screen.findByRole("link", { name: "Map fields" })).toHaveAttribute("href", "/Settings/Integrations/c1/map?entity=machine");
  });

  it("a preview of an API run offers to import it with the same template, or to change the mapping", async () => {
    routeApi(base([template()]));
    renderAt("/Settings/Integrations/c1/runs/r9");
    expect(await screen.findByRole("link", { name: "Change the mapping" })).toHaveAttribute("href", "/Settings/Integrations/c1/map?entity=machine&template=t1");
    await userEvent.click(screen.getByRole("button", { name: "Import these records" }));
    await waitFor(() => expect(calls.filter((c) => c.k === "POST /integrations/connections/c1/runs").at(-1).body).toEqual({ entityType: "machine", kind: "full", templateId: "t1" }));
  });
});
