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

const providers = [
  { key: "csv", name: "CSV / Excel file", description: "Import files", kind: "file", authTypes: [], capabilities: [], status: "available" },
  { key: "rest_api", name: "REST API", description: "Read from an API", kind: "api", authTypes: ["bearer"], capabilities: [], status: "available" },
];
const conn = (over = {}) => ({
  id: "c1", provider: { key: "rest_api", name: "REST API", kind: "api" }, name: "Sage 200", externalSystem: "sage-200", status: "draft",
  config: { baseUrl: "https://erp.example.com/api", authType: "bearer" }, lastTest: null, readyAt: null, readyBy: null, activatedAt: null, activatedBy: null,
  createdAt: "2026-11-09T09:00:00Z", createdBy: { id: "u1", name: "Ada Owner" }, ...over,
});
const detail = (over = {}) => ({ ...conn(), credential: null, problems: ["Store a credential"], events: [{ action: "created", fromStatus: null, toStatus: "draft", note: "REST API", at: "2026-11-09T09:00:00Z", by: { id: "u1", name: "Ada Owner" } }], ...over });

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
        </Routes>
        <div id="modal-root" />
      </MemoryRouter>
    </QueryClientProvider>
  );

beforeEach(() => {
  permissions = ["integrations.read", "integrations.manage", "integrations.approve"];
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
    routeApi({ "GET /integrations/connections/c1": detail(), "GET /integrations/providers": { data: providers } });
    renderAt("/Settings/Integrations/c1");
    expect(await screen.findByText("Still needed before this can be marked ready")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mark ready" })).toBeDisabled();
    expect(screen.getByText("No credential stored")).toBeInTheDocument();
  });

  it("sends a credential once and never shows it", async () => {
    routeApi({
      "GET /integrations/connections/c1": detail(),
      "GET /integrations/providers": { data: providers },
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

  it("offers Activate to an approver only when the connection is ready", async () => {
    routeApi({ "GET /integrations/connections/c1": detail({ status: "ready", problems: [] }), "GET /integrations/providers": { data: providers } });
    renderAt("/Settings/Integrations/c1");
    expect(await screen.findByRole("button", { name: "Activate" })).toBeInTheDocument();
  });

  it("does not offer Activate without approval rights", async () => {
    permissions = ["integrations.read", "integrations.manage"];
    routeApi({ "GET /integrations/connections/c1": detail({ status: "ready", problems: [] }), "GET /integrations/providers": { data: providers } });
    renderAt("/Settings/Integrations/c1");
    expect(await screen.findByText(/Waiting for a different person/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Activate" })).toBeNull();
  });
});
