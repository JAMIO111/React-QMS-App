import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

let preview;
const lastQuery = vi.fn();
vi.mock("../../hooks/useNcr", () => ({
  useRatePreview: (q) => {
    lastQuery(q);
    return preview;
  },
}));

import CostForm from "./CostForm";

const renderForm = (props = {}) => render(<CostForm baseCurrency="GBP" vatRate={0.2} onSubmit={vi.fn()} onCancel={vi.fn()} {...props} />);
const currencyBox = () => screen.getByRole("combobox", { name: "Currency" });

beforeEach(() => {
  preview = { data: undefined, isLoading: false };
  lastQuery.mockReset();
});

describe("CostForm currency", () => {
  it("starts a new cost in the NC's site currency and looks up the published rate instead of asking for one", () => {
    preview = { data: { rate: 0.85, rateDate: "2026-10-30", state: "published" }, isLoading: false };
    renderForm({ defaultCurrency: "EUR" });
    expect(currencyBox()).toHaveAttribute("placeholder", expect.stringContaining("EUR"));
    expect(screen.queryByLabelText(/Exchange rate \(/)).toBeNull();
    expect(screen.getByLabelText("Exchange rate")).toHaveTextContent("1 EUR = 0.85 GBP");
    expect(lastQuery).toHaveBeenLastCalledWith(expect.objectContaining({ from: "EUR", to: "GBP" }));
  });

  it("says what happens when there is no rate: not published, or the service cannot be reached", () => {
    preview = { data: { rate: null, state: "not_published" }, isLoading: false };
    const { unmount } = renderForm({ defaultCurrency: "AED" });
    expect(screen.getByLabelText("Exchange rate")).toHaveTextContent("No automatic rate is published for AED");
    unmount();
    preview = { data: { rate: null, state: "unavailable" }, isLoading: false };
    renderForm({ defaultCurrency: "AED" });
    expect(screen.getByLabelText("Exchange rate")).toHaveTextContent("could not be looked up just now");
  });

  it("asks for no rate in the site's own currency", () => {
    renderForm();
    expect(currencyBox()).toHaveAttribute("placeholder", expect.stringContaining("GBP"));
    expect(screen.queryByLabelText("Exchange rate")).toBeNull();
    expect(lastQuery).toHaveBeenLastCalledWith(expect.objectContaining({ from: null }));
  });

  it("keeps the currency a saved cost was entered in, whatever the site's is now", () => {
    renderForm({
      defaultCurrency: "USD",
      cost: { costType: "scrap", description: "", incurredOn: "2026-11-01", currency: "GBP", vatTreatment: "none", vatRate: 0, amount: 10, exchangeRate: 1 },
    });
    expect(currencyBox()).toHaveAttribute("placeholder", expect.stringContaining("GBP"));
  });

  it("never sends a rate", async () => {
    const { default: userEvent } = await import("@testing-library/user-event");
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    preview = { data: { rate: 0.85, rateDate: "2026-10-30", state: "published" }, isLoading: false };
    renderForm({
      onSubmit,
      cost: { costType: "labour", description: "", incurredOn: "2026-11-01", currency: "EUR", vatTreatment: "none", vatRate: 0, quantity: 1, unitCost: 10, amount: 10, exchangeRate: 0.9 },
    });
    await user.click(screen.getByRole("button", { name: /Save cost/ }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ currency: "EUR", unitCost: 10 }));
    expect(onSubmit.mock.calls[0][0]).not.toHaveProperty("exchangeRate");
  });
});

describe("CostForm quantity × unit cost", () => {
  it("works the amount out from the quantity and unit cost and sends both", async () => {
    const { default: userEvent } = await import("@testing-library/user-event");
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    renderForm({
      onSubmit,
      cost: { costType: "labour", description: "", incurredOn: "2026-11-01", currency: "GBP", vatTreatment: "none", vatRate: 0, quantity: 1, unitCost: 10, amount: 10, exchangeRate: 1 },
    });
    const qty = screen.getByLabelText("Quantity");
    await user.clear(qty);
    await user.type(qty, "2.5");
    const unit = screen.getByLabelText("Unit cost");
    await user.clear(unit);
    await user.type(unit, "33.333");
    expect(screen.getByLabelText("Cost preview")).toHaveTextContent("2.5 × £33.333 = £83.33");
    await user.click(screen.getByRole("button", { name: /Save cost/ }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ quantity: 2.5, unitCost: 33.333 }));
    expect(onSubmit.mock.calls[0][0]).not.toHaveProperty("amount");
  });

  it("starts a new line at one, and a line from before quantities as one at its amount", async () => {
    renderForm();
    expect(screen.getByLabelText("Quantity")).toHaveValue(1);
  });

  it("refuses a quantity of nothing", async () => {
    const { default: userEvent } = await import("@testing-library/user-event");
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    renderForm({
      onSubmit,
      cost: { costType: "scrap", description: "", incurredOn: "2026-11-01", currency: "GBP", vatTreatment: "none", vatRate: 0, amount: 12, exchangeRate: 1 },
    });
    expect(screen.getByLabelText("Unit cost")).toHaveValue(12);
    const qty = screen.getByLabelText("Quantity");
    await user.clear(qty);
    await user.type(qty, "0");
    await user.click(screen.getByRole("button", { name: /Save cost/ }));
    expect(await screen.findByText("Must be more than 0")).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
