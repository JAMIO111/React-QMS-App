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
import { describeRecordSource, drainMessage, recordSourceBody, recordSourceForm, recordSourceProblem } from "../../../lib/integrations";

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
    expect(recordSourceForm(SOURCE)).toEqual({ keyColumn: "id", allColumns: false, columns: ["id", "code"], filters: [{ column: "active", op: "eq", value: "true" }] });
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
