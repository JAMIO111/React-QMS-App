import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const apiFetch = vi.fn();
vi.mock("../../lib/api-client", async (importOriginal) => ({ ...(await importOriginal()), apiFetch: (...a) => apiFetch(...a) }));
vi.mock("../../contexts/OrganisationProvider", () => ({ useOrganisation: () => ({ organisationId: "org-1" }) }));

import ReconciliationCard from "./ReconciliationCard";
import { ADD_ONLY_KINDS, ADD_UPDATE_KINDS, templateSettings } from "../../lib/importTemplates";
import { ENTITY_DESCRIPTIONS, ENTITY_LABELS, recordPath } from "../../lib/integrations";

const row = (over = {}) => ({ poLineId: "l1", poNumber: "PO-1", lineNumber: 2, supplier: "ACME", item: "Bolts", sourceQuantity: 380, sourceLastReceivedOn: "2026-11-01", fortressQuantity: 400, fortressLastReceivedOn: "2026-11-01", recordedAt: "2026-11-10T09:00:00Z", state: "over", ...over });
const renderCard = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ReconciliationCard connectionId="c1" />
    </QueryClientProvider>
  );

beforeEach(() => apiFetch.mockReset());

describe("received quantities check", () => {
  it("lists the order lines where Fortress and the source disagree", async () => {
    apiFetch.mockResolvedValue({ data: [row()], counts: { short: 0, over: 1, date: 0, match: 3 } });
    renderCard();
    const table = await screen.findByRole("table", { name: "Received quantities check" });
    expect(within(table).getByText("PO-1 / 2")).toBeInTheDocument();
    expect(within(table).getByText("380")).toBeInTheDocument();
    expect(within(table).getByText("400")).toBeInTheDocument();
    expect(within(table).getByText("Fortress has more")).toBeInTheDocument();
    expect(screen.getByText(/1 of 4 lines disagree/)).toBeInTheDocument();
    expect(apiFetch.mock.calls[0][0]).toBe("/integrations/connections/c1/reconciliation");
  });

  it("can show the lines that agree too", async () => {
    apiFetch.mockImplementation(async (...args) =>
      String(args[0]).includes("all=true")
        ? { data: [row(), row({ poLineId: "l2", lineNumber: 1, sourceQuantity: 150, fortressQuantity: 150, state: "match" })], counts: { short: 0, over: 1, date: 0, match: 1 } }
        : { data: [row()], counts: { short: 0, over: 1, date: 0, match: 1 } }
    );
    renderCard();
    await screen.findByText("PO-1 / 2");
    await userEvent.click(screen.getByRole("switch", { name: "Show lines that agree" }));
    expect(await screen.findByText("Agrees")).toBeInTheDocument();
  });

  it("says nothing until a source has reported totals", async () => {
    apiFetch.mockResolvedValue({ data: [], counts: { short: 0, over: 0, date: 0, match: 0 } });
    const { container } = renderCard();
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("knows the new kinds of record and their fixed settings", () => {
    expect(ENTITY_LABELS.po_receipt_total).toBe("Received quantities");
    expect(ENTITY_DESCRIPTIONS.goods_receipt).toMatch(/never sent for inspection/);
    expect(recordPath("goods_receipt", "x")).toBe("/Supplier-Quality/Goods-Receipts");
    expect(ADD_ONLY_KINDS).toContain("goods_receipt");
    expect(ADD_UPDATE_KINDS).toEqual(["po_receipt_total"]);
    expect(templateSettings("goods_receipt", { writeMode: "add_update", matchExisting: true })).toEqual({ writeMode: "add_only", matchExisting: false });
    expect(templateSettings("po_receipt_total", { writeMode: "add_only" })).toEqual({ writeMode: "add_update", matchExisting: false });
    expect(templateSettings("purchase_order", { writeMode: "add_update", matchExisting: true })).toEqual({ writeMode: "add_update", matchExisting: true });
  });
});
