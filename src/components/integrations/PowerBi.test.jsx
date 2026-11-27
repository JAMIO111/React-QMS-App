import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

let permissions;
const apiFetch = vi.fn();
const showToast = vi.fn();
vi.mock("../../lib/api-client", async (importOriginal) => ({ ...(await importOriginal()), apiFetch: (...a) => apiFetch(...a), API_URL: "https://api.example.com" }));
vi.mock("../../contexts/OrganisationProvider", () => ({ useOrganisation: () => ({ organisationId: "org-1" }) }));
vi.mock("../../hooks/useQmsApi", () => ({ usePermissions: () => ({ can: (p) => permissions.includes(p) }) }));
vi.mock("../../contexts/ToastProvider", () => ({ useToast: () => ({ showToast }) }));

import PowerBiCard from "./PowerBiCard";
import { powerQueryScript, reportingBaseUrl } from "../../lib/powerBi";

const key = (over = {}) => ({
  id: "k1", name: "Power BI", keyPrefix: "abcd1234", status: "active", expiresAt: "2027-11-23T00:00:00Z", lastUsedAt: null, lastUsedAddress: null,
  revokedAt: null, revokedReason: null, createdAt: "2026-11-23T09:00:00Z", mine: true, ...over,
});
const datasets = [
  {
    key: "non_conformances", title: "Non-conformances", description: "One row per non-conformance.", path: "/api/v1/reporting/v1/non_conformances",
    columns: [
      { name: "id", type: "text", description: "" }, { name: "total_cost", type: "number", description: "" }, { name: "detected_on", type: "date", description: "" },
      { name: "raised_at", type: "datetime", description: "" }, { name: "active", type: "boolean", description: "" }, { name: "metrics", type: "json", description: "" },
    ],
  },
  { key: "suppliers", title: "Suppliers", description: "One row per supplier.", path: "/api/v1/reporting/v1/suppliers", columns: [{ name: "code", type: "text", description: "" }] },
];

let keys;
let pendingInvoice;
const calls = [];
const renderCard = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <PowerBiCard />
    </QueryClientProvider>,
  );

beforeEach(() => {
  permissions = ["integrations.read", "integrations.manage", "subscription.read"];
  keys = [key()];
  pendingInvoice = false;
  calls.length = 0;
  apiFetch.mockReset();
  showToast.mockReset();
  apiFetch.mockImplementation(async (path, opts = {}) => {
    const k = `${opts.method ?? "GET"} ${path}`;
    calls.push({ k, body: opts.body });
    if (k === "GET /subscription") return { firstInvoicePending: pendingInvoice };
    if (k === "GET /reporting/keys") return { data: keys };
    if (k === "GET /reporting/v1/datasets") return { datasets };
    if (k === "POST /reporting/keys") {
      const made = key({ id: "k2", name: opts.body.name, keyPrefix: "wxyz9876" });
      keys = [made, ...keys];
      return { secret: `fqr_${"A".repeat(43)}`, key: made };
    }
    if (k.startsWith("POST /reporting/keys/") && k.endsWith("/revoke")) {
      keys = keys.map((x) => (x.id === path.split("/")[3] ? { ...x, status: "revoked", revokedReason: opts.body.reason } : x));
      return keys.find((x) => x.id === path.split("/")[3]);
    }
    throw new Error(`unexpected ${k}`);
  });
});

describe("the Power BI script", () => {
  it("pages through the dataset with the fixed host and a relative path, types the columns and leaves the key out", () => {
    const script = powerQueryScript({ baseUrl: "https://api.example.com/api/v1/reporting/v1", dataset: "non_conformances", columns: datasets[0].columns });
    expect(script).toContain('BaseUrl = "https://api.example.com/api/v1/reporting/v1"');
    expect(script).toContain('Dataset = "non_conformances"');
    expect(script).toContain("RelativePath = Dataset");
    expect(script).toContain("nextCursor");
    expect(script).toContain('{"total_cost", type number}');
    expect(script).toContain('{"detected_on", type date}');
    expect(script).toContain('{"raised_at", type datetimezone}');
    expect(script).toContain('{"active", type logical}');
    expect(script).not.toContain('"metrics"');
    expect(script).not.toMatch(/fqr_/);
    expect(reportingBaseUrl("https://api.example.com/")).toBe("https://api.example.com/api/v1/reporting/v1");
  });

  it("still works before the columns are known", () => {
    const script = powerQueryScript({ dataset: "suppliers" });
    expect(script).toContain("Result");
    expect(script).not.toContain("TransformColumnTypes");
  });
});

describe("Power BI and reporting card", () => {
  it("holds back Make a key, and says why, while an invoiced organisation's first invoice is unpaid", async () => {
    pendingInvoice = true;
    renderCard();
    expect(await screen.findByText("Reporting keys wait for your first invoice")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Make a key" })).toBeDisabled();
  });

  it("offers Make a key as usual when nothing is waiting", async () => {
    renderCard();
    await screen.findByRole("list", { name: "Reporting keys" });
    expect(screen.queryByText("Reporting keys wait for your first invoice")).toBeNull();
    expect(screen.getByRole("button", { name: "Make a key" })).toBeEnabled();
  });

  it("lists keys by their first characters, who they act as and when they were last used, never the key", async () => {
    keys = [key({ lastUsedAt: "2026-11-23T10:00:00Z", lastUsedAddress: "203.0.113.5" }), key({ id: "k0", name: "Old", status: "revoked", revokedReason: "Replaced" })];
    renderCard();
    const list = await screen.findByRole("list", { name: "Reporting keys" });
    expect(within(list).getByText(/Power BI/)).toBeInTheDocument();
    expect(list).toHaveTextContent("fqr_abcd1234…");
    expect(list).toHaveTextContent("Acts as you");
    expect(list).toHaveTextContent("from 203.0.113.5");
    expect(await screen.findByText(/Past keys \(1\)/)).toBeInTheDocument();
  });

  it("makes a key and shows it once, with Basic sign-in advice", async () => {
    const user = userEvent.setup();
    renderCard();
    await screen.findByRole("list", { name: "Reporting keys" });
    await user.click(screen.getByRole("button", { name: /Make a key/ }));
    const name = screen.getByLabelText(/Name/);
    await user.clear(name);
    await user.type(name, "Quality report");
    await user.click(screen.getByRole("button", { name: "Make the key" }));
    expect(await screen.findByTestId("report-key-secret")).toHaveTextContent(`fqr_${"A".repeat(43)}`);
    expect(screen.getByText(/shown only once/)).toBeInTheDocument();
    expect(screen.getByText(/Basic/)).toBeInTheDocument();
    expect(calls.find((c) => c.k === "POST /reporting/keys").body).toEqual({ name: "Quality report", days: 365 });
    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByTestId("report-key-secret")).not.toBeInTheDocument();
    expect(await screen.findByText(/Quality report/)).toBeInTheDocument();
  });

  it("revokes a key with a reason, and shows it revoked at once", async () => {
    const user = userEvent.setup();
    renderCard();
    await screen.findByRole("list", { name: "Reporting keys" });
    await user.click(screen.getByRole("button", { name: "Revoke Power BI" }));
    const submit = screen.getByRole("button", { name: "Revoke the key" });
    expect(submit).toBeDisabled();
    await user.type(screen.getByLabelText(/Why/), "Replaced by a new report");
    await user.click(submit);
    await waitFor(() => expect(calls.some((c) => c.k === "POST /reporting/keys/k1/revoke")).toBe(true));
    expect(calls.find((c) => c.k === "POST /reporting/keys/k1/revoke").body).toEqual({ reason: "Replaced by a new report" });
    await waitFor(() => expect(screen.queryByRole("list", { name: "Reporting keys" })).not.toBeInTheDocument());
    expect(await screen.findByText(/Past keys \(1\)/)).toBeInTheDocument();
  });

  it("shows the address and the script for the chosen dataset, with copy buttons", async () => {
    const user = userEvent.setup();
    renderCard();
    await screen.findByRole("list", { name: "Reporting keys" });
    await user.click(screen.getByRole("button", { name: "Connect Power BI" }));
    expect(await screen.findByTestId("power-bi-address")).toHaveTextContent("https://api.example.com/api/v1/reporting/v1");
    await waitFor(() => expect(screen.getByTestId("power-bi-script")).toHaveTextContent('Dataset = "non_conformances"'));
    expect(screen.getByTestId("power-bi-script")).toHaveTextContent("type number");
    expect(screen.getByRole("button", { name: "Copy power query script" })).toBeInTheDocument();
  });

  it("offers no way to make or revoke keys without the manage permission", async () => {
    permissions = ["integrations.read"];
    renderCard();
    await screen.findByRole("list", { name: "Reporting keys" });
    expect(screen.queryByRole("button", { name: /Make a key/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Revoke/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect Power BI" })).toBeInTheDocument();
  });
});
