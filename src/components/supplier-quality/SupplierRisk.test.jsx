import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

let permissions;
const apiFetch = vi.fn();
vi.mock("../../lib/api-client", async (importOriginal) => ({ ...(await importOriginal()), apiFetch: (...a) => apiFetch(...a) }));
vi.mock("../../contexts/OrganisationProvider", () => ({ useOrganisation: () => ({ organisationId: "org-1" }) }));
vi.mock("../../hooks/useQmsApi", () => ({ usePermissions: () => ({ can: (p) => permissions.includes(p) }) }));
vi.mock("../../contexts/ToastProvider", () => ({ useToast: () => ({ showToast: vi.fn() }) }));

import { RiskCard } from "./RiskAssessment";
import SettingsSupplierQuality from "../Settings/SettingsSupplierQuality";
import { factorKey } from "../../lib/supplierRisk";

const model = (over = {}) => ({
  id: "m1", version: 1, reviewIntervalMonths: 12, reason: "Default model", createdAt: "2026-11-01T09:00:00Z", createdBy: null,
  thresholds: { mediumFrom: 1.75, highFrom: 2.5, criticalFrom: 3.25 },
  factors: [
    { key: "product_criticality", label: "Criticality of what they supply", description: "Impact if it is wrong", weight: 5, escalates: true },
    { key: "quality_system", label: "Quality system maturity", description: "", weight: 4, escalates: false },
  ],
  versions: [{ version: 1, createdAt: "2026-11-01T09:00:00Z", createdBy: null, reason: "Default model" }], ...over,
});
const assessment = (over = {}) => ({
  id: "a1", supplierId: "s1", modelVersion: 1, index: 1.67, band: "low", rating: "high", escalatedBy: ["Criticality of what they supply"],
  factors: [
    { key: "product_criticality", label: "Criticality of what they supply", weight: 5, escalates: true, score: 4, note: "Safety part" },
    { key: "quality_system", label: "Quality system maturity", weight: 4, escalates: false, score: 1, note: null },
  ],
  rationale: "Critical product from a certified supplier", previousRating: "medium", reviewOn: "2027-11-01", status: "current", reviewOverdue: false,
  assessedAt: "2026-11-02T09:00:00Z", assessedBy: { id: "u1", name: "Ada Owner" }, ...over,
});
const calls = [];
const routeApi = (routes = {}) =>
  apiFetch.mockImplementation(async (path, opts = {}) => {
    const k = `${opts.method ?? "GET"} ${path.split("?")[0]}`;
    calls.push({ k, path, body: opts.body });
    if (!(k in routes)) throw new Error(`unexpected ${k}`);
    return typeof routes[k] === "function" ? routes[k](path, opts) : routes[k];
  });
const supplier = { id: "s1", name: "Acme Metals Ltd", displayName: "Acme", riskRating: null };
const renderUi = (ui) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>{ui}<div id="modal-root" /></MemoryRouter>
    </QueryClientProvider>
  );

beforeEach(() => {
  permissions = ["supplier_quality.read", "supplier_quality.manage", "supplier_quality.configure"];
  calls.length = 0;
  apiFetch.mockReset();
});

describe("factorKey", () => {
  it("makes a stable key from a name and avoids the ones taken", () => {
    expect(factorKey("Delivery performance")).toBe("delivery_performance");
    expect(factorKey("  Cost & Price!! ")).toBe("cost_price");
    expect(factorKey("Delivery performance", ["delivery_performance"])).toBe("delivery_performance_2");
    expect(factorKey("")).toBe("factor");
    expect(factorKey("A").length).toBeGreaterThanOrEqual(2);
  });
});

describe("the risk card", () => {
  it("says a supplier has not been assessed and offers to assess it", async () => {
    routeApi({ "GET /supplier-quality/suppliers/s1/risk-assessments": { data: [] }, "GET /supplier-quality/risk-model": model() });
    renderUi(<RiskCard supplier={supplier} canManage />);
    expect(await screen.findByText(/Not assessed yet/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Assess risk" })).toBeInTheDocument();
  });

  it("shows the rating with its working-out, the rationale, factor scores and earlier assessments", async () => {
    routeApi({
      "GET /supplier-quality/suppliers/s1/risk-assessments": { data: [assessment(), assessment({ id: "a0", status: "superseded", rating: "medium", band: "medium", escalatedBy: [], index: 2, rationale: "First look", previousRating: null })] },
      "GET /supplier-quality/risk-model": model(),
    });
    renderUi(<RiskCard supplier={supplier} canManage />);
    expect(await screen.findByText(/raised to/)).toHaveTextContent("Weighted score 1.67 of 4 → low band, raised to high because Criticality of what they supply is critical. Model version 1.");
    expect(screen.getByText("Critical product from a certified supplier")).toBeInTheDocument();
    const factors = screen.getByRole("table", { name: "Factor scores" });
    expect(within(factors).getByText("Safety part")).toBeInTheDocument();
    expect(within(factors).getByText(/raises the rating/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Assess again" })).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "Earlier assessments" })).getByText("First look")).toBeInTheDocument();
    expect(screen.queryByText("This assessment is due for review")).toBeNull();
  });

  it("warns when the review is overdue, and a reader gets no button", async () => {
    permissions = ["supplier_quality.read"];
    routeApi({ "GET /supplier-quality/suppliers/s1/risk-assessments": { data: [assessment({ reviewOverdue: true })] }, "GET /supplier-quality/risk-model": model() });
    renderUi(<RiskCard supplier={supplier} canManage={false} />);
    expect(await screen.findByText("This assessment is due for review")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Assess/ })).toBeNull();
  });

  it("scores every factor, shows the rating the database works out, and saves only with a rationale", async () => {
    routeApi({
      "GET /supplier-quality/suppliers/s1/risk-assessments": { data: [] },
      "GET /supplier-quality/risk-model": model(),
      "POST /supplier-quality/suppliers/s1/risk-assessments/preview": { modelVersion: 1, index: 2.33, band: "medium", rating: "medium", escalatedBy: [], factors: [] },
      "POST /supplier-quality/suppliers/s1/risk-assessments": assessment(),
    });
    renderUi(<RiskCard supplier={supplier} canManage />);
    await userEvent.click(await screen.findByRole("button", { name: "Assess risk" }));
    const dialog = screen.getByRole("dialog");
    const submit = within(dialog).getByRole("button", { name: "Record assessment" });
    expect(submit).toBeDisabled();
    expect(within(dialog).getByText("Score every factor to see the rating.")).toBeInTheDocument();
    await userEvent.click(within(within(dialog).getByRole("radiogroup", { name: "Criticality of what they supply score" })).getByRole("radio", { name: "Medium" }));
    expect(calls.some((c) => c.k.endsWith("/preview"))).toBe(false); // not until every factor is scored
    await userEvent.click(within(within(dialog).getByRole("radiogroup", { name: "Quality system maturity score" })).getByRole("radio", { name: "High" }));
    await userEvent.type(within(dialog).getByLabelText("Note on Quality system maturity"), "Two audit findings");
    expect(await within(dialog).findByText("Rating: medium")).toBeInTheDocument();
    expect(calls.filter((c) => c.k.endsWith("/preview")).at(-1).body).toEqual({
      scores: [{ key: "product_criticality", score: 2, note: null }, { key: "quality_system", score: 3, note: "Two audit findings" }],
    });
    expect(submit).toBeDisabled(); // a rationale is needed
    await userEvent.type(within(dialog).getByLabelText(/Rationale/), "Sound supplier with some findings");
    expect(submit).toBeEnabled();
    await userEvent.click(submit);
    await waitFor(() => expect(calls.find((c) => c.k === "POST /supplier-quality/suppliers/s1/risk-assessments")?.body).toEqual({
      scores: [{ key: "product_criticality", score: 2, note: null }, { key: "quality_system", score: 3, note: "Two audit findings" }], rationale: "Sound supplier with some findings",
    }));
  });
});

describe("settings: the risk model", () => {
  const classifications = { data: [{ id: "k1", key: "welding", label: "Welding", description: null, sequence: 5, active: true, suppliers: 1 }] };

  it("shows the model in force and its versions", async () => {
    routeApi({ "GET /supplier-quality/classifications": classifications, "GET /supplier-quality/risk-model": model() });
    renderUi(<SettingsSupplierQuality />);
    const table = await screen.findByRole("table", { name: "Risk factors" });
    expect(within(table).getByText("Criticality of what they supply")).toBeInTheDocument();
    expect(screen.getByText(/Medium from 1.75 · high from 2.5 · critical from 3.25 · review every 12 months/)).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "Model versions" })).getByText(/Default model/)).toBeInTheDocument();
  });

  it("saves a new version with a reason, keeping the keys of existing factors and making one for a new factor", async () => {
    routeApi({ "GET /supplier-quality/classifications": classifications, "GET /supplier-quality/risk-model": model(), "PUT /supplier-quality/risk-model": model({ version: 2 }) });
    renderUi(<SettingsSupplierQuality />);
    await userEvent.click(await screen.findByRole("button", { name: "Change the model" }));
    const dialog = screen.getByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save new version" }));
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Say why the model is changing");
    await userEvent.click(within(dialog).getByRole("button", { name: "Add factor" }));
    const labels = within(dialog).getAllByRole("textbox", { name: "Factor" });
    await userEvent.type(labels.at(-1), "Delivery performance");
    await userEvent.type(within(dialog).getByLabelText(/Why is it changing/), "Added delivery");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save new version" }));
    await waitFor(() => expect(calls.find((c) => c.k === "PUT /supplier-quality/risk-model")).toBeTruthy());
    const body = calls.find((c) => c.k === "PUT /supplier-quality/risk-model").body;
    expect(body.factors.map((f) => f.key)).toEqual(["product_criticality", "quality_system", "delivery_performance"]);
    expect(body).toMatchObject({ thresholds: { mediumFrom: 1.75, highFrom: 2.5, criticalFrom: 3.25 }, reviewIntervalMonths: 12, reason: "Added delivery" });
    expect(body.factors[2]).toMatchObject({ weight: 3, escalates: false });
  });

  it("refuses thresholds that do not rise", async () => {
    routeApi({ "GET /supplier-quality/classifications": classifications, "GET /supplier-quality/risk-model": model() });
    renderUi(<SettingsSupplierQuality />);
    await userEvent.click(await screen.findByRole("button", { name: "Change the model" }));
    const dialog = screen.getByRole("dialog");
    const high = within(dialog).getByLabelText("High from");
    await userEvent.clear(high);
    await userEvent.type(high, "1.2");
    await userEvent.type(within(dialog).getByLabelText(/Why is it changing/), "Testing");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save new version" }));
    expect(within(dialog).getByRole("alert")).toHaveTextContent("The bands must rise");
    expect(calls.some((c) => c.k === "PUT /supplier-quality/risk-model")).toBe(false);
  });

  it("offers no change button without supplier_quality.configure", async () => {
    permissions = ["supplier_quality.read"];
    routeApi({ "GET /supplier-quality/classifications": classifications, "GET /supplier-quality/risk-model": model() });
    renderUi(<SettingsSupplierQuality />);
    await screen.findByRole("table", { name: "Risk factors" });
    expect(screen.queryByRole("button", { name: "Change the model" })).toBeNull();
  });
});
