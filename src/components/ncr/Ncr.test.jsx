import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, within, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { format } from "date-fns";

let permissions;
let orgProduction = {};
const apiFetch = vi.fn();
vi.mock("../../lib/api-client", async (importOriginal) => ({ ...(await importOriginal()), apiFetch: (...a) => apiFetch(...a) }));
vi.mock("../../contexts/OrganisationProvider", () => ({ useOrganisation: () => ({ organisationId: "org-1" }) }));
vi.mock("../../hooks/useQmsApi", () => ({
  usePermissions: () => ({ can: (p) => permissions.includes(p) }),
  useSites: () => ({ data: { data: [{ id: "s1", code: "MAIN", name: "Main site" }] } }),
  useOrganisationDetails: () => ({ data: { settings: { baseCurrency: "GBP", vatRate: 0.2, ...orgProduction } } }),
}));
const upload = vi.fn();
vi.mock("@/api/supabaseApi", () => ({ uploadFileToSupabase: (...a) => upload(...a), generateSignedUrl: vi.fn() }));
vi.mock("../../contexts/ToastProvider", () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock("../../contexts/SearchProvider", () => ({ useGlobalSearch: () => ({ debouncedSearchTerm: "" }) }));

import NcrPage from "./NcrPage";
import LegacyNcrRedirect from "./LegacyNcrRedirect";
import NonConformance from "../NonConformance";
import SettingsDataManagement from "../Settings/SettingsDataManagement";

const ALL = ["ncr.read", "ncr.create", "ncr.update", "ncr.delete", "lookups.manage", "master_data.read"];
const classifications = [
  { id: "fm1", kind: "failure_mode", parentId: null, code: "DIM", name: "Dimensional", description: null, active: true },
  { id: "sf1", kind: "sub_failure_mode", parentId: "fm1", code: null, name: "Oversize", description: null, active: true },
  { id: "fm2", kind: "failure_mode", parentId: null, code: null, name: "Cosmetic", description: null, active: true },
  { id: "cat1", kind: "category", parentId: null, code: "PRODUCT", name: "Product", description: null, active: true },
  { id: "cat2", kind: "category", parentId: null, code: "PROCESS", name: "Process", description: null, active: true },
  { id: "pr1", kind: "process", parentId: null, code: "CNC", name: "Machining", description: null, active: true },
];
const ncr = (over = {}) => ({
  id: "n1", reference: "NCM-26-001", source: "internal", category: { id: "cat1", name: "Product" }, sourceChangeReason: null, stage: "open", severity: "major", title: "Bore oversize", detectedAt: "2026-11-01",
  quantityAffected: 4, totalCost: 292.4, costCurrency: "GBP", part: { id: "p1", partNumber: "BRK-100", name: "Bracket", revision: "A" }, customer: null, supplier: null,
  workOrder: "WO-1", purchaseOrder: null, customerReference: null, failureMode: { id: "fm1", name: "Dimensional" },
  subFailureMode: { id: "sf1", name: "Oversize" }, causalProcess: null, deletedAt: null, createdAt: "2026-11-01T09:00:00Z",
  stageReason: null, description: "0.05 over", requirement: null, actualResult: null, site: null, partRevisionId: "r1", lotNumber: null,
  serialNumber: null, quantityInspected: null, detectionProcess: null, responsibleEmployee: null, owner: null,
  detectedBy: { id: "u1", name: "Ada Owner" }, createdBy: { id: "u1", name: "Ada Owner" }, closedAt: null, closedBy: null,
  deletedBy: null, deleteReason: null, updatedAt: "2026-11-01T09:00:00Z", ...over,
});
const page = (data) => ({ data, nextCursor: null });

const calls = [];
/** The person's saved filters, kept by the fake API between calls (the API enforces five and unique names). */
let savedFilters = [];
const savedItem = (f, i) => ({ id: f.id, scope: "ncr_register", name: f.name, filters: f.filters, position: i, createdAt: "2026-11-01T09:00:00Z", updatedAt: "2026-11-01T09:00:00Z" });
const routeApi = (routes) =>
  apiFetch.mockImplementation(async (path, opts = {}) => {
    const k = `${opts.method ?? "GET"} ${path.split("?")[0]}`;
    calls.push({ k, path, body: opts.body });
    const all = {
      "GET /ncr-classifications": { data: classifications },
      "GET /employees/lookup": { data: [{ id: "e1", name: "Sam Operator", jobTitle: null, active: true }] },
      "GET /parts": page([{ id: "p1", partNumber: "BRK-100", name: "Bracket" }]),
      "GET /parts/p1": { id: "p1", revisions: [{ id: "r1", revision: "A", status: "released" }] },
      "GET /customers": page([{ id: "c1", code: "ACME", name: "Acme Fabrication", displayName: "Acme" }]),
      "GET /suppliers": page([{ id: "sp1", code: "STEEL", name: "Steel Supplies", displayName: null }]),
      "GET /machines": page([
        { id: "m1", code: "LATHE-1", name: "CNC lathe 1", active: true },
        { id: "m2", code: "WELD-1", name: "Port weld", active: true },
      ]),
      "GET /saved-filters": () => ({ data: savedFilters.map(savedItem), limit: 5 }),
      "POST /saved-filters": (_path, o) => {
        if (savedFilters.length >= 5) throw Object.assign(new Error("You can save up to 5 filters here."), { status: 409 });
        const item = { id: `f${savedFilters.length + 10}`, name: o.body.name, filters: o.body.filters };
        savedFilters = [...savedFilters, item];
        return savedItem(item, savedFilters.length - 1);
      },
      ...routes,
    };
    if (!(k in all) && /^PATCH \/saved-filters\/[^/]+$/.test(k)) {
      const id = path.split("/").pop();
      savedFilters = savedFilters.map((f) => (f.id === id ? { ...f, ...opts.body } : f));
      return savedItem(savedFilters.find((f) => f.id === id), 0);
    }
    if (!(k in all) && /^DELETE \/saved-filters\/[^/]+$/.test(k)) {
      savedFilters = savedFilters.filter((f) => f.id !== path.split("/").pop());
      return undefined;
    }
    // Every NCR page also loads its costs, files and history.
    if (!(k in all) && /^GET \/ncrs\/[^/]+\/costs$/.test(k)) return { data: [], totals: { baseCurrency: "GBP", net: 0, gross: 0, count: 0 } };
    if (!(k in all) && /^GET \/ncrs\/[^/]+\/(attachments|history)$/.test(k)) return { data: [] };
    // ... and its containment, dispositions and what is still needed for each stage.
    if (!(k in all) && /^GET \/ncrs\/[^/]+\/containment$/.test(k)) return { actions: [], notNeededReason: null, resolved: false, problems: ["record a containment action, or say why none is needed"] };
    if (!(k in all) && /^GET \/ncrs\/[^/]+\/dispositions$/.test(k)) return { data: [], affected: 5, approvedQuantity: 0, proposedQuantity: 0, remaining: 5, canApprove: true, settled: false, problems: ["approved dispositions cover 0 of the 5 affected"] };
    if (!(k in all) && /^GET \/ncrs\/[^/]+\/affected-lots$/.test(k)) return { data: [], affected: 5, assigned: 0, remaining: 5, suggestedLot: null, problems: [] };
    if (!(k in all) && /^GET \/ncrs\/[^/]+\/gates$/.test(k)) return { contained: [], investigating: [], dispositioned: [], awaitingClosure: [], closed: [] };
    if (!(k in all)) throw new Error(`unexpected ${k}`);
    return typeof all[k] === "function" ? all[k](path, opts) : all[k];
  });

const Where = () => {
  const l = useLocation();
  return <p data-testid="where">{l.pathname + l.search}</p>;
};
const renderAt = (url) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="/Non-Conformance/Register" element={<><NonConformance /><Where /></>} />
          <Route path="/Non-Conformance/Register/:id" element={<><NcrPage /><Where /></>} />
          <Route path="/Non-Conformance/:type" element={<><LegacyNcrRedirect /><Where /></>} />
          <Route path="/Non-Conformance/:type/:id" element={<><LegacyNcrRedirect /><Where /></>} />
          <Route path="/Settings" element={<SettingsDataManagement />} />
        </Routes>
        <div id="modal-root" />
      </MemoryRouter>
    </QueryClientProvider>
  );
const lastCall = (k) => calls.filter((c) => c.k === k).at(-1);
/** Choose an option in one of the form's combo boxes. */
const pick = async (label, option) => {
  await userEvent.click(screen.getByRole("combobox", { name: label }));
  await userEvent.click(await screen.findByRole("option", { name: option }));
};

beforeEach(() => {
  apiFetch.mockReset();
  calls.length = 0;
  permissions = [...ALL];
  orgProduction = {};
  document.body.innerHTML = '<div id="modal-root"></div>';
});

describe("NC registers", () => {
  it("lists every source and category in one register, with Source and Category columns", async () => {
    routeApi({
      "GET /ncrs": {
        data: [
          ncr({ source: "calibration", category: { id: "cat2", name: "Process" } }),
          ncr({ id: "n2", reference: "NCM-26-002", source: "internal_audit", category: null }),
        ],
        page: 1, pageSize: 25, total: 2,
      },
    });
    renderAt("/Non-Conformance/Register");
    expect(await screen.findByText("NCM-26-001")).toBeInTheDocument();
    expect(lastCall("GET /ncrs").path).not.toContain("source=");
    expect(screen.getByRole("columnheader", { name: /Source/ })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /Category/ })).toBeInTheDocument();
    const first = screen.getByText("NCM-26-001").closest("tr");
    expect(within(first).getByText("Calibration")).toBeInTheDocument();
    expect(within(first).getByText("Process")).toBeInTheDocument();
    const second = screen.getByText("NCM-26-002").closest("tr");
    expect(within(second).getByText("Internal audit")).toBeInTheDocument();
    expect(within(second).getByText("Uncategorised")).toBeInTheDocument();
    expect(screen.getByText("2 records")).toBeInTheDocument();
    // Columns that only some sources use start hidden.
    expect(screen.queryByRole("columnheader", { name: /Purchase order/ })).toBeNull();
  });

  describe("saved filters", () => {
    const OPEN_MAJORS = { id: "f1", name: "Open majors", filters: { stage: "open", severity: "major" } };
    const CUSTOMER = { id: "f2", name: "Customer complaints", filters: { source: "customer" } };
    const list = () => routeApi({ "GET /ncrs": { data: [ncr()], page: 1, pageSize: 25, total: 1 } });
    const ready = async (url = "/Non-Conformance/Register") => {
      list();
      renderAt(url);
      await screen.findByText("NCM-26-001");
    };
    const filterOf = () => decodeURIComponent(lastCall("GET /ncrs").path);

    beforeEach(() => {
      savedFilters = [];
    });

    it("replace the old Customer / Internal / Supplier tabs: with none saved there is only All", async () => {
      await ready();
      const bar = screen.getByRole("tablist", { name: "Saved filters" });
      expect(within(bar).getAllByRole("tab").map((t) => t.textContent)).toEqual(["All"]);
      expect(within(bar).getByRole("tab", { name: "All" })).toHaveAttribute("aria-selected", "true");
      expect(screen.queryByRole("button", { name: "Save filter" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Manage saved filters" })).toBeNull();
    });

    it("show the person's own filters after All, and one click applies it to the URL and the list", async () => {
      savedFilters = [OPEN_MAJORS, CUSTOMER];
      await ready();
      expect(within(screen.getByRole("tablist", { name: "Saved filters" })).getAllByRole("tab").map((t) => t.textContent)).toEqual(["All", "Open majors", "Customer complaints"]);
      await userEvent.click(screen.getByRole("tab", { name: "Open majors" }));
      await waitFor(() => expect(filterOf()).toContain("stage=open"));
      expect(filterOf()).toContain("severity=major");
      expect(screen.getByRole("tab", { name: "Open majors" })).toHaveAttribute("aria-selected", "true");
      expect(screen.getByRole("tab", { name: "All" })).toHaveAttribute("aria-selected", "false");
      // Choosing another replaces what the first had chosen.
      await userEvent.click(screen.getByRole("tab", { name: "Customer complaints" }));
      await waitFor(() => expect(filterOf()).toContain("source=customer"));
      expect(filterOf()).not.toContain("stage=");
      expect(filterOf()).not.toContain("severity=");
      await userEvent.click(screen.getByRole("tab", { name: "All" }));
      await waitFor(() => expect(lastCall("GET /ncrs").path).not.toContain("source="));
      expect(screen.getByTestId("where")).toHaveTextContent(/^\/Non-Conformance\/Register$/);
    });

    it("highlight the saved filter the page is showing, whatever the order of a list in it", async () => {
      savedFilters = [{ id: "f3", name: "Closed or cancelled", filters: { stage: "closed,cancelled" } }];
      await ready("/Non-Conformance/Register?stage=cancelled%2Cclosed");
      expect(screen.getByRole("tab", { name: "Closed or cancelled" })).toHaveAttribute("aria-selected", "true");
      expect(screen.queryByRole("button", { name: "Save filter" })).toBeNull();
    });

    it("highlight nothing for filters that are not saved, and offer to save them", async () => {
      savedFilters = [OPEN_MAJORS];
      await ready("/Non-Conformance/Register?source=calibration,engineering");
      for (const name of ["All", "Open majors"]) expect(screen.getByRole("tab", { name })).toHaveAttribute("aria-selected", "false");
      expect(screen.getByLabelText("Active filters")).toHaveTextContent("Source: Calibration, Engineering");
      expect(screen.getByRole("button", { name: "Save filter" })).toBeInTheDocument();
      await userEvent.click(within(screen.getByLabelText("Active filters")).getByRole("button", { name: /Remove filter Source/ }));
      await waitFor(() => expect(lastCall("GET /ncrs").path).not.toContain("source="));
    });

    it("are saved from the filters chosen, under a name, and appear at once", async () => {
      await ready("/Non-Conformance/Register?stage=open&severity=major&partLabel=BRK-100&part=p1");
      await userEvent.click(screen.getByRole("button", { name: "Save filter" }));
      const dialog = await screen.findByRole("dialog", { name: "Save filter" });
      expect(dialog).toHaveTextContent("Saves:");
      expect(dialog).toHaveTextContent("Stage: Open");
      const save = within(dialog).getByRole("button", { name: "Save" });
      expect(save).toBeDisabled(); // a name is needed
      await userEvent.type(within(dialog).getByLabelText(/Name/), "  Open majors  ");
      await userEvent.click(save);
      await waitFor(() => expect(lastCall("POST /saved-filters")).toBeTruthy());
      expect(lastCall("POST /saved-filters").body).toEqual({ scope: "ncr_register", name: "Open majors", filters: { stage: "open", severity: "major", part: "p1", partLabel: "BRK-100" } });
      // It is the page's own filters, so it is the highlighted one and there is nothing left to save.
      expect(await screen.findByRole("tab", { name: "Open majors" })).toHaveAttribute("aria-selected", "true");
      expect(screen.queryByRole("button", { name: "Save filter" })).toBeNull();
    });

    it("replace a filter of the same name, whatever its case, instead of adding another", async () => {
      savedFilters = [OPEN_MAJORS];
      await ready("/Non-Conformance/Register?stage=closed");
      await userEvent.click(screen.getByRole("button", { name: "Save filter" }));
      const dialog = await screen.findByRole("dialog", { name: "Save filter" });
      await userEvent.type(within(dialog).getByLabelText(/Name/), "open MAJORS");
      expect(dialog).toHaveTextContent("Saving replaces it");
      await userEvent.click(within(dialog).getByRole("button", { name: "Replace" }));
      await waitFor(() => expect(lastCall("PATCH /saved-filters/f1")).toBeTruthy());
      expect(lastCall("PATCH /saved-filters/f1").body).toEqual({ filters: { stage: "closed" } });
      expect(calls.filter((c) => c.k === "POST /saved-filters")).toHaveLength(0);
    });

    it("stop at five: the dialog says so and will not save a new name, but a name in use can still be replaced", async () => {
      savedFilters = ["One", "Two", "Three", "Four", "Five"].map((name, i) => ({ id: `f${i + 1}`, name, filters: { stage: "closed", severity: ["minor", "major", "critical"][i % 3], from: `2026-0${i + 1}-01` } }));
      await ready("/Non-Conformance/Register?stage=draft");
      await userEvent.click(screen.getByRole("button", { name: "Save filter" }));
      const dialog = await screen.findByRole("dialog", { name: "Save filter" });
      await userEvent.type(within(dialog).getByLabelText(/Name/), "Six");
      expect(dialog).toHaveTextContent("You have 5 saved filters");
      expect(within(dialog).getByRole("button", { name: "Save" })).toBeDisabled();
      await userEvent.clear(within(dialog).getByLabelText(/Name/));
      await userEvent.type(within(dialog).getByLabelText(/Name/), "Three");
      expect(within(dialog).getByRole("button", { name: "Replace" })).toBeEnabled();
    });

    it("show a refusal from the server and put the list back", async () => {
      savedFilters = [];
      await ready("/Non-Conformance/Register?stage=open");
      routeApi({
        "GET /ncrs": { data: [ncr()], page: 1, pageSize: 25, total: 1 },
        "POST /saved-filters": () => {
          throw Object.assign(new Error("You can save up to 5 filters here. Delete one to save another."), { status: 409 });
        },
      });
      await userEvent.click(screen.getByRole("button", { name: "Save filter" }));
      const dialog = await screen.findByRole("dialog", { name: "Save filter" });
      await userEvent.type(within(dialog).getByLabelText(/Name/), "Mine");
      await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
      await waitFor(() => expect(lastCall("POST /saved-filters")).toBeTruthy());
      await waitFor(() => expect(screen.queryByRole("tab", { name: "Mine" })).toBeNull());
    });

    it("are listed with what they contain, then renamed and deleted from a row menu", async () => {
      savedFilters = [OPEN_MAJORS, CUSTOMER];
      await ready();
      await userEvent.click(screen.getByRole("button", { name: "Manage saved filters" }));
      const list = await screen.findByRole("dialog", { name: "Saved filters" });
      expect(within(list).getByText("Open majors")).toBeInTheDocument();
      expect(within(list).getByText("Customer complaints")).toBeInTheDocument();
      await userEvent.click(within(list).getByRole("button", { name: "Actions for Open majors" }));
      await userEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
      const dialog = await screen.findByRole("dialog", { name: "Rename filter" });
      const name = within(dialog).getByLabelText(/Name/);
      expect(name).toHaveValue("Open majors");
      await userEvent.clear(name);
      await userEvent.type(name, "Customer complaints");
      expect(dialog).toHaveTextContent("You already have a filter called");
      expect(within(dialog).getByRole("button", { name: "Rename" })).toBeDisabled();
      await userEvent.clear(name);
      await userEvent.type(name, "Majors to chase");
      await userEvent.click(within(dialog).getByRole("button", { name: "Rename" }));
      await waitFor(() => expect(lastCall("PATCH /saved-filters/f1")).toBeTruthy());
      expect(lastCall("PATCH /saved-filters/f1").body).toEqual({ name: "Majors to chase" });
      expect(await screen.findByRole("tab", { name: "Majors to chase" })).toBeInTheDocument();
      expect(screen.queryByRole("tab", { name: "Open majors" })).toBeNull();

      const again = await screen.findByRole("dialog", { name: "Saved filters" });
      await userEvent.click(within(again).getByRole("button", { name: "Actions for Customer complaints" }));
      await userEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
      await waitFor(() => expect(lastCall("DELETE /saved-filters/f2")).toBeTruthy());
      await waitFor(() => expect(screen.queryByRole("tab", { name: "Customer complaints" })).toBeNull());
    });

    it("carry a search saved in the filter back to the page", async () => {
      savedFilters = [{ id: "f4", name: "Bores", filters: { search: "bore" } }];
      await ready();
      await userEvent.click(screen.getByRole("tab", { name: "Bores" }));
      await waitFor(() => expect(filterOf()).toContain("q=bore"));
      expect(screen.getByTestId("where")).toHaveTextContent("search=bore");
    });
  });

  it.each([
    ["/Non-Conformance/Internal", "/Non-Conformance/Register?source=internal"],
    ["/Non-Conformance/Customer", "/Non-Conformance/Register?source=customer"],
    ["/Non-Conformance/Supplier", "/Non-Conformance/Register?source=supplier%2Cgoods_receiving"],
    ["/Non-Conformance/Customer?stage=closed", "/Non-Conformance/Register?stage=closed&source=customer"],
    ["/Non-Conformance/Supplier/n1", "/Non-Conformance/Register/n1"],
    ["/Non-Conformance/Internal/new", "/Non-Conformance/Register/new?source=internal"],
  ])("sends the old address %s to %s", async (from, to) => {
    routeApi({ "GET /ncrs": { data: [], page: 1, pageSize: 25, total: 0 }, "GET /ncrs/n1": ncr() });
    renderAt(from);
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(to));
  });

  it("asks where it came from before a new non-conformance, defaulting to the source filter", async () => {
    routeApi({ "GET /ncrs": { data: [], page: 1, pageSize: 25, total: 0 } });
    renderAt("/Non-Conformance/Register?source=customer");
    await screen.findByText("No records found.");
    await userEvent.click(screen.getByRole("button", { name: /New NC/ }));
    const dialog = await screen.findByRole("dialog", { name: "Where did this non-conformance come from?" });
    expect(within(dialog).getByRole("radio", { name: /^Customer/ })).toBeChecked();
    expect(within(dialog).getAllByRole("radio")).toHaveLength(11);
    await userEvent.click(within(dialog).getByRole("radio", { name: /^Calibration/ }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/Non-Conformance/Register/new?source=calibration"));
  });

  it("shows the quantity and the total cost of the selected rows", async () => {
    routeApi({ "GET /ncrs": { data: [ncr(), ncr({ id: "n2", reference: "NCM-26-002", quantityAffected: 6, totalCost: 100.5 }), ncr({ id: "n3", reference: "NCM-26-003", quantityAffected: 9, totalCost: 7 })], page: 1, pageSize: 25, total: 3 } });
    renderAt("/Non-Conformance/Register");
    await screen.findByText("NCM-26-001");
    expect(screen.getByText("3 records")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("checkbox", { name: "Select NCM-26-001" }));
    expect(screen.getByText("1 selected · Qty 4 · Cost £292.40")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("checkbox", { name: "Select NCM-26-002" }));
    expect(screen.getByText("2 selected · Qty 10 · Cost £392.90")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("checkbox", { name: "Select NCM-26-001" }));
    expect(screen.getByText("1 selected · Qty 6 · Cost £100.50")).toBeInTheDocument();
  });

  it("sorts on the server when a header is clicked", async () => {
    routeApi({ "GET /ncrs": { data: [ncr()], page: 1, pageSize: 25, total: 1 } });
    renderAt("/Non-Conformance/Register");
    await screen.findByText("NCM-26-001");
    await userEvent.click(within(screen.getByRole("columnheader", { name: /Detected/ })).getByRole("button"));
    await waitFor(() => expect(lastCall("GET /ncrs").path).toContain("sort=detectedAt"));
    expect(lastCall("GET /ncrs").path).toContain("order=asc");
  });

  it("shows each NC's total cost and sorts by it", async () => {
    routeApi({ "GET /ncrs": { data: [ncr(), ncr({ id: "n2", reference: "NCM-26-002", title: "No costs", totalCost: 0 })], page: 1, pageSize: 25, total: 2 } });
    renderAt("/Non-Conformance/Register");
    await screen.findByText("NCM-26-001");
    const header = screen.getByRole("columnheader", { name: /Total cost/ });
    expect(screen.getByText("£292.40")).toBeInTheDocument();
    await userEvent.click(within(header).getByRole("button"));
    await waitFor(() => expect(lastCall("GET /ncrs").path).toContain("sort=totalCost"));
  });

  it("opens a record on double-click and offers New NC with ncr.create", async () => {
    routeApi({ "GET /ncrs": { data: [ncr()], page: 1, pageSize: 25, total: 1 }, "GET /ncrs/n1": ncr() });
    renderAt("/Non-Conformance/Register");
    await userEvent.dblClick(await screen.findByText("Bore oversize"));
    expect(screen.getByTestId("where")).toHaveTextContent("/Non-Conformance/Register/n1");
  });

  it("hides New NC without ncr.create", async () => {
    permissions = ["ncr.read"];
    routeApi({ "GET /ncrs": { data: [], page: 1, pageSize: 25, total: 0 } });
    renderAt("/Non-Conformance/Register");
    expect(await screen.findByText("No records found.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /New NC/ })).toBeNull();
  });

  it("filters by stage and shows deleted records on request", async () => {
    routeApi({ "GET /ncrs": { data: [], page: 1, pageSize: 25, total: 0 } });
    renderAt("/Non-Conformance/Register");
    await screen.findByText("No records found.");
    await userEvent.click(screen.getByRole("button", { name: /Filter/ }));
    const pane = screen.getByRole("dialog", { name: "Filter non-conformances" });
    await userEvent.click(within(pane).getByText("Investigating"));
    await userEvent.click(within(pane).getByRole("combobox", { name: "Deleted records" }));
    await userEvent.click(screen.getByRole("option", { name: "Only deleted" }));
    await userEvent.click(within(pane).getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(lastCall("GET /ncrs").path).toContain("stage=investigating"));
    expect(lastCall("GET /ncrs").path).toContain("deleted=only");
  });

  it("filters by failure mode and sub-failure mode, shows what is applied and removes filters one by one", async () => {
    routeApi({ "GET /ncrs": { data: [], page: 1, pageSize: 25, total: 0 } });
    renderAt("/Non-Conformance/Register?page=3");
    await screen.findByText("No records found.");
    await userEvent.click(screen.getByRole("button", { name: /Filter/ }));
    const pane = screen.getByRole("dialog", { name: "Filter non-conformances" });
    // Before a failure mode is chosen, each sub-failure mode shows its failure mode.
    await userEvent.click(within(pane).getByRole("combobox", { name: "Sub-failure mode" }));
    expect(screen.getByRole("option", { name: /Oversize/ })).toHaveTextContent("Dimensional");
    await userEvent.keyboard("{Escape}");
    await userEvent.click(within(pane).getByRole("combobox", { name: "Failure mode" }));
    await userEvent.click(screen.getByRole("option", { name: "DIM – Dimensional" }));
    await userEvent.click(within(pane).getByRole("combobox", { name: "Sub-failure mode" }));
    await userEvent.click(screen.getByRole("option", { name: "Oversize" }));
    await userEvent.click(within(pane).getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(lastCall("GET /ncrs").path).toContain("failureModeId=fm1&subFailureModeId=sf1"));
    expect(lastCall("GET /ncrs").path).toContain("page=1");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Filter non-conformances" })).toBeNull());

    const active = screen.getByLabelText("Active filters");
    expect(active).toHaveTextContent("Failure mode: Dimensional");
    expect(active).toHaveTextContent("Sub-failure mode: Oversize");
    await userEvent.click(within(active).getByRole("button", { name: "Remove filter Sub-failure mode: Oversize" }));
    await waitFor(() => expect(lastCall("GET /ncrs").path).not.toContain("subFailureModeId"));
    expect(lastCall("GET /ncrs").path).toContain("failureModeId=fm1");
    await userEvent.click(within(screen.getByLabelText("Active filters")).getByRole("button", { name: "Clear all" }));
    await waitFor(() => expect(lastCall("GET /ncrs").path).not.toContain("failureModeId"));
    expect(screen.queryByLabelText("Active filters")).toBeNull();
  });

  it("filters by date, severity, part, customer, total cost and quantity", async () => {
    routeApi({
      "GET /ncrs": { data: [], page: 1, pageSize: 25, total: 0 },
      "GET /ncrs/ranges": { cost: { max: 873 }, quantity: { max: 48 }, baseCurrency: "GBP" },
    });
    renderAt("/Non-Conformance/Register");
    await screen.findByText("No records found.");
    await userEvent.click(screen.getByRole("button", { name: /Filter/ }));
    const pane = screen.getByRole("dialog", { name: "Filter non-conformances" });

    await userEvent.click(within(pane).getByText("Critical"));
    await userEvent.click(within(pane).getByText("Major"));
    await userEvent.click(within(pane).getByRole("combobox", { name: "Part number" }));
    await userEvent.click(await screen.findByRole("option", { name: "BRK-100 · Bracket" }));
    await userEvent.click(within(pane).getByRole("combobox", { name: "Customer" }));
    await userEvent.click(await screen.findByRole("option", { name: /^Acme/ }));

    // Sliders run from 0 to the register's highest value, rounded up (£873 → £900, 48 → 50).
    const costMin = within(pane).getByRole("slider", { name: "Total cost minimum" });
    const costMax = within(pane).getByRole("slider", { name: "Total cost maximum" });
    expect(costMax).toHaveAttribute("max", "900");
    fireEvent.change(costMin, { target: { value: "100" } });
    fireEvent.change(costMax, { target: { value: "500" } });
    fireEvent.change(within(pane).getByRole("slider", { name: "Quantity affected minimum" }), { target: { value: "5" } });
    expect(within(pane).getByText("£100 – £500")).toBeInTheDocument();

    // Detected from: the 1st of this month.
    const first = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    await userEvent.click(within(pane).getByRole("button", { name: /^Detected from/ }));
    await userEvent.click(within(screen.getByRole("dialog", { name: "Choose detected from" })).getByRole("button", { name: format(first, "EEEE d MMMM yyyy") }));
    expect(screen.getByRole("dialog", { name: "Filter non-conformances" })).toBeInTheDocument();

    await userEvent.click(within(pane).getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(lastCall("GET /ncrs").path).toContain("severity=critical%2Cmajor"));
    const path = lastCall("GET /ncrs").path;
    for (const part of ["partId=p1", "customerId=c1", "costMin=100", "costMax=500", "qtyMin=5", `from=${format(first, "yyyy-MM-dd")}`]) expect(path).toContain(part);
    expect(path).not.toContain("qtyMax");
    const active = screen.getByLabelText("Active filters");
    for (const text of ["Severity: Critical, Major", "Part: BRK-100 · Bracket", "Customer: Acme", "Total cost £100 – £500", "Quantity from 5"]) expect(active).toHaveTextContent(text);
    await userEvent.click(within(active).getByRole("button", { name: "Remove filter Total cost £100 – £500" }));
    await waitFor(() => expect(lastCall("GET /ncrs").path).not.toContain("costMin"));
  });

  it("filters by production order and lot, kept in the URL with chips, and offers no lot choice when lots are switched off", async () => {
    const routes = {
      "GET /ncrs": { data: [], page: 1, pageSize: 25, total: 0 },
      "GET /ncrs/ranges": { cost: { max: 0 }, quantity: { max: 0 }, baseCurrency: "GBP" },
      "GET /production-orders/lookup": { data: [{ id: "o1", orderNumber: "WO-154789", part: { id: "p1", partNumber: "BRK-100", name: "Bracket" }, status: "released", quantityPlanned: 24 }] },
      "GET /lots/lookup": { data: [{ id: "l1", lotNumber: "LOT-7", part: { id: "p1", partNumber: "BRK-100", name: "Bracket" }, origin: "produced", productionOrder: { id: "o1", orderNumber: "WO-154789" }, status: "released", statusReason: null }] },
    };
    orgProduction = {};
    routeApi(routes);
    const first = renderAt("/Non-Conformance/Register");
    await screen.findByText("No records found.");
    await userEvent.click(screen.getByRole("button", { name: /Filter/ }));
    const pane = screen.getByRole("dialog", { name: "Filter non-conformances" });
    await userEvent.click(within(pane).getByRole("combobox", { name: "Production order" }));
    await userEvent.click(await screen.findByRole("option", { name: /WO-154789/ }));
    await userEvent.click(within(pane).getByRole("combobox", { name: "Lot" }));
    await userEvent.click(await screen.findByRole("option", { name: /LOT-7/ }));
    await userEvent.click(within(pane).getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(lastCall("GET /ncrs").path).toContain("productionOrderId=o1"));
    expect(lastCall("GET /ncrs").path).toContain("lotId=l1");
    const active = screen.getByLabelText("Active filters");
    expect(active).toHaveTextContent("Order: WO-154789");
    expect(active).toHaveTextContent("Lot: LOT-7");
    await userEvent.click(within(active).getByRole("button", { name: "Remove filter Lot: LOT-7" }));
    await waitFor(() => expect(lastCall("GET /ncrs").path).not.toContain("lotId"));
    expect(lastCall("GET /ncrs").path).toContain("productionOrderId=o1");
    first.unmount();

    orgProduction = { useLotsAndSerials: false };
    routeApi(routes);
    renderAt("/Non-Conformance/Register");
    await screen.findByText("No records found.");
    await userEvent.click(screen.getByRole("button", { name: /Filter/ }));
    const off = screen.getByRole("dialog", { name: "Filter non-conformances" });
    expect(within(off).getByRole("combobox", { name: "Production order" })).toBeInTheDocument();
    expect(within(off).queryByRole("combobox", { name: "Lot" })).toBeNull();
  });

  it("offers source, category, customer and supplier filters, and filters by them", async () => {
    routeApi({ "GET /ncrs": { data: [], page: 1, pageSize: 25, total: 0 }, "GET /ncrs/ranges": { cost: { max: 0 }, quantity: { max: 0 }, baseCurrency: "GBP" } });
    renderAt("/Non-Conformance/Register");
    await screen.findByText("No records found.");
    await userEvent.click(screen.getByRole("button", { name: /Filter/ }));
    const pane = screen.getByRole("dialog", { name: "Filter non-conformances" });
    expect(within(pane).getByRole("combobox", { name: "Supplier" })).toBeInTheDocument();
    expect(within(pane).getByRole("combobox", { name: "Customer" })).toBeInTheDocument();
    expect(within(pane).getByText("No costs recorded in this register yet.")).toBeInTheDocument();
    expect(within(pane).getByRole("slider", { name: "Total cost minimum" })).toBeDisabled();
    const sources = within(pane).getByRole("group", { name: "Source" });
    expect(within(sources).getAllByRole("checkbox")).toHaveLength(11);
    await userEvent.click(within(sources).getByText("Calibration"));
    await userEvent.click(within(sources).getByText("Engineering"));
    await userEvent.click(within(pane).getByRole("combobox", { name: "Category" }));
    const names = within(screen.getByRole("listbox")).getAllByRole("option").map((o) => o.textContent);
    expect(names.some((n) => n.startsWith("Uncategorised"))).toBe(true);
    expect(names).toEqual(expect.arrayContaining(["Product", "Process"]));
    await userEvent.click(screen.getByRole("option", { name: "Process" }));
    await userEvent.click(within(pane).getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(decodeURIComponent(lastCall("GET /ncrs").path)).toMatch(/source=calibration,engineering.*categoryId=cat2|categoryId=cat2.*source=calibration,engineering/));
    const chips = await screen.findByLabelText("Active filters");
    expect(chips).toHaveTextContent("Source: Calibration, Engineering");
    expect(chips).toHaveTextContent("Category: Process");
  });

  it("filters to the non-conformances with no category", async () => {
    routeApi({ "GET /ncrs": { data: [], page: 1, pageSize: 25, total: 0 }, "GET /ncrs/ranges": { cost: { max: 0 }, quantity: { max: 0 }, baseCurrency: "GBP" } });
    renderAt("/Non-Conformance/Register");
    await screen.findByText("No records found.");
    await userEvent.click(screen.getByRole("button", { name: /Filter/ }));
    const pane = screen.getByRole("dialog", { name: "Filter non-conformances" });
    await userEvent.click(within(pane).getByRole("combobox", { name: "Category" }));
    await userEvent.click(screen.getByRole("option", { name: /^Uncategorised/ }));
    await userEvent.click(within(pane).getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(lastCall("GET /ncrs").path).toContain("uncategorised=true"));
    expect(lastCall("GET /ncrs").path).not.toContain("categoryId=");
    expect(await screen.findByLabelText("Active filters")).toHaveTextContent("Uncategorised");
  });

  it("opens the filters as a full-height drawer that closes from its backdrop", async () => {
    routeApi({ "GET /ncrs": { data: [], page: 1, pageSize: 25, total: 0 } });
    renderAt("/Non-Conformance/Register");
    await screen.findByText("No records found.");
    await userEvent.click(screen.getByRole("button", { name: /Filter/ }));
    const drawer = screen.getByRole("dialog", { name: "Filter non-conformances" });
    expect(drawer.tagName).toBe("ASIDE");
    expect(drawer).toHaveClass("inset-y-0", "right-0", "h-dvh");
    expect(drawer.parentElement.parentElement).toBe(document.body);
    await userEvent.click(within(drawer).getByText("Closed"));
    fireEvent.mouseDown(drawer.previousElementSibling);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Filter non-conformances" })).toBeNull());
    expect(lastCall("GET /ncrs").path).not.toContain("stage=");
  });

  it("closes the filter pane on Escape without applying", async () => {
    routeApi({ "GET /ncrs": { data: [], page: 1, pageSize: 25, total: 0 } });
    renderAt("/Non-Conformance/Register");
    await screen.findByText("No records found.");
    await userEvent.click(screen.getByRole("button", { name: /Filter/ }));
    await userEvent.click(within(screen.getByRole("dialog", { name: "Filter non-conformances" })).getByText("Closed"));
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Filter non-conformances" })).toBeNull());
    expect(lastCall("GET /ncrs").path).not.toContain("stage=");
  });
});

describe("NC form", () => {
  it("raises an internal NC with only the internal fields", async () => {
    routeApi({ "POST /ncrs": (_p, o) => ncr({ ...o.body, id: "n9", reference: "NCM-26-002" }), "GET /ncrs/n9": ncr({ id: "n9", reference: "NCM-26-002" }) });
    renderAt("/Non-Conformance/Register/new");
    expect(await screen.findByRole("heading", { name: "New non-conformance" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: /^Source/ })).toHaveValue("Internal");
    expect(screen.queryByLabelText(/Customer$/)).toBeNull();
    await userEvent.type(screen.getByLabelText("Title"), "Bore oversize");
    await pick(/^Severity/, "Major");
    await pick(/^Category/, "Process");
    await userEvent.type(screen.getByLabelText("Quantity affected"), "4");
    await userEvent.type(screen.getByLabelText("Work order"), "WO-7");
    expect(screen.getByRole("combobox", { name: "Sub-failure mode" })).toBeDisabled();
    await pick("Failure mode", "DIM – Dimensional");
    await pick("Sub-failure mode", "Oversize");
    const today = new Date();
    const first = new Date(today.getFullYear(), today.getMonth(), 1);
    await userEvent.click(screen.getByRole("button", { name: /^Detected on/ }));
    await userEvent.click(within(screen.getByRole("dialog", { name: "Choose detected on" })).getByRole("button", { name: format(first, "EEEE d MMMM yyyy") }));
    await userEvent.click(screen.getByRole("button", { name: "Raise NC" }));
    const body = lastCall("POST /ncrs").body;
    const iso = format(first, "yyyy-MM-dd");
    expect(body).toMatchObject({ source: "internal", open: true, title: "Bore oversize", severity: "major", categoryId: "cat2", quantityAffected: 4, workOrder: "WO-7", failureModeId: "fm1", subFailureModeId: "sf1", detectedAt: iso });
    expect(body).not.toHaveProperty("customerId");
    expect(body).not.toHaveProperty("supplierId");
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/Non-Conformance/Register/n9"));
  });

  it("asks for the customer on customer NCs, the supplier on supplier NCs and only offers the supplier on goods receiving", async () => {
    routeApi({ "POST /ncrs": (_p, o) => ncr({ ...o.body, id: "n8" }), "GET /ncrs/n8": ncr({ id: "n8", source: "customer" }) });
    renderAt("/Non-Conformance/Register/new?source=customer");
    await userEvent.type(await screen.findByLabelText("Title"), "Complaint");
    await pick(/^Customer/, /^Acme/);
    await userEvent.type(screen.getByLabelText("Customer reference"), "CLM-9");
    await userEvent.click(screen.getByRole("button", { name: "Save as draft" }));
    expect(lastCall("POST /ncrs").body).toMatchObject({ source: "customer", customerId: "c1", customerReference: "CLM-9" });
    expect(lastCall("POST /ncrs").body).not.toHaveProperty("open");
  });

  it("changes the fields with the source chosen on a new form, and keeps the choice out of the way of the rest", async () => {
    routeApi({ "POST /ncrs": (_p, o) => ncr({ ...o.body, id: "n8" }), "GET /ncrs/n8": ncr({ id: "n8" }) });
    renderAt("/Non-Conformance/Register/new?source=supplier");
    await userEvent.type(await screen.findByLabelText("Title"), "Wrong alloy");
    expect(screen.getByRole("combobox", { name: /^Source/ })).toHaveValue("Supplier");
    expect(screen.getByRole("combobox", { name: /^Supplier/ })).toBeInTheDocument();
    expect(screen.getByLabelText("Purchase order")).toBeInTheDocument();
    expect(screen.queryByLabelText("Work order")).toBeNull();
    await pick(/^Supplier/, /Steel Supplies/);
    await userEvent.type(screen.getByLabelText("Purchase order"), "PO-5");
    // Goods receiving may name the supplier but does not have to, and has no work order either.
    await pick(/^Source/, /^Goods receiving/);
    expect(screen.getByRole("combobox", { name: "Supplier" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Work order")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Save as draft" }));
    expect(lastCall("POST /ncrs").body).toMatchObject({ source: "goods_receiving", supplierId: "sp1", purchaseOrder: "PO-5", title: "Wrong alloy" });
  });

  it("needs a category to raise one, and says so", async () => {
    const { ApiClientError } = await import("../../lib/api-client");
    routeApi({ "POST /ncrs": () => Promise.reject(new ApiClientError({ status: 409, code: "ncr_rule", message: "To open this non-conformance, fill in: category" })) });
    renderAt("/Non-Conformance/Register/new");
    await userEvent.type(await screen.findByLabelText("Title"), "No category yet");
    expect(screen.getByRole("combobox", { name: /^Category/ })).toBeInTheDocument();
    expect(screen.getByText("What the problem is. Needed to open")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Raise NC" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("fill in: category");
    expect(lastCall("POST /ncrs").body).not.toHaveProperty("categoryId", "cat1");
  });

  it("shows the source and category of a non-conformance; the category can be changed but not cleared once open", async () => {
    routeApi({ "GET /ncrs/n1": ncr(), "PATCH /ncrs/n1": (_p, o) => ncr({ category: { id: o.body.categoryId, name: "Process" } }) });
    renderAt("/Non-Conformance/Register/n1");
    await screen.findByLabelText("Title");
    expect(screen.getByText("Internal", { selector: "span" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: /^Category/ })).toHaveValue("Product");
    expect(screen.queryByRole("button", { name: "Clear Category" })).toBeNull();
    await pick(/^Category/, "Process");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(lastCall("PATCH /ncrs/n1").body).toEqual({ categoryId: "cat2" });
  });

  it("picks where it was detected and the causal process from the machines, and shows the saved machine's name", async () => {
    routeApi({ "GET /ncrs/n1": ncr({ detectionProcess: { id: "m2", name: "Port weld" }, causalProcess: { id: "m1", name: "CNC lathe 1" } }), "PATCH /ncrs/n1": () => ncr() });
    renderAt("/Non-Conformance/Register/n1");
    await screen.findByLabelText("Title");
    expect(screen.getByRole("combobox", { name: "Where detected" })).toHaveValue("Port weld");
    expect(screen.getByRole("combobox", { name: "Causal process" })).toHaveValue("CNC lathe 1");
    await userEvent.click(screen.getByRole("combobox", { name: "Causal process" }));
    const options = within(await screen.findByRole("listbox")).getAllByRole("option").map((o) => o.textContent);
    expect(options.join(" ")).toContain("CNC lathe 1");
    expect(options.join(" ")).toContain("Port weld");
    expect(options.join(" ")).toContain("WELD-1");
    await userEvent.click(within(screen.getByRole("listbox")).getByRole("option", { name: /Port weld/ }));
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(lastCall("PATCH /ncrs/n1").body).toEqual({ causalProcessId: "m2" });
    expect(calls.some((c) => c.k === "GET /machines")).toBe(true);
  });

  it("offers a draft without a category the choice to pick one", async () => {
    routeApi({ "GET /ncrs/n1": ncr({ stage: "draft", category: null }) });
    renderAt("/Non-Conformance/Register/n1");
    await screen.findByLabelText("Title");
    expect(screen.getByRole("combobox", { name: /^Category/ })).toHaveAttribute("placeholder", "Select a category");
  });

  it("shows a legacy open non-conformance with no category as Uncategorised", async () => {
    routeApi({ "GET /ncrs/n1": ncr({ category: null }) });
    renderAt("/Non-Conformance/Register/n1");
    await screen.findByLabelText("Title");
    expect(screen.getByRole("combobox", { name: /^Category/ })).toHaveAttribute("placeholder", "Uncategorised");
  });

  it("changes the source with a reason, and keeps what was entered", async () => {
    routeApi({ "GET /ncrs/n1": ncr(), "POST /ncrs/n1/source": (_p, o) => ncr({ source: o.body.source, sourceChangeReason: o.body.reason }) });
    renderAt("/Non-Conformance/Register/n1");
    await screen.findByLabelText("Title");
    await userEvent.click(screen.getByRole("button", { name: "Change source" }));
    const dialog = await screen.findByRole("dialog", { name: "Change the source of NCM-26-001" });
    expect(within(dialog).getByText(/What was already entered/)).toBeInTheDocument();
    const confirm = within(dialog).getByRole("button", { name: "Change source" });
    expect(confirm).toBeDisabled();
    await userEvent.click(within(dialog).getByRole("combobox", { name: /^New source/ }));
    // The current source is not offered.
    const offered = within(screen.getByRole("listbox")).getAllByRole("option").map((o) => o.textContent);
    expect(offered).toHaveLength(10);
    expect(offered.some((n) => n.startsWith("Internal") && !n.startsWith("Internal audit"))).toBe(false);
    await userEvent.click(screen.getByRole("option", { name: /^Calibration/ }));
    expect(confirm).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText(/^Why is the source changing/), "The bore gauge failed its calibration");
    await userEvent.click(confirm);
    expect(lastCall("POST /ncrs/n1/source").body).toEqual({ source: "calibration", reason: "The bore gauge failed its calibration" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /Change the source/ })).toBeNull());
  });

  it("shows why a source cannot be taken, and stays open", async () => {
    const { ApiClientError } = await import("../../lib/api-client");
    routeApi({
      "GET /ncrs/n1": ncr(),
      "POST /ncrs/n1/source": () => Promise.reject(new ApiClientError({ status: 409, code: "ncr_rule", message: "Choose the customer first: a customer non-conformance names its customer" })),
    });
    renderAt("/Non-Conformance/Register/n1");
    await screen.findByLabelText("Title");
    await userEvent.click(screen.getByRole("button", { name: "Change source" }));
    const dialog = await screen.findByRole("dialog", { name: /Change the source/ });
    await userEvent.click(within(dialog).getByRole("combobox", { name: /^New source/ }));
    await userEvent.click(screen.getByRole("option", { name: /^Customer/ }));
    await userEvent.type(within(dialog).getByLabelText(/^Why is the source changing/), "The customer found it too");
    await userEvent.click(within(dialog).getByRole("button", { name: "Change source" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Choose the customer first");
  });

  it("offers no source change without ncr.update or on a closed non-conformance", async () => {
    permissions = ["ncr.read"];
    routeApi({ "GET /ncrs/n1": ncr() });
    const first = renderAt("/Non-Conformance/Register/n1");
    await screen.findByLabelText("Title");
    expect(screen.queryByRole("button", { name: "Change source" })).toBeNull();
    first.unmount();
    document.body.innerHTML = '<div id="modal-root"></div>';
    permissions = [...ALL];
    routeApi({ "GET /ncrs/n1": ncr({ stage: "closed" }) });
    renderAt("/Non-Conformance/Register/n1");
    await screen.findByLabelText("Title");
    expect(screen.queryByRole("button", { name: "Change source" })).toBeNull();
  });

  it("shows the reason for the last source change", async () => {
    routeApi({ "GET /ncrs/n1": ncr({ source: "calibration", sourceChangeReason: "The bore gauge failed" }) });
    renderAt("/Non-Conformance/Register/n1");
    await screen.findByLabelText("Title");
    expect(screen.getByText("Changed: The bore gauge failed")).toBeInTheDocument();
  });

  it("sends only the changed fields when editing", async () => {
    routeApi({ "GET /ncrs/n1": ncr(), "PATCH /ncrs/n1": (_p, o) => ncr(o.body) });
    renderAt("/Non-Conformance/Register/n1");
    const title = await screen.findByLabelText("Title");
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    await userEvent.clear(title);
    await userEvent.type(title, "Bore oversize on op 20");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(lastCall("PATCH /ncrs/n1").body).toEqual({ title: "Bore oversize on op 20" });
  });

  it("moves the stage forward and asks for a reason to cancel", async () => {
    routeApi({ "GET /ncrs/n1": ncr(), "POST /ncrs/n1/transitions": (_p, o) => ncr({ stage: o.body.to }) });
    renderAt("/Non-Conformance/Register/n1");
    await userEvent.click(await screen.findByRole("button", { name: "Move to Contained" }));
    expect(lastCall("POST /ncrs/n1/transitions").body).toEqual({ to: "contained" });

    await userEvent.click(screen.getByRole("button", { name: "Cancel NC" }));
    const dialog = screen.getByRole("dialog", { name: "Cancel NCM-26-001?" });
    expect(within(dialog).getByRole("button", { name: "Cancel NC" })).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText("Why is it being cancelled?"), "Duplicate of NCM-26-000");
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel NC" }));
    expect(lastCall("POST /ncrs/n1/transitions").body).toEqual({ to: "cancelled", reason: "Duplicate of NCM-26-000" });
  });

  it("locks closed records and offers reopen with a reason", async () => {
    routeApi({ "GET /ncrs/n1": ncr({ stage: "closed", closedAt: "2026-11-02T09:00:00Z", closedBy: { id: "u1", name: "Ada Owner" } }) });
    renderAt("/Non-Conformance/Register/n1");
    expect(await screen.findByText(/This non-conformance is closed; reopen it/)).toBeInTheDocument();
    expect(screen.getByLabelText("Title")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Reopen" }));
    expect(screen.getByRole("dialog", { name: "Reopen NCM-26-001?" })).toBeInTheDocument();
  });

  it("deletes with a reason and restores a deleted record", async () => {
    routeApi({ "GET /ncrs/n1": ncr(), "POST /ncrs/n1/delete": (_p, o) => ncr({ deletedAt: "2026-11-03T09:00:00Z", deleteReason: o.body.reason }), "GET /ncrs": { data: [], page: 1, pageSize: 25, total: 0 } });
    renderAt("/Non-Conformance/Register/n1");
    await userEvent.click(await screen.findByRole("button", { name: "Delete" }));
    const dialog = screen.getByRole("dialog", { name: "Delete NCM-26-001?" });
    await userEvent.type(within(dialog).getByLabelText("Reason for deleting"), "Raised in error");
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    expect(lastCall("POST /ncrs/n1/delete").body).toEqual({ reason: "Raised in error" });
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/Non-Conformance/Register"));
  });

  it("shows deleted records read-only with a restore button", async () => {
    routeApi({ "GET /ncrs/n1": ncr({ deletedAt: "2026-11-03T09:00:00Z", deletedBy: { id: "u1", name: "Ada Owner" }, deleteReason: "Raised in error" }), "POST /ncrs/n1/restore": ncr() });
    renderAt("/Non-Conformance/Register/n1");
    expect(await screen.findByText(/Raised in error/)).toBeInTheDocument();
    expect(screen.getByLabelText("Title")).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Restore" }));
    expect(lastCall("POST /ncrs/n1/restore")).toBeTruthy();
  });

  it("is read-only without ncr.update", async () => {
    permissions = ["ncr.read"];
    routeApi({ "GET /ncrs/n1": ncr() });
    renderAt("/Non-Conformance/Register/n1");
    expect(await screen.findByLabelText("Title")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Move to Contained" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  });

  it("shows the history in plain words", async () => {
    routeApi({
      "GET /ncrs/n1": ncr(),
      "GET /ncrs/n1/history": {
        data: [
          { id: "h1", at: "2026-11-01T09:00:00Z", actor: { id: "u1", name: "Ada Owner" }, action: "insert", changedFields: [], previous: null, current: {}, reason: null, source: "api" },
          { id: "h2", at: "2026-11-02T09:00:00Z", actor: { id: "u1", name: "Ada Owner" }, action: "update", changedFields: ["stage", "severity", "quantity_affected", "updated_at"], previous: { stage: "draft", severity: null, quantity_affected: 2 }, current: { stage: "open", severity: "major", quantity_affected: 4 }, reason: "Raised", source: "api", names: {} },
          { id: "h3", at: "2026-11-02T10:00:00Z", actor: { id: "u1", name: "Ada Owner" }, action: "update", changedFields: ["failure_mode_id", "description"], previous: { failure_mode_id: "11111111-1111-4111-8111-111111111111", description: "First words" }, current: { failure_mode_id: "22222222-2222-4222-8222-222222222222", description: "Better words" }, reason: null, source: "api", names: { "11111111-1111-4111-8111-111111111111": "Cosmetic", "22222222-2222-4222-8222-222222222222": "Dimensional" } },
        ],
      },
    });
    renderAt("/Non-Conformance/Register/n1");
    await screen.findByRole("heading", { level: 2, name: "History" });
    const items = await screen.findAllByRole("listitem");
    const text = items.map((li) => li.textContent);
    expect(text).toContain("Stage: Draft → Open");
    expect(text).toContain("Severity: — → Major");
    expect(text).toContain("Quantity affected: 2 → 4");
    expect(text).toContain("Failure mode: Cosmetic → Dimensional");
    expect(text).toContain("Description:BeforeFirst wordsAfterBetter words");
    expect(screen.getAllByText("Ada Owner")).toHaveLength(3);
  });

  it("explains a server rule", async () => {
    const { ApiClientError } = await import("../../lib/api-client");
    routeApi({
      "GET /ncrs/n1": ncr({ stage: "draft", severity: null }),
      "POST /ncrs/n1/transitions": () => Promise.reject(new ApiClientError({ status: 409, code: "ncr_rule", message: "To open this non-conformance, fill in: severity" })),
    });
    renderAt("/Non-Conformance/Register/n1");
    await userEvent.click(await screen.findByRole("button", { name: "Open this NC" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("To open this non-conformance, fill in: severity");
  });
});

describe("Settings → Data Management", () => {
  it("adds failure modes and sub-failure modes, renames and deactivates", async () => {
    routeApi({ "POST /ncr-classifications": (_p, o) => ({ id: "x", ...o.body }), "PATCH /ncr-classifications/fm2": (_p, o) => ({ id: "fm2", ...o.body }) });
    renderAt("/Settings");
    expect(await screen.findByText("Oversize")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("New failure mode"), "Contamination");
    await userEvent.click(within(screen.getByLabelText("New failure mode").closest("form")).getByRole("button", { name: "Add" }));
    expect(lastCall("POST /ncr-classifications").body).toEqual({ kind: "failure_mode", name: "Contamination" });
    const subForm = screen.getAllByLabelText("New sub-failure mode")[0].closest("form");
    await userEvent.type(within(subForm).getByLabelText("New sub-failure mode"), "Undersize");
    await userEvent.click(within(subForm).getByRole("button", { name: "Add" }));
    expect(lastCall("POST /ncr-classifications").body).toEqual({ kind: "sub_failure_mode", name: "Undersize", parentId: "fm1" });
    await userEvent.click(screen.getByRole("switch", { name: "Cosmetic active" }));
    expect(lastCall("PATCH /ncr-classifications/fm2").body).toEqual({ active: false });
  });

  it("lists the categories first, adds one and switches one off", async () => {
    routeApi({ "POST /ncr-classifications": (_p, o) => ({ id: "x", ...o.body }), "PATCH /ncr-classifications/cat2": (_p, o) => ({ id: "cat2", ...o.body }) });
    renderAt("/Settings");
    const card = await screen.findByRole("region", { name: "Categories" });
    expect(within(card).getByText("Product")).toBeInTheDocument();
    expect(within(card).getByText("Process")).toBeInTheDocument();
    await userEvent.type(within(card).getByLabelText("New category"), "Software");
    await userEvent.click(within(card).getByRole("button", { name: "Add" }));
    expect(lastCall("POST /ncr-classifications").body).toEqual({ kind: "category", name: "Software" });
    await userEvent.click(within(card).getByRole("switch", { name: "Process active" }));
    expect(lastCall("PATCH /ncr-classifications/cat2").body).toEqual({ active: false });
    // The fixed sources are listed with what each needs.
    const sources = screen.getByRole("region", { name: "Sources" });
    expect(within(sources).getAllByRole("listitem")).toHaveLength(11);
    expect(within(sources).getByText(/Needs the customer to open/)).toBeInTheDocument();
  });

  it("is read-only without lookups.manage", async () => {
    permissions = ["ncr.read"];
    routeApi({});
    renderAt("/Settings");
    expect(await screen.findByText("Dimensional")).toBeInTheDocument();
    expect(screen.queryByLabelText("New failure mode")).toBeNull();
    expect(screen.queryByRole("switch", { name: /^(?!Show).* active$/ })).toBeNull();
  });
});

describe("NC page layout, costs and files", () => {
  const costList = {
    data: [
      { id: "c1", costType: "scrap", description: "Scrapped bar", incurredOn: "2026-11-01", currency: "GBP", vatTreatment: "inclusive", vatRate: 0.2, amount: 120,
        exchangeRate: 1, netAmount: 100, vatAmount: 20, grossAmount: 120, baseCurrency: "GBP", netBase: 100, grossBase: 120,
        createdAt: "2026-11-01T09:00:00Z", createdBy: { id: "u1", name: "Ada Owner" }, deletedAt: null, deleteReason: null },
    ],
    totals: { baseCurrency: "GBP", net: 100, gross: 120, count: 1 },
  };

  it("shows the old form's sections; costs and files wait until the NC is saved", async () => {
    routeApi({});
    renderAt("/Non-Conformance/Register/new");
    const nav = await screen.findByRole("navigation", { name: "Sections" });
    expect(within(nav).getByRole("button", { name: "Go to NC Details" })).toBeEnabled();
    expect(within(nav).getByRole("button", { name: "Go to Cost" })).toBeDisabled();
    expect(within(nav).getByRole("button", { name: "Go to Additional Info" })).toBeDisabled();
    expect(screen.queryByRole("table", { name: "Costs" })).toBeNull();
  });

  it("lists costs with base-currency totals and adds a cost with a VAT preview", async () => {
    routeApi({ "GET /ncrs/n1": ncr(), "GET /ncrs/n1/costs": costList, "POST /ncrs/n1/costs": (_p, o) => ({ id: "c2", ...o.body }) });
    renderAt("/Non-Conformance/Register/n1");
    const table = await screen.findByRole("table", { name: "Costs" });
    expect(within(table).getByText("Scrapped bar")).toBeInTheDocument();
    expect(within(table).getByText("Total (1 item)")).toBeInTheDocument();
    expect(within(table).getAllByText("£120.00").length).toBeGreaterThan(0);

    await userEvent.click(screen.getByRole("button", { name: "New item" }));
    const dialog = screen.getByRole("dialog", { name: "New cost item" });
    await userEvent.click(within(dialog).getByRole("combobox", { name: /Cost type/ }));
    await userEvent.click(await screen.findByRole("option", { name: "Labour" }));
    await userEvent.click(within(dialog).getByRole("combobox", { name: "VAT option" }));
    await userEvent.click(screen.getByRole("option", { name: "VAT exclusive" }));
    await userEvent.type(within(dialog).getByLabelText(/Amount \(ex\. VAT\)/), "50");
    const preview = within(dialog).getByLabelText("Cost preview");
    expect(preview).toHaveTextContent("£50.00");
    expect(preview).toHaveTextContent("£10.00");
    expect(preview).toHaveTextContent("£60.00");
    await userEvent.click(within(dialog).getByRole("button", { name: "Add cost" }));
    await waitFor(() => expect(lastCall("POST /ncrs/n1/costs").body).toMatchObject({ costType: "labour", currency: "GBP", vatTreatment: "exclusive", vatRate: 0.2, amount: 50, exchangeRate: 1 }));
  });

  it("asks for an exchange rate for a foreign currency", async () => {
    routeApi({ "GET /ncrs/n1": ncr(), "POST /ncrs/n1/costs": (_p, o) => ({ id: "c2", ...o.body }) });
    renderAt("/Non-Conformance/Register/n1");
    await userEvent.click(await screen.findByRole("button", { name: "New item" }));
    const dialog = screen.getByRole("dialog", { name: "New cost item" });
    await userEvent.click(within(dialog).getByRole("combobox", { name: /Cost type/ }));
    await userEvent.click(await screen.findByRole("option", { name: "Transport" }));
    const currency = within(dialog).getByRole("combobox", { name: /Currency/ });
    await userEvent.click(currency);
    await userEvent.type(currency, "EUR");
    await userEvent.click(screen.getByRole("option", { name: /^EUR/ }));
    await userEvent.type(within(dialog).getByLabelText(/^Amount/), "100");
    await userEvent.click(within(dialog).getByRole("button", { name: "Add cost" }));
    expect(await within(dialog).findByText("Enter the exchange rate")).toBeInTheDocument();
    await userEvent.type(within(dialog).getByLabelText(/Exchange rate/), "0.85");
    expect(within(dialog).getByLabelText("Cost preview")).toHaveTextContent("£85.00");
    await userEvent.click(within(dialog).getByRole("button", { name: "Add cost" }));
    await waitFor(() => expect(lastCall("POST /ncrs/n1/costs").body).toMatchObject({ costType: "transport", currency: "EUR", amount: 100, exchangeRate: 0.85 }));
  });

  it("deletes a cost with a reason", async () => {
    routeApi({ "GET /ncrs/n1": ncr(), "GET /ncrs/n1/costs": costList, "POST /ncr-costs/c1/delete": {} });
    renderAt("/Non-Conformance/Register/n1");
    await userEvent.click(await screen.findByRole("button", { name: "Delete Scrap cost" }));
    const dialog = screen.getByRole("dialog", { name: "Delete scrap cost?" });
    await userEvent.type(within(dialog).getByLabelText("Reason for deleting"), "Duplicate");
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    expect(lastCall("POST /ncr-costs/c1/delete").body).toEqual({ reason: "Duplicate" });
  });

  it("uploads dropped files to the NC folder and records them; removing asks for a reason", async () => {
    upload.mockResolvedValue({ path: "org-1/ncr/n1/u1-photo.jpg" });
    routeApi({
      "GET /ncrs/n1": ncr(),
      "GET /ncrs/n1/attachments": { data: [{ id: "f1", fileName: "report.pdf", contentType: "application/pdf", sizeBytes: 2048, description: null, storagePath: "org-1/ncr/n1/x-report.pdf",
        createdAt: "2026-11-01T09:00:00Z", createdBy: { id: "u1", name: "Ada Owner" }, deletedAt: null, deleteReason: null }] },
      "POST /ncrs/n1/attachments": (_p, o) => ({ id: "f2", ...o.body }),
      "POST /ncr-attachments/f1/delete": {},
    });
    renderAt("/Non-Conformance/Register/n1");
    expect(await screen.findByText("report.pdf")).toBeInTheDocument();
    const file = new File(["jpeg"], "photo.jpg", { type: "image/jpeg" });
    globalThis.URL.createObjectURL ??= () => "blob:preview";
    globalThis.URL.revokeObjectURL ??= () => {};
    await userEvent.upload(screen.getByTestId("file-input"), file);
    expect(screen.getByText("Unsaved file")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Save upload" }));
    await waitFor(() => expect(lastCall("POST /ncrs/n1/attachments")?.body).toEqual({ storagePath: "org-1/ncr/n1/u1-photo.jpg", fileName: "photo.jpg", contentType: "image/jpeg", sizeBytes: 4 }));
    expect(upload).toHaveBeenCalledWith(file, "nc-files", "org-1", "n1", "ncr");

    await userEvent.click(screen.getByRole("button", { name: "Remove report.pdf" }));
    const dialog = screen.getByRole("dialog", { name: "Remove report.pdf?" });
    await userEvent.type(within(dialog).getByLabelText("Reason for removing"), "Wrong file");
    await userEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    expect(lastCall("POST /ncr-attachments/f1/delete").body).toEqual({ reason: "Wrong file" });
  });

  it("hides cost and file editing on a closed NC", async () => {
    routeApi({ "GET /ncrs/n1": ncr({ stage: "closed" }), "GET /ncrs/n1/costs": costList });
    renderAt("/Non-Conformance/Register/n1");
    expect(await screen.findByRole("table", { name: "Costs" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New item" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Add files/ })).toBeNull();
  });
});

describe("dialogs inside the NC form", () => {
  it("saving a cost does not also save the NC", async () => {
    routeApi({ "GET /ncrs/n1": ncr(), "POST /ncrs/n1/costs": (_p, o) => ({ id: "c9", ...o.body }), "PATCH /ncrs/n1": (_p, o) => ncr(o.body) });
    renderAt("/Non-Conformance/Register/n1");
    const title = await screen.findByLabelText("Title");
    await userEvent.type(title, " (edited)");
    await userEvent.click(screen.getByRole("button", { name: "New item" }));
    const dialog = screen.getByRole("dialog", { name: "New cost item" });
    await userEvent.click(within(dialog).getByRole("combobox", { name: /Cost type/ }));
    await userEvent.click(await screen.findByRole("option", { name: "Rework" }));
    await userEvent.type(within(dialog).getByLabelText(/^Amount/), "10");
    await userEvent.click(within(dialog).getByRole("button", { name: "Add cost" }));
    await waitFor(() => expect(lastCall("POST /ncrs/n1/costs")).toBeTruthy());
    expect(lastCall("PATCH /ncrs/n1")).toBeUndefined();
  });
});

describe("NC form: production records", () => {
  const links = (over = {}) => ({ productionOrder: null, lot: null, serial: null, ...over });
  const order = { id: "o1", orderNumber: "WO-154789", status: "released" };
  const lookups = {
    "GET /production-orders/lookup": { data: [{ id: "o1", orderNumber: "WO-154789", part: { id: "p1", partNumber: "BRK-100", name: "Bracket" }, status: "released", quantityPlanned: 24 }] },
    "GET /lots/lookup": { data: [{ id: "l1", lotNumber: "LOT-7", part: { id: "p1", partNumber: "BRK-100", name: "Bracket" }, origin: "produced", productionOrder: { id: "o1", orderNumber: "WO-154789" }, status: "released", statusReason: null }] },
    "GET /serial-numbers/lookup": { data: [] },
  };

  it("offers the production order, lot and serial number to people who may read them, and nothing to people who may not", async () => {
    routeApi({ "GET /ncrs/n1": ncr({ links: links() }), ...lookups });
    permissions = [...ALL, "production.read"];
    const { unmount } = renderAt("/Non-Conformance/Register/n1");
    await screen.findByLabelText("Title");
    for (const name of ["Production order", "Lot", "Serial number"]) expect(screen.getByRole("combobox", { name })).toBeInTheDocument();
    unmount();
    permissions = [...ALL];
    renderAt("/Non-Conformance/Register/n1");
    await screen.findByLabelText("Title");
    expect(screen.queryByRole("combobox", { name: "Production order" })).toBeNull();
    expect(screen.getByLabelText("Work order")).toBeEnabled();
  });

  it("links the NC to an order: the work order text is filled in and locked, and the link is saved with it", async () => {
    routeApi({ "GET /ncrs/n1": ncr({ workOrder: null, links: links() }), "PATCH /ncrs/n1": (_p, o) => ncr({ ...o.body, links: links({ productionOrder: order }) }), ...lookups });
    permissions = [...ALL, "production.read"];
    renderAt("/Non-Conformance/Register/n1");
    await screen.findByLabelText("Title");
    await pick("Production order", /WO-154789/);
    expect(screen.getByLabelText("Work order")).toHaveValue("WO-154789");
    expect(screen.getByLabelText("Work order")).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(lastCall("PATCH /ncrs/n1")).toBeTruthy());
    expect(lastCall("PATCH /ncrs/n1").body).toEqual({ productionOrderId: "o1", workOrder: "WO-154789" });
  });

  it("picking a lot brings its order and lot number with it", async () => {
    routeApi({ "GET /ncrs/n1": ncr({ workOrder: null, links: links() }), "PATCH /ncrs/n1": (_p, o) => ncr({ ...o.body, links: links() }), ...lookups });
    permissions = [...ALL, "production.read"];
    renderAt("/Non-Conformance/Register/n1");
    await screen.findByLabelText("Title");
    await pick("Lot", /LOT-7/);
    expect(screen.getByLabelText("Lot / batch")).toHaveValue("LOT-7");
    expect(screen.getByLabelText("Lot / batch")).toBeDisabled();
    expect(screen.getByLabelText("Work order")).toHaveValue("WO-154789");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(lastCall("PATCH /ncrs/n1")).toBeTruthy());
    expect(lastCall("PATCH /ncrs/n1").body).toEqual({ lotId: "l1", productionOrderId: "o1", lotNumber: "LOT-7", workOrder: "WO-154789" });
  });

  it("says when the lot it is on is on hold, and leaves a supplier NC without an order picker", async () => {
    routeApi({
      "GET /ncrs/n1": ncr({ source: "supplier", links: links({ lot: { id: "l1", lotNumber: "LOT-7", status: "on_hold", statusReason: "Suspect material" } }), lotNumber: "LOT-7" }),
      ...lookups,
    });
    permissions = [...ALL, "production.read"];
    renderAt("/Non-Conformance/Register/n1");
    await screen.findByLabelText("Title");
    expect(screen.getByText("Lot LOT-7 is on hold: Suspect material.")).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Production order" })).toBeNull();
    expect(screen.getByRole("combobox", { name: "Lot" })).toBeInTheDocument();
  });

  it("offers only the order to an organisation that does not use lots and serial numbers", async () => {
    orgProduction = { useLotsAndSerials: false };
    routeApi({ "GET /ncrs/n1": ncr({ links: links() }), ...lookups });
    permissions = [...ALL, "production.read"];
    renderAt("/Non-Conformance/Register/n1");
    await screen.findByLabelText("Title");
    expect(screen.getByRole("combobox", { name: "Production order" })).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Lot" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Serial number" })).toBeNull();
  });

  it("has an Affected lots section while lots are used, and none when they are switched off or the NC is new", async () => {
    orgProduction = {};
    routeApi({ "GET /ncrs/n1": ncr({ links: links() }), "GET /ncrs/n1/affected-lots": { data: [], affected: 4, assigned: 0, remaining: 4, suggestedLot: null, problems: [] }, ...lookups });
    permissions = [...ALL, "production.read"];
    const { unmount } = renderAt("/Non-Conformance/Register/n1");
    await screen.findByLabelText("Title");
    expect((await screen.findAllByRole("heading", { name: "Affected lots" })).length).toBeGreaterThan(0);
    unmount();
    orgProduction = { useLotsAndSerials: false };
    renderAt("/Non-Conformance/Register/n1");
    await screen.findByLabelText("Title");
    expect(screen.queryAllByRole("heading", { name: "Affected lots" })).toHaveLength(0);
    expect(screen.queryByText("Which lots are involved")).toBeNull();
  });
});
