import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

let permissions = [];
const apiFetch = vi.fn();
const showToast = vi.fn();
vi.mock("../../lib/api-client", async (importOriginal) => ({ ...(await importOriginal()), apiFetch: (...a) => apiFetch(...a) }));
vi.mock("../../contexts/OrganisationProvider", () => ({ useOrganisation: () => ({ organisationId: "org-1" }) }));
vi.mock("../../contexts/ToastProvider", () => ({ useToast: () => ({ showToast }) }));
vi.mock("../../hooks/useQmsApi", () => ({ usePermissions: () => ({ can: (p) => permissions.includes(p) }) }));

import CustomFieldsSettings from "./CustomFieldsSettings";

const def = (over) => ({
  id: "f1", entityType: "part", key: "surface_finish", label: "Surface finish", fieldType: "text", helpText: null, section: "Finishing", position: 1,
  requiredAt: "never", options: [], decimals: null, unit: null, min: null, max: null, active: true, retiredAt: null, retireReason: null,
  createdAt: "2026-11-10T00:00:00Z", updatedAt: "2026-11-10T00:00:00Z", ...over,
});
const entities = [
  { entityType: "part", label: "Parts", stages: [], activeCount: 2 },
  { entityType: "nonconformance", label: "Non-conformances", stages: [{ value: "open", label: "Open" }, { value: "closed", label: "Closed" }], activeCount: 0 },
];
let fields = [];
const route = (path, opts = {}) => {
  if (path.startsWith("/custom-fields?")) {
    const type = new URLSearchParams(path.split("?")[1]).get("entityType");
    return Promise.resolve({ data: fields.filter((f) => f.entityType === type), limit: 20, entities });
  }
  if (path === "/custom-fields" && opts.method === "POST") return Promise.resolve(def({ id: "new", ...opts.body }));
  return Promise.resolve({});
};

const renderPage = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <CustomFieldsSettings />
    </QueryClientProvider>,
  );
};

beforeEach(() => {
  apiFetch.mockReset();
  apiFetch.mockImplementation(route);
  showToast.mockReset();
  fields = [
    def(),
    def({ id: "f2", key: "coating", label: "Coating", fieldType: "choice", section: null, position: 2, requiredAt: "save", options: [{ key: "zinc", label: "Zinc", active: true }, { key: "paint", label: "Paint", active: false }] }),
    def({ id: "f3", key: "old", label: "Old field", position: 3, active: false, retiredAt: "2026-11-01T00:00:00Z", retireReason: "Not used" }),
  ];
});

describe("Settings → Custom fields", () => {
  it("lists the fields of a kind of record with type, section and rule, and the retired ones apart", async () => {
    permissions = ["custom_fields.manage"];
    renderPage();
    const list = await screen.findByRole("list", { name: "Custom fields on parts" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Surface finish");
    expect(rows[0]).toHaveTextContent("Finishing");
    expect(rows[1]).toHaveTextContent("One choice");
    expect(rows[1]).toHaveTextContent("1 options");
    expect(rows[1]).toHaveTextContent("Required");
    expect(screen.getByText("2 of 20 fields in use, 1 retired.")).toBeInTheDocument();
    expect(screen.getByText("Retired fields (1)")).toBeInTheDocument();
  });

  it("adds a choice field with its options", async () => {
    permissions = ["custom_fields.manage"];
    renderPage();
    await screen.findByRole("list", { name: "Custom fields on parts" });
    await userEvent.click(screen.getByRole("button", { name: /Add field/ }));
    const dialog = screen.getByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText("Label"), "Heat treatment");
    await userEvent.click(within(dialog).getByRole("combobox", { name: /Type/ }));
    await userEvent.click(await screen.findByRole("option", { name: /One choice/ }));
    expect(within(dialog).getByRole("button", { name: "Add field" })).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText("New option"), "Hardened{Enter}");
    await userEvent.type(within(dialog).getByLabelText("New option"), "Annealed{Enter}");
    await userEvent.click(within(dialog).getByRole("button", { name: "Add field" }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/custom-fields", expect.objectContaining({ method: "POST" })));
    const body = apiFetch.mock.calls.find(([p, o]) => p === "/custom-fields" && o.method === "POST")[1].body;
    expect(body).toMatchObject({
      entityType: "part", fieldType: "choice", label: "Heat treatment", requiredAt: "never",
      options: [{ key: "hardened", label: "Hardened", active: true }, { key: "annealed", label: "Annealed", active: true }],
    });
  });

  it("keeps the type fixed when editing and switches saved options off instead of removing them", async () => {
    permissions = ["custom_fields.manage"];
    renderPage();
    const list = await screen.findByRole("list", { name: "Custom fields on parts" });
    await userEvent.click(within(within(list).getAllByRole("listitem")[1]).getByRole("button", { name: "Actions" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Edit" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("combobox", { name: /Type/ })).toBeDisabled();
    expect(within(dialog).queryByRole("button", { name: /Remove Zinc/ })).toBeNull();
    await userEvent.click(within(dialog).getByRole("switch", { name: "Zinc can be chosen" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/custom-fields/f2", expect.objectContaining({ method: "PATCH" })));
    const body = apiFetch.mock.calls.find(([p]) => p === "/custom-fields/f2")[1].body;
    expect(body.options).toEqual([{ key: "zinc", label: "Zinc", active: false }, { key: "paint", label: "Paint", active: false }]);
    expect(body.fieldType).toBeUndefined();
  });

  it("retires a field with a reason, and brings a retired one back", async () => {
    permissions = ["custom_fields.manage"];
    renderPage();
    const list = await screen.findByRole("list", { name: "Custom fields on parts" });
    await userEvent.click(within(within(list).getAllByRole("listitem")[0]).getByRole("button", { name: "Actions" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Retire" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "Retire field" })).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText(/Why is it retired/), "Not needed");
    await userEvent.click(within(dialog).getByRole("button", { name: "Retire field" }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/custom-fields/f1/retire", expect.objectContaining({ body: { reason: "Not needed" } })));
    await userEvent.click(screen.getByText("Retired fields (1)"));
    await userEvent.click(screen.getByRole("button", { name: "Bring back" }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/custom-fields/f3/reactivate", expect.objectContaining({ method: "POST" })));
  });

  it("moves a field down, sending the whole order", async () => {
    permissions = ["custom_fields.manage"];
    renderPage();
    await screen.findByRole("list", { name: "Custom fields on parts" });
    await userEvent.click(screen.getByRole("button", { name: "Move Surface finish down" }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/custom-fields/order", expect.objectContaining({ method: "PUT", body: { entityType: "part", ids: ["f2", "f1", "f3"] } })));
  });

  it("offers the stages of a kind of record as required choices", async () => {
    permissions = ["custom_fields.manage"];
    renderPage();
    await screen.findByRole("list", { name: "Custom fields on parts" });
    await userEvent.click(screen.getByRole("combobox", { name: /Kind of record/ }));
    await userEvent.click(await screen.findByRole("option", { name: /Non-conformances/ }));
    expect(await screen.findByText(/No custom fields on non-conformances yet/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Add field/ }));
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("combobox", { name: /Required/ }));
    expect(await screen.findByRole("option", { name: "Required before it reaches Closed" })).toBeInTheDocument();
  });

  it("is read-only without the permission", async () => {
    permissions = [];
    renderPage();
    await screen.findByRole("list", { name: "Custom fields on parts" });
    expect(screen.queryByRole("button", { name: /Add field/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Actions" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Move/ })).toBeNull();
  });
});
