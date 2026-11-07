import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

let permissions;
const apiFetch = vi.fn();
vi.mock("../../lib/api-client", async (importOriginal) => ({ ...(await importOriginal()), apiFetch: (...a) => apiFetch(...a) }));
vi.mock("../../contexts/OrganisationProvider", () => ({ useOrganisation: () => ({ organisationId: "org-1" }) }));
vi.mock("../../hooks/useQmsApi", () => ({
  usePermissions: () => ({ can: (p) => permissions.includes(p) }),
  useSites: () => ({ data: { data: [{ id: "s1", code: "MAIN", name: "Main site" }, { id: "s2", code: "PLB", name: "Plant B" }] } }),
  useAllDepartments: () => ({
    data: { data: [{ id: "d1", siteId: "s1", code: "QA", name: "Quality" }, { id: "d2", siteId: "s2", code: "MFG", name: "Manufacturing" }] },
  }),
}));
vi.mock("../../contexts/SearchProvider", () => ({ useGlobalSearch: () => ({ debouncedSearchTerm: "" }) }));
vi.mock("../../contexts/ToastProvider", () => ({ useToast: () => ({ showToast: vi.fn() }) }));

import EmployeesPage from "./EmployeesPage";

const employee = (over = {}) => ({
  id: "e1", name: "Ada Lovelace", firstName: "Ada", surname: "Lovelace", jobTitle: "Inspector", employeeNumber: "E-001", email: "ada@example.test",
  site: { id: "s1", code: "MAIN", name: "Main site" }, department: { id: "d1", code: "QA", name: "Quality" }, active: true, hasLogin: false,
  createdAt: "2026-11-01T09:00:00Z", updatedAt: "2026-11-01T09:00:00Z", ...over,
});

const calls = [];
const routeApi = (list, extra = {}) =>
  apiFetch.mockImplementation(async (path, opts = {}) => {
    const k = `${opts.method ?? "GET"} ${path.split("?")[0]}`;
    calls.push({ k, path, body: opts.body });
    if (k === "GET /employees") return list;
    if (extra[k]) return extra[k];
    if (k === "POST /employees" || k.startsWith("PATCH /employees/")) return employee();
    throw new Error(`unexpected ${k}`);
  });
const lastList = () => calls.filter((c) => c.k === "GET /employees").at(-1);
const lastWrite = () => calls.filter((c) => c.k !== "GET /employees").at(-1);

const renderAt = (url = "/Employees") =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="/Employees" element={<EmployeesPage />} />
        </Routes>
        <div id="modal-root" />
      </MemoryRouter>
    </QueryClientProvider>
  );

beforeEach(() => {
  permissions = ["master_data.read", "master_data.manage"];
  calls.length = 0;
  apiFetch.mockReset();
});

describe("employees register", () => {
  it("is a server-side table sorted by name, with a count, the filter button and New employee", async () => {
    routeApi({ data: [employee(), employee({ id: "e2", name: "Grace Hopper", firstName: "Grace", surname: "Hopper", active: false })], page: 1, pageSize: 25, total: 2 });
    renderAt();
    const table = await screen.findByRole("region", { name: "Employees" });
    expect(await within(table).findByText("Ada Lovelace")).toBeInTheDocument();
    expect(lastList().path).toContain("sort=name&order=asc");
    expect(within(table).getByText("Inactive")).toBeInTheDocument();
    expect(screen.getByText("2 employees")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Filter" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New employee" })).toBeInTheDocument();
  });

  it("sorts on the server by a column header", async () => {
    routeApi({ data: [employee()], page: 1, pageSize: 25, total: 1 });
    renderAt();
    const table = await screen.findByRole("region", { name: "Employees" });
    await within(table).findByText("Ada Lovelace");
    await userEvent.click(within(table).getByTitle("Sort by Job title"));
    await waitFor(() => expect(lastList().path).toContain("sort=jobTitle&order=asc"));
  });

  it("filters from the drawer, shows chips and clears them; department choices follow the site", async () => {
    routeApi({ data: [employee()], page: 1, pageSize: 25, total: 1 });
    renderAt();
    await screen.findByText("Ada Lovelace");
    await userEvent.click(screen.getByRole("button", { name: "Filter" }));
    const pane = await screen.findByRole("dialog", { name: "Filter employees" });
    await userEvent.click(within(pane).getByText("Inactive"));
    await userEvent.click(within(pane).getByRole("combobox", { name: "Site" }));
    await userEvent.click(await screen.findByRole("option", { name: /Plant B/ }));
    await userEvent.click(within(pane).getByRole("combobox", { name: "Department" }));
    expect(screen.getByRole("option", { name: /Manufacturing/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Quality/ })).toBeNull();
    await userEvent.click(screen.getByRole("option", { name: /Manufacturing/ }));
    await userEvent.click(within(pane).getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(lastList().path).toContain("status=inactive"));
    expect(lastList().path).toContain("siteId=s2");
    expect(lastList().path).toContain("departmentId=d2");
    expect(screen.getByRole("button", { name: /Remove filter Status: Inactive/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Clear all" }));
    await waitFor(() => expect(lastList().path).not.toContain("status="));
  });

  it("reads filters from the address", async () => {
    routeApi({ data: [], page: 1, pageSize: 25, total: 0 });
    renderAt("/Employees?status=active&site=s1");
    await waitFor(() => expect(lastList().path).toContain("status=active"));
    expect(lastList().path).toContain("siteId=s1");
    expect(await screen.findByRole("button", { name: /Remove filter Site: Main site/ })).toBeInTheDocument();
  });
});

describe("adding and editing", () => {
  it("adds an employee in a pop-up and sends exactly what was entered", async () => {
    routeApi({ data: [], page: 1, pageSize: 25, total: 0 });
    renderAt();
    await screen.findByText("0 employees");
    await userEvent.click(screen.getByRole("button", { name: "New employee" }));
    const dialog = await screen.findByRole("dialog", { name: "New employee" });
    const add = within(dialog).getByRole("button", { name: "Add employee" });
    expect(add).toBeDisabled(); // a first name and surname are needed
    await userEvent.type(within(dialog).getByLabelText("First name"), "Ada");
    await userEvent.type(within(dialog).getByLabelText("Surname"), "Lovelace");
    await userEvent.type(within(dialog).getByLabelText("Job title"), "Inspector");
    await userEvent.type(within(dialog).getByLabelText("Employee number"), "E-001");
    await userEvent.type(within(dialog).getByLabelText("Work email"), "ada@example.test");
    await userEvent.click(within(dialog).getByRole("combobox", { name: "Department" }));
    await userEvent.click(await screen.findByRole("option", { name: /QA · Quality/ }));
    await userEvent.click(add);
    await waitFor(() => expect(lastWrite()?.k).toBe("POST /employees"));
    expect(lastWrite().body).toEqual({
      firstName: "Ada", surname: "Lovelace", jobTitle: "Inspector", employeeNumber: "E-001", email: "ada@example.test", siteId: "s1", departmentId: "d1",
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("choosing a department fills in its site, and another site clears a department that is not there", async () => {
    routeApi({ data: [], page: 1, pageSize: 25, total: 0 });
    renderAt();
    await screen.findByText("0 employees");
    await userEvent.click(screen.getByRole("button", { name: "New employee" }));
    const dialog = await screen.findByRole("dialog", { name: "New employee" });
    await userEvent.click(within(dialog).getByRole("combobox", { name: "Department" }));
    await userEvent.click(await screen.findByRole("option", { name: /MFG · Manufacturing/ }));
    expect(within(dialog).getByRole("combobox", { name: "Site" })).toHaveAttribute("placeholder", expect.stringContaining("Plant B"));
    await userEvent.click(within(dialog).getByRole("combobox", { name: "Site" }));
    await userEvent.click(await screen.findByRole("option", { name: /Main site/ }));
    expect(within(dialog).getByRole("combobox", { name: "Department" })).toHaveAttribute("placeholder", "No department");
  });

  it("edits from the row actions or a double click, and can deactivate in the form", async () => {
    routeApi({ data: [employee()], page: 1, pageSize: 25, total: 1 });
    renderAt();
    const table = await screen.findByRole("region", { name: "Employees" });
    await within(table).findByText("Ada Lovelace");
    await userEvent.click(within(table).getByRole("button", { name: "Actions" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit Ada Lovelace" });
    expect(within(dialog).getByLabelText("First name")).toHaveValue("Ada");
    await userEvent.clear(within(dialog).getByLabelText("Job title"));
    await userEvent.type(within(dialog).getByLabelText("Job title"), "Lead inspector");
    await userEvent.click(within(dialog).getByRole("switch"));
    await userEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(lastWrite()?.k).toBe("PATCH /employees/e1"));
    expect(lastWrite().body).toMatchObject({ jobTitle: "Lead inspector", active: false, firstName: "Ada", surname: "Lovelace" });
  });

  it("deactivates straight from the row actions", async () => {
    routeApi({ data: [employee()], page: 1, pageSize: 25, total: 1 });
    renderAt();
    const table = await screen.findByRole("region", { name: "Employees" });
    await within(table).findByText("Ada Lovelace");
    await userEvent.click(within(table).getByRole("button", { name: "Actions" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Deactivate" }));
    await waitFor(() => expect(lastWrite()?.k).toBe("PATCH /employees/e1"));
    expect(lastWrite().body).toEqual({ active: false });
  });

  it("is read-only without master_data.manage", async () => {
    permissions = ["master_data.read"];
    routeApi({ data: [employee()], page: 1, pageSize: 25, total: 1 });
    renderAt();
    const table = await screen.findByRole("region", { name: "Employees" });
    await within(table).findByText("Ada Lovelace");
    expect(screen.queryByRole("button", { name: "New employee" })).toBeNull();
    await userEvent.click(within(table).getByRole("button", { name: "Actions" }));
    expect(screen.queryByRole("menuitem", { name: "Deactivate" })).toBeNull();
    await userEvent.click(await screen.findByRole("menuitem", { name: "View" }));
    const dialog = await screen.findByRole("dialog", { name: "Ada Lovelace" });
    expect(within(dialog).getByLabelText("First name")).toBeDisabled();
    expect(within(dialog).queryByRole("button", { name: "Save changes" })).toBeNull();
  });
});
