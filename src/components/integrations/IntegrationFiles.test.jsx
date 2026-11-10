import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

let permissions;
const apiFetch = vi.fn();
const upload = vi.fn();
const toast = vi.fn();
vi.mock("../../lib/api-client", async (importOriginal) => ({ ...(await importOriginal()), apiFetch: (...a) => apiFetch(...a) }));
vi.mock("../../api/supabaseApi", () => ({ uploadFileToSupabase: (...a) => upload(...a) }));
vi.mock("../../contexts/OrganisationProvider", () => ({ useOrganisation: () => ({ organisationId: "org-1" }) }));
vi.mock("../../hooks/useQmsApi", () => ({ usePermissions: () => ({ can: (p) => permissions.includes(p) }) }));
vi.mock("../../contexts/ToastProvider", () => ({ useToast: () => ({ showToast: toast }) }));

import { ApiClientError } from "../../lib/api-client";
import { exampleValue, fileProblem, freeSystemCode, mappingChanged, mappingToRows, parseValueMap, readDate, rowsInUse, rowsToFields, suggestColumns } from "../../lib/integrations";
import CsvImportWizard from "./CsvImportWizard";
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

const settings = (over = {}) => [
  { entityType: "supplier", writeMode: "add_only", matchExisting: false, onMissing: "nothing", schedule: "manual", saved: false, fixed: false, canDeactivate: true, ...over },
  { entityType: "nonconformance", writeMode: "add_only", matchExisting: false, onMissing: "nothing", schedule: "manual", saved: false, fixed: true, canDeactivate: false },
];
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
      "GET /integrations/connections/c1/mappings": { data: [version()] },
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
    await waitFor(() => expect(calls.find((c) => c.k === "POST /integrations/connections/c1/runs").body).toEqual({ entityType: "supplier", kind: "preview", fileId: "f1" }));
    expect(await screen.findByText(/file suppliers.csv · mapping version 1/)).toBeInTheDocument();
  });

  it("does not run a file that has no mapping yet", async () => {
    routeApi({
      "GET /integrations/connections/c1": conn(),
      "GET /integrations/providers": { data: [] },
      "GET /integrations/runs": { data: [], page: 1, pageSize: 20, total: 0 },
      "GET /integrations/connections/c1/files": { data: [file()] },
      "GET /integrations/connections/c1/mappings": { data: [] },
    });
    renderAt("/Settings/Integrations/c1");
    await userEvent.click(await screen.findByRole("button", { name: "Run an import" }));
    expect(await screen.findByText(/Map the file's columns to suppliers first/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run" })).toBeDisabled();
  });
});

describe("file import wizard", () => {
  const base = (mappings, over = {}) => ({
    "GET /integrations/connections": { data: [conn({ status: "active", importable: ["supplier"], writable: ["supplier"] })] },
    "GET /integrations/connections/c1": conn({ status: "active", importable: ["supplier"], writable: ["supplier"] }),
    "GET /integrations/entities": catalogue,
    "GET /integrations/connections/c1/files": { data: [file()] },
    "GET /integrations/files/f1": fileDetail,
    "GET /integrations/connections/c1/mappings": { data: mappings },
    "GET /integrations/connections/c1/settings": { data: settings() },
    ...over,
  });
  const run = (over = {}) => ({ id: "r9", connection: { id: "c1", name: "Supplier file" }, entityType: "supplier", kind: "preview", trigger: "user", status: "succeeded", requestedBy: null, requestedAt: "2026-11-09T10:00:00Z", startedAt: null, finishedAt: null, counts: { total: 3, rejected: 0, unchanged: 0, created: 3, updated: 0, failed: 0, superseded: 0, skipped: 0 }, attempts: 0, nextAttemptAt: null, errorSummary: null, cancelReason: null, cancelledBy: null, fetchDone: true, file: { id: "f1", name: "suppliers.csv" }, mappingVersion: 1, settings: null, cursorStart: null, cursorNext: null, errors: [], rowsNow: {}, drain: null, ...over });
  const step3 = "/Settings/Integrations/csv?connection=c1&entity=supplier&file=f1&step=3";

  it("step 1: makes the organisation's file connection when none exists yet, then moves on", async () => {
    routeApi({
      ...base([]),
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

  it("step 1: kinds that cannot be imported, or that the person may not write, cannot be chosen", async () => {
    routeApi(base([version()], { "GET /integrations/entities": { data: [catalogue.data[0], { ...catalogue.data[0], entityType: "customer", label: "Customers" }] } }));
    renderAt("/Settings/Integrations/csv");
    expect(await screen.findByRole("button", { name: /^Customers/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^Suppliers/ })).toHaveTextContent("Mapping saved");
  });

  it("step 2: reads the file with the options chosen, shows its first rows and the import settings", async () => {
    routeApi({ ...base([]), "GET /integrations/connections/c1/files": { data: [] }, "POST /integrations/connections/c1/files": fileDetail, "PUT /integrations/connections/c1/settings": settings({ writeMode: "add_update", saved: true })[0] });
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
    const card = screen.getByText("Suppliers already in Fortress").closest("section");
    expect(within(card).queryByRole("combobox", { name: "Runs" })).toBeNull();
    await choose("What an import may do", "Add new and update existing", card);
    await waitFor(() => expect(calls.find((c) => c.k === "PUT /integrations/connections/c1/settings").body).toEqual({ entityType: "supplier", writeMode: "add_update" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Next" })).toBeEnabled());
  });

  it("step 3: suggests columns, shows examples, flags a missing required field, then saves the first version and imports", async () => {
    routeApi({ ...base([]), "PUT /integrations/connections/c1/mapping": { data: [version()] }, "POST /integrations/connections/c1/runs": { id: "r9" }, "GET /integrations/runs/r9": run({ kind: "full" }), "GET /integrations/runs/r9/rows": { data: [], page: 1, pageSize: 50, total: 0 } });
    renderAt(step3);
    const code = await screen.findByRole("listitem", { name: "Code" });
    // A first mapping takes the record's code from the column that identifies it.
    expect(within(code).getByRole("combobox", { name: "Column for Code" })).toHaveValue("Account");
    expect(within(screen.getByRole("listitem", { name: "Name" })).getByLabelText("Example for Name")).toHaveTextContent("Acme");
    expect(screen.getByText(/All required fields matched · 4 of 4 fields used/)).toBeInTheDocument();
    await userEvent.click(within(code).getByRole("button", { name: "Clear Column for Code" }));
    expect(code).toHaveAttribute("data-missing");
    expect(screen.getAllByText("1 required field is not matched").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Import 3 rows" })).toBeDisabled();
    await choose("Column for Code", "Account", code);
    await userEvent.click(screen.getByRole("button", { name: "Import 3 rows" }));
    await waitFor(() =>
      expect(calls.find((c) => c.k === "PUT /integrations/connections/c1/mapping").body).toEqual({
        entityType: "supplier", keyField: "Account", fileId: "f1",
        fields: [{ target: "code", source: "Account" }, { target: "name", source: "Supplier Name" }, { target: "email", source: "E-mail" }, { target: "country", source: "Country" }],
      }),
    );
    await waitFor(() => expect(calls.find((c) => c.k === "POST /integrations/connections/c1/runs").body).toEqual({ entityType: "supplier", kind: "full", fileId: "f1" }));
    expect(await screen.findByText(/file suppliers.csv/)).toBeInTheDocument();
  });

  it("step 3: an unchanged mapping is not saved again; a changed one asks why, and the server's problems are listed", async () => {
    let fail = true;
    routeApi({
      ...base([version()]),
      "PUT /integrations/connections/c1/mapping": () => {
        if (fail) throw new ApiClientError({ status: 409, code: "integration_rule", message: "x", details: { problems: ["Name: the column \"Gone\" is not in the file"] } });
        return { data: [version({ id: "m2", version: 2 })] };
      },
      "POST /integrations/connections/c1/runs": { id: "r9" },
      "GET /integrations/runs/r9": run(),
      "GET /integrations/runs/r9/rows": { data: [], page: 1, pageSize: 50, total: 0 },
    });
    renderAt(step3);
    const email = await screen.findByRole("listitem", { name: "Email" });
    expect(within(email).getByRole("combobox", { name: "Column for Email" })).toHaveValue("");
    await choose("Column for Email", "E-mail", email);
    await userEvent.click(screen.getByRole("button", { name: "Preview" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText("Reason"), "Email column added");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save and continue" }));
    expect(await screen.findByText("Name: the column \"Gone\" is not in the file")).toBeInTheDocument();
    expect(calls.find((c) => c.k === "PUT /integrations/connections/c1/mapping").body.reason).toBe("Email column added");
    expect(calls.some((c) => c.k === "POST /integrations/connections/c1/runs")).toBe(false);
  });

  it("step 3: previews with the saved mapping without saving it again", async () => {
    routeApi({ ...base([version()]), "POST /integrations/connections/c1/runs": { id: "r9" }, "GET /integrations/runs/r9": run(), "GET /integrations/runs/r9/rows": { data: [], page: 1, pageSize: 50, total: 0 } });
    renderAt(step3);
    await screen.findByRole("listitem", { name: "Code" });
    await userEvent.click(screen.getByRole("button", { name: "Preview" }));
    await waitFor(() => expect(calls.find((c) => c.k === "POST /integrations/connections/c1/runs").body).toEqual({ entityType: "supplier", kind: "preview", fileId: "f1" }));
    expect(calls.some((c) => c.k === "PUT /integrations/connections/c1/mapping")).toBe(false);
  });

  it("step 3: is read-only without integrations.manage", async () => {
    permissions = ["integrations.read", "integrations.run"];
    routeApi(base([version()]));
    renderAt(step3);
    expect(await screen.findByRole("combobox", { name: "Column that identifies each record" })).toBeDisabled();
    expect(within(screen.getByRole("listitem", { name: "Name" })).getByRole("combobox", { name: "Column for Name" })).toBeDisabled();
  });

  it("step 3: a row opens to show its settings, with Match by only for links that can be matched by an earlier import", async () => {
    const withRef = { data: [{ ...catalogue.data[0], fields: [...catalogue.data[0].fields, { key: "since", label: "Supplier since", type: "date", required: false, maxLength: null, options: null, description: null }, { key: "site", label: "Site", type: "text", required: false, maxLength: 100, options: null, description: null, ref: { kind: "site", source: false } }, { key: "machine", label: "Machine", type: "text", required: false, maxLength: 100, options: null, description: null, ref: { kind: "machine", source: true } }] }] };
    const detail = { ...fileDetail, headers: [...fileDetail.headers, "Since"], sample: [{ row: 2, values: { ...fileDetail.sample[0].values, Since: "03/04/2021" } }] };
    routeApi({ ...base([version()]), "GET /integrations/entities": withRef, "GET /integrations/files/f1": detail, "PUT /integrations/connections/c1/mapping": { data: [version({ id: "m2", version: 2 })] }, "POST /integrations/connections/c1/runs": { id: "r9" }, "GET /integrations/runs/r9": run(), "GET /integrations/runs/r9/rows": { data: [], page: 1, pageSize: 50, total: 0 } });
    renderAt(step3);
    const since = await screen.findByRole("listitem", { name: "Supplier since" });
    await choose("Column for Supplier since", "Since", since);
    expect(within(since).getByLabelText("Example for Supplier since")).toHaveTextContent("Not a date written this way");
    await userEvent.click(within(since).getByRole("button", { name: "Show settings for Supplier since" }));
    await choose("Dates written as", "Day/month/year", since);
    expect(within(since).getByLabelText("Example for Supplier since")).toHaveTextContent("2021-04-03");
    const machine = screen.getByRole("listitem", { name: "Machine" });
    await choose("Column for Machine", "Account", machine);
    await userEvent.click(within(machine).getByRole("button", { name: "Show settings for Machine" }));
    await choose("Match by", "Id from an earlier import", machine);
    const site = screen.getByRole("listitem", { name: "Site" });
    await userEvent.click(within(site).getByRole("button", { name: "Show settings for Site" }));
    expect(within(site).queryByRole("combobox", { name: "Match by" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Preview" }));
    await userEvent.type(within(await screen.findByRole("dialog")).getByLabelText("Reason"), "Machine link");
    await userEvent.click(screen.getByRole("button", { name: "Save and continue" }));
    await waitFor(() => expect(calls.find((c) => c.k === "PUT /integrations/connections/c1/mapping").body.fields).toEqual(expect.arrayContaining([{ target: "machine", source: "Account", match: "source" }, { target: "since", source: "Since", dateFormat: "dmy" }])));
  });

  it("after a preview of a file, imports the same file in one click or goes back to the mapping", async () => {
    routeApi({ ...base([version()]), "GET /integrations/runs/r9": run(), "GET /integrations/runs/r9/rows": { data: [], page: 1, pageSize: 50, total: 0 }, "POST /integrations/connections/c1/runs": { id: "r10" }, "GET /integrations/runs/r10": run({ id: "r10", kind: "full" }), "GET /integrations/runs/r10/rows": { data: [], page: 1, pageSize: 50, total: 0 } });
    renderAt("/Settings/Integrations/c1/runs/r9");
    expect(await screen.findByRole("link", { name: "Change the mapping" })).toHaveAttribute("href", "/Settings/Integrations/csv?connection=c1&entity=supplier&file=f1&step=3");
    await userEvent.click(screen.getByRole("button", { name: "Import these records" }));
    await waitFor(() => expect(calls.find((c) => c.k === "POST /integrations/connections/c1/runs").body).toEqual({ entityType: "supplier", kind: "full", fileId: "f1" }));
    expect(await screen.findByText("Full import · Suppliers", { exact: false })).toBeInTheDocument();
  });

  it("the old mapping address opens step 3 of the wizard", async () => {
    routeApi(base([version()]));
    renderAt("/Settings/Integrations/c1/mapping?entity=supplier&file=f1");
    expect(await screen.findByRole("listitem", { name: "Code" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Map columns/ })).toHaveAttribute("aria-current", "step");
  });
});

describe("file import helpers", () => {
  const fields = catalogue.data[0].fields;
  const row = (over) => ({ ...mappingToRows(fields, null, [])[0], ...over });
  it("works out examples the way the server reads them", () => {
    expect(exampleValue(row({ source: "A", transform: "upper" }), fields[0], { A: " s-1 " })).toEqual({ value: "S-1", problem: null });
    expect(exampleValue(row({ transform: "concat", sources: ["A", "B"], separator: "-" }), fields[0], { A: "x", B: "" })).toEqual({ value: "x", problem: null });
    expect(exampleValue(row({ source: "A", transform: "map", valuesText: "uk=GB" }), fields[0], { A: "UK" }).value).toBe("GB");
    expect(exampleValue(row({ source: "A", default: "N/A" }), fields[0], { A: "" }).value).toBe("N/A");
    expect(exampleValue(row({ source: "A" }), { type: "number" }, { A: "12 kg" }).problem).toBe("Not a number");
    expect(exampleValue(row({ source: "A", decimal: "," }), { type: "number" }, { A: "1.234,5" }).value).toBe("1234.5");
    expect(exampleValue(row({ source: "A" }), { type: "text", maxLength: 2 }, { A: "abc" }).problem).toMatch(/Longer than 2/);
    expect(readDate("45000", "iso")).toBe("2023-03-15");
    expect(readDate("31/02/2024", "dmy")).toBeNull();
  });
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
      "GET /integrations/connections/c1/mappings": { data: [version()] },
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
    await waitFor(() => expect(calls.find((c) => c.k === "POST /integrations/connections/c1/runs").body).toEqual({ entityType: "supplier", kind: "full", fileId: "f1" }));
    expect(await screen.findByText(/add new records only/)).toBeInTheDocument();
    expect(screen.getByText("Skipped")).toBeInTheDocument();
  });
});
