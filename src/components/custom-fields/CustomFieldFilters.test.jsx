import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router-dom";
import { renderHook } from "@testing-library/react";

const apiFetch = vi.fn();
vi.mock("../../lib/api-client", async (importOriginal) => ({ ...(await importOriginal()), apiFetch: (...a) => apiFetch(...a) }));
vi.mock("../../contexts/OrganisationProvider", () => ({ useOrganisation: () => ({ organisationId: "org-1" }) }));

import CustomFieldFilters, { CustomFilterChips } from "./CustomFieldFilters";
import { customCsvValues, describeCustomFilter, useCustomColumns } from "./customColumns";

const fields = [
  { id: "a", entityType: "part", key: "finish", label: "Surface finish", fieldType: "text", options: [], active: true },
  { id: "b", entityType: "part", key: "weight", label: "Weight", fieldType: "number", unit: "kg", decimals: null, options: [], active: true },
  { id: "c", entityType: "part", key: "coating", label: "Coating", fieldType: "choice", options: [{ key: "zinc", label: "Zinc", active: true }, { key: "paint", label: "Paint", active: true }], active: true },
  { id: "d", entityType: "part", key: "old", label: "Old", fieldType: "text", options: [], active: false },
];

beforeEach(() => {
  apiFetch.mockReset();
  apiFetch.mockImplementation((path) => (path.startsWith("/custom-fields?") ? Promise.resolve({ data: fields, limit: 20, entities: [] }) : Promise.resolve({ data: [] })));
});

const Where = () => <output data-testid="where">{useLocation().search}</output>;
const wrapper = (at = "/Parts") => ({ children }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter initialEntries={[at]}>{children}</MemoryRouter>
  </QueryClientProvider>
);

describe("custom field filters", () => {
  it("puts each filter in the address as cf_<key>", async () => {
    const Wrapper = wrapper("/Parts?page=3");
    render(
      <Wrapper>
        <CustomFieldFilters entityType="part" />
        <Where />
      </Wrapper>,
    );
    await userEvent.type(await screen.findByLabelText("Surface finish"), "Ra");
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("cf_finish=Ra"));
    expect(screen.getByTestId("where")).not.toHaveTextContent("page=3");
    await userEvent.type(screen.getByLabelText("Weight from"), "5");
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("cf_weight=5.."));
    await userEvent.click(screen.getByRole("combobox", { name: /Coating/ }));
    await userEvent.click(await screen.findByRole("option", { name: "Paint" }));
    expect(screen.getByTestId("where")).toHaveTextContent("cf_coating=paint");
    expect(screen.queryByLabelText("Old")).toBeNull();
  });

  it("shows removable chips in words", async () => {
    const Wrapper = wrapper("/Parts?cf_coating=paint&cf_weight=5..10&cf_finish=-");
    render(
      <Wrapper>
        <CustomFilterChips entityType="part" />
        <Where />
      </Wrapper>,
    );
    expect(await screen.findByText("Coating: Paint")).toBeInTheDocument();
    expect(screen.getByText("Weight: 5 to 10 kg")).toBeInTheDocument();
    expect(screen.getByText("Surface finish: none")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Remove filter Coating: Paint" }));
    expect(screen.getByTestId("where")).not.toHaveTextContent("cf_coating");
  });
});

describe("custom columns", () => {
  it("adds one hidden, unsortable column per active field, reading customValues", async () => {
    const { result } = renderHook(() => useCustomColumns("part"), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.columns).toHaveLength(3));
    expect(result.current.columns.map((c) => c.id)).toEqual(["cf_finish", "cf_weight", "cf_coating"]);
    expect(result.current.defaultHidden).toEqual({ cf_finish: false, cf_weight: false, cf_coating: false });
    expect(result.current.columns[2].accessorFn({ customValues: { coating: "zinc" } })).toBe("Zinc");
    expect(result.current.columns[1].enableSorting).toBe(false);
  });

  it("describes filters and CSV values", () => {
    expect(describeCustomFilter(fields[1], "..10")).toBe("Weight: up to 10 kg");
    expect(describeCustomFilter(fields[0], "Ra")).toBe('Surface finish: contains "Ra"');
    expect(customCsvValues(fields, { customValues: { weight: 3, coating: "paint" } })).toEqual({ "Surface finish": "", Weight: "3 kg", Coating: "Paint" });
  });
});
