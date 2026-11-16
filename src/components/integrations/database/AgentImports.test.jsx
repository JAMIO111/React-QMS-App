import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const apiFetch = vi.fn();
const showToast = vi.fn();
vi.mock("../../../lib/api-client", async (importOriginal) => ({ ...(await importOriginal()), apiFetch: (...a) => apiFetch(...a) }));
vi.mock("../../../contexts/OrganisationProvider", () => ({ useOrganisation: () => ({ organisationId: "org-1" }) }));
vi.mock("../../../contexts/ToastProvider", () => ({ useToast: () => ({ showToast }) }));
vi.mock("../../../hooks/useQmsApi", async (importOriginal) => ({ ...(await importOriginal()), usePermissions: () => ({ can: () => true, isLoading: false }) }));

import { BrowseCard } from "./DatabasePanels";
import { RecordSourcesCard } from "./RecordSources";
import { HealthCard, ScheduleCard } from "../KeepHealthy";
import ImportsCard from "../ImportsCard";
import { describeRecordSource, drainMessage, recordSourceBody, recordSourceForm, recordSourceProblem, scheduleLabel, scheduleOptions } from "../../../lib/integrations";

const calls = [];
const routeApi = (routes) =>
  apiFetch.mockImplementation(async (path, opts = {}) => {
    const k = `${opts.method ?? "GET"} ${path.split("?")[0]}`;
    calls.push({ k, body: opts.body });
    if (!(k in routes)) throw new Error(`unexpected ${k}`);
    return typeof routes[k] === "function" ? routes[k](path, opts) : routes[k];
  });
const wrap = (ui) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );

const COLUMNS = [
  { name: "id", type: "integer", nullable: false, primaryKey: true },
  { name: "code", type: "text", nullable: false, primaryKey: false },
  { name: "name", type: "text", nullable: false, primaryKey: false },
  { name: "active", type: "boolean", nullable: false, primaryKey: false },
];
const SOURCE = { schema: "erp", object: "machines", keyColumn: "id", columns: ["id", "code"], filters: [{ column: "active", op: "eq", value: "true" }] };
const connection = (over = {}) => ({
  id: "c1", name: "ERP database", status: "active", provider: { key: "sql_agent", kind: "agent" },
  config: { engine: "postgres", server: "db", database: "erp", authType: "password" },
  agent: { id: "ag1", name: "Newcastle", status: "active", online: true }, agentJobs: [], recordSources: [], ...over,
});
const ENTITIES = { data: [{ entityType: "machine", label: "Machines", fields: [] }, { entityType: "part", label: "Parts", fields: [] }] };

beforeEach(() => {
  calls.length = 0;
  apiFetch.mockReset();
  showToast.mockReset();
});

describe("where records are read from", () => {
  it("builds the structured request the agent turns into its own query", () => {
    const f = recordSourceForm(null, { columns: COLUMNS });
    expect(f).toMatchObject({ keyColumn: "id", allColumns: true, filters: [] });
    expect(recordSourceBody("erp", "machines", f)).toEqual({ schema: "erp", object: "machines", keyColumn: "id" });
    expect(recordSourceProblem({ ...f, allColumns: false, columns: ["code"] })).toMatch(/identifies each row too/);
    expect(recordSourceProblem({ ...f, filters: [{ column: "active", op: "eq", value: " " }] })).toMatch(/value the filter on active/);
    expect(recordSourceProblem({ ...f, filters: [{ column: "retired", op: "is_null", value: "" }] })).toBeNull();
    expect(recordSourceBody("erp", "machines", { ...f, allColumns: false, columns: ["id", "code"], filters: [{ column: "active", op: "eq", value: " true " }, { column: "retired", op: "is_null", value: "x" }] }))
      .toEqual({ schema: "erp", object: "machines", keyColumn: "id", columns: ["id", "code"], filters: [{ column: "active", op: "eq", value: "true" }, { column: "retired", op: "is_null" }] });
    expect(describeRecordSource(SOURCE)).toBe("erp.machines · key id · 2 columns · active equals true");
    expect(recordSourceForm(SOURCE)).toEqual({ keyColumn: "id", allColumns: false, columns: ["id", "code"], filters: [{ column: "active", op: "eq", value: "true" }], changedColumn: null });
  });

  it("says a run is waiting for the agent in words, not as a failure", () => {
    expect(drainMessage({ state: "waiting", reason: "Waiting for the connector agent: 2,000 rows read so far" })).toBe(
      "Waiting for the connector agent: 2,000 rows read so far. The import carries on once the agent has sent every row.",
    );
    expect(drainMessage({ state: "waiting", reason: "HTTP 503" })).toMatch(/could not be read/);
  });

  it("uses a browsed table for a kind of record, with the columns and filters chosen", async () => {
    let n = 0;
    routeApi({
      "GET /integrations/entities": ENTITIES,
      "POST /integrations/connections/c1/agent-jobs": (_p, o) => ({ id: `j${++n}`, kind: o.body.kind, status: "pending", body: o.body }),
      "GET /integrations/agent-jobs/j1": { id: "j1", status: "completed", result: { level: "schemas", schemas: [{ name: "erp" }] } },
      "GET /integrations/agent-jobs/j2": { id: "j2", status: "completed", result: { level: "objects", objects: [{ name: "machines", kind: "table", rowEstimate: 1200 }] } },
      "GET /integrations/agent-jobs/j3": { id: "j3", status: "completed", result: { level: "columns", columns: COLUMNS, foreignKeys: [] } },
      "PUT /integrations/connections/c1/record-source": (_p, o) => connection({ recordSources: [{ entityType: o.body.entityType, source: o.body.source, updatedAt: new Date().toISOString() }] }),
    });
    wrap(<BrowseCard connection={connection()} />);
    await userEvent.click(screen.getByRole("button", { name: "Browse" }));
    await userEvent.click(within(await screen.findByRole("region", { name: "Schemas" })).getByRole("button", { name: "erp" }));
    await userEvent.click(await within(await screen.findByRole("region", { name: "Tables and views" })).findByRole("button", { name: /machines/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Use this table" }));
    const dialog = await screen.findByRole("dialog", { name: "Read records from erp.machines" });
    await userEvent.click(within(dialog).getByRole("combobox", { name: /Fortress records in this table/ }));
    await userEvent.click(await screen.findByRole("option", { name: "Machines" }));
    expect(within(dialog).getByRole("combobox", { name: /Column that identifies each row/ })).toHaveValue("id");
    await userEvent.click(within(dialog).getByRole("button", { name: "Choose" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "name" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "active" }));
    await userEvent.click(within(dialog).getByRole("button", { name: /Add a filter/ }));
    await userEvent.click(within(dialog).getByRole("combobox", { name: /Filter 1 column/ }));
    await userEvent.click(await screen.findByRole("option", { name: /active/ }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(within(dialog).getByRole("alert")).toHaveTextContent(/value the filter on active/);
    await userEvent.type(within(dialog).getByRole("textbox", { name: /^Value/ }), "true");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls.some((c) => c.k === "PUT /integrations/connections/c1/record-source")).toBe(true));
    expect(calls.find((c) => c.k === "PUT /integrations/connections/c1/record-source").body).toEqual({ entityType: "machine", source: SOURCE });
  });

  it("lists each kind of record with its table, a way to map its fields, and stops reading one", async () => {
    routeApi({ "PUT /integrations/connections/c1/record-source": connection() });
    wrap(<RecordSourcesCard connection={connection({ recordSources: [{ entityType: "machine", source: SOURCE, updatedAt: "2026-11-15T10:00:00Z" }] })} />);
    const list = screen.getByRole("list", { name: "Record sources" });
    expect(within(list).getByText("Machines")).toBeInTheDocument();
    expect(within(list).getByText("erp.machines · key id · 2 columns · active equals true")).toBeInTheDocument();
    expect(within(list).getByRole("link", { name: "Map fields" })).toHaveAttribute("href", "/Settings/Integrations/c1/map?entity=machine");
    await userEvent.click(within(list).getByRole("button", { name: "Actions" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Stop reading" }));
    await waitFor(() => expect(calls.find((c) => c.k === "PUT /integrations/connections/c1/record-source")?.body).toEqual({ entityType: "machine", source: null }));
  });

  it("asks how to start when no table has been chosen", () => {
    wrap(<RecordSourcesCard connection={connection()} />);
    expect(screen.getByText(/Browse the database below/)).toBeInTheDocument();
  });
});

describe("reading only what changed, on a schedule (AG4)", () => {
  const TRACKED = { ...SOURCE, columns: ["id", "code", "changed_at"], changedColumn: "changed_at" };
  const setting = (over = {}) => ({
    entityType: "machine", writeMode: "add_update", matchExisting: false, onMissing: "nothing", schedule: "manual", saved: true, fixed: false,
    canDeactivate: true, tracksMissing: true, template: null, scheduledBy: null, lastScheduledAt: null, scheduleProblem: null, ...over,
  });

  it("keeps the column that shows when a row changed with the source", () => {
    const f = recordSourceForm(TRACKED);
    expect(f.changedColumn).toBe("changed_at");
    expect(recordSourceBody("erp", "machines", f)).toMatchObject({ changedColumn: "changed_at" });
    expect(recordSourceProblem({ ...f, columns: ["id", "code"] })).toMatch(/shows when a row changed too/);
    expect(recordSourceProblem({ ...f, allColumns: true, columns: [] })).toBeNull();
    expect(describeRecordSource(TRACKED)).toMatch(/changes shown by changed_at$/);
    expect(scheduleOptions(false).map((o) => o.value)).toEqual(["manual", "daily"]);
    expect(scheduleOptions(true).map((o) => o.value)).toEqual(["manual", "every_5m", "every_15m", "hourly", "daily"]);
    expect(scheduleLabel("every_15m")).toBe("Every 15 minutes");
  });

  it("offers every few minutes for a database table and says it reads only the changes", async () => {
    let saved = setting();
    routeApi({
      "GET /integrations/connections/c1/settings": () => ({ data: [saved] }),
      "GET /integrations/templates": { data: [{ id: "t1", name: "ERP machines", entityType: "machine", currentVersion: 1 }] },
      "PUT /integrations/connections/c1/settings": (_p, o) => {
        saved = setting({ ...o.body, template: { id: "t1", name: "ERP machines", version: 1 }, scheduledBy: { id: "u1", name: "Ada Owner" } });
        return saved;
      },
    });
    wrap(<ScheduleCard connection={connection({ recordSources: [{ entityType: "machine", source: TRACKED }] })} />);
    const row = await screen.findByRole("listitem", { name: "Machines schedule" });
    await userEvent.click(within(row).getByRole("combobox", { name: /Import template/ }));
    await userEvent.click(await screen.findByRole("option", { name: /ERP machines/ }));
    await waitFor(() => expect(calls.find((c) => c.k === "PUT /integrations/connections/c1/settings")?.body).toEqual({ entityType: "machine", templateId: "t1" }));
    await userEvent.click(within(row).getByRole("combobox", { name: /How often machines are imported/ }));
    await userEvent.click(await screen.findByRole("option", { name: "Every 15 minutes" }));
    await waitFor(() => expect(calls.filter((c) => c.k === "PUT /integrations/connections/c1/settings").at(-1).body).toEqual({ entityType: "machine", schedule: "every_15m", templateId: "t1" }));
    expect(await within(row).findByText(/Runs every 15 minutes while the connector agent is online as Ada Owner/)).toBeInTheDocument();
    expect(within(row).getByText(/Reads only the rows changed since the last import/)).toBeInTheDocument();
  });

  it("allows an incremental import only when the table says when a row changed", async () => {
    routeApi({
      "GET /integrations/runs": { data: [{ id: "r1", kind: "full", entityType: "machine", status: "succeeded", requestedAt: "2026-11-15T08:00:00Z", template: { id: "t1", name: "ERP machines", version: 1 }, counts: {} }], page: 1, pageSize: 8, total: 1 },
      "GET /integrations/templates": { data: [{ id: "t1", name: "ERP machines", entityType: "machine", currentVersion: 1 }] },
    });
    const base = { runnable: ["machine"], importable: ["machine"], writable: ["machine"] };
    const { unmount } = wrap(<ImportsCard canRun connection={connection({ ...base, recordSources: [{ entityType: "machine", source: SOURCE }] })} />);
    await userEvent.click(screen.getByRole("button", { name: "Run an import" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Full" })).toBeEnabled());
    expect(screen.getByRole("button", { name: "Incremental" })).toBeDisabled();
    unmount();
    wrap(<ImportsCard canRun connection={connection({ ...base, recordSources: [{ entityType: "machine", source: TRACKED }] })} />);
    await userEvent.click(screen.getByRole("button", { name: "Run an import" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Incremental" })).toBeEnabled());
  });

  it("says in import health when a scheduled import's agent is offline", async () => {
    routeApi({
      "GET /integrations/health": {
        data: [{ connectionId: "c1", connectionName: "ERP database", connectionStatus: "active", providerKind: "agent", entityType: "machine", schedule: "every_5m", onMissing: "nothing", template: null,
          lastScheduledAt: null, scheduleProblem: null, lastRun: null, lastSuccessAt: null, failedInARow: 0, rowsNeedingAction: 0, missingWaiting: 0, missingHeld: 0, conflictsOpen: 0,
          agent: { id: "ag1", name: "Newcastle", online: false, lastHeartbeatAt: "2026-11-15T09:00:00Z" }, state: "attention" }],
        counts: { ok: 0, attention: 1, failing: 0 },
      },
    });
    wrap(<HealthCard />);
    const row = await screen.findByRole("listitem", { name: "ERP database: Machines" });
    expect(within(row).getByText(/Every 5 minutes · not imported yet · connector agent Newcastle offline since/)).toBeInTheDocument();
    expect(within(row).getByText("Needs a look")).toBeInTheDocument();
  });
});

describe("files in a folder (AG5b)", () => {
  const folderConnection = (over = {}) =>
    connection({ name: "ERP exports", config: { engine: "folder", folder: "\\\\files01\\exports\\erp", authType: "none" }, ...over });

  it("checks a folder and a file name as the database does, and makes a dated name a pattern", async () => {
    const { folderPathProblem, fileNameProblem, filePatternFrom, databaseConfig, databaseForm, databaseWhere } = await import("../../../lib/integrations");
    expect(folderPathProblem("\\\\files01\\exports")).toBeNull();
    expect(folderPathProblem("C:\\Exports")).toBeNull();
    expect(folderPathProblem("/srv/exports")).toBeNull();
    expect(folderPathProblem("exports")).toMatch(/whole folder path/);
    expect(folderPathProblem("C:\\Exports\\..\\Windows")).toMatch(/cannot contain/);
    expect(fileNameProblem("machines-*.csv")).toBeNull();
    expect(fileNameProblem("../secret.csv")).toMatch(/directly in the folder/);
    expect(fileNameProblem("old/m.csv")).toMatch(/directly in the folder/);
    expect(filePatternFrom("machines-2026-11-15.csv")).toBe("machines-*.csv");
    expect(filePatternFrom("parts_20261115_0600.xlsx")).toBe("parts_*.xlsx");
    expect(filePatternFrom("machines.csv")).toBe("machines.csv");
    const f = { ...databaseForm("folder"), folder: " C:\\Exports ", fileDelimiter: ";", hasHeader: false };
    expect(f.authType).toBe("none");
    expect(databaseConfig(f)).toEqual({ engine: "folder", folder: "C:\\Exports", authType: "none", delimiter: ";", hasHeader: false });
    expect(databaseWhere({ engine: "folder", folder: "C:\\Exports" })).toBe("C:\\Exports");
    expect(describeRecordSource({ file: "machines-*.csv" })).toBe("Newest CSV or Excel file matching machines-*.csv");
  });

  it("lists the folder's files and uses a dated export as a pattern for a kind of record", async () => {
    routeApi({
      "POST /integrations/connections/c1/agent-jobs": { id: "j1", kind: "discover", status: "pending" },
      "GET /integrations/agent-jobs/j1": {
        id: "j1", kind: "discover", status: "completed",
        result: { level: "files", files: [
          { name: "machines-2026-11-15.csv", size: 2048, modifiedAt: "2026-11-15T06:00:00Z", supported: true },
          { name: "readme.docx", size: 100, modifiedAt: "2026-11-01T06:00:00Z", supported: false },
        ] },
      },
      "GET /integrations/entities": ENTITIES,
      "PUT /integrations/connections/c1/record-source": folderConnection(),
    });
    wrap(<BrowseCard connection={folderConnection()} />);
    await userEvent.click(screen.getByRole("button", { name: "List the files" }));
    const list = await screen.findByRole("list", { name: "Files" });
    expect(within(list).getByText("readme.docx")).toBeInTheDocument();
    expect(within(list).getByText(/not a CSV or Excel file/)).toBeInTheDocument();
    expect(within(list).queryByRole("button", { name: "Use readme.docx" })).not.toBeInTheDocument();
    expect(calls.find((c) => c.k === "POST /integrations/connections/c1/agent-jobs").body).toEqual({ kind: "discover", request: { level: "files" } });
    await userEvent.click(within(list).getByRole("button", { name: "Use machines-2026-11-15.csv" }));
    const dialog = await screen.findByRole("dialog", { name: "Read records from a file" });
    expect(within(dialog).getByRole("textbox", { name: /File name or pattern/ })).toHaveValue("machines-*.csv");
    await userEvent.click(within(dialog).getByRole("combobox", { name: /Fortress records in this file/ }));
    await userEvent.click(await screen.findByRole("option", { name: "Machines" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls.find((c) => c.k === "PUT /integrations/connections/c1/record-source")?.body).toEqual({ entityType: "machine", source: { file: "machines-*.csv" } }));
  });

  it("names the folder's files on the sources card and allows incremental reads of them", async () => {
    routeApi({});
    wrap(<RecordSourcesCard connection={folderConnection({ recordSources: [{ entityType: "machine", source: { file: "machines-*.csv" }, updatedAt: "2026-11-15T10:00:00Z" }] })} />);
    expect(screen.getByText("Records read from the folder")).toBeInTheDocument();
    expect(screen.getByText("Newest CSV or Excel file matching machines-*.csv")).toBeInTheDocument();
  });
});
