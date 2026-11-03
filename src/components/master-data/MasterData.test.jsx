import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

let permissions;
let confirmAnswer;
const confirmCalls = [];
const apiFetch = vi.fn();
vi.mock("../../lib/api-client", async (importOriginal) => ({ ...(await importOriginal()), apiFetch: (...a) => apiFetch(...a) }));
vi.mock("../../contexts/OrganisationProvider", () => ({ useOrganisation: () => ({ organisationId: "org-1" }) }));
vi.mock("../../hooks/useQmsApi", () => ({ usePermissions: () => ({ can: (p) => permissions.includes(p) }) }));
vi.mock("../../contexts/ToastProvider", () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock("../../contexts/ConfirmationModalProvider", () => ({ useConfirm: () => async (opts) => (confirmCalls.push(opts), confirmAnswer) }));

import PartsPage from "./PartsPage";
import PartDetailPage from "./PartDetailPage";
import PartiesPage from "./PartiesPage";

const page = (data, nextCursor = null) => ({ data, nextCursor });
const parts = [
  { id: "p1", partNumber: "BRK-100", name: "Bracket", description: null, customer: { id: "c1", code: "ACME", name: "Acme" }, active: true, currentRevision: "B" },
  { id: "p2", partNumber: "AX-1", name: "Axle", description: null, customer: null, active: true, currentRevision: null },
];
const detail = {
  ...parts[0],
  revisions: [
    { id: "r3", partId: "p1", revision: "C", drawingRef: "DRG-100 iss C", changeSummary: "Thicker", status: "draft", releasedAt: null, createdAt: "2026-11-03T10:00:00Z" },
    { id: "r2", partId: "p1", revision: "B", drawingRef: "DRG-100 iss B", changeSummary: "Hole moved", status: "released", releasedAt: "2026-10-01T10:00:00Z", createdAt: "2026-09-01T10:00:00Z" },
    { id: "r1", partId: "p1", revision: "A", drawingRef: null, changeSummary: null, status: "superseded", releasedAt: "2026-01-01T10:00:00Z", createdAt: "2026-01-01T10:00:00Z" },
  ],
};

/** Routes the mocked API by path and method. */
const routeApi = (routes) =>
  apiFetch.mockImplementation(async (path, opts = {}) => {
    const k = `${opts.method ?? "GET"} ${path.split("?")[0]}`;
    if (!(k in routes)) throw new Error(`unexpected ${k}`);
    return typeof routes[k] === "function" ? routes[k](path, opts) : routes[k];
  });

const renderAt = (url) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="/Parts" element={<PartsPage />} />
          <Route path="/Parts/:id" element={<PartDetailPage />} />
          <Route path="/Customers" element={<PartiesPage kind="customers" />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );

beforeEach(() => {
  apiFetch.mockReset();
  confirmCalls.length = 0;
  permissions = ["master_data.read", "master_data.manage"];
  confirmAnswer = true;
});

describe("PartsPage", () => {
  it("lists parts with their current revision and customer", async () => {
    routeApi({ "GET /parts": page(parts) });
    renderAt("/Parts");
    expect(await screen.findByRole("link", { name: "BRK-100" })).toHaveAttribute("href", "/Parts/p1");
    expect(screen.getByText("None released")).toBeInTheDocument();
    expect(screen.getByText("Acme")).toBeInTheDocument();
  });

  it("searches on the server after typing pauses", async () => {
    const seen = [];
    routeApi({ "GET /parts": (path) => (seen.push(path), page([])) });
    renderAt("/Parts");
    await userEvent.type(screen.getByRole("searchbox", { name: "Search part number or name" }), "axle");
    expect(await screen.findByText("No parts match “axle”.")).toBeInTheDocument();
    expect(seen.at(-1)).toContain("q=axle");
  });

  it("adds a part with a first draft revision and opens it", async () => {
    let created;
    routeApi({
      "GET /parts": page([]),
      "GET /customers": page([{ id: "c1", code: "ACME", name: "Acme Fabrication", displayName: "Acme", active: true }]),
      "POST /parts": (_p, opts) => ((created = opts.body), { ...detail, id: "p9" }),
      "GET /parts/p9": { ...detail, id: "p9" },
    });
    renderAt("/Parts");
    await userEvent.click(await screen.findByRole("button", { name: "Add part" }));
    const dialog = screen.getByRole("dialog", { name: "Add part" });
    await userEvent.type(within(dialog).getByLabelText("Part number"), "BRK-200");
    await userEvent.type(within(dialog).getByLabelText("Name"), "Bracket large");
    await userEvent.selectOptions(within(dialog).getByLabelText("Customer"), await within(dialog).findByRole("option", { name: "ACME · Acme" }));
    await userEvent.type(within(dialog).getByLabelText("Drawing reference"), "DRG-200");
    await userEvent.click(within(dialog).getByRole("button", { name: "Add part" }));
    expect(created).toEqual({ partNumber: "BRK-200", name: "Bracket large", description: "", customerId: "c1", initialRevision: { revision: "A", drawingRef: "DRG-200" } });
    expect(await screen.findByRole("heading", { name: /BRK-100/ })).toBeInTheDocument();
  });

  it("hides adding for read-only members", async () => {
    permissions = ["master_data.read"];
    routeApi({ "GET /parts": page(parts) });
    renderAt("/Parts");
    await screen.findByRole("link", { name: "BRK-100" });
    expect(screen.queryByRole("button", { name: "Add part" })).toBeNull();
  });
});

describe("PartDetailPage", () => {
  it("shows revisions with their status and the current revision", async () => {
    routeApi({ "GET /parts/p1": detail, "GET /customers": page([]) });
    renderAt("/Parts/p1");
    expect(await screen.findByText("Current revision:")).toHaveTextContent("Current revision: B");
    const rows = within(screen.getByRole("table")).getAllByRole("row").slice(1);
    expect(rows.map((r) => within(r).getAllByRole("cell")[1].textContent)).toEqual(["draft", "released", "superseded"]);
  });

  it("releases a draft after confirming, explaining what is superseded", async () => {
    const posted = [];
    routeApi({
      "GET /parts/p1": detail,
      "GET /customers": page([]),
      "POST /part-revisions/r3/release": (path) => (posted.push(path), { ...detail.revisions[0], status: "released" }),
    });
    renderAt("/Parts/p1");
    await userEvent.click(await screen.findByRole("button", { name: "Release" }));
    expect(confirmCalls[0]).toMatchObject({ title: "Release revision C?", message: expect.stringContaining("Revision B will be superseded") });
    expect(posted).toEqual(["/part-revisions/r3/release"]);
  });

  it("does nothing when the release is cancelled", async () => {
    confirmAnswer = false;
    routeApi({ "GET /parts/p1": detail, "GET /customers": page([]) });
    renderAt("/Parts/p1");
    await userEvent.click(await screen.findByRole("button", { name: "Release" }));
    expect(apiFetch.mock.calls.some(([p]) => p.includes("/release"))).toBe(false);
  });

  it("edits only draft revisions and adds new ones", async () => {
    let added;
    routeApi({
      "GET /parts/p1": detail,
      "GET /customers": page([]),
      "POST /parts/p1/revisions": (_p, opts) => ((added = opts.body), { ...detail.revisions[0], id: "r4", revision: "D" }),
    });
    renderAt("/Parts/p1");
    expect(await screen.findByRole("button", { name: "Edit revision C" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit revision B" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Add revision" }));
    const dialog = screen.getByRole("dialog", { name: "Add revision" });
    await userEvent.type(within(dialog).getByLabelText(/^Revision/), "D");
    await userEvent.type(within(dialog).getByLabelText("What changed"), "New finish");
    await userEvent.click(within(dialog).getByRole("button", { name: "Add draft revision" }));
    expect(added).toEqual({ revision: "D", drawingRef: "", changeSummary: "New finish" });
  });

  it("is read-only without master_data.manage", async () => {
    permissions = ["master_data.read"];
    routeApi({ "GET /parts/p1": detail });
    renderAt("/Parts/p1");
    expect(await screen.findByLabelText("Part number")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Release" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add revision" })).toBeNull();
  });

  it("explains an unknown part", async () => {
    const { ApiClientError } = await import("../../lib/api-client");
    routeApi({ "GET /parts/p404": () => Promise.reject(new ApiClientError({ status: 404, code: "part_not_found", message: "Part not found" })) });
    renderAt("/Parts/p404");
    expect(await screen.findByRole("alert")).toHaveTextContent("Part not found");
  });
});

describe("PartiesPage", () => {
  it("adds and edits customers", async () => {
    const bodies = [];
    routeApi({
      "GET /customers": page([{ id: "c1", code: "ACME", name: "Acme Fabrication Ltd", displayName: "Acme", companyNumber: null, vatNumber: "GB1", notes: null, active: true }]),
      "POST /customers": (_p, opts) => (bodies.push(["POST", opts.body]), { id: "c2", ...opts.body }),
      "PATCH /customers/c1": (_p, opts) => (bodies.push(["PATCH", opts.body]), {}),
    });
    renderAt("/Customers");
    await userEvent.click(await screen.findByRole("button", { name: "Add customer" }));
    let dialog = screen.getByRole("dialog", { name: "Add customer" });
    await userEvent.type(within(dialog).getByLabelText("Code"), "BOREAL");
    await userEvent.type(within(dialog).getByLabelText("Name"), "Boreal Tooling Ltd");
    await userEvent.click(within(dialog).getByRole("button", { name: "Add customer" }));
    expect(bodies[0]).toEqual(["POST", { code: "BOREAL", name: "Boreal Tooling Ltd", displayName: "", companyNumber: "", vatNumber: "", notes: "" }]);

    await userEvent.click(await screen.findByRole("button", { name: "ACME" }));
    dialog = screen.getByRole("dialog", { name: "Edit ACME" });
    expect(within(dialog).getByLabelText("VAT number")).toHaveValue("GB1");
    await userEvent.click(within(dialog).getByLabelText(/Active/));
    await userEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
    expect(bodies[1][1]).toMatchObject({ code: "ACME", active: false });
  });

  it("shows server validation errors in the form", async () => {
    const { ApiClientError } = await import("../../lib/api-client");
    routeApi({
      "GET /customers": page([]),
      "POST /customers": () => Promise.reject(new ApiClientError({ status: 409, code: "conflict", message: "A customer with this code already exists" })),
    });
    renderAt("/Customers");
    await userEvent.click(await screen.findByRole("button", { name: "Add customer" }));
    const dialog = screen.getByRole("dialog", { name: "Add customer" });
    await userEvent.type(within(dialog).getByLabelText("Code"), "ACME");
    await userEvent.type(within(dialog).getByLabelText("Name"), "Acme");
    await userEvent.click(within(dialog).getByRole("button", { name: "Add customer" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("A customer with this code already exists");
  });
});
