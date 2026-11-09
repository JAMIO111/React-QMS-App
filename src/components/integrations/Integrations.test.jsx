import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

let permissions;
const apiFetch = vi.fn();
vi.mock("../../lib/api-client", async (importOriginal) => ({ ...(await importOriginal()), apiFetch: (...a) => apiFetch(...a) }));
vi.mock("../../contexts/OrganisationProvider", () => ({ useOrganisation: () => ({ organisationId: "org-1" }) }));
vi.mock("../../hooks/useQmsApi", () => ({ usePermissions: () => ({ can: (p) => permissions.includes(p) }) }));
vi.mock("../../contexts/ToastProvider", () => ({ useToast: () => ({ showToast: vi.fn() }) }));

import SettingsIntegrations from "../Settings/SettingsIntegrations";
import ConnectionPage from "./ConnectionPage";
import RunPage from "./RunPage";

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

describe("Settings → Integrations", () => {
  it("lists connections with their status and offers Add only to managers", async () => {
    routeApi({ "GET /integrations/connections": { data: [conn({ status: "active" })] }, "GET /integrations/providers": { data: providers } });
    renderAt("/Settings/Integrations");
    expect(await screen.findByRole("link", { name: "Sage 200" })).toHaveAttribute("href", "/Settings/Integrations/c1");
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Add connection/ })).toBeInTheDocument();
  });

  it("tells someone without a Controller seat that integrations need one", async () => {
    permissions = ["ncr.read"];
    routeApi({});
    renderAt("/Settings/Integrations");
    expect(await screen.findByText("Integrations are for Controller seat holders")).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });

  it("hides Add without the manage permission", async () => {
    permissions = ["integrations.read"];
    routeApi({ "GET /integrations/connections": { data: [] }, "GET /integrations/providers": { data: providers } });
    renderAt("/Settings/Integrations");
    expect(await screen.findByText("No connections yet")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Add connection/ })).toBeNull();
  });
});

describe("Connection page", () => {
  it("shows what is still needed and blocks Mark ready until nothing is", async () => {
    routeApi({ "GET /integrations/connections/c1": detail(), "GET /integrations/providers": { data: providers }, "GET /integrations/runs": noRuns });
    renderAt("/Settings/Integrations/c1");
    expect(await screen.findByText("Still needed before this can be marked ready")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mark ready" })).toBeDisabled();
    expect(screen.getByText("No credential stored")).toBeInTheDocument();
  });

  it("sends a credential once and never shows it", async () => {
    routeApi({
      "GET /integrations/connections/c1": detail(),
      "GET /integrations/providers": { data: providers },
      "GET /integrations/runs": noRuns,
      "PUT /integrations/connections/c1/credential": detail({ credential: { kind: "bearer", setAt: "2026-11-09T10:00:00Z", setBy: { id: "u1", name: "Ada Owner" } }, problems: [] }),
    });
    renderAt("/Settings/Integrations/c1");
    await userEvent.click(await screen.findByRole("button", { name: "Store a credential" }));
    await userEvent.type(await screen.findByLabelText(/Bearer token/), "s3cret-value");
    await userEvent.click(screen.getByRole("button", { name: "Store" }));
    await waitFor(() => expect(calls.some((c) => c.k === "PUT /integrations/connections/c1/credential")).toBe(true));
    expect(calls.find((c) => c.k.startsWith("PUT")).body).toEqual({ kind: "bearer", secret: "s3cret-value" });
    expect(screen.queryByText("s3cret-value")).toBeNull();
  });

  it("offers Activate when the API says the caller may activate it", async () => {
    routeApi({ "GET /integrations/connections/c1": detail({ status: "ready", problems: [], canActivate: true }), "GET /integrations/providers": { data: providers }, "GET /integrations/runs": noRuns });
    renderAt("/Settings/Integrations/c1");
    expect(await screen.findByRole("button", { name: "Activate" })).toBeInTheDocument();
  });

  it("does not offer Activate to the person who marked it ready unless they may self-approve", async () => {
    routeApi({ "GET /integrations/connections/c1": detail({ status: "ready", problems: [] }), "GET /integrations/providers": { data: providers }, "GET /integrations/runs": noRuns });
    renderAt("/Settings/Integrations/c1");
    expect(await screen.findByText(/Waiting for a different person/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Activate" })).toBeNull();
  });
});

describe("Imports", () => {
  it("says imports are not available yet when nothing can be imported", async () => {
    routeApi({ "GET /integrations/connections/c1": detail(), "GET /integrations/providers": { data: providers }, "GET /integrations/runs": noRuns });
    renderAt("/Settings/Integrations/c1");
    expect(await screen.findByText(/Nothing can be imported through this connection yet/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Run an import" })).toBeNull();
  });

  it("starts a preview and lists the runs with what they did", async () => {
    routeApi({
      "GET /integrations/connections/c1": detail({ runnable: ["supplier"] }),
      "GET /integrations/providers": { data: providers },
      "GET /integrations/runs": { ...noRuns, data: [run()], total: 1 },
      "POST /integrations/connections/c1/runs": run({ id: "r2", kind: "preview" }),
      "GET /integrations/runs/r2": run({ id: "r2", kind: "preview" }),
      "GET /integrations/runs/r2/rows": { data: [], page: 1, pageSize: 50, total: 0 },
    });
    renderAt("/Settings/Integrations/c1");
    expect(await screen.findByRole("link", { name: "Full import · Suppliers" })).toHaveAttribute("href", "/Settings/Integrations/c1/runs/r1");
    expect(screen.getByText("2 created · 1 rejected · 1 failed")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Run an import" }));
    expect(screen.getByRole("button", { name: "Full" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(calls.find((c) => c.k === "POST /integrations/connections/c1/runs").body).toEqual({ entityType: "supplier", kind: "preview" }));
    expect(await screen.findByText(/A preview writes nothing/)).toBeInTheDocument();
  });

  it("shows a run's figures and failed rows, and retries them", async () => {
    routeApi({
      "GET /integrations/runs/r1": run(),
      "GET /integrations/connections/c1": detail({ status: "active", runnable: ["supplier"] }),
      "GET /integrations/runs/r1/rows": (path) => ({
        data: path.includes("status=failed") ? [{ id: "i1", runId: "r1", externalId: "S-3", sourceRow: 4, status: "failed", action: null, internalId: null, errors: [{ field: null, message: "Supplier S-3 has no approved category" }], attempts: 1, payload: { code: "S-3" }, purgedAt: null, createdAt: "2026-11-09T10:00:02Z", appliedAt: null }] : [],
        page: 1, pageSize: 50, total: 1,
      }),
      "POST /integrations/connections/c1/retry": run({ id: "r3", kind: "retry", status: "succeeded", drain: { state: "finished", reason: null } }),
    });
    renderAt("/Settings/Integrations/c1/runs/r1");
    expect(await screen.findByText("Supplier S-3 has no approved category")).toBeInTheDocument();
    expect(screen.getByText("row 4")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry failed rows" }));
    await waitFor(() => expect(calls.find((c) => c.k === "POST /integrations/connections/c1/retry").body).toEqual({ entityType: "supplier" }));
  });

  it("offers Continue and Cancel on a running import, and asks why it is cancelled", async () => {
    routeApi({
      "GET /integrations/runs/r1": run({ status: "running", finishedAt: null, rowsNow: { staged: 3, previewed: 0, unchanged: 0, applied: 0, rejected: 0, failed: 0, superseded: 0 } }),
      "GET /integrations/connections/c1": detail({ status: "active" }),
      "GET /integrations/runs/r1/rows": { data: [], page: 1, pageSize: 50, total: 0 },
      "POST /integrations/runs/r1/cancel": run({ status: "cancelled", cancelReason: "Wrong file" }),
    });
    renderAt("/Settings/Integrations/c1/runs/r1");
    expect(await screen.findByRole("button", { name: "Continue" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Cancel import" }));
    await userEvent.type(await screen.findByLabelText(/Reason/), "Wrong file");
    await userEvent.click(screen.getAllByRole("button", { name: "Cancel import" }).at(-1));
    await waitFor(() => expect(calls.find((c) => c.k === "POST /integrations/runs/r1/cancel").body).toEqual({ reason: "Wrong file" }));
  });

  it("hides the actions from people who may only look", async () => {
    permissions = ["integrations.read"];
    routeApi({
      "GET /integrations/runs/r1": run({ status: "running", finishedAt: null }),
      "GET /integrations/connections/c1": detail({ status: "active" }),
      "GET /integrations/runs/r1/rows": { data: [], page: 1, pageSize: 50, total: 0 },
    });
    renderAt("/Settings/Integrations/c1/runs/r1");
    expect(await screen.findByText("Rows read")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel import" })).toBeNull();
  });
});
