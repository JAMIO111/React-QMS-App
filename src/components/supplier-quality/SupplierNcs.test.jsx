import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const apiFetch = vi.fn();
vi.mock("../../lib/api-client", async (importOriginal) => ({ ...(await importOriginal()), apiFetch: (...a) => apiFetch(...a) }));
vi.mock("../../contexts/OrganisationProvider", () => ({ useOrganisation: () => ({ organisationId: "org-1" }) }));

import SupplierNcs from "./SupplierNcs";
import { OPEN_NC_STAGES } from "../../lib/supplierQuality";

const supplier = { id: "s1", name: "Acme Metals Ltd", displayName: "Acme", counts: { openNcs: 1, totalNcs: 2 } };
const row = (over = {}) => ({
  id: "n1", reference: "NC-000001", title: "Bent bracket", source: "goods_receiving", stage: "open", severity: "major",
  detectedAt: "2026-11-01", part: { id: "p1", partNumber: "BR-100" }, ...over,
});
const renderUi = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <SupplierNcs supplier={supplier} />
      </MemoryRouter>
    </QueryClientProvider>
  );

beforeEach(() => apiFetch.mockReset());

describe("SupplierNcs", () => {
  it("asks for this supplier's open non-conformances and shows where each was found", async () => {
    apiFetch.mockResolvedValue({ data: [row()], page: 1, pageSize: 25, total: 1 });
    renderUi();
    expect(await screen.findByText("NC-000001")).toBeInTheDocument();
    expect(screen.getByText("Goods receiving")).toBeInTheDocument();
    const path = apiFetch.mock.calls[0][0];
    expect(path).toContain("supplierId=s1");
    expect(path).toContain(`stage=${encodeURIComponent(OPEN_NC_STAGES.join(","))}`);
    expect(screen.getByRole("link", { name: "NC-000001" })).toHaveAttribute("href", "/Non-Conformance/Register/n1");
  });

  it("All drops the stage filter", async () => {
    apiFetch.mockResolvedValue({ data: [], page: 1, pageSize: 25, total: 0 });
    renderUi();
    expect(await screen.findByText("No open non-conformances for this supplier.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "All" }));
    await waitFor(() => expect(apiFetch.mock.calls.at(-1)[0]).not.toContain("stage="));
    expect(await screen.findByText("No non-conformances for this supplier.")).toBeInTheDocument();
  });
});
