import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const apiFetch = vi.fn();
vi.mock("../../lib/api-client", async (importOriginal) => ({ ...(await importOriginal()), apiFetch: (...a) => apiFetch(...a) }));
vi.mock("../../contexts/OrganisationProvider", () => ({ useOrganisation: () => ({ organisationId: "org-1" }) }));

import { mappingToRows } from "../../lib/integrations";
import MappingStep from "./MappingStep";

const fields = [
  { key: "code", label: "Code", type: "text", required: true },
  { key: "site", label: "Site", type: "text", ref: { kind: "site", source: false } },
];
const columns = ["Ref", "Site"];
const list = (data, total = data.length) => ({ kind: "site", word: "site", total, data });
const reference = (over = {}) => ({ target: "site", label: "Site", kind: "site", word: "site", mode: "code", checked: 40, distinct: 3, missing: 0, ambiguous: 0, examples: [], truncated: false, ...over });

const Harness = ({ preview, site = "Site" }) => {
  const rows = mappingToRows(fields, { fields: [{ target: "code", source: "Ref" }, ...(site ? [{ target: "site", source: site }] : [])] }, columns);
  return (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MappingStep fields={fields} columns={columns} preview={preview} keyField="Ref" onKeyField={() => {}} rows={rows} onRows={() => {}} />
    </QueryClientProvider>
  );
};

beforeEach(() => {
  apiFetch.mockReset();
  apiFetch.mockImplementation(async (path) => {
    const url = new URL(path, "http://x");
    if (url.pathname.endsWith("/reference-values")) {
      const q = url.searchParams.get("q");
      const all = [{ code: "LEEDS", name: "Leeds plant", hint: null, active: true, duplicate: false }, { code: "HULL", name: "Hull plant", hint: null, active: false, duplicate: false }];
      return list(q ? all.filter((d) => d.code.toLowerCase().includes(q.toLowerCase())) : all);
    }
    return {};
  });
});

describe("link fields in the mapping", () => {
  it("says the values all match, with a way to see the allowed ones", () => {
    render(<Harness preview={{ rows: [], columnCheck: { missing: [], unused: [] }, references: [reference()] }} />);
    const line = screen.getByRole("status");
    expect(line).toHaveAttribute("data-reference-check", "ok");
    expect(line).toHaveTextContent("All 3 different values in 40 rows match a site in Fortress");
    expect(within(line).getByRole("button", { name: /See allowed values/ })).toBeInTheDocument();
  });

  it("names the values that do not match, and the dialog lists them first with the allowed codes to search", async () => {
    const user = userEvent.setup();
    const check = reference({ missing: 2, ambiguous: 1, distinct: 5, examples: [{ value: "NOWHERE", reason: "missing", rows: 7 }, { value: "QA", reason: "ambiguous", rows: 2 }] });
    render(<Harness preview={{ rows: [], columnCheck: { missing: [], unused: [] }, references: [check] }} />);
    const line = screen.getByRole("status");
    expect(line).toHaveAttribute("data-reference-check", "problem");
    expect(line).toHaveTextContent('3 of 5 different values are not usable as a site: "NOWHERE", "QA"');
    await user.click(within(line).getByRole("button", { name: /See the list/ }));
    const dialog = await screen.findByRole("dialog", { name: "Allowed values for Site" });
    const bad = within(dialog).getByRole("list", { name: "Values in your file with no match" });
    expect(bad).toHaveTextContent("NOWHERE — no site has this code; 7 rows");
    expect(bad).toHaveTextContent("QA — more than one site has this code; 2 rows");
    const codes = await within(dialog).findByRole("list", { name: "Allowed site codes" });
    expect(within(codes).getAllByRole("listitem")).toHaveLength(2);
    expect(within(codes).getByText("LEEDS")).toBeInTheDocument();
    expect(within(codes).getByText("inactive")).toBeInTheDocument();
    await user.type(within(dialog).getByRole("searchbox", { name: "Search the allowed values" }), "leeds");
    await vi.waitFor(() => expect(within(within(dialog).getByRole("list", { name: "Allowed site codes" })).getAllByRole("listitem")).toHaveLength(1));
    expect(apiFetch).toHaveBeenCalledWith(expect.stringContaining("q=leeds"), expect.anything());
  });

  it("offers the list before a column is chosen, and says so when the list is empty or cannot be read", async () => {
    const user = userEvent.setup();
    apiFetch.mockImplementation(async () => list([]));
    render(<Harness site={null} preview={null} />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /See allowed values/ }));
    const dialog = await screen.findByRole("dialog", { name: "Allowed values for Site" });
    expect(await within(dialog).findByText(/There are no sites in Fortress yet/)).toBeInTheDocument();
  });

  it("shows an error in the dialog when the list cannot be loaded", async () => {
    const user = userEvent.setup();
    apiFetch.mockImplementation(async () => {
      throw new Error("Nope");
    });
    render(<Harness site={null} preview={null} />);
    await user.click(screen.getByRole("button", { name: /See allowed values/ }));
    expect(await screen.findByText(/The list could not be loaded: Nope/)).toBeInTheDocument();
  });

  it("shows nothing for a field that is not a link", () => {
    render(<Harness preview={{ rows: [], columnCheck: { missing: [], unused: [] }, references: [] }} />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
