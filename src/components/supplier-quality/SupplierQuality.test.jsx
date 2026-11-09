import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

let permissions;
const apiFetch = vi.fn();
vi.mock("../../lib/api-client", async (importOriginal) => ({ ...(await importOriginal()), apiFetch: (...a) => apiFetch(...a) }));
vi.mock("../../contexts/OrganisationProvider", () => ({ useOrganisation: () => ({ organisationId: "org-1" }) }));
vi.mock("../../hooks/useQmsApi", () => ({ usePermissions: () => ({ can: (p) => permissions.includes(p) }) }));
vi.mock("../../contexts/ToastProvider", () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock("../../contexts/SearchProvider", () => ({ useGlobalSearch: () => ({ debouncedSearchTerm: "" }) }));
vi.mock("../ncr/Pickers", () => ({
  PartPicker: ({ label, onChange }) => <button type="button" onClick={() => onChange("p1", { id: "p1", name: "BAR-50" })}>{label}: pick BAR-50</button>,
}));

import SuppliersRegisterPage from "./SuppliersRegisterPage";
import SupplierProfilePage from "./SupplierProfilePage";
import SettingsSupplierQuality from "../Settings/SettingsSupplierQuality";

const classes = [
  { id: "k1", key: "welding", label: "Welding", description: null, sequence: 5, active: true, suppliers: 1 },
  { id: "k2", key: "casting", label: "Casting foundry", description: null, sequence: 10, active: false, suppliers: 0 },
];
const row = (over = {}) => ({
  id: "s1", code: "ACME", name: "Acme Metals Ltd", displayName: "Acme", supplierType: "subcontractor", country: "GB", city: "Sheffield", approvalStatus: "approved", approvalStatusChangedAt: "2026-11-02T09:00:00Z",
  active: true, riskRating: null, classifications: [{ id: "k1", label: "Welding" }], primaryContact: { name: "Pat Quality", email: "pat@acme.test", phone: null }, openNcCount: 2, createdAt: "2026-11-01T09:00:00Z", ...over,
});
const detail = (over = {}) => {
  const { primaryContact: _omit, ...r } = row();
  return {
    ...r, companyNumber: null, vatNumber: null, notes: "Preferred for welding", addressLine1: "1 Steel Way", addressLine2: null, region: null, postcode: "S1 1AA", website: "https://acme.test", email: null, phone: null,
    purchasingReference: "V-100", approvalStatusChangedBy: { id: "u1", name: "Ada Owner" }, conditions: null, reviewOn: null,
    contacts: [{ id: "c1", name: "Pat Quality", jobTitle: "QA lead", role: "quality", email: "pat@acme.test", phone: null, isPrimary: true, active: true, notes: null }],
    products: [{ id: "pr1", kind: "part", part: { id: "p1", partNumber: "BAR-50", name: "Bar stock" }, description: null, supplierPartNumber: "AC-50", notes: null, active: true }],
    counts: { openNcs: 2, totalNcs: 5, receivedLots: 3, lastReceivedOn: "2026-10-30" }, ...over,
  };
};
const calls = [];
const routeApi = (routes = {}) =>
  apiFetch.mockImplementation(async (path, opts = {}) => {
    const k = `${opts.method ?? "GET"} ${path.split("?")[0]}`;
    calls.push({ k, path, body: opts.body });
    const all = {
      "GET /supplier-quality/classifications": { data: classes },
      "GET /saved-filters": { data: [], limit: 5 },
      "GET /supplier-quality/suppliers": { data: [row(), row({ id: "s2", code: "BETA", name: "Beta Fasteners", approvalStatus: "pending_approval", active: false, openNcCount: 0, classifications: [] })], page: 1, pageSize: 25, total: 2 },
      ...routes,
    };
    if (!(k in all)) throw new Error(`unexpected ${k}`);
    return typeof all[k] === "function" ? all[k](path, opts) : all[k];
  });
const lastList = () => calls.filter((c) => c.k === "GET /supplier-quality/suppliers").at(-1);

const Where = () => {
  const l = useLocation();
  return <p data-testid="where">{l.pathname + l.search}</p>;
};
const renderAt = (url) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="/Suppliers" element={<><SuppliersRegisterPage /><Where /></>} />
          <Route path="/Suppliers/:id" element={<><SupplierProfilePage /><Where /></>} />
          <Route path="/Settings/Supplier-Quality" element={<SettingsSupplierQuality />} />
          <Route path="/Non-Conformance/Register" element={<Where />} />
        </Routes>
        <div id="modal-root" />
      </MemoryRouter>
    </QueryClientProvider>
  );

beforeEach(() => {
  permissions = ["supplier_quality.read", "supplier_quality.manage", "supplier_quality.approve", "supplier_quality.configure"];
  calls.length = 0;
  apiFetch.mockReset();
});

describe("supplier register", () => {
  it("is a server-side table with approval and activity shown separately, and active suppliers asked for by default", async () => {
    routeApi();
    renderAt("/Suppliers");
    const table = await screen.findByRole("region", { name: "Suppliers" });
    expect(await within(table).findByRole("link", { name: "ACME" })).toHaveAttribute("href", "/Suppliers/s1");
    expect(within(table).getByText("Approved")).toBeInTheDocument();
    expect(within(table).getByText("Pending approval")).toBeInTheDocument();
    expect(within(table).getByRole("link", { name: "2" })).toHaveAttribute("href", expect.stringContaining("/Non-Conformance/Register?supplier=s1"));
    expect(screen.getByText("2 suppliers")).toBeInTheDocument();
    expect(Object.fromEntries(new URL(lastList().path, "http://x").searchParams)).toMatchObject({ active: "active", sort: "code", order: "asc", page: "1", pageSize: "25" });
    expect(screen.getByRole("button", { name: "Add supplier" })).toBeInTheDocument();
  });

  it("filters from the drawer, shows chips and clears them", async () => {
    routeApi();
    const where = renderAt("/Suppliers");
    await screen.findByRole("region", { name: "Suppliers" });
    await userEvent.click(screen.getByRole("button", { name: "Filter" }));
    const pane = await screen.findByRole("dialog", { name: "Filter suppliers" });
    await userEvent.click(within(pane).getByLabelText("Approved"));
    await userEvent.click(within(pane).getByLabelText("Welding"));
    await userEvent.click(within(pane).getByRole("radio", { name: "All" }));
    await userEvent.click(within(pane).getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(Object.fromEntries(new URL(lastList().path, "http://x").searchParams)).toMatchObject({ status: "approved", classificationId: "k1", active: "all" }));
    expect(screen.getByRole("button", { name: /Remove filter Approval: Approved/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Remove filter Classification: Welding/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Clear all" }));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(/^\/Suppliers$/));
    void where;
  });

  it("reads filters from the address and offers a bar of saved filters", async () => {
    routeApi({ "GET /saved-filters": { data: [{ id: "f1", scope: "supplier_register", name: "Approved welders", filters: { status: "approved" }, position: 0, createdAt: "2026-11-01T09:00:00Z", updatedAt: "2026-11-01T09:00:00Z" }], limit: 5 } });
    renderAt("/Suppliers?status=suspended,conditional&type=manufacturer");
    expect(await screen.findByRole("button", { name: /Remove filter Approval: Suspended, Conditional approval/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Remove filter Type: Manufacturer/ })).toBeInTheDocument();
    expect(Object.fromEntries(new URL(lastList().path, "http://x").searchParams)).toMatchObject({ status: "suspended,conditional", type: "manufacturer" });
    expect(await screen.findByRole("tab", { name: "Approved welders" })).toBeInTheDocument();
    expect(calls.some((c) => c.k === "GET /saved-filters" && c.path.includes("scope=supplier_register"))).toBe(true);
  });

  it("adds a supplier without any way to ask for approval, and offers no button without the right", async () => {
    routeApi({ "POST /supplier-quality/suppliers": (_p, o) => ({ ...detail(), id: "s9", code: o.body.code, approvalStatus: "pending_approval" }), "GET /supplier-quality/suppliers/s9": detail({ id: "s9", code: "NEW1" }) });
    renderAt("/Suppliers");
    await userEvent.click(await screen.findByRole("button", { name: "Add supplier" }));
    const dialog = await screen.findByRole("dialog", { name: "Add supplier" });
    expect(within(dialog).queryByLabelText(/approval/i)).toBeNull();
    expect(dialog).toHaveTextContent("Pending Approval");
    await userEvent.type(within(dialog).getByLabelText(/Code/), "new1");
    await userEvent.type(within(dialog).getByLabelText(/Legal name/), "New Supplier Ltd");
    await userEvent.click(within(dialog).getByText("Welding"));
    await userEvent.click(within(dialog).getByRole("button", { name: "Add supplier" }));
    await waitFor(() => expect(calls.find((c) => c.k === "POST /supplier-quality/suppliers")).toBeTruthy());
    const body = calls.find((c) => c.k === "POST /supplier-quality/suppliers").body;
    expect(body).toMatchObject({ code: "new1", name: "New Supplier Ltd", classificationIds: ["k1"] });
    expect(body).not.toHaveProperty("approvalStatus");
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/Suppliers/s9"));
  });

  it("offers no Add button to a reader", async () => {
    permissions = ["supplier_quality.read"];
    routeApi();
    renderAt("/Suppliers");
    await screen.findByRole("region", { name: "Suppliers" });
    expect(screen.queryByRole("button", { name: "Add supplier" })).toBeNull();
  });
});

describe("supplier profile", () => {
  const profile = (over = {}) => routeApi({ "GET /supplier-quality/suppliers/s1": detail(over), "GET /supplier-quality/suppliers/s1/history": { data: [] } });

  it("shows the overview with status, activity, details, contacts and counts, and links the non-conformances", async () => {
    profile();
    renderAt("/Suppliers/s1");
    expect(await screen.findByRole("heading", { name: /ACME · Acme Metals Ltd/ })).toBeInTheDocument();
    expect(screen.getByText("Open non-conformances").closest("a")).toHaveAttribute("href", expect.stringContaining("supplier=s1"));
    expect(screen.getByRole("list", { name: "Contacts" })).toHaveTextContent("Pat Quality");
    expect(screen.getByText("Preferred for welding")).toBeInTheDocument();
    expect(screen.getByText(/1 Steel Way, Sheffield, S1 1AA/)).toBeInTheDocument();
  });

  it("changes the approval status with only the direct moves and a reason; approving goes through the Qualification tab", async () => {
    profile({ approvalStatus: "approved" });
    renderAt("/Suppliers/s1");
    await userEvent.click(await screen.findByRole("button", { name: "Change approval status" }));
    const dialog = await screen.findByRole("dialog", { name: "Change approval status" });
    // From Approved the direct moves are suspend, disqualify and archive; conditional approval is a decision, and approve / re-open are not allowed.
    expect(within(dialog).getByRole("radio", { name: "Suspend" })).toBeChecked();
    expect(within(dialog).getByRole("radio", { name: "Disqualify" })).toBeInTheDocument();
    expect(within(dialog).queryByRole("radio", { name: "Approve conditionally" })).toBeNull();
    expect(within(dialog).queryByRole("radio", { name: "Approve" })).toBeNull();
    expect(within(dialog).queryByRole("radio", { name: "Re-open for qualification" })).toBeNull();
    expect(within(dialog).getByRole("link", { name: "Qualification tab" })).toHaveAttribute("href", "/Suppliers/s1?tab=qualification");
    const submit = within(dialog).getByRole("button", { name: "Suspend" });
    expect(submit).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText(/Reason/), "Late deliveries");
    await userEvent.click(submit);
    await waitFor(() => expect(calls.find((c) => c.k === "POST /supplier-quality/suppliers/s1/status")).toBeTruthy());
    expect(calls.find((c) => c.k === "POST /supplier-quality/suppliers/s1/status").body).toEqual({ status: "suspended", reason: "Late deliveries" });
  });

  it("hides the status and edit buttons from someone without the rights", async () => {
    permissions = ["supplier_quality.read"];
    profile();
    renderAt("/Suppliers/s1");
    await screen.findByRole("heading", { name: /ACME/ });
    expect(screen.queryByRole("button", { name: "Change approval status" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit supplier" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add contact" })).toBeNull();
  });

  it("lists products and services, links a part and ends a link", async () => {
    profile();
    renderAt("/Suppliers/s1?tab=products");
    const list = await screen.findByRole("list", { name: "Products and services" });
    expect(within(list).getByRole("link", { name: /BAR-50/ })).toHaveAttribute("href", "/Parts/p1");
    expect(list).toHaveTextContent("Their number: AC-50");
    await userEvent.click(within(list).getByRole("switch", { name: /BAR-50 is current/ }).closest("label") ?? within(list).getByRole("switch", { name: /BAR-50 is current/ }));
    await waitFor(() => expect(calls.find((c) => c.k === "PATCH /supplier-quality/supplier-products/pr1")).toBeTruthy());
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    const dialog = await screen.findByRole("dialog", { name: "Add product or service" });
    await userEvent.click(within(dialog).getByRole("button", { name: /Part: pick BAR-50/ }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Add" }));
    await waitFor(() => expect(calls.find((c) => c.k === "POST /supplier-quality/suppliers/s1/products")).toBeTruthy());
    expect(calls.find((c) => c.k === "POST /supplier-quality/suppliers/s1/products").body).toMatchObject({ kind: "part", partId: "p1" });
  });

  it("shows the approval history, newest first, with reasons and conditions", async () => {
    routeApi({
      "GET /supplier-quality/suppliers/s1": detail(),
      "GET /supplier-quality/suppliers/s1/history": {
        data: [
          { id: "h2", fromStatus: "approved", toStatus: "conditional", reason: "Late deliveries", conditions: "Inspect every delivery", reviewOn: "2027-01-01", changedAt: "2026-11-05T09:00:00Z", changedBy: { id: "u1", name: "Ada Owner" } },
          { id: "h1", fromStatus: null, toStatus: "approved", reason: null, conditions: null, reviewOn: null, changedAt: "2026-11-01T09:00:00Z", changedBy: null },
        ],
      },
    });
    renderAt("/Suppliers/s1?tab=history");
    const history = await screen.findByRole("list", { name: "Approval history" });
    const items = within(history).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("Late deliveries");
    expect(items[0]).toHaveTextContent("Conditions: Inspect every delivery");
    expect(items[0]).toHaveTextContent("Ada Owner");
    expect(items[1]).toHaveTextContent("Recorded as");
  });

  it("says plainly which sections are not available yet", async () => {
    profile();
    renderAt("/Suppliers/s1?tab=audits");
    expect(await screen.findByText(/not available yet/)).toBeInTheDocument();
  });
});

describe("settings: classifications", () => {
  it("lists them with how many suppliers hold each, switches one off and adds one", async () => {
    routeApi({
      "PATCH /supplier-quality/classifications/k1": () => ({ ...classes[0], active: false }),
      "POST /supplier-quality/classifications": (_p, o) => ({ id: "k3", key: "plating", label: o.body.label, description: null, sequence: 11, active: true, suppliers: 0 }),
    });
    renderAt("/Settings/Supplier-Quality");
    const list = await screen.findByRole("list", { name: "Supplier classifications" });
    expect(within(list).getByText("Welding")).toBeInTheDocument();
    expect(list).toHaveTextContent("1 supplier");
    await userEvent.click(within(list).getByRole("switch", { name: "Welding is in use" }));
    await waitFor(() => expect(calls.find((c) => c.k === "PATCH /supplier-quality/classifications/k1")?.body).toEqual({ active: false }));
    await userEvent.click(screen.getByRole("button", { name: /Add classification/ }));
    const dialog = await screen.findByRole("dialog", { name: "Add a classification" });
    await userEvent.type(within(dialog).getByLabelText(/Name/), "Plating");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls.find((c) => c.k === "POST /supplier-quality/classifications")?.body).toMatchObject({ label: "Plating" }));
  });

  it("is read-only without supplier_quality.configure", async () => {
    permissions = ["supplier_quality.read"];
    routeApi();
    renderAt("/Settings/Supplier-Quality");
    const list = await screen.findByRole("list", { name: "Supplier classifications" });
    expect(screen.queryByRole("button", { name: /Add classification/ })).toBeNull();
    expect(within(list).getByRole("switch", { name: "Welding is in use" })).toBeDisabled();
  });
});
