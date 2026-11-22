import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";

const apiFetch = vi.fn();
const showToast = vi.fn();
vi.mock("../../lib/api-client", async (importOriginal) => ({ ...(await importOriginal()), apiFetch: (...a) => apiFetch(...a) }));
vi.mock("../../contexts/OrganisationProvider", () => ({ useOrganisation: () => ({ organisationId: "org-1" }) }));
vi.mock("../../contexts/ToastProvider", () => ({ useToast: () => ({ showToast }) }));

import CustomFieldsCard, { CustomFieldInputs } from "./CustomFieldsCard";

const def = (over) => ({
  id: over.key, entityType: "part", label: over.key, fieldType: "text", helpText: null, section: null, position: 1, requiredAt: "never", options: [],
  decimals: null, unit: null, min: null, max: null, active: true, retiredAt: null, retireReason: null, ...over,
});
let fields = [];
const PART = "11111111-1111-1111-1111-111111111111";

beforeEach(() => {
  apiFetch.mockReset();
  showToast.mockReset();
  fields = [
    def({ key: "finish", label: "Surface finish", section: "Finishing", helpText: "As on the drawing" }),
    def({ key: "weight", label: "Weight", fieldType: "number", unit: "kg", decimals: 1, min: 0, requiredAt: "save" }),
    def({ key: "critical", label: "Safety critical", fieldType: "boolean" }),
    def({ key: "coating", label: "Coating", fieldType: "choice", options: [{ key: "zinc", label: "Zinc", active: false }, { key: "paint", label: "Paint", active: true }] }),
    def({ key: "tests", label: "Tests", fieldType: "multi_choice", options: [{ key: "salt", label: "Salt spray", active: true }, { key: "hard", label: "Hardness", active: true }] }),
    def({ key: "owner", label: "Design owner", fieldType: "person" }),
    def({ key: "old", label: "Old code", active: false }),
    def({ key: "unused", label: "Unused retired", active: false }),
  ];
  apiFetch.mockImplementation((path, opts = {}) => {
    if (path.startsWith("/custom-fields?")) return Promise.resolve({ data: fields, limit: 20, entities: [{ entityType: "part", label: "Parts", stages: [], activeCount: 6 }] });
    if (path === "/custom-fields/people") return Promise.resolve({ data: [{ id: "u1", name: "Ada Owner" }, { id: "u2", name: "Ben Smith" }] });
    if (path.startsWith("/custom-values/") && opts.method === "PUT") return Promise.resolve({ values: {} });
    return Promise.resolve({});
  });
});

const wrap = (ui) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>);
const record = (values) => ({ id: PART, customValues: values });

describe("More details card", () => {
  it("shows the values as words when it cannot be edited, with retired fields only when they hold a value", async () => {
    wrap(<CustomFieldsCard entityType="part" record={record({ finish: "Ra 0.8", weight: 12.5, critical: true, coating: "zinc", tests: ["salt", "hard"], owner: "u2", old: "X-1" })} />);
    const card = await screen.findByRole("region", { name: "More details" });
    expect(within(card).getByText("Finishing")).toBeInTheDocument();
    expect(within(card).getByText("Ra 0.8")).toBeInTheDocument();
    expect(within(card).getByText("12.5 kg")).toBeInTheDocument();
    expect(within(card).getByText("Yes")).toBeInTheDocument();
    expect(within(card).getByText("Zinc")).toBeInTheDocument();
    expect(within(card).getByText("Salt spray, Hardness")).toBeInTheDocument();
    expect(await within(card).findByText("Ben Smith")).toBeInTheDocument();
    expect(within(card).getByText("X-1")).toBeInTheDocument();
    expect(within(card).queryByText(/Unused retired/)).toBeNull();
    expect(within(card).queryByRole("textbox")).toBeNull();
  });

  it("renders nothing when the kind of record has no fields", async () => {
    fields = [];
    const { container } = wrap(<CustomFieldsCard entityType="part" record={record({})} editable />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("saves a text field when it is left, only when it changed", async () => {
    wrap(<CustomFieldsCard entityType="part" record={record({ weight: 2 })} editable />);
    const box = await screen.findByLabelText("Surface finish");
    await userEvent.click(box);
    await userEvent.tab();
    expect(apiFetch).not.toHaveBeenCalledWith(`/custom-values/${PART}`, expect.anything());
    await userEvent.type(box, "Ra 1.6{Enter}");
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith(`/custom-values/${PART}`, expect.objectContaining({ method: "PUT", body: { entityType: "part", values: { finish: "Ra 1.6" } } })));
  });

  it("saves yes / no, a choice and several choices as they are given, never offering a switched-off option", async () => {
    wrap(<CustomFieldsCard entityType="part" record={record({ weight: 2, tests: ["salt"] })} editable />);
    await userEvent.click(await screen.findByRole("switch", { name: "Safety critical" }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith(`/custom-values/${PART}`, expect.objectContaining({ body: { entityType: "part", values: { critical: true } } })));
    await userEvent.click(screen.getByRole("combobox", { name: /Coating/ }));
    expect(screen.queryByRole("option", { name: "Zinc" })).toBeNull();
    await userEvent.click(await screen.findByRole("option", { name: "Paint" }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith(`/custom-values/${PART}`, expect.objectContaining({ body: { entityType: "part", values: { coating: "paint" } } })));
    await userEvent.click(screen.getByRole("button", { name: "Hardness" }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith(`/custom-values/${PART}`, expect.objectContaining({ body: { entityType: "part", values: { tests: ["salt", "hard"] } } })));
  });

  it("tells the person when the database refuses a value", async () => {
    apiFetch.mockImplementation((path, opts = {}) => {
      if (path.startsWith("/custom-fields?")) return Promise.resolve({ data: fields, limit: 20, entities: [] });
      if (opts.method === "PUT") return Promise.reject(Object.assign(new Error("Weight: at most 1 decimal places"), { status: 409 }));
      return Promise.resolve({ data: [] });
    });
    wrap(<CustomFieldsCard entityType="part" record={record({})} editable />);
    await userEvent.type(await screen.findByLabelText(/Weight/), "1.25{Enter}");
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: "error", title: "Weight not saved" })));
  });
});

describe("custom fields on a create form", () => {
  const Form = () => {
    const [values, setValues] = useState({});
    return (
      <>
        <CustomFieldInputs entityType="part" values={values} onChange={setValues} />
        <output data-testid="values">{JSON.stringify(values)}</output>
      </>
    );
  };
  it("asks only for the fields required on save and keeps them in the form", async () => {
    wrap(<Form />);
    const box = await screen.findByLabelText(/Weight/);
    expect(screen.queryByLabelText("Surface finish")).toBeNull();
    await userEvent.type(box, "3,5");
    await userEvent.tab();
    expect(screen.getByTestId("values")).toHaveTextContent('{"weight":"3.5"}');
    expect(apiFetch).not.toHaveBeenCalledWith(expect.stringContaining("/custom-values"), expect.anything());
  });
});

describe("More details card, custom fields a scheduled import owns", () => {
  const withLocks = (locked) => {
    const base = apiFetch.getMockImplementation();
    apiFetch.mockImplementation((path, opts = {}) => {
      if (path.startsWith("/import-locks?")) return Promise.resolve({ data: locked.map((field) => ({ field, connection: { id: "c1", name: "ERP" } })) });
      return base(path, opts);
    });
  };

  it("disables those fields with the lock, leaves the others editable and never saves a locked one", async () => {
    withLocks(["cf_finish", "cf_critical", "cf_tests", "cf_coating"]);
    const user = userEvent.setup();
    wrap(<CustomFieldsCard entityType="part" editable record={record({ finish: "Ra 0.8", weight: 12.5, critical: false, tests: ["salt"] })} />);
    const card = await screen.findByRole("region", { name: "More details" });
    expect(await within(card).findAllByRole("button", { name: "Managed by ERP" })).toHaveLength(4);
    expect(within(card).getByRole("textbox", { name: /Surface finish/ })).toBeDisabled();
    expect(within(card).getByRole("switch", { name: "Safety critical" })).toBeDisabled();
    expect(within(card).getByRole("button", { name: "Salt spray" })).toBeDisabled();
    expect(within(card).getByRole("textbox", { name: /Weight/ })).toBeEnabled();
    await user.click(within(card).getByRole("button", { name: "Hardness" }));
    expect(apiFetch.mock.calls.some(([path, o]) => path.startsWith("/custom-values/") && o?.method === "PUT")).toBe(false);
  });

  it("shows no lock when nothing is managed", async () => {
    withLocks([]);
    wrap(<CustomFieldsCard entityType="part" editable record={record({ finish: "Ra 0.8" })} />);
    const card = await screen.findByRole("region", { name: "More details" });
    expect(within(card).getByRole("textbox", { name: /Surface finish/ })).toBeEnabled();
    expect(within(card).queryByRole("button", { name: /Managed by/ })).toBeNull();
  });
});
