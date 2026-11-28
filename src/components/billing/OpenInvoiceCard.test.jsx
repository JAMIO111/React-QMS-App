import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import OpenInvoiceCard from "./OpenInvoiceCard";

const invoice = { id: "i1", number: "INV-0042", total: 7500, currency: "GBP", dueOn: "2026-12-03", overdueDays: 0, hostedUrl: "https://pay.test/i/1", pdfUrl: "https://pay.test/pdf/1" };
const sub = (over = {}) => ({ paymentRoute: "invoice", currency: "GBP", paymentTermsDays: 14, openInvoice: invoice, firstInvoicePending: false, ...over });

afterEach(() => vi.restoreAllMocks());

describe("OpenInvoiceCard", () => {
  it("shows nothing for a card subscription", () => {
    const { container } = render(<OpenInvoiceCard sub={{ paymentRoute: "card" }} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("says nothing is owed when there is no open invoice", () => {
    render(<OpenInvoiceCard sub={sub({ openInvoice: null })} />);
    expect(screen.getByText(/No invoice is waiting to be paid/)).toBeInTheDocument();
  });

  it("names the invoice, opens Stripe's page to pay it and the PDF to download it", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    render(<OpenInvoiceCard sub={sub()} />);
    expect(screen.getByRole("status")).toHaveTextContent("Invoice INV-0042 for £75.00 is due on 3 Dec 2026");
    await userEvent.click(screen.getByRole("button", { name: "Pay this invoice" }));
    expect(open).toHaveBeenCalledWith("https://pay.test/i/1", "_blank", "noopener,noreferrer");
    await userEvent.click(screen.getByRole("button", { name: "Download" }));
    expect(open).toHaveBeenLastCalledWith("https://pay.test/pdf/1", "_blank", "noopener,noreferrer");
  });

  it("says what is held back until the first invoice is paid, and raises an alert when it is overdue", () => {
    render(<OpenInvoiceCard sub={sub({ firstInvoicePending: true, openInvoice: { ...invoice, overdueDays: 2 } })} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Your first invoice is waiting to be paid");
    expect(screen.getByRole("alert")).toHaveTextContent(/2 days overdue/);
    expect(screen.getByRole("alert")).toHaveTextContent(/Seats can be added and reporting keys made once it is paid/);
    expect(screen.getByRole("alert")).toHaveTextContent(/Access stops if it stays unpaid/);
  });

  it("offers no pay button when Stripe has not given a page", () => {
    render(<OpenInvoiceCard sub={sub({ openInvoice: { ...invoice, hostedUrl: null, pdfUrl: null } })} />);
    expect(screen.queryByRole("button", { name: "Pay this invoice" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Download" })).toBeNull();
  });
});
