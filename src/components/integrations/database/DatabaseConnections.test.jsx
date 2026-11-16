import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const apiFetch = vi.fn();
const showToast = vi.fn();
const sealCredential = vi.fn();
vi.mock("../../../lib/api-client", async (importOriginal) => ({ ...(await importOriginal()), apiFetch: (...a) => apiFetch(...a) }));
vi.mock("../../../contexts/OrganisationProvider", () => ({ useOrganisation: () => ({ organisationId: "org-1" }) }));
vi.mock("../../../contexts/ToastProvider", () => ({ useToast: () => ({ showToast }) }));
vi.mock("../../../lib/sealCredential", () => ({ sealCredential: (...a) => sealCredential(...a) }));

import DatabaseConnectionDialog from "./DatabaseConnectionDialog";
import { AgentCard, BrowseCard } from "./DatabasePanels";
import { databaseConfig, databaseForm, databaseFormProblem, databaseWhere } from "../../../lib/integrations";

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

const SEALING = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE" + "A".repeat(52);
const connection = (over = {}) => ({
  id: "c1", name: "ERP database", externalSystem: "erp", status: "draft", provider: { key: "sql_agent", name: "Database through a connector agent", kind: "agent" },
  config: { engine: "postgres", server: "erp-db.factory.local", port: 5432, database: "erp", authType: "password", encrypt: true },
  agent: { id: "ag1", name: "Newcastle", status: "active", online: true, lastHeartbeatAt: new Date().toISOString(), keyId: "k1", sealingKey: SEALING },
  agentCredential: null, agentJobs: [], problems: [], events: [], ...over,
});

beforeEach(() => {
  calls.length = 0;
  apiFetch.mockReset();
  showToast.mockReset();
  sealCredential.mockReset();
});

describe("database connection settings", () => {
  it("checks the settings as the database does", () => {
    const f = databaseForm("sqlserver");
    expect(f.authType).toBe("windows");
    expect(databaseFormProblem({ ...f, server: "SQL01;Password=x", database: "ERP" })).toMatch(/server/);
    expect(databaseFormProblem({ ...f, server: "SQL01", database: "ERP;x" })).toMatch(/database name/);
    expect(databaseFormProblem({ ...f, server: "SQL01", database: "ERP", instance: "SQLEXPRESS", port: "1433" })).toMatch(/port or an instance/);
    expect(databaseFormProblem({ ...f, server: "SQL01", database: "ERP", instance: "SQLEXPRESS" })).toBeNull();
    expect(databaseConfig({ ...f, server: " SQL01 ", database: "ERP", instance: "SQLEXPRESS" })).toEqual({ engine: "sqlserver", server: "SQL01", database: "ERP", authType: "windows", encrypt: true, instance: "SQLEXPRESS" });
    expect(databaseWhere({ server: "SQL01", instance: "SQLEXPRESS", database: "ERP" })).toBe("SQL01\\SQLEXPRESS / ERP");
  });

  it("creates a database connection on a chosen agent, with settings only", async () => {
    const onCreated = vi.fn();
    routeApi({
      "GET /integrations/agents": { data: [{ id: "ag1", name: "Newcastle", status: "active", online: true }, { id: "ag2", name: "Old", status: "revoked", online: false }], onlineCount: 1, activeCount: 1 },
      "POST /integrations/connections": (_p, o) => ({ id: "c9", ...o.body }),
    });
    wrap(<DatabaseConnectionDialog engine="postgres" onClose={() => {}} onCreated={onCreated} />);
    const dialog = await screen.findByRole("dialog", { name: "Connect PostgreSQL" });
    await userEvent.click(within(dialog).getByRole("combobox", { name: /Connector agent/ }));
    expect(screen.queryByRole("option", { name: /Old/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("option", { name: /Newcastle/ }));
    await userEvent.type(within(dialog).getByRole("textbox", { name: /^Name/ }), "ERP database");
    await userEvent.type(within(dialog).getByRole("textbox", { name: /^Server/ }), "erp-db;x");
    await userEvent.type(within(dialog).getByRole("textbox", { name: /^Database/ }), "erp");
    await userEvent.click(within(dialog).getByRole("button", { name: "Create connection" }));
    expect(within(dialog).getByRole("alert")).toHaveTextContent(/server/);
    expect(calls.some((c) => c.k === "POST /integrations/connections")).toBe(false);
    await userEvent.clear(within(dialog).getByRole("textbox", { name: /^Server/ }));
    await userEvent.type(within(dialog).getByRole("textbox", { name: /^Server/ }), "erp-db.factory.local");
    await userEvent.click(within(dialog).getByRole("button", { name: "Create connection" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(calls.find((c) => c.k === "POST /integrations/connections").body).toEqual({
      providerKey: "sql_agent", name: "ERP database", externalSystem: "erp-database", agentId: "ag1",
      config: { engine: "postgres", server: "erp-db.factory.local", database: "erp", authType: "password", encrypt: true },
    });
  });

  it("connects MySQL through an agent with a user name and password (AG5)", async () => {
    const f = databaseForm("mysql");
    expect(f.authType).toBe("password");
    expect(databaseConfig({ ...f, server: "erp-mysql", database: "erp", port: "3307" })).toEqual({ engine: "mysql", server: "erp-mysql", database: "erp", authType: "password", encrypt: true, port: 3307 });
    routeApi({
      "GET /integrations/agents": { data: [{ id: "ag1", name: "Newcastle", status: "active", online: true }], onlineCount: 1, activeCount: 1 },
      "POST /integrations/connections": (_p, o) => ({ id: "c9", ...o.body }),
    });
    const onCreated = vi.fn();
    wrap(<DatabaseConnectionDialog engine="mysql" onClose={() => {}} onCreated={onCreated} />);
    const dialog = await screen.findByRole("dialog", { name: "Connect MySQL" });
    expect(within(dialog).queryByRole("textbox", { name: /Instance/ })).not.toBeInTheDocument();
    expect(within(dialog).getByRole("spinbutton", { name: /Port/ })).toHaveAttribute("placeholder", "3306");
    await userEvent.click(within(dialog).getByRole("combobox", { name: /Connector agent/ }));
    await userEvent.click(screen.getByRole("option", { name: /Newcastle/ }));
    await userEvent.type(within(dialog).getByRole("textbox", { name: /^Name/ }), "ERP MySQL");
    await userEvent.type(within(dialog).getByRole("textbox", { name: /^Server/ }), "erp-mysql.factory.local");
    await userEvent.type(within(dialog).getByRole("textbox", { name: /^Database/ }), "erp");
    await userEvent.click(within(dialog).getByRole("button", { name: "Create connection" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(calls.find((c) => c.k === "POST /integrations/connections").body.config).toEqual({ engine: "mysql", server: "erp-mysql.factory.local", database: "erp", authType: "password", encrypt: true });
  });

  it("connects a folder of files through an agent with no password (AG5b)", async () => {
    routeApi({
      "GET /integrations/agents": { data: [{ id: "ag1", name: "Newcastle", status: "active", online: true }], onlineCount: 1, activeCount: 1 },
      "POST /integrations/connections": (_p, o) => ({ id: "c9", ...o.body }),
    });
    const onCreated = vi.fn();
    wrap(<DatabaseConnectionDialog engine="folder" onClose={() => {}} onCreated={onCreated} />);
    const dialog = await screen.findByRole("dialog", { name: "Connect a folder of files" });
    expect(within(dialog).queryByRole("textbox", { name: /^Server/ })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("combobox", { name: /How the agent signs in/ })).not.toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("combobox", { name: /Connector agent/ }));
    await userEvent.click(screen.getByRole("option", { name: /Newcastle/ }));
    await userEvent.type(within(dialog).getByRole("textbox", { name: /^Name/ }), "ERP exports");
    await userEvent.type(within(dialog).getByRole("textbox", { name: /^Folder/ }), "exports");
    await userEvent.click(within(dialog).getByRole("button", { name: "Create connection" }));
    expect(within(dialog).getByRole("alert")).toHaveTextContent(/whole folder path/);
    await userEvent.clear(within(dialog).getByRole("textbox", { name: /^Folder/ }));
    await userEvent.type(within(dialog).getByRole("textbox", { name: /^Folder/ }), "C:\\Exports\\ERP");
    await userEvent.click(within(dialog).getByRole("button", { name: "Create connection" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(calls.find((c) => c.k === "POST /integrations/connections").body).toEqual({
      providerKey: "sql_agent", name: "ERP exports", externalSystem: "erp-exports", agentId: "ag1", config: { engine: "folder", folder: "C:\\Exports\\ERP", authType: "none" },
    });
  });

  it("says when there is no agent to read through", async () => {
    routeApi({ "GET /integrations/agents": { data: [], onlineCount: 0, activeCount: 0 } });
    wrap(<DatabaseConnectionDialog engine="sqlserver" onClose={() => {}} />);
    expect(await screen.findByText("No connector agent yet")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Add a connector agent" })).toHaveAttribute("href", "/Settings/Integrations/Agents");
    expect(screen.getByRole("button", { name: "Create connection" })).toBeDisabled();
  });
});

describe("the agent and the password", () => {
  it("seals the password in the browser for the agent and sends only the sealed bytes", async () => {
    sealCredential.mockResolvedValue({ epk: "E".repeat(88), iv: "I".repeat(16), ct: "C".repeat(64) });
    routeApi({
      "POST /integrations/agents/ag1/wake": { woken: true },
      "PUT /integrations/connections/c1/agent-credential": connection({ agentCredential: { status: "waiting" } }),
    });
    wrap(<AgentCard connection={connection()} canManage />);
    await waitFor(() => expect(calls.some((c) => c.k === "POST /integrations/agents/ag1/wake")).toBe(true));
    expect(screen.getByText(/Password: Not typed yet/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Type the password" }));
    const dialog = screen.getByRole("dialog", { name: "Type the database password" });
    await userEvent.type(within(dialog).getByRole("textbox", { name: /^User name/ }), "reader");
    await userEvent.type(within(dialog).getByLabelText(/^Password/), "hunter2");
    await userEvent.click(within(dialog).getByRole("button", { name: "Seal and send to the agent" }));
    await waitFor(() => expect(calls.some((c) => c.k === "PUT /integrations/connections/c1/agent-credential")).toBe(true));
    expect(sealCredential).toHaveBeenCalledWith(SEALING, "c1", { username: "reader", password: "hunter2" });
    const sent = calls.find((c) => c.k === "PUT /integrations/connections/c1/agent-credential").body;
    expect(sent).toEqual({ keyId: "k1", sealed: { epk: "E".repeat(88), iv: "I".repeat(16), ct: "C".repeat(64) } });
    expect(JSON.stringify(calls)).not.toContain("hunter2");
  });

  it("needs no password for Windows authentication, and says when the agent is offline or must be given it again", async () => {
    routeApi({ "POST /integrations/agents/ag1/wake": { woken: true } });
    const { unmount } = wrap(<AgentCard connection={connection({ config: { engine: "sqlserver", server: "SQL01", database: "ERP", authType: "windows" } })} canManage />);
    expect(screen.getByText(/there is no password to type/)).toBeInTheDocument();
    unmount();
    wrap(<AgentCard connection={connection({ agent: { ...connection().agent, online: false }, agentCredential: { status: "cleared", message: "The connector agent was reinstalled: type the password again" } })} canManage />);
    expect(screen.getByText("The connector agent was reinstalled: type the password again")).toBeInTheDocument();
    expect(screen.getByText(/The agent is offline/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Type the password" })).toBeInTheDocument();
  });
});

describe("browsing through the agent", () => {
  it("lists schemas, tables and columns and previews rows, one job at a time", async () => {
    let n = 0;
    const results = {};
    routeApi({
      "POST /integrations/connections/c1/agent-jobs": (_p, o) => {
        const id = `j${++n}`;
        results[id] = o.body;
        return { id, kind: o.body.kind, status: "pending" };
      },
      ...Object.fromEntries([1, 2, 3, 4].map((i) => [`GET /integrations/agent-jobs/j${i}`, () => {
        const b = results[`j${i}`];
        const result = b.kind === "preview"
          ? { schema: "erp", object: "work orders", columns: [{ name: "order no", type: "text" }, { name: "qty", type: "numeric" }], rows: [{ "order no": "WO-1", qty: "1.500" }], truncated: false }
          : b.request.level === "schemas" ? { level: "schemas", schemas: [{ name: "erp" }], allowListed: true }
          : b.request.level === "objects" ? { level: "objects", schema: "erp", objects: [{ name: "work orders", kind: "table", rowEstimate: 2500 }, { name: "v_open", kind: "view", rowEstimate: null }] }
          : { level: "columns", columns: [{ name: "id", type: "bigint", nullable: false, primaryKey: true }], foreignKeys: [{ name: "fk", columns: ["part_id"], references: { schema: "erp", object: "parts", columns: ["id"] } }] };
        return { id: `j${i}`, status: "completed", result };
      }])),
    });
    wrap(<BrowseCard connection={connection()} />);
    await userEvent.click(screen.getByRole("button", { name: "Browse" }));
    const schemas = await screen.findByRole("region", { name: "Schemas" });
    expect(within(schemas).getByText("Limited by the agent's allow-list.")).toBeInTheDocument();
    await userEvent.click(within(schemas).getByRole("button", { name: "erp" }));
    const tables = await screen.findByRole("region", { name: "Tables and views" });
    await userEvent.click(await within(tables).findByRole("button", { name: /work orders ~2,500 rows/ }));
    const columns = screen.getByRole("region", { name: "Columns" });
    expect(await within(columns).findByText("key")).toBeInTheDocument();
    expect(within(columns).getByText(/Links to: erp.parts \(part_id\)/)).toBeInTheDocument();
    await userEvent.click(within(columns).getByRole("button", { name: "Preview the first rows" }));
    const table = await screen.findByRole("table", { name: "First rows of erp.work orders" });
    expect(within(table).getByText("WO-1")).toBeInTheDocument();
    expect(calls.filter((c) => c.k === "POST /integrations/connections/c1/agent-jobs").map((c) => c.body)).toEqual([
      { kind: "discover", request: { level: "schemas" } },
      { kind: "discover", request: { level: "objects", schema: "erp" } },
      { kind: "discover", request: { level: "columns", schema: "erp", object: "work orders" } },
      { kind: "preview", request: { schema: "erp", object: "work orders", limit: 20 } },
    ]);
  });

  it("shows what the agent could not do", async () => {
    routeApi({
      "POST /integrations/connections/c1/agent-jobs": { id: "jx", status: "pending" },
      "GET /integrations/agent-jobs/jx": { id: "jx", status: "failed", errorMessage: "The database refused the sign-in: password authentication failed" },
    });
    wrap(<BrowseCard connection={connection()} />);
    await userEvent.click(screen.getByRole("button", { name: "Browse" }));
    expect(await screen.findByText(/password authentication failed/)).toBeInTheDocument();
  });
});
