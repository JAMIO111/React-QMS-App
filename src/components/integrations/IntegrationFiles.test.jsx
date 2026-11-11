import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

let permissions;
let advanced = false;
const apiFetch = vi.fn();
const upload = vi.fn();
const toast = vi.fn();
vi.mock("../../lib/api-client", async (importOriginal) => ({ ...(await importOriginal()), apiFetch: (...a) => apiFetch(...a) }));
vi.mock("../../api/supabaseApi", () => ({ uploadFileToSupabase: (...a) => upload(...a) }));
vi.mock("../../contexts/OrganisationProvider", () => ({ useOrganisation: () => ({ organisationId: "org-1" }) }));
vi.mock("../../hooks/useQmsApi", () => ({
  usePermissions: () => ({ can: (p) => permissions.includes(p) }),
  useOrganisationDetails: () => ({ data: { settings: { advancedImports: advanced } } }),
}));
vi.mock("../../contexts/ToastProvider", () => ({ useToast: () => ({ showToast: toast }) }));

import { ApiClientError } from "../../lib/api-client";
import { fileProblem, freeSystemCode, mappingChanged, mappingToRows, parseValueMap, rowsInUse, rowsToFields, suggestColumns } from "../../lib/integrations";
import CsvImportWizard, { GaugeChecksNotice } from "./CsvImportWizard";
import ConnectionPage from "./ConnectionPage";
import MappingPage from "./MappingPage";
import RunPage from "./RunPage";

const catalogue = {
  data: [
    {
      entityType: "supplier", label: "Suppliers", keyHint: "Usually the supplier code or account number",
      fields: [
        { key: "code", label: "Code", type: "text", required: true, maxLength: 40, options: null, description: null },
        { key: "name", label: "Name", type: "text", required: true, maxLength: 200, options: null, description: null },
        { key: "email", label: "Email", type: "email", required: false, maxLength: 200, options: null, description: null },
        { key: "country", label: "Country", type: "text", required: false, maxLength: 2, options: null, description: null },
      ],
    },
  ],
};
const file = (over = {}) => ({
  id: "f1", connectionId: "c1", fileName: "suppliers.csv", sizeBytes: 120, status: "parsed", sheet: null, headers: ["Account", "Supplier Name", "E-mail", "Country"],
  rowCount: 3, error: null, uploadedBy: { id: "u1", name: "Ada Owner" }, uploadedAt: "2026-11-09T09:00:00Z", purgedAt: null, ...over,
});
const fileDetail = { ...file(), sample: [{ row: 2, values: { Account: "S-1", "Supplier Name": "Acme", "E-mail": "a@acme.test", Country: "GB" } }] };
const conn = (over = {}) => ({
  id: "c1", provider: { key: "csv", name: "CSV / Excel file", kind: "file" }, name: "Supplier file", externalSystem: "sage", status: "draft",
  config: { delimiter: ",", hasHeader: true }, lastTest: null, readyAt: null, readyBy: null, activatedAt: "2026-11-09T09:00:00Z", activatedBy: null,
  createdAt: "2026-11-09T09:00:00Z", createdBy: { id: "u1", name: "Ada Owner" }, credential: null, problems: [], runnable: ["supplier", "customer", "part"],
  importable: [], writable: [], fileConnection: true, canActivate: false, events: [], ...over,
});
const version = (over = {}) => ({
  id: "m1", entityType: "supplier", version: 1, keyField: "Account", fields: [{ target: "code", source: "Account" }, { target: "name", source: "Supplier Name" }],
  reason: null, current: true, createdBy: { id: "u1", name: "Ada Owner" }, createdAt: "2026-11-09T09:10:00Z", ...over,
});

const template = (over = {}) => ({
  id: "t1", entityType: "supplier", name: "Sage suppliers", description: null, currentVersion: 1, archived: null, createdBy: { id: "u1", name: "Ada Owner" },
  createdAt: "2026-11-09T09:10:00Z", updatedAt: "2026-11-09T09:10:00Z", runCount: 2, lastUsedAt: "2026-11-09T10:00:00Z", ...over,
});
const templateDetail = (over = {}, current = {}) => ({
  ...template(over), canManage: true,
  current: {
    version: over.currentVersion ?? 1, keyField: "Account", fields: [{ target: "code", source: "Account" }, { target: "name", source: "Supplier Name" }], sourceSettings: {},
    expectedColumns: ["Account", "Supplier Name", "E-mail", "Country"], settings: { writeMode: "add_only", matchExisting: false }, reason: null, current: true,
    createdBy: { id: "u1", name: "Ada Owner" }, createdAt: "2026-11-09T09:10:00Z", runCount: 2, ...current,
  },
});
/** What the server's preview answers for a body: the sample row's value per column, "<value>:<step>" after each step, and missing columns. */
const previewFor = (_path, { body }) => {
  const values = fileDetail.sample[0].values;
  const headers = Object.keys(values);
  const missing = body.fields.flatMap((f) => (f.source && !headers.includes(f.source) ? [{ column: f.source, fields: [f.target], blocking: f.target === "code" }] : []));
  return {
    columns: headers,
    columnCheck: { missing, unused: headers.filter((h) => !body.fields.some((f) => f.source === h) && h !== body.keyField) },
    problems: [],
    rows: [{
      row: 2, externalId: values[body.keyField] ?? null, errors: [],
      fields: body.fields.map((f) => {
        const taken = f.formula ? "FORMULA" : values[f.source] ?? "";
        const steps = (f.steps ?? []).map((s) => `${taken}:${s.kind}`);
        return { target: f.target, label: f.target, taken, steps, value: steps.at(-1) ?? taken, error: null };
      }),
    }],
  };
};
const calls = [];
const routeApi = (routes) =>
  apiFetch.mockImplementation(async (path, opts = {}) => {
    const k = `${opts.method ?? "GET"} ${path.split("?")[0]}`;
    calls.push({ k, path, body: opts.body });
    if (!(k in routes)) throw new Error(`unexpected ${k}`);
    return typeof routes[k] === "function" ? routes[k](path, opts) : routes[k];
  });
const renderAt = (at) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[at]}>
        <Routes>
          <Route path="/Settings/Integrations/csv" element={<CsvImportWizard />} />
          <Route path="/Settings/Integrations/:id" element={<ConnectionPage />} />
          <Route path="/Settings/Integrations/:id/mapping" element={<MappingPage />} />
          <Route path="/Settings/Integrations/:id/runs/:runId" element={<RunPage />} />
        </Routes>
        <div id="modal-root" />
      </MemoryRouter>
    </QueryClientProvider>
  );
const choose = async (label, option, scope = document.body) => {
  await userEvent.click(within(scope).getByRole("combobox", { name: label }));
  await userEvent.click(await screen.findByRole("option", { name: new RegExp(`^${option}`) }));
};

beforeEach(() => {
  permissions = ["integrations.read", "integrations.manage", "integrations.run", "integrations.approve"];
  advanced = false;
  calls.length = 0;
  apiFetch.mockReset();
  upload.mockReset();
  toast.mockReset();
});

describe("integration file helpers", () => {
  it("suggests columns by heading, ignoring case, spaces and punctuation", () => {
    expect(suggestColumns(catalogue.data[0].fields, ["Account", "Supplier Name", "E-mail", "COUNTRY"])).toEqual({ name: "Supplier Name", email: "E-mail", country: "COUNTRY" });
  });
  it("turns rows into fields with only what each transform uses", () => {
    const fields = catalogue.data[0].fields;
    const rows = mappingToRows(fields, null, ["Code", "Name"]);
    rows[2] = { ...rows[2], on: true, transform: "constant", value: "x@y.test", source: "Name" };
    rows[3] = { ...rows[3], on: true, transform: "map", source: "Name", valuesText: "United Kingdom=GB\nFrance = FR\n" };
    expect(rowsToFields(rows, fields)).toEqual([
      { target: "code", source: "Code" },
      { target: "name", source: "Name" },
      { target: "email", transform: "constant", value: "x@y.test" },
      { target: "country", transform: "map", source: "Name", values: { "United Kingdom": "GB", France: "FR" } },
    ]);
    expect(parseValueMap("a=b=c\n=x\nnone")).toEqual({ a: "b=c" });
  });
  it("refuses files of the wrong kind or size", () => {
    expect(fileProblem({ name: "a.pdf", size: 10 })).toMatch(/csv/);
    expect(fileProblem({ name: "a.xlsx", size: 26 * 1024 * 1024 })).toMatch(/25 MB/);
    expect(fileProblem({ name: "a.CSV", size: 10 })).toBeNull();
  });
});

describe("file connection page", () => {
  it("uploads a file to private storage, then asks the API to read it", async () => {
    routeApi({
      "GET /integrations/connections/c1": conn(),
      "GET /integrations/providers": { data: [] },
      "GET /integrations/runs": { data: [], page: 1, pageSize: 20, total: 0 },
      "GET /integrations/connections/c1/files": { data: [file({ id: "f0", fileName: "old.xlsx", status: "failed", error: "The workbook has no worksheet", headers: [] })] },
      "POST /integrations/connections/c1/files": fileDetail,
    });
    upload.mockResolvedValue({ path: "org-1/integration/c1/uuid-suppliers.csv" });
    renderAt("/Settings/Integrations/c1");
    expect(await screen.findByText("The workbook has no worksheet", { exact: false })).toBeInTheDocument();
    const f = new File(["Account,Supplier Name\nS-1,Acme\n"], "suppliers.csv", { type: "text/csv" });
    await userEvent.upload(screen.getByTestId("file-input"), f);
    await waitFor(() => expect(upload).toHaveBeenCalledWith(f, "integration-files", "org-1", "c1", "integration"));
    await waitFor(() => expect(calls.find((c) => c.k === "POST /integrations/connections/c1/files").body).toEqual({ path: "org-1/integration/c1/uuid-suppliers.csv", fileName: "suppliers.csv", size: f.size }));
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ type: "success", message: "3 rows, 4 columns" }));
  });

  it("previews a file once it is mapped; a full import waits for an importer", async () => {
    routeApi({
      "GET /integrations/connections/c1": conn({ status: "active" }),
      "GET /integrations/providers": { data: [] },
      "GET /integrations/runs": { data: [], page: 1, pageSize: 20, total: 0 },
      "GET /integrations/connections/c1/files": { data: [file()] },
      "GET /integrations/templates": { data: [template()] },
      "POST /integrations/connections/c1/runs": { id: "r9" },
      "GET /integrations/runs/r9": { id: "r9", connection: { id: "c1", name: "Supplier file" }, entityType: "supplier", kind: "preview", trigger: "user", status: "succeeded", requestedBy: null, requestedAt: "2026-11-09T10:00:00Z", startedAt: null, finishedAt: null, counts: { total: 3, rejected: 1, unchanged: 0, created: 2, updated: 0, failed: 0, superseded: 0 }, attempts: 0, nextAttemptAt: null, errorSummary: null, cancelReason: null, cancelledBy: null, fetchDone: true, file: { id: "f1", name: "suppliers.csv" }, mappingVersion: 1, cursorStart: null, cursorNext: null, errors: [], rowsNow: {}, drain: null },
      "GET /integrations/runs/r9/rows": { data: [], page: 1, pageSize: 50, total: 0 },
    });
    renderAt("/Settings/Integrations/c1");
    await userEvent.click(await screen.findByRole("button", { name: "Run an import" }));
    expect(screen.getByRole("button", { name: "Import" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Incremental" })).toBeNull();
    expect(screen.getByText(/not available yet: preview only/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Run" })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(calls.find((c) => c.k === "POST /integrations/connections/c1/runs").body).toEqual({ entityType: "supplier", kind: "preview", fileId: "f1", templateId: "t1" }));
    expect(await screen.findByText(/file suppliers.csv · mapping version 1/)).toBeInTheDocument();
  });

  it("does not run a file that has no mapping yet", async () => {
    routeApi({
      "GET /integrations/connections/c1": conn(),
      "GET /integrations/providers": { data: [] },
      "GET /integrations/runs": { data: [], page: 1, pageSize: 20, total: 0 },
      "GET /integrations/connections/c1/files": { data: [file()] },
      "GET /integrations/templates": { data: [] },
    });
    renderAt("/Settings/Integrations/c1");
    await userEvent.click(await screen.findByRole("button", { name: "Run an import" }));
    expect(await screen.findByText(/Map the file's columns to suppliers first/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run" })).toBeDisabled();
  });
});

describe("file import wizard", () => {
  const base = (templates = [], over = {}) => ({
    "GET /integrations/connections": { data: [conn({ status: "active", importable: ["supplier"], writable: ["supplier"] })] },
    "GET /integrations/connections/c1": conn({ status: "active", importable: ["supplier"], writable: ["supplier"] }),
    "GET /integrations/entities": catalogue,
    "GET /integrations/connections/c1/files": { data: [file()] },
    "GET /integrations/files/f1": fileDetail,
    "GET /integrations/templates": { data: templates },
    "GET /integrations/templates/t1": templateDetail(),
    "POST /integrations/templates/preview": previewFor,
    ...over,
  });
  const run = (over = {}) => ({ id: "r9", connection: { id: "c1", name: "Supplier file" }, entityType: "supplier", kind: "preview", trigger: "user", status: "succeeded", requestedBy: null, requestedAt: "2026-11-09T10:00:00Z", startedAt: null, finishedAt: null, counts: { total: 3, rejected: 0, unchanged: 0, created: 3, updated: 0, failed: 0, superseded: 0, skipped: 0 }, attempts: 0, nextAttemptAt: null, errorSummary: null, cancelReason: null, cancelledBy: null, fetchDone: true, file: { id: "f1", name: "suppliers.csv" }, mappingVersion: null, template: { id: "t1", name: "Sage suppliers", version: 1 }, settings: null, cursorStart: null, cursorNext: null, errors: [], rowsNow: {}, drain: null, ...over });
  const runRoutes = { "POST /integrations/connections/c1/runs": { id: "r9" }, "GET /integrations/runs/r9": run(), "GET /integrations/runs/r9/rows": { data: [], page: 1, pageSize: 50, total: 0 } };
  const step3 = "/Settings/Integrations/csv?connection=c1&entity=supplier&file=f1&step=3";
  const lastPreview = () => calls.filter((c) => c.k === "POST /integrations/templates/preview").at(-1)?.body;

  it("step 1: makes the organisation's file connection when none exists yet, then moves on", async () => {
    routeApi({
      ...base(),
      "GET /integrations/connections": { data: [{ ...conn({ id: "r1", provider: { key: "rest_api", name: "REST API" }, externalSystem: "files" }) }] },
      "POST /integrations/connections": { id: "c1" },
    });
    renderAt("/Settings/Integrations/csv");
    const next = await screen.findByRole("button", { name: "Next" });
    expect(next).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: /^Suppliers/ }));
    await userEvent.click(next);
    await waitFor(() => expect(calls.find((c) => c.k === "POST /integrations/connections").body).toEqual({ providerKey: "csv", name: "File imports", externalSystem: "files-2" }));
    expect(await screen.findByText("How to read the file")).toBeInTheDocument();
  });

  it("step 1: kinds that cannot be imported, or that the person may not write, cannot be chosen; a saved template is shown", async () => {
    routeApi(base([template()], { "GET /integrations/entities": { data: [catalogue.data[0], { ...catalogue.data[0], entityType: "customer", label: "Customers" }] } }));
    renderAt("/Settings/Integrations/csv");
    expect(await screen.findByRole("button", { name: /^Customers/ })).toBeDisabled();
    await waitFor(() => expect(screen.getByRole("button", { name: /^Suppliers/ })).toHaveTextContent("Template saved"));
  });

  it("step 2: reads the file with the options chosen and shows its first rows", async () => {
    routeApi({ ...base(), "GET /integrations/connections/c1/files": { data: [] }, "POST /integrations/connections/c1/files": fileDetail });
    upload.mockResolvedValue({ path: "org-1/integration/c1/uuid-suppliers.csv" });
    renderAt("/Settings/Integrations/csv?connection=c1&entity=supplier&step=2");
    await userEvent.click(await screen.findByRole("switch", { name: "The first row holds column headings" }));
    await choose("Separator", "Semicolon");
    const f = new File(["S-1;Acme\n"], "suppliers.csv", { type: "text/csv" });
    await userEvent.upload(screen.getByTestId("file-input"), f);
    await waitFor(() =>
      expect(calls.find((c) => c.k === "POST /integrations/connections/c1/files").body).toEqual({ path: "org-1/integration/c1/uuid-suppliers.csv", fileName: "suppliers.csv", size: f.size, options: { hasHeader: false, encoding: "auto", delimiter: ";" } }),
    );
    expect(await screen.findByRole("table", { name: "First rows" })).toHaveTextContent("Acme");
    await waitFor(() => expect(screen.getByRole("button", { name: "Next" })).toBeEnabled());
  });

  it("step 3 with no template: suggests columns, shows the server's examples, flags a missing field, then saves a new template and imports with it", async () => {
    routeApi({ ...base(), "POST /integrations/templates": { id: "t2" }, ...runRoutes });
    renderAt(step3);
    const code = await screen.findByRole("listitem", { name: "Code" });
    expect(within(code).getByRole("combobox", { name: "Column for Code" })).toHaveValue("Account");
    await waitFor(() => expect(within(screen.getByRole("listitem", { name: "Name" })).getByLabelText("Example for Name")).toHaveTextContent("Acme"));
    expect(lastPreview()).toMatchObject({ entityType: "supplier", fileId: "f1", keyField: "Account" });
    expect(screen.getByRole("combobox", { name: "Start from" })).toHaveValue("Start a new mapping");
    expect(screen.getByText(/All required fields matched · 4 of 4 fields used/)).toBeInTheDocument();
    await userEvent.click(within(code).getByRole("button", { name: "Clear Column for Code" }));
    expect(code).toHaveAttribute("data-missing");
    expect(screen.getByRole("button", { name: "Import 3 rows" })).toBeDisabled();
    await choose("Column for Code", "Account", code);
    await userEvent.click(screen.getByRole("button", { name: "Import 3 rows" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByLabelText("Template name")).toHaveValue("Suppliers from suppliers.csv");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save and import" }));
    await waitFor(() =>
      expect(calls.find((c) => c.k === "POST /integrations/templates").body).toEqual({
        entityType: "supplier", name: "Suppliers from suppliers.csv", keyField: "Account",
        fields: [{ target: "code", source: "Account" }, { target: "name", source: "Supplier Name" }, { target: "email", source: "E-mail" }, { target: "country", source: "Country" }],
        settings: { writeMode: "add_only", matchExisting: false }, sourceSettings: { hasHeader: true, encoding: "auto", delimiter: "auto" }, expectedColumns: ["Account", "Supplier Name", "E-mail", "Country"],
      }),
    );
    await waitFor(() => expect(calls.find((c) => c.k === "POST /integrations/connections/c1/runs").body).toEqual({ entityType: "supplier", kind: "full", fileId: "f1", templateId: "t2" }));
  });

  it("step 3 starts from the template used last; unchanged, a preview runs with it and nothing is saved", async () => {
    routeApi({ ...base([template(), template({ id: "t0", name: "Old", lastUsedAt: null })]), ...runRoutes });
    renderAt(step3);
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Start from" })).toHaveValue("Sage suppliers"));
    expect(await screen.findByText("Version 1, unchanged")).toBeInTheDocument();
    expect(within(screen.getByRole("listitem", { name: "Email" })).getByRole("combobox", { name: "Column for Email" })).toHaveValue("");
    await userEvent.click(screen.getByRole("button", { name: "Preview" }));
    await waitFor(() => expect(calls.find((c) => c.k === "POST /integrations/connections/c1/runs").body).toEqual({ entityType: "supplier", kind: "preview", fileId: "f1", templateId: "t1" }));
    expect(calls.some((c) => c.k.startsWith("POST /integrations/templates/t1"))).toBe(false);
  });

  it("step 3: a change is saved as the template's next version with a reason, or as a new template; the server's problems are listed", async () => {
    let fail = true;
    routeApi({
      ...base([template()]),
      "POST /integrations/templates/t1/versions": () => {
        if (fail) throw new ApiClientError({ status: 409, code: "integration_rule", message: "x", details: { problems: ["Name: the column \"Gone\" is not in the file"] } });
        return templateDetail({ currentVersion: 2 });
      },
      "POST /integrations/templates": { id: "t3" },
      ...runRoutes,
    });
    renderAt(step3);
    const email = await screen.findByRole("listitem", { name: "Email" });
    await screen.findByText("Version 1, unchanged");
    await choose("Column for Email", "E-mail", email);
    expect(screen.getByText(/Changed from version 1: save it before importing/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Preview" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("radio", { name: /Version 2 of “Sage suppliers”/ })).toBeChecked();
    await userEvent.type(within(dialog).getByLabelText("Why is it changing?"), "Email column added");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save and preview" }));
    expect(await screen.findByText("Name: the column \"Gone\" is not in the file")).toBeInTheDocument();
    expect(calls.find((c) => c.k === "POST /integrations/templates/t1/versions").body).toMatchObject({ reason: "Email column added", keyField: "Account" });
    expect(calls.some((c) => c.k === "POST /integrations/connections/c1/runs")).toBe(false);
    fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Preview" }));
    const again = await screen.findByRole("dialog");
    await userEvent.click(within(again).getByRole("radio", { name: /A new template/ }));
    await userEvent.clear(within(again).getByLabelText("Template name"));
    await userEvent.type(within(again).getByLabelText("Template name"), "Sage with email");
    await userEvent.click(within(again).getByRole("button", { name: "Save and preview" }));
    await waitFor(() => expect(calls.find((c) => c.k === "POST /integrations/templates").body).toMatchObject({ name: "Sage with email", entityType: "supplier" }));
    await waitFor(() => expect(calls.find((c) => c.k === "POST /integrations/connections/c1/runs").body.templateId).toBe("t3"));
  });

  it("step 3: without managing rights changes can be tried, but importing needs them saved by someone who may", async () => {
    permissions = ["integrations.read", "integrations.run"];
    routeApi({ ...base([template()]), ...runRoutes });
    renderAt(step3);
    const email = await screen.findByRole("listitem", { name: "Email" });
    await screen.findByText("Version 1, unchanged");
    expect(screen.queryByRole("button", { name: "Save a new version" })).toBeNull();
    expect(screen.getByRole("button", { name: "Preview" })).toBeEnabled();
    await choose("Column for Email", "E-mail", email);
    expect(screen.getAllByText("Ask someone who manages integrations to save these changes").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Preview" })).toBeDisabled();
  });

  it("step 3: a row's steps are edited and the value after each comes from the server; Match by only for links matched by an earlier import", async () => {
    const withRef = { data: [{ ...catalogue.data[0], fields: [...catalogue.data[0].fields, { key: "site", label: "Site", type: "text", required: false, maxLength: 100, options: null, description: null, ref: { kind: "site", source: false } }, { key: "machine", label: "Machine", type: "text", required: false, maxLength: 100, options: null, description: null, ref: { kind: "machine", source: true } }] }] };
    routeApi({ ...base([template()]), "GET /integrations/entities": withRef, "POST /integrations/templates/t1/versions": templateDetail({ currentVersion: 2 }), ...runRoutes });
    renderAt(step3);
    const name = await screen.findByRole("listitem", { name: "Name" });
    await screen.findByText("Version 1, unchanged");
    await userEvent.click(within(name).getByRole("button", { name: "Show settings for Name" }));
    const steps = within(name).getByRole("region", { name: "Steps for Name" });
    await choose("Add a step", "Capitals", steps);
    await waitFor(() => expect(lastPreview().fields.find((f) => f.target === "name")).toEqual({ target: "name", source: "Supplier Name", steps: [{ kind: "upper" }] }), { timeout: 3000 });
    await waitFor(() => expect(within(steps).getByLabelText("After step 1")).toHaveTextContent("Acme:upper"), { timeout: 3000 });
    await choose("Add a step", "Add before", steps);
    expect(within(steps).getByText("Add before: text is needed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Preview" })).toBeDisabled();
    await userEvent.type(within(steps).getByLabelText("Text"), "S-");
    const machine = screen.getByRole("listitem", { name: "Machine" });
    await choose("Column for Machine", "Account", machine);
    await userEvent.click(within(machine).getByRole("button", { name: "Show settings for Machine" }));
    await choose("Match by", "Id from an earlier import", machine);
    const site = screen.getByRole("listitem", { name: "Site" });
    await userEvent.click(within(site).getByRole("button", { name: "Show settings for Site" }));
    expect(within(site).queryByRole("combobox", { name: "Match by" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Save a new version" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText("Why is it changing?"), "Names in capitals");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(calls.find((c) => c.k === "POST /integrations/templates/t1/versions").body.fields).toEqual(
        expect.arrayContaining([{ target: "name", source: "Supplier Name", steps: [{ kind: "upper" }, { kind: "prefix", text: "S-" }] }, { target: "machine", source: "Account", match: "source" }]),
      ),
    );
    expect(calls.some((c) => c.k === "POST /integrations/connections/c1/runs")).toBe(false);
  });

  it("step 3: the formula editor is offered only with advanced imports; the server checks the formula and works out the example", async () => {
    routeApi({ ...base([template()]), "POST /integrations/formulas/check": { ok: true, error: null, columns: ["Account"], functions: ["CONCAT"], result: { value: "M-S-1", error: null } }, "GET /integrations/formulas/functions": { data: [{ name: "CONCAT", usage: "CONCAT(value, value, …)", description: "Joins the values", minArgs: 1, maxArgs: 50 }] } });
    const { unmount } = renderAt(step3);
    const code = await screen.findByRole("listitem", { name: "Code" });
    await userEvent.click(within(code).getByRole("button", { name: "Show settings for Code" }));
    expect(within(code).queryByRole("switch", { name: "Use a formula instead of a column" })).toBeNull();
    unmount();
    advanced = true;
    renderAt(step3);
    const code2 = await screen.findByRole("listitem", { name: "Code" });
    await screen.findByText("Version 1, unchanged");
    await userEvent.click(within(code2).getByRole("button", { name: "Show settings for Code" }));
    await userEvent.click(within(code2).getByRole("switch", { name: "Use a formula instead of a column" }));
    const box = within(code2).getByLabelText("Formula for Code");
    await userEvent.type(box, "CON");
    await userEvent.click(await within(code2).findByRole("button", { name: /CONCAT\(value, value, …\)/ }));
    await waitFor(() => expect(box).toHaveValue("CONCAT("));
    await userEvent.type(box, '"M-", [[Account])');
    await waitFor(() => expect(calls.filter((c) => c.k === "POST /integrations/formulas/check").at(-1).body).toEqual({ formula: 'CONCAT("M-", [Account])', columns: ["Account", "Supplier Name", "E-mail", "Country"], sample: fileDetail.sample[0].values }), { timeout: 10000 });
    expect(await within(code2).findByText("M-S-1", {}, { timeout: 10000 })).toBeInTheDocument();
    await waitFor(() => expect(lastPreview().fields.find((f) => f.target === "code")).toEqual({ target: "code", formula: 'CONCAT("M-", [Account])' }), { timeout: 10000 });
  }, 30000);

  it("step 3: the server's column check is shown above the fields and blocks an import that needs a missing column", async () => {
    routeApi({ ...base([template()]), "GET /integrations/templates/t1": templateDetail({}, { keyField: "Account", fields: [{ target: "code", source: "Ref" }, { target: "name", source: "Supplier Name" }] }) });
    renderAt(step3);
    expect(await screen.findByText("Columns the mapping uses are not in this file")).toBeInTheDocument();
    expect(screen.getByText(/\[Ref\] — code \(needed\)/)).toBeInTheDocument();
    expect(screen.getByText(/2 columns of the file are not used/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Preview" })).toBeDisabled());
  });

  it("after a preview of a file, imports the same file with the same template in one click or goes back to the mapping", async () => {
    routeApi({ ...base([template()]), "GET /integrations/runs/r9": run(), "GET /integrations/runs/r9/rows": { data: [], page: 1, pageSize: 50, total: 0 }, "POST /integrations/connections/c1/runs": { id: "r10" }, "GET /integrations/runs/r10": run({ id: "r10", kind: "full" }), "GET /integrations/runs/r10/rows": { data: [], page: 1, pageSize: 50, total: 0 } });
    renderAt("/Settings/Integrations/c1/runs/r9");
    expect(await screen.findByText(/template Sage suppliers version 1/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Change the mapping" })).toHaveAttribute("href", "/Settings/Integrations/csv?connection=c1&entity=supplier&template=t1&file=f1&step=3");
    await userEvent.click(screen.getByRole("button", { name: "Import these records" }));
    await waitFor(() => expect(calls.find((c) => c.k === "POST /integrations/connections/c1/runs").body).toEqual({ entityType: "supplier", kind: "full", fileId: "f1", templateId: "t1" }));
    expect(await screen.findByText("Full import · Suppliers", { exact: false })).toBeInTheDocument();
  });

  it("the old mapping address opens step 3 of the wizard", async () => {
    routeApi(base([template()]));
    renderAt("/Settings/Integrations/c1/mapping?entity=supplier&file=f1");
    expect(await screen.findByRole("listitem", { name: "Code" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Map columns/ })).toHaveAttribute("aria-current", "step");
  });
});

describe("gauge types without checks before a gauge import", () => {
  const show = (enabled) =>
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter>
          <GaugeChecksNotice enabled={enabled} />
        </MemoryRouter>
      </QueryClientProvider>
    );

  it("names the active types with no checks and links to where they are added", async () => {
    apiFetch.mockImplementation(async (path) => {
      if (path.startsWith("/gauge-types")) {
        return {
          data: [
            { id: "t1", code: "CAL-150", name: "Caliper", active: true, characteristicCount: 0 },
            { id: "t2", code: "MIC-25", name: "Micrometer", active: true, characteristicCount: 2 },
            { id: "t3", code: "OLD", name: "Old", active: false, characteristicCount: 0 },
          ],
        };
      }
      throw new Error(`unexpected ${path}`);
    });
    show(true);
    expect(await screen.findByText("A gauge type has no checks yet")).toBeInTheDocument();
    expect(screen.getByText(/CAL-150\./)).toBeInTheDocument();
    expect(screen.queryByText(/MIC-25|OLD/)).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Settings → Data Management → Calibration/ })).toHaveAttribute("href", "/Settings/Data-Management?tab=calibration");
  });

  it("asks nothing when not importing gauges (or without calibration.read)", () => {
    show(false);
    expect(apiFetch).not.toHaveBeenCalled();
    expect(screen.queryByText(/no checks yet/)).not.toBeInTheDocument();
  });
});

describe("file import helpers", () => {
  const fields = catalogue.data[0].fields;
  const row = (over) => ({ ...mappingToRows(fields, null, [])[0], ...over });
  it("knows when a mapping differs from the saved version, and picks a free system code", () => {
    expect(mappingChanged(version(), "Account", [{ target: "name", source: "Supplier Name" }, { target: "code", source: "Account" }])).toBe(false);
    expect(mappingChanged(version(), "Account", [{ target: "code", source: "Account" }])).toBe(true);
    expect(mappingChanged(null, "Account", [])).toBe(true);
    expect(freeSystemCode([{ externalSystem: "files" }, { externalSystem: "files-2" }])).toBe("files-3");
    expect(rowsInUse([row({ source: null, default: " " }), row({ transform: "constant", value: "x" })]).map((r) => r.on)).toEqual([false, true]);
  });
});

describe("file connection page", () => {
  it("has no lifecycle steps: it is in use, and edit and retire sit in its menu", async () => {
    routeApi({
      "GET /integrations/connections/c1": conn({ status: "active" }),
      "GET /integrations/providers": { data: [] },
      "GET /integrations/runs": { data: [], page: 1, pageSize: 20, total: 0 },
      "GET /integrations/connections/c1/files": { data: [] },
    });
    renderAt("/Settings/Integrations/c1");
    expect(await screen.findByText("In use")).toBeInTheDocument();
    for (const name of ["Test connection", "Mark ready", "Activate", "Pause", "Resume"]) expect(screen.queryByRole("button", { name })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Actions" }));
    expect(screen.getByRole("menuitem", { name: "Retire" })).toBeInTheDocument();
  });

  it("lets someone who may write the records import a mapped file themselves", async () => {
    routeApi({
      "GET /integrations/connections/c1": conn({ status: "active", importable: ["supplier"], writable: ["supplier"] }),
      "GET /integrations/providers": { data: [] },
      "GET /integrations/runs": { data: [], page: 1, pageSize: 20, total: 0 },
      "GET /integrations/connections/c1/files": { data: [file()] },
      "GET /integrations/templates": { data: [template()] },
      "POST /integrations/connections/c1/runs": { id: "r9" },
      "GET /integrations/runs/r9": { id: "r9", connection: { id: "c1", name: "Supplier file" }, entityType: "supplier", kind: "full", trigger: "user", status: "succeeded", requestedBy: null, requestedAt: "2026-11-09T10:00:00Z", startedAt: null, finishedAt: null, counts: { total: 3, rejected: 0, unchanged: 0, created: 2, updated: 0, failed: 0, superseded: 0, skipped: 1 }, attempts: 0, nextAttemptAt: null, errorSummary: null, cancelReason: null, cancelledBy: null, fetchDone: true, file: { id: "f1", name: "suppliers.csv" }, mappingVersion: 1, settings: { writeMode: "add_only", matchExisting: false, onMissing: "nothing", schedule: "manual" }, cursorStart: null, cursorNext: null, errors: [], rowsNow: {}, drain: null },
      "GET /integrations/runs/r9/rows": { data: [], page: 1, pageSize: 50, total: 0 },
    });
    renderAt("/Settings/Integrations/c1");
    await userEvent.click(await screen.findByRole("button", { name: "Run an import" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Import" })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: "Import" }));
    expect(screen.getByText(/You approve this import yourself/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(calls.find((c) => c.k === "POST /integrations/connections/c1/runs").body).toEqual({ entityType: "supplier", kind: "full", fileId: "f1", templateId: "t1" }));
    expect(await screen.findByText(/add new records only/)).toBeInTheDocument();
    expect(screen.getByText("Skipped")).toBeInTheDocument();
  });
});
