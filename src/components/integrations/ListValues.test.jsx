import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("../../lib/api-client", async (importOriginal) => ({ ...(await importOriginal()), apiFetch: vi.fn(async () => ({})) }));
vi.mock("../../contexts/OrganisationProvider", () => ({ useOrganisation: () => ({ organisationId: "org-1" }) }));

import { mappingToRows } from "../../lib/integrations";
import MappingStep from "./MappingStep";

const severity = { key: "severity", label: "Severity", type: "enum", options: [{ value: "critical", label: "Critical" }, { value: "major", label: "Major" }, { value: "minor", label: "Minor" }] };
const fields = [{ key: "code", label: "Code", type: "text", required: true }, severity, { key: "currency", label: "Currency", type: "currency" }];
const columns = ["Ref", "Sev", "Cur"];

const Harness = ({ preview, mapped = true }) => {
  const rows = mappingToRows(fields, { fields: [{ target: "code", source: "Ref" }, ...(mapped ? [{ target: "severity", source: "Sev" }] : [])] }, columns);
  return (
    <QueryClientProvider client={new QueryClient()}>
      <MappingStep fields={fields} columns={columns} preview={preview} keyField="Ref" onKeyField={() => {}} rows={rows} onRows={() => {}} />
    </QueryClientProvider>
  );
};

const row = (n, sev) => ({ row: n, errors: [], fields: [{ target: "code", taken: `C${n}`, steps: [], value: `C${n}` }, { target: "severity", taken: sev, steps: [], value: null }] });

describe("fields that take one of a list", () => {
  it("offers the list before a column is chosen, for a fixed choice and a currency", async () => {
    const user = userEvent.setup();
    render(<Harness mapped={false} preview={null} />);
    expect(screen.getByRole("button", { name: /See accepted currencies/ })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /See accepted values/ }));
    const dialog = await screen.findByRole("dialog", { name: "Accepted values for Severity" });
    const list = within(dialog).getByRole("list", { name: "Accepted values for Severity" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(3);
    expect(within(list).getByText("Major")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Copy Major" })).toBeInTheDocument();
    expect(dialog).toHaveTextContent("by its words or its code");
  });

  it("checks the example rows: green when all are on the list, red naming those that are not, listed first in the pop-up", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Harness preview={{ rows: [row(2, "Major"), row(3, "minor")], columnCheck: { missing: [], unused: [] } }} />);
    const ok = screen.getByRole("status");
    expect(ok).toHaveAttribute("data-list-check", "ok");
    expect(ok).toHaveTextContent("Every value in the 2 example rows is on the list");

    rerender(<Harness preview={{ rows: [row(2, "Major"), row(3, "Big"), row(4, "Big"), row(5, "Huge")], columnCheck: { missing: [], unused: [] } }} />);
    const bad = screen.getByRole("status");
    expect(bad).toHaveAttribute("data-list-check", "problem");
    expect(bad).toHaveTextContent('3 of the 4 example rows have values not on the list: "Big", "Huge"');
    await user.click(within(bad).getByRole("button", { name: /See the list/ }));
    const dialog = await screen.findByRole("dialog", { name: "Accepted values for Severity" });
    const off = within(dialog).getByRole("list", { name: "Values not on the list" });
    expect(off).toHaveTextContent("Big — 2 rows");
    expect(off).toHaveTextContent("Huge — 1 row");
  });

  it("lists currencies by code with a search", async () => {
    const user = userEvent.setup();
    render(<Harness preview={null} />);
    await user.click(screen.getByRole("button", { name: /See accepted currencies/ }));
    const dialog = await screen.findByRole("dialog", { name: "Accepted currencies for Currency" });
    await user.type(within(dialog).getByRole("searchbox", { name: "Search the accepted values" }), "pound sterling");
    const list = within(dialog).getByRole("list", { name: "Accepted values for Currency" });
    expect(within(list).getByText("GBP")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Copy GBP" })).toBeInTheDocument();
  });
});
