import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import CostForm from "./CostForm";

const renderForm = (props = {}) => render(<CostForm baseCurrency="GBP" vatRate={0.2} onSubmit={vi.fn()} onCancel={vi.fn()} {...props} />);
const currencyBox = () => screen.getByRole("combobox", { name: "Currency" });

describe("CostForm currency", () => {
  it("starts a new cost in the NC's site currency and asks for the exchange rate when it differs from the organisation's", () => {
    renderForm({ defaultCurrency: "EUR" });
    expect(currencyBox()).toHaveAttribute("placeholder", expect.stringContaining("EUR"));
    expect(screen.getByLabelText(/Exchange rate \(1 EUR = \? GBP\)/)).toBeInTheDocument();
  });

  it("falls back to the organisation's currency when the site has none", () => {
    renderForm();
    expect(currencyBox()).toHaveAttribute("placeholder", expect.stringContaining("GBP"));
    expect(screen.queryByLabelText(/Exchange rate/)).toBeNull();
  });

  it("keeps the currency a saved cost was entered in, whatever the site's is now", () => {
    renderForm({
      defaultCurrency: "USD",
      cost: { costType: "scrap", description: "", incurredOn: "2026-11-01", currency: "GBP", vatTreatment: "none", vatRate: 0, amount: 10, exchangeRate: 1 },
    });
    expect(currencyBox()).toHaveAttribute("placeholder", expect.stringContaining("GBP"));
  });
});
