import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const apiFetch = vi.fn();
const updateMutate = vi.fn();
const confirm = vi.fn();
vi.mock("../../lib/api-client", async (importOriginal) => ({ ...(await importOriginal()), apiFetch: (...a) => apiFetch(...a) }));
vi.mock("../../contexts/OrganisationProvider", () => ({ useOrganisation: () => ({ organisationId: "org-1" }) }));
vi.mock("../../contexts/ConfirmationModalProvider", () => ({ useConfirm: () => confirm }));
vi.mock("../../contexts/ToastProvider", () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock("../../hooks/useQmsApi", () => ({ useUpdateOrganisation: () => ({ mutate: updateMutate, isPending: false }), useOrganisationDetails: () => ({ data: undefined }) }));

import ProductionSettings from "./ProductionSettings";

const settings = { useLotsAndSerials: true, allowInlineOrders: false, requireProductionOrder: false };
const report = (over = {}) => ({
  dryRun: true,
  orders: { new: 3, matched: 1, skipped: [{ number: "WO-200", reason: "typed against more than one part" }] },
  lots: { new: 2, matched: 0 },
  serialNumbers: { new: 5, matched: 0 },
  recordsToLink: 12,
  noPart: 1,
  unusableText: 0,
  conflicts: 0,
  inspectionsLinked: 0,
  ncrsLinked: 0,
  ...over,
});

const renderIt = (props = {}) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ProductionSettings settings={settings} canManage {...props} />
    </QueryClientProvider>
  );

beforeEach(() => {
  apiFetch.mockReset();
  updateMutate.mockReset();
  confirm.mockReset();
  confirm.mockResolvedValue(true);
});

describe("production settings", () => {
  it("shows each setting as a switch and saves one change at a time with a reason", async () => {
    renderIt();
    expect(screen.getByRole("switch", { name: "Track lots and serial numbers" })).toBeChecked();
    expect(screen.getByRole("switch", { name: "Let operators make an order from a job" })).not.toBeChecked();
    await userEvent.click(screen.getByRole("switch", { name: "Track lots and serial numbers" }));
    expect(updateMutate).toHaveBeenCalledWith({ body: { settings: { useLotsAndSerials: false } }, reason: "Track lots and serial numbers: off" }, expect.any(Object));
    await userEvent.click(screen.getByRole("switch", { name: "Require a production order to complete a job" }));
    expect(updateMutate).toHaveBeenLastCalledWith({ body: { settings: { requireProductionOrder: true } }, reason: "Require a production order to complete a job: on" }, expect.any(Object));
  });

  it("is read-only without organisation.manage, and offers no backfill", () => {
    renderIt({ canManage: false });
    for (const sw of screen.getAllByRole("switch")) expect(sw).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Preview" })).toBeNull();
  });

  it("previews the backfill without changing anything, then links after a confirmation", async () => {
    apiFetch.mockResolvedValueOnce(report());
    renderIt();
    expect(screen.queryByRole("button", { name: "Link them" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Preview" }));
    const shown = await screen.findByLabelText("Backfill report");
    expect(apiFetch).toHaveBeenCalledWith("/production/backfill", expect.objectContaining({ method: "POST", body: { dryRun: true } }));
    expect(within(shown).getByText("This is what would happen (nothing has changed):")).toBeInTheDocument();
    expect(within(shown).getByText(/3 production orders would be made, 1 already exist and would be used/)).toBeInTheDocument();
    expect(within(shown).getByText(/2 lots and 5 serial numbers would be made/)).toBeInTheDocument();
    expect(within(shown).getByText(/12 inspections and non-conformances would be linked/)).toBeInTheDocument();
    expect(within(shown).getByText(/1 record has text but no part/)).toBeInTheDocument();
    expect(within(shown).getByText("WO-200: typed against more than one part")).toBeInTheDocument();
    expect(confirm).not.toHaveBeenCalled();

    apiFetch.mockResolvedValueOnce(report({ dryRun: false, inspectionsLinked: 8, ncrsLinked: 4 }));
    await userEvent.click(screen.getByRole("button", { name: "Link them" }));
    await waitFor(() => expect(apiFetch).toHaveBeenLastCalledWith("/production/backfill", expect.objectContaining({ body: { dryRun: false } })));
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ title: "Link the existing records?" }));
    expect(await screen.findByText("Done:")).toBeInTheDocument();
    expect(screen.getByText(/8 inspections and 4 non-conformances linked/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Link them" })).toBeNull();
  });

  it("does nothing when the confirmation is declined", async () => {
    apiFetch.mockResolvedValueOnce(report());
    confirm.mockResolvedValueOnce(false);
    renderIt();
    await userEvent.click(screen.getByRole("button", { name: "Preview" }));
    await screen.findByLabelText("Backfill report");
    await userEvent.click(screen.getByRole("button", { name: "Link them" }));
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it("will not offer to link when there is nothing to link", async () => {
    apiFetch.mockResolvedValueOnce(report({ recordsToLink: 0, orders: { new: 0, matched: 0, skipped: [] }, lots: { new: 0, matched: 0 }, serialNumbers: { new: 0, matched: 0 }, noPart: 0 }));
    renderIt();
    await userEvent.click(screen.getByRole("button", { name: "Preview" }));
    await screen.findByLabelText("Backfill report");
    expect(screen.getByRole("button", { name: "Link them" })).toBeDisabled();
  });
});
