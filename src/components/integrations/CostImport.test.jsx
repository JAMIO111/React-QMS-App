import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const apiFetch = vi.fn();
vi.mock("../../lib/api-client", async (importOriginal) => ({ ...(await importOriginal()), apiFetch: (...a) => apiFetch(...a) }));
vi.mock("../../contexts/OrganisationProvider", () => ({ useOrganisation: () => ({ organisationId: "org-1" }) }));

import { ENTITY_DESCRIPTIONS, ENTITY_LABELS, costSummaryWords, mappingToRows, matchHint } from "../../lib/integrations";
import { ADD_ONLY_KINDS, fieldsForSettings, templateChanged, templateSettings } from "../../lib/importTemplates";
import CostRunCard, { CostCurrencyNotice } from "./CostImportParts";
import MappingStep from "./MappingStep";
import ReferenceValuesDialog from "./ReferenceValues";
import { TemplateSettingsCard } from "./CsvImportWizard";

const costs = (over = {}) => ({
  lines: 6,
  currencies: [
    { currency: "EUR", lines: 3, withRate: 3, waiting: 0 },
    { currency: "XAF", lines: 2, withRate: 0, waiting: 2 },
    { currency: "GBP", lines: 1, withRate: 1, waiting: 0 },
  ],
  onClosed: 0,
  onCancelled: 0,
  booked: 0,
  waitingNow: 0,
  ...over,
});

beforeEach(() => apiFetch.mockReset());

describe("cost import words and settings", () => {
  it("names the kind, describes it and always adds", () => {
    expect(ENTITY_LABELS.ncr_cost).toBe("NC cost lines");
    expect(ENTITY_DESCRIPTIONS.ncr_cost).toMatch(/only ever added/);
    expect(ADD_ONLY_KINDS).toContain("ncr_cost");
  });

  it("keeps the closed-NC choice on a cost template only", () => {
    expect(templateSettings("ncr_cost", { writeMode: "add_update", matchExisting: true, costsOnClosed: true })).toEqual({ writeMode: "add_only", matchExisting: false, costsOnClosed: true, missingDate: "reject" });
    expect(templateSettings("ncr_cost", undefined)).toEqual({ writeMode: "add_only", matchExisting: false, costsOnClosed: false, missingDate: "reject" });
    expect(templateSettings("nonconformance", { costsOnClosed: true })).toEqual({ writeMode: "add_only", matchExisting: false });
    expect(templateSettings("supplier", { writeMode: "add_update", matchExisting: true })).toEqual({ writeMode: "add_update", matchExisting: true });
  });

  it("counts a changed closed-NC choice as a change to the template", () => {
    const version = { keyField: "id", fields: [], settings: { writeMode: "add_only", matchExisting: false, costsOnClosed: false, missingDate: "reject" } };
    expect(templateChanged(version, { keyField: "id", fields: [], settings: templateSettings("ncr_cost", { costsOnClosed: false }) })).toBe(false);
    expect(templateChanged(version, { keyField: "id", fields: [], settings: templateSettings("ncr_cost", { costsOnClosed: true }) })).toBe(true);
  });

  it("says in words what a link to a non-conformance matches by", () => {
    expect(matchHint("nonconformance", "code", "x")).toMatch(/Fortress reference, such as SNC-26-0011/);
    expect(matchHint("nonconformance", "source", "x")).toMatch(/importing the non-conformances through this connection first/);
    expect(matchHint("part", "source", "The id from this file")).toBe("The id from this file");
    expect(matchHint("part", "code", "x")).toBe("The code as it is in Fortress");
  });

  it("sums the lines waiting for a rate", () => {
    expect(costSummaryWords(costs()).waiting).toBe(2);
    expect(costSummaryWords(costs()).sentence).toBe("2 lines have no published rate yet");
    expect(costSummaryWords(costs({ currencies: [{ currency: "EUR", lines: 1, withRate: 1, waiting: 0 }], lines: 1 })).sentence).toBe("every line has an exchange rate for its date");
    expect(costSummaryWords(null)).toBeNull();
  });
});

describe("the cost template settings card", () => {
  it("offers the closed-NC switch for cost lines only, and says what it does", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { rerender } = render(<TemplateSettingsCard entityType="ncr_cost" settings={{ writeMode: "add_only", matchExisting: false, costsOnClosed: false }} onChange={onChange} />);
    const toggle = screen.getByRole("switch", { name: /Allow costs on closed or cancelled non-conformances/ });
    expect(toggle).not.toBeChecked();
    expect(screen.getByText(/one made by hand in Fortress stays closed to new costs/)).toBeInTheDocument();
    await user.click(toggle);
    expect(onChange).toHaveBeenCalledWith({ writeMode: "add_only", matchExisting: false, costsOnClosed: true });
    rerender(<TemplateSettingsCard entityType="nonconformance" settings={{ writeMode: "add_only", matchExisting: false }} onChange={onChange} />);
    expect(screen.queryByRole("switch", { name: /closed or cancelled/ })).not.toBeInTheDocument();
  });

  it("cannot be changed by someone who may only look", () => {
    render(<TemplateSettingsCard entityType="ncr_cost" settings={{ writeMode: "add_only", matchExisting: false, costsOnClosed: true }} onChange={() => {}} readOnly />);
    expect(screen.getByRole("switch", { name: /Allow costs on closed/ })).toBeDisabled();
  });
});

describe("a cost line with no date", () => {
  it("is refused unless the template says to use the date the non-conformance was detected", () => {
    expect(templateSettings("ncr_cost", { missingDate: "nc_detected" }).missingDate).toBe("nc_detected");
    expect(templateSettings("ncr_cost", { missingDate: "import_day" }).missingDate).toBe("reject");
    expect(templateSettings("nonconformance", { missingDate: "nc_detected" })).not.toHaveProperty("missingDate");
  });

  it("makes the date optional in the mapping only when the NC date is used", () => {
    const fields = [{ key: "amount", required: true }, { key: "incurredOn", required: true }];
    expect(fieldsForSettings("ncr_cost", fields, { missingDate: "reject" })).toBe(fields);
    expect(fieldsForSettings("ncr_cost", fields, { missingDate: "nc_detected" }).map((f) => f.required)).toEqual([true, false]);
    expect(fieldsForSettings("supplier", fields, { missingDate: "nc_detected" })).toBe(fields);
  });

  it("offers exactly the two choices on the template", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<TemplateSettingsCard entityType="ncr_cost" settings={{ writeMode: "add_only", matchExisting: false, costsOnClosed: false, missingDate: "reject" }} onChange={onChange} />);
    await user.click(screen.getByRole("combobox", { name: /When a line has no date/ }));
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      expect.stringContaining("Refuse the line"),
      expect.stringContaining("Use the date the non-conformance was detected"),
    ]);
    await user.click(screen.getByRole("option", { name: /Use the date the non-conformance was detected/ }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ missingDate: "nc_detected" }));
  });

  it("says on the run how many lines took the non-conformance's date", () => {
    render(<CostRunCard run={{ costs: costs({ datedFromNc: 3 }) }} preview />);
    expect(screen.getByText("Lines dated from their non-conformance")).toBeInTheDocument();
    expect(screen.getByText(/3 lines had no date, so will take the date their non-conformance was detected/)).toBeInTheDocument();
  });
});

describe("currencies and rates on the run page", () => {
  it("shows each currency with its lines, the ones with a rate and the ones waiting, and says the waiting lines import", () => {
    render(<CostRunCard run={{ costs: costs() }} preview />);
    const table = screen.getByRole("table", { name: /Cost lines by currency/ });
    const xaf = within(table).getByRole("row", { name: /XAF/ });
    expect(within(xaf).getAllByRole("cell").map((c) => c.textContent)).toEqual(["2", "0", "2"]);
    expect(screen.getByText("6 lines · 2 lines have no published rate yet")).toBeInTheDocument();
    expect(screen.getByText("2 lines will wait for a rate")).toBeInTheDocument();
    expect(screen.getByText(/add to no total, and Fortress fills them in on its own/)).toBeInTheDocument();
  });

  it("says nothing is waiting when every line has a rate", () => {
    render(<CostRunCard run={{ costs: costs({ currencies: [{ currency: "EUR", lines: 6, withRate: 6, waiting: 0 }] }) }} preview />);
    expect(screen.getByText(/every line has an exchange rate for its date/)).toBeInTheDocument();
    expect(screen.queryByText(/will wait for a rate/)).not.toBeInTheDocument();
  });

  it("after the import names the lines still waiting for a rate", () => {
    render(<CostRunCard run={{ costs: costs({ waitingNow: 2 }) }} preview={false} />);
    expect(screen.getByText("2 imported lines are still waiting for a rate")).toBeInTheDocument();
    expect(screen.getByText("2 lines will wait for a rate")).toBeInTheDocument();
    expect(screen.getByText(/They were imported without a converted value/)).toBeInTheDocument();
  });

  it("warns about closed and cancelled non-conformances and the template setting that allows them", () => {
    render(<CostRunCard run={{ costs: costs({ onClosed: 3, onCancelled: 1 }) }} preview />);
    const note = screen.getByText("Lines on closed or cancelled non-conformances").closest("div");
    expect(note).toHaveTextContent("3 lines on closed non-conformances and 1 line on cancelled ones");
    expect(note).toHaveTextContent("only when the template allows costs on closed or cancelled non-conformances an import brought in");
  });

  it("mentions the value the source booked", () => {
    render(<CostRunCard run={{ costs: costs({ booked: 4 }) }} preview />);
    expect(screen.getByText(/4 lines carry the value your source booked in the site currency/)).toBeInTheDocument();
  });

  it("shows nothing for a run with no cost summary or no lines", () => {
    const { container, rerender } = render(<CostRunCard run={{ costs: null }} preview />);
    expect(container).toBeEmptyDOMElement();
    rerender(<CostRunCard run={{ costs: costs({ lines: 0, currencies: [] }) }} preview />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("the cost mapping", () => {
  const fields = [
    { key: "nonconformance", label: "Non-conformance", type: "text", required: true, ref: { kind: "nonconformance", source: true } },
    { key: "currency", label: "Currency", type: "currency", required: true },
  ];
  const columns = ["Id", "NC", "Ccy"];
  const Harness = ({ match = "code", withNotice = true }) => {
    const rows = mappingToRows(fields, { fields: [{ target: "nonconformance", source: "NC", match }, { target: "currency", source: "Ccy" }] }, columns);
    return (
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MappingStep fields={fields} columns={columns} keyField="Id" onKeyField={() => {}} rows={rows} onRows={() => {}} notice={withNotice ? <CostCurrencyNotice /> : null} />
      </QueryClientProvider>
    );
  };

  it("explains that nothing is converted in the file and rates come from each line's date", () => {
    render(<Harness />);
    const note = screen.getByRole("note");
    expect(note).toHaveTextContent("Currencies and exchange rates");
    expect(note).toHaveTextContent("on its own incurred date");
    expect(note).toHaveTextContent("never reads a rate from the file");
    expect(note).toHaveTextContent("still imported and fills in when the rate arrives");
  });

  it("matches the non-conformance link by the Fortress reference, or by the id from an earlier import, and says which", async () => {
    const user = userEvent.setup();
    render(<Harness match="source" />);
    await user.click(screen.getByRole("button", { name: "Show settings for Non-conformance" }));
    expect(await screen.findByText(/importing the non-conformances through this connection first/)).toBeInTheDocument();
  });

  it("shows nothing extra for other kinds", () => {
    render(<Harness withNotice={false} />);
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
  });
});

describe("the list of allowed non-conformances", () => {
  it("lists references with their titles and marks the ones that are closed or cancelled", async () => {
    apiFetch.mockImplementation(async () => ({
      kind: "nonconformance",
      word: "non-conformance",
      total: 2,
      data: [
        { code: "SNC-26-0011", name: "Burr on bore", hint: "open", active: true, duplicate: false },
        { code: "SNC-26-0003", name: "Wrong finish", hint: "closed", active: false, duplicate: false },
      ],
    }));
    const field = { key: "nonconformance", label: "Non-conformance", ref: { kind: "nonconformance", source: true } };
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ReferenceValuesDialog field={field} check={null} onClose={() => {}} />
      </QueryClientProvider>,
    );
    const dialog = await screen.findByRole("dialog", { name: "Allowed values for Non-conformance" });
    const codes = await within(dialog).findByRole("list", { name: "Allowed non-conformance codes" });
    expect(within(codes).getByText("SNC-26-0011")).toBeInTheDocument();
    expect(within(codes).getByText("Burr on bore · open")).toBeInTheDocument();
    expect(within(codes).getByText("closed or cancelled")).toBeInTheDocument();
    expect(within(codes).queryByText("inactive")).not.toBeInTheDocument();
    expect(apiFetch).toHaveBeenCalledWith(expect.stringContaining("kind=nonconformance"), expect.anything());
  });
});
