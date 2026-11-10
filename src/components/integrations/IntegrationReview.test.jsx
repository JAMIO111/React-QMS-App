import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";

let permissions;
const apiFetch = vi.fn();
const toast = vi.fn();
vi.mock("../../lib/api-client", async (importOriginal) => ({ ...(await importOriginal()), apiFetch: (...a) => apiFetch(...a) }));
vi.mock("../../contexts/OrganisationProvider", () => ({ useOrganisation: () => ({ organisationId: "org-1" }) }));
vi.mock("../../hooks/useQmsApi", () => ({
  usePermissions: () => ({ can: (p) => permissions.includes(p) }),
  useOrganisationDetails: () => ({ data: { settings: { advancedImports: false } } }),
  useUpdateOrganisation: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("../../contexts/ToastProvider", () => ({ useToast: () => ({ showToast: toast }) }));

import { mappingToRows, ownershipOptions, recordPath, rowsToFields, runSummary } from "../../lib/integrations";
import ReviewPage from "./ReviewPage";
import MappingStep from "./MappingStep";
import SettingsIntegrations from "../Settings/SettingsIntegrations";

const conflict = (over = {}) => ({
  id: "c1", status: "open", entityType: "production_order", record: { id: "o1", label: "WO-9001" }, externalId: "9001",
  field: { key: "quantityPlanned", label: "Quantity planned" }, fortressValue: "100", sourceValue: "120", applyError: null,
  connection: { id: "k1", name: "ERP export" }, runId: "r1", createdAt: "2026-11-10T09:00:00Z", decidedAt: null, decidedBy: null, decisionNote: null,
  supersededAt: null, canDecide: true, ...over,
});

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
          <Route path="/Settings/Integrations" element={<SettingsIntegrations />} />
          <Route path="/Settings/Integrations/Review" element={<ReviewPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );

beforeEach(() => {
  permissions = ["integrations.read", "integrations.run", "integrations.manage"];
  calls.length = 0;
  apiFetch.mockReset();
  toast.mockReset();
});

describe("field ownership in the mapping", () => {
  const fields = [
    { key: "orderNumber", label: "Order number", type: "text", required: true, reviewable: true },
    { key: "quantityPlanned", label: "Quantity planned", type: "number", required: false, reviewable: true },
    { key: "revision", label: "Revision", type: "text", required: false, reviewable: false },
  ];

  it("keeps a field's ownership when a mapping is loaded and saved again", () => {
    const rows = mappingToRows(fields, { fields: [{ target: "orderNumber", source: "No" }, { target: "quantityPlanned", source: "Qty", ownership: "manual_review" }] });
    expect(rows[1].ownership).toBe("manual_review");
    expect(rows[0].ownership).toBe("source_wins");
    expect(rowsToFields(rows, fields)).toEqual([{ target: "orderNumber", source: "No" }, { target: "quantityPlanned", source: "Qty", ownership: "manual_review" }]);
  });

  it("offers Review only where the field can be reviewed", () => {
    expect(ownershipOptions(fields[1]).map((o) => o.value)).toEqual(["source_wins", "qms_wins", "manual_review"]);
    expect(ownershipOptions(fields[2]).map((o) => o.value)).toEqual(["source_wins", "qms_wins"]);
  });

  const Harness = ({ updates }) => {
    const [rows, setRows] = useState(mappingToRows(fields, { fields: [{ target: "orderNumber", source: "No" }, { target: "quantityPlanned", source: "Qty" }, { target: "revision", source: "Rev" }] }));
    return (
      <>
        <MappingStep fields={fields} columns={["No", "Qty", "Rev"]} keyField="No" onKeyField={() => {}} rows={rows} onRows={setRows} updates={updates} />
        <output data-testid="fields">{JSON.stringify(rowsToFields(rows, fields))}</output>
      </>
    );
  };

  it("asks who owns a field when the import updates records", async () => {
    render(<Harness updates />);
    await userEvent.click(screen.getByRole("button", { name: "Show settings for Quantity planned" }));
    const choice = screen.getByRole("group", { name: "Who owns Quantity planned" });
    await userEvent.click(within(choice).getByRole("button", { name: "Review" }));
    expect(screen.getByText(/waits under Values to review/)).toBeInTheDocument();
    expect(JSON.parse(screen.getByTestId("fields").textContent)[1]).toEqual({ target: "quantityPlanned", source: "Qty", ownership: "manual_review" });
    expect(screen.getByText(/changes reviewed/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Show settings for Revision" }));
    const rev = screen.getByRole("group", { name: "Who owns Revision" });
    expect(within(rev).queryByRole("button", { name: "Review" })).not.toBeInTheDocument();
    await userEvent.click(within(rev).getByRole("button", { name: "Fortress wins" }));
    expect(JSON.parse(screen.getByTestId("fields").textContent)[2]).toMatchObject({ ownership: "qms_wins" });
  });

  it("does not ask when the import only adds new records", async () => {
    render(<Harness updates={false} />);
    await userEvent.click(screen.getByRole("button", { name: "Show settings for Quantity planned" }));
    expect(screen.queryByRole("group", { name: "Who owns Quantity planned" })).not.toBeInTheDocument();
  });
});

describe("values to review", () => {
  it("lists what waits, with both values and a link to the record", async () => {
    routeApi({ "GET /integrations/conflicts": { data: [conflict(), conflict({ id: "c2", field: { key: "customer", label: "Customer" }, fortressValue: null, sourceValue: "BIGCO" })], page: 1, pageSize: 50, total: 2, openCount: 2 } });
    renderAt("/Settings/Integrations/Review");
    const card = await screen.findByRole("listitem", { name: "WO-9001: Quantity planned" });
    expect(within(card).getByText("100")).toBeInTheDocument();
    expect(within(card).getByText("120")).toBeInTheDocument();
    expect(within(card).getByRole("link", { name: "WO-9001" })).toHaveAttribute("href", "/Production/Orders/o1");
    expect(within(screen.getByRole("listitem", { name: "WO-9001: Customer" })).getByText("(empty)")).toBeInTheDocument();
    expect(calls[0].path).toContain("status=open");
  });

  it("accepting takes the value off the list at once", async () => {
    let answer;
    routeApi({
      "GET /integrations/conflicts": { data: [conflict()], page: 1, pageSize: 50, total: 1, openCount: 1 },
      "POST /integrations/conflicts/c1/accept": () => new Promise((r) => { answer = r; }),
    });
    renderAt("/Settings/Integrations/Review");
    const card = await screen.findByRole("listitem", { name: "WO-9001: Quantity planned" });
    await userEvent.click(within(card).getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(screen.queryByRole("listitem", { name: "WO-9001: Quantity planned" })).not.toBeInTheDocument());
    expect(calls.find((c) => c.k === "POST /integrations/conflicts/c1/accept").body).toEqual({});
    answer(conflict({ status: "accepted" }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ type: "success", title: "Accepted" })));
  });

  it("puts the value back when accepting is refused", async () => {
    routeApi({
      "GET /integrations/conflicts": { data: [conflict()], page: 1, pageSize: 50, total: 1, openCount: 1 },
      "POST /integrations/conflicts/c1/accept": () => Promise.reject(new Error("Not allowed")),
    });
    renderAt("/Settings/Integrations/Review");
    const card = await screen.findByRole("listitem", { name: "WO-9001: Quantity planned" });
    await userEvent.click(within(card).getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ type: "error" })));
    expect(await screen.findByRole("listitem", { name: "WO-9001: Quantity planned" })).toBeInTheDocument();
  });

  it("keeping Fortress's value needs a reason", async () => {
    routeApi({
      "GET /integrations/conflicts": { data: [conflict()], page: 1, pageSize: 50, total: 1, openCount: 1 },
      "POST /integrations/conflicts/c1/reject": conflict({ status: "rejected" }),
    });
    renderAt("/Settings/Integrations/Review");
    const card = await screen.findByRole("listitem", { name: "WO-9001: Quantity planned" });
    await userEvent.click(within(card).getByRole("button", { name: "Keep Fortress's" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "Keep Fortress's value" })).toBeDisabled();
    await userEvent.type(within(dialog).getByRole("textbox", { name: /Why does Fortress keep its value/ }), "Planned here");
    await userEvent.click(within(dialog).getByRole("button", { name: "Keep Fortress's value" }));
    await waitFor(() => expect(calls.find((c) => c.k === "POST /integrations/conflicts/c1/reject").body).toEqual({ reason: "Planned here" }));
  });

  it("offers no decision without the right, and explains a value Fortress cannot take", async () => {
    routeApi({ "GET /integrations/conflicts": { data: [conflict({ canDecide: false }), conflict({ id: "c3", field: { key: "status", label: "Status" }, applyError: "An order that is in progress cannot become planned" })], page: 1, pageSize: 50, total: 2, openCount: 2 } });
    renderAt("/Settings/Integrations/Review");
    const first = await screen.findByRole("listitem", { name: "WO-9001: Quantity planned" });
    expect(within(first).queryByRole("button", { name: "Accept" })).not.toBeInTheDocument();
    const second = screen.getByRole("listitem", { name: "WO-9001: Status" });
    expect(within(second).getByText(/cannot become planned/)).toBeInTheDocument();
    expect(within(second).getByRole("button", { name: "Accept" })).toBeDisabled();
  });

  it("Settings → Integrations says how many values wait", async () => {
    routeApi({
      "GET /integrations/conflicts": { data: [conflict()], page: 1, pageSize: 1, total: 3, openCount: 3 },
      "GET /integrations/connections": { data: [] },
      "GET /integrations/runs": { data: [] },
    });
    renderAt("/Settings/Integrations");
    expect(await screen.findByText("3 imported values are waiting for review")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Review values" })).toHaveAttribute("href", "/Settings/Integrations/Review");
  });

  it("helpers: record addresses and the run summary", () => {
    expect(recordPath("production_order", "o1")).toBe("/Production/Orders/o1");
    expect(recordPath("machine", "m1")).toBe("/Machines");
    expect(runSummary({ kind: "full", counts: { created: 0, updated: 2, unchanged: 0, skipped: 0, rejected: 0, failed: 0, superseded: 0, parked: 3, total: 2 } })).toBe("2 updated · 3 to review");
  });
});
