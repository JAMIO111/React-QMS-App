import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

let permissions;
const apiFetch = vi.fn();
vi.mock("../../lib/api-client", async (importOriginal) => ({ ...(await importOriginal()), apiFetch: (...a) => apiFetch(...a) }));
vi.mock("../../contexts/OrganisationProvider", () => ({ useOrganisation: () => ({ organisationId: "org-1" }) }));
vi.mock("../../hooks/useQmsApi", () => ({ usePermissions: () => ({ can: (p) => permissions.includes(p) }) }));

import InspectionRecommendation from "./InspectionRecommendation";

const supplier = { id: "s1", code: "ACME", name: "Acme Metals" };
const basis = { days: 90, from: "2026-08-12", to: "2026-11-09", approvalStatus: "approved", riskRating: "high", band: "poor", score: 42, deliveredLines: 6, rejectedLines: 1, criticalNcs: 1, majorNcs: 0, overdueScars: 0, expiredCerts: 1, minLines: 5 };
const rec = (over = {}) => ({
  level: "increased", canReduce: false, change: "raise", current: { level: "normal", ruleId: null, ruleName: null, basis: "default" }, basis,
  reasons: [{ code: "risk", kind: "raises", message: "The supplier's risk rating is high" }, { code: "band", kind: "raises", message: "The supplier's performance is poor" }], generatedAt: "2026-11-09T10:00:00Z", ...over,
});
const renderUi = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter><InspectionRecommendation supplier={supplier} /></MemoryRouter></QueryClientProvider>);

beforeEach(() => {
  permissions = ["supplier_quality.read", "receiving.read", "supplier_quality.manage"];
  apiFetch.mockReset();
});

describe("inspection recommendation", () => {
  it("says what it recommends, why, and how it differs from today, and offers to write a requirement", async () => {
    apiFetch.mockResolvedValue(rec());
    renderUi();
    expect(await screen.findByText("Consider increased inspection")).toBeInTheDocument();
    expect(screen.getByText("The supplier's risk rating is high")).toBeInTheDocument();
    expect(screen.getByText(/no supplier-wide requirement, so the default applies/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Write a requirement" })).toHaveAttribute("href", "/Supplier-Quality/Inspection-Requirements");
    expect(apiFetch.mock.calls[0][0]).toBe("/supplier-quality/suppliers/s1/inspection-recommendation?days=90");
  });

  it("says which parts have no approved part approval package, and notes when they could not be read", async () => {
    apiFetch.mockResolvedValue(rec({
      reasons: [{ code: "ppap_not_approved", kind: "raises", message: "2 parts have no approved part approval package (PPAP): PN-1, PN-2" }],
      basis: { ...basis, ppap: { available: true, notApproved: ["PN-1", "PN-2"], interim: ["PN-3"] } },
    }));
    renderUi();
    expect(await screen.findByText(/PN-1, PN-2/)).toBeInTheDocument();
    expect(screen.getByText(/part approvals: 2 not approved, 1 interim/)).toBeInTheDocument();
  });

  it("does not mention part approvals when the person may not read them", async () => {
    apiFetch.mockResolvedValue(rec({ basis: { ...basis, ppap: { available: false, notApproved: [], interim: [] } } }));
    renderUi();
    await screen.findByText("Consider increased inspection");
    expect(screen.queryByText(/part approvals:/)).not.toBeInTheDocument();
  });

  it("reminds that a reduction never reaches a part with a critical characteristic, and offers nothing when nothing changes", async () => {
    apiFetch.mockResolvedValue(rec({ level: "reduced", canReduce: true, change: "lower", reasons: [{ code: "earned", kind: "supports", message: "Approved, low risk" }] }));
    renderUi();
    expect(await screen.findByText("This supplier has earned a lower level of inspection")).toBeInTheDocument();
    expect(screen.getByText(/never applied to a part with a critical characteristic/)).toBeInTheDocument();
  });

  it("offers no action when the level already fits", async () => {
    apiFetch.mockResolvedValue(rec({ level: "normal", change: "none", reasons: [{ code: "band_not_good", kind: "blocks_reduction", message: "Performance is watch, not good" }] }));
    renderUi();
    expect(await screen.findByText("The current level (normal) fits")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Write a requirement" })).toBeNull();
  });

  it("shows nothing to someone who cannot read supplier quality and receiving", () => {
    permissions = ["supplier_quality.read"];
    renderUi();
    expect(screen.queryByText("Recommended inspection level")).toBeNull();
    expect(apiFetch).not.toHaveBeenCalled();
  });
});
