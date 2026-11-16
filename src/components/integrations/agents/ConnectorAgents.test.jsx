import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

let permissions;
const apiFetch = vi.fn();
const showToast = vi.fn();
vi.mock("../../../lib/api-client", async (importOriginal) => ({ ...(await importOriginal()), apiFetch: (...a) => apiFetch(...a) }));
vi.mock("../../../contexts/OrganisationProvider", () => ({ useOrganisation: () => ({ organisationId: "org-1" }) }));
vi.mock("../../../hooks/useQmsApi", () => ({ usePermissions: () => ({ can: (p) => permissions.includes(p) }) }));
vi.mock("../../../contexts/ToastProvider", () => ({ useToast: () => ({ showToast }) }));

import AgentsPage from "./AgentsPage";
import AgentPage from "./AgentPage";
import { ago, eventWords, pingWords } from "../../../lib/agents";

const recent = new Date(Date.now() - 30_000).toISOString();
const agent = (over = {}) => ({
  id: "ag1", name: "Newcastle factory", location: "Server room B", status: "active", online: true, lastHeartbeatAt: recent, lastAddress: "203.0.113.5",
  version: "0.1.0", operatingSystem: "Windows Server 2022", machineName: "ERP01", capabilities: {}, activeJobs: 0, lastError: null,
  registeredAt: "2026-11-15T09:00:00Z", registeredBy: "Ada Owner", revokedAt: null, revokedBy: null, revokedReason: null, ...over,
});
const detail = (over = {}) => ({
  ...agent(), keys: [{ fingerprint: "ab12 cd34 ef56 7890", status: "active", createdAt: "2026-11-15T09:00:00Z", retiredAt: null }],
  jobs: [], events: [{ kind: "registered", detail: { machine: "ERP01", version: "0.1.0" }, at: "2026-11-15T09:00:00Z", by: "Ada Owner" }], ...over,
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
          <Route path="/Settings/Integrations/Agents" element={<AgentsPage />} />
          <Route path="/Settings/Integrations/Agents/:id" element={<AgentPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );

beforeEach(() => {
  permissions = ["integrations.read", "integrations.manage"];
  calls.length = 0;
  apiFetch.mockReset();
  showToast.mockReset();
});

describe("connector agents list", () => {
  it("lists agents with whether they are online, and waiting tokens", async () => {
    routeApi({
      "GET /integrations/agents": { data: [agent(), agent({ id: "ag2", name: "Old box", status: "revoked", online: false, revokedReason: "Decommissioned" })], onlineCount: 1, activeCount: 1 },
      "GET /integrations/agent-registrations": { data: [{ id: "g1", name: "Birmingham", state: "waiting", expiresAt: "2026-11-16T09:00:00Z", createdAt: recent, createdBy: "Ada Owner", replaces: null }] },
    });
    renderAt("/Settings/Integrations/Agents");
    const list = await screen.findByRole("list", { name: "Connector agents" });
    expect(within(list).getByRole("link", { name: "Newcastle factory" })).toBeInTheDocument();
    expect(within(list).getByText("Online")).toBeInTheDocument();
    expect(within(list).getByText(/ERP01 · version 0.1.0/)).toBeInTheDocument();
    expect(await screen.findByRole("list", { name: "Tokens not used yet" })).toHaveTextContent("Birmingham");
    expect(screen.getByRole("list", { name: "Revoked agents" })).toHaveTextContent("Decommissioned");
  });

  it("adds an agent and shows the token once, with the address and the steps", async () => {
    routeApi({
      "GET /integrations/agents": { data: [], onlineCount: 0, activeCount: 0 },
      "GET /integrations/agent-registrations": { data: [] },
      "POST /integrations/agent-registrations": (_p, o) => ({
        id: "g2", name: o.body.name, token: `FAGT-${"x".repeat(43)}`, expiresAt: "2026-11-16T09:00:00Z", apiUrl: "https://api.example.com/api/v1",
        downloadUrl: "https://downloads.example.com/setup.exe",
      }),
    });
    renderAt("/Settings/Integrations/Agents");
    await userEvent.click(await screen.findByRole("button", { name: "Add a connector agent" }));
    const dialog = screen.getByRole("dialog", { name: "Add a connector agent" });
    expect(within(dialog).getByRole("button", { name: "Make a token" })).toBeDisabled();
    await userEvent.type(within(dialog).getByRole("textbox", { name: /^Name/ }), "Newcastle factory");
    await userEvent.click(within(dialog).getByRole("button", { name: "Make a token" }));
    const result = await screen.findByRole("dialog", { name: "Install the agent" });
    expect(within(result).getByTestId("agent-token")).toHaveTextContent(`FAGT-${"x".repeat(43)}`);
    expect(within(result).getByText("https://api.example.com/api/v1")).toBeInTheDocument();
    expect(within(result).getByRole("link", { name: /Download the Fortress Connector Agent/ })).toHaveAttribute("href", "https://downloads.example.com/setup.exe");
    expect(calls.find((c) => c.k === "POST /integrations/agent-registrations").body).toEqual({ name: "Newcastle factory", location: null, expiresHours: 24 });
  });

  it("someone who may only read sees agents but no way to add one", async () => {
    permissions = ["integrations.read"];
    routeApi({ "GET /integrations/agents": { data: [agent()], onlineCount: 1, activeCount: 1 }, "GET /integrations/agent-registrations": { data: [] } });
    renderAt("/Settings/Integrations/Agents");
    await screen.findByRole("list", { name: "Connector agents" });
    expect(screen.queryByRole("button", { name: "Add a connector agent" })).not.toBeInTheDocument();
  });

  it("people without integrations are told who may use them", () => {
    permissions = [];
    renderAt("/Settings/Integrations/Agents");
    expect(screen.getByText("Connector agents are for Controller seat holders")).toBeInTheDocument();
  });
});

describe("one agent", () => {
  it("wakes the agent, checks it and shows its answer", async () => {
    let job = { id: "j1", kind: "ping", status: "pending", result: null, errorMessage: null, createdAt: recent, finishedAt: null };
    routeApi({
      "GET /integrations/agents/ag1": detail(),
      "POST /integrations/agents/ag1/wake": { woken: true },
      "POST /integrations/agents/ag1/ping": () => job,
      "GET /integrations/agent-jobs/j1": () => job,
    });
    renderAt("/Settings/Integrations/Agents/ag1");
    expect(await screen.findByText("ERP01")).toBeInTheDocument();
    expect(screen.getByText("ab12 cd34 ef56 7890")).toBeInTheDocument();
    await waitFor(() => expect(calls.some((c) => c.k === "POST /integrations/agents/ag1/wake")).toBe(true));
    await userEvent.click(screen.getByRole("button", { name: "Check now" }));
    expect(await screen.findByRole("status")).toHaveTextContent(/Waiting for the agent/);
    job = { ...job, status: "completed", result: { pong: true, version: "0.1.0", agentTime: new Date().toISOString() }, finishedAt: new Date().toISOString() };
    expect(await screen.findByText(/The agent answered \(version 0.1.0\)/, {}, { timeout: 4000 })).toBeInTheDocument();
  });

  it("rotates the keys and collects diagnostics, showing the bundle in words", async () => {
    const rot = { id: "r1", kind: "rotate_keys", status: "completed", result: { fingerprint: "ffff 0000" }, errorMessage: null, createdAt: recent, finishedAt: recent };
    const diag = {
      id: "d1", kind: "diagnostics", status: "completed", errorMessage: null, createdAt: recent, finishedAt: recent,
      result: { version: "0.6.0", os: "Windows Server 2022", memoryMb: 52.5, uptimeSeconds: 7200, keyAgeDays: 12, keyFingerprint: "ab12", allowList: '{"hosts":["erp.local"]}', log: ["one", "two"] },
    };
    routeApi({
      "GET /integrations/agents/ag1": detail(),
      "POST /integrations/agents/ag1/wake": { woken: true },
      "POST /integrations/agents/ag1/rotate-keys": rot,
      "GET /integrations/agent-jobs/r1": rot,
      "POST /integrations/agents/ag1/diagnostics": diag,
      "GET /integrations/agent-jobs/d1": diag,
    });
    renderAt("/Settings/Integrations/Agents/ag1");
    await userEvent.click(await screen.findByRole("button", { name: "Rotate keys now" }));
    expect(await screen.findByText(/Keys rotated: the new fingerprint is ffff 0000/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Collect diagnostics" }));
    const section = await screen.findByRole("region", { name: "Diagnostics" });
    expect(within(section).getByText("0.6.0")).toBeInTheDocument();
    expect(within(section).getByText("52.5 MB")).toBeInTheDocument();
    expect(within(section).getByText("2 hours")).toBeInTheDocument();
    expect(within(section).getByText("12 days")).toBeInTheDocument();
    expect(within(section).getByText("Last 2 log lines")).toBeInTheDocument();
  });

  it("someone who may only read cannot rotate keys or collect diagnostics", async () => {
    permissions = ["integrations.read"];
    routeApi({ "GET /integrations/agents/ag1": detail(), "POST /integrations/agents/ag1/wake": { woken: true } });
    renderAt("/Settings/Integrations/Agents/ag1");
    expect(await screen.findByText(/Only someone who manages integrations/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Rotate keys now" })).not.toBeInTheDocument();
  });

  it("revokes with a reason", async () => {
    routeApi({
      "GET /integrations/agents/ag1": detail(),
      "POST /integrations/agents/ag1/wake": { woken: true },
      "POST /integrations/agents/ag1/revoke": detail({ status: "revoked", online: false, revokedReason: "Server decommissioned", revokedAt: recent, revokedBy: "Ada Owner" }),
    });
    renderAt("/Settings/Integrations/Agents/ag1");
    await userEvent.click(await screen.findByRole("button", { name: "Actions" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Revoke" }));
    const dialog = screen.getByRole("dialog", { name: "Revoke Newcastle factory?" });
    expect(within(dialog).getByRole("button", { name: "Revoke" })).toBeDisabled();
    await userEvent.type(within(dialog).getByRole("textbox", { name: /^Why/ }), "Server decommissioned");
    await userEvent.click(within(dialog).getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(calls.find((c) => c.k === "POST /integrations/agents/ag1/revoke")?.body).toEqual({ reason: "Server decommissioned" }));
  });
});

describe("words", () => {
  it("says how long ago, what happened and what a ping answered", () => {
    expect(ago(new Date(Date.now() - 10_000).toISOString())).toBe("just now");
    expect(ago(new Date(Date.now() - 5 * 60_000).toISOString())).toBe("5 minutes ago");
    expect(ago(null)).toBe("never");
    expect(eventWords({ kind: "version_changed", detail: { from: "0.1.0", to: "0.2.0" } })).toBe("Updated from version 0.1.0 to 0.2.0");
    expect(eventWords({ kind: "revoked", detail: { reason: "Old" } })).toBe("Revoked: Old");
    const now = new Date();
    expect(pingWords({ status: "completed", result: { version: "0.1.0", agentTime: new Date(now.getTime() + 120_000).toISOString() }, finishedAt: now.toISOString() }))
      .toBe("The agent answered (version 0.1.0) — its clock is 120 seconds ahead");
    expect(pingWords({ status: "failed" })).toBeNull();
  });
});
