import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

let permissions;
const apiFetch = vi.fn();
vi.mock("../../lib/api-client", async (importOriginal) => ({ ...(await importOriginal()), apiFetch: (...a) => apiFetch(...a) }));
vi.mock("../../contexts/OrganisationProvider", () => ({ useOrganisation: () => ({ organisationId: "org-1" }) }));
vi.mock("../../hooks/useQmsApi", () => ({ usePermissions: () => ({ can: (p) => permissions.includes(p) }) }));
vi.mock("../ppap/PpapDialogs", () => ({ NewPpapDialog: ({ defaults }) => <div role="dialog">Record dialog {defaults.direction} {defaults.supplier.name}</div> }));

import SupplierPpap from "./SupplierPpap";

const supplier = { id: "s1", code: "ACME", name: "Acme Castings" };
const row = (over = {}) => ({
  partId: "p1", partNumber: "PN-1", partName: "Housing", revision: "A", state: "approved", submissionId: "k1", reference: "PPAP-26-0001", status: "approved", interimExpiresOn: null, nextReviewOn: "2027-06-01", ...over,
});
const answer = (data, over = {}) => ({
  available: true, data, counts: { approved: data.filter((d) => d.state === "approved").length, interim: data.filter((d) => d.state === "interim").length, notApproved: data.filter((d) => !["approved", "interim"].includes(d.state)).length }, ...over,
});
const renderUi = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter><SupplierPpap supplier={supplier} /></MemoryRouter><div id="modal-root" /></QueryClientProvider>);

beforeEach(() => {
  permissions = ["supplier_quality.read", "ppap.read", "ppap.manage"];
  apiFetch.mockReset();
});

describe("the supplier's part approvals tab", () => {
  it("shows where each part stands, with the dates that matter and a link to the package", async () => {
    apiFetch.mockResolvedValue(
      answer([
        row(),
        row({ partId: "p2", partNumber: "PN-2", partName: "Cover", state: "interim", status: "interim_approved", submissionId: "k2", reference: "PPAP-26-0002", interimExpiresOn: "2026-12-31", nextReviewOn: null }),
        row({ partId: "p3", partNumber: "PN-3", partName: "Bracket", state: "in_preparation", status: "in_preparation", submissionId: "k3", reference: "PPAP-26-0003", nextReviewOn: null }),
      ])
    );
    renderUi();
    const table = await screen.findByRole("table", { name: "Part approvals of this supplier" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent("Approved");
    expect(rows[0]).toHaveTextContent("Review");
    expect(within(rows[0]).getByRole("link", { name: "PPAP-26-0001" })).toHaveAttribute("href", "/PPAP/k1");
    expect(rows[1]).toHaveTextContent("Interim approval");
    expect(rows[1]).toHaveTextContent("Runs to");
    expect(rows[2]).toHaveTextContent("In preparation");
    expect(screen.getByText(/on an interim approval/, { selector: "p" })).toHaveTextContent("1 approved · 1 on an interim approval · 1 not approved");
    expect(apiFetch.mock.calls[0][0]).toBe("/supplier-quality/suppliers/s1/ppap");
  });

  it("warns when an interim approval has run out, and says it changes nothing", async () => {
    apiFetch.mockResolvedValue(answer([row({ state: "interim_lapsed", status: "interim_approved", interimExpiresOn: "2026-01-01", nextReviewOn: null })]));
    renderUi();
    expect(await screen.findByText("An interim approval has run out")).toBeInTheDocument();
    expect(screen.getByText(/never changes the supplier's approval status/)).toBeInTheDocument();
  });

  it("says plainly when there are no packages, and when the person may not read them", async () => {
    apiFetch.mockResolvedValue(answer([]));
    renderUi();
    expect(await screen.findByText("No part approval package has been recorded for this supplier.")).toBeInTheDocument();
  });

  it("says it is not available, never an empty list, without access", async () => {
    apiFetch.mockResolvedValue({ available: false, data: [], counts: { approved: 0, interim: 0, notApproved: 0 } });
    renderUi();
    expect(await screen.findByText("You do not have access to part approvals.")).toBeInTheDocument();
    expect(screen.queryByText(/No part approval package/)).not.toBeInTheDocument();
  });

  it("records a package for this supplier from the tab", async () => {
    apiFetch.mockResolvedValue(answer([]));
    renderUi();
    await userEvent.click(await screen.findByRole("button", { name: "Record a package" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("Record dialog received Acme Castings");
  });

  it("offers no record button without ppap.manage", async () => {
    permissions = ["supplier_quality.read", "ppap.read"];
    apiFetch.mockResolvedValue(answer([]));
    renderUi();
    await screen.findByText("No part approval package has been recorded for this supplier.");
    expect(screen.queryByRole("button", { name: "Record a package" })).not.toBeInTheDocument();
  });
});
