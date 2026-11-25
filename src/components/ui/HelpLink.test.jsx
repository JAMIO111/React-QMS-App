import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("../../lib/api-client", async (importOriginal) => ({ ...(await importOriginal()), apiFetch: vi.fn(async () => ({ data: [] })) }));
vi.mock("../../contexts/OrganisationProvider", () => ({ useOrganisation: () => ({ organisationId: "org-1" }) }));

import HelpLink from "./HelpLink";
import FilterBuilder from "../integrations/FilterBuilder";
import FormulaEditor from "../integrations/FormulaEditor";
import { HELP_TOPICS, helpUrl } from "../../lib/help";

const wrap = (ui) => render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);

describe("links to the formula guide", () => {
  it("opens the guide on the website in a new tab", () => {
    render(<HelpLink topic={HELP_TOPICS.importFormulas}>How to write a formula</HelpLink>);
    const link = screen.getByRole("link", { name: /How to write a formula/ });
    expect(link).toHaveAttribute("href", "https://fortress-qms.com/help/import-formulas");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(link).toHaveAccessibleName(/opens in a new tab/);
    expect(helpUrl("x")).toBe("https://fortress-qms.com/help/x");
  });

  it("sits beside the field formula editor", () => {
    wrap(<FormulaEditor label="Formula" value="" onChange={() => {}} columns={["Code"]} sample={{ Code: "A" }} />);
    expect(screen.getByRole("link", { name: /How to write a formula/ })).toHaveAttribute("href", helpUrl("import-formulas"));
  });

  it("sits under a filter formula, and not beside filter rules", () => {
    const { unmount } = wrap(<FilterBuilder columns={["Status"]} value={{ mode: "keep", match: "all", rules: [], formula: '[Status] = "Active"' }} onChange={() => {}} advanced />);
    expect(screen.getByRole("link", { name: /How to write a formula/ })).toHaveAttribute("href", helpUrl("import-formulas"));
    unmount();
    wrap(<FilterBuilder columns={["Status"]} value={{ mode: "keep", match: "all", rules: [{ column: "Status", test: "equals", value: "Active" }] }} onChange={() => {}} advanced />);
    expect(screen.queryByRole("link", { name: /How to write a formula/ })).toBeNull();
  });
});
