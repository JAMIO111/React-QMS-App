import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CHOICE, EMPTY_COMPANY, INVOICE_TERMS_DAYS, clearChoice, companyProblems, invoiceBody, invoiceStartWords, loadRoute, newClientKey, owedWords, saveRoute, formatDate, loadChoice, money, recurringTotal, saveChoice, seatChangeWords, seatCount, trialEnd, unitPrice, seatPlans, feeTotal, freeObserverLimit, observerProblem } from "./billing";

const plans = [
  { slug: "observer", monthly: { unitAmount: 500 }, annual: { unitAmount: 5000 } },
  { slug: "controller", monthly: { unitAmount: 2500 }, annual: { unitAmount: 25000 } },
];

describe("billing helpers", () => {
  beforeEach(() => sessionStorage.clear());

  it("formats pence as pounds, and dashes for nothing", () => {
    expect(money(2500)).toBe("£25.00");
    expect(money(0)).toBe("£0.00");
    expect(money(null)).toBe("—");
    expect(formatDate("2026-01-15T00:00:00Z")).toBe("15 Jan 2026");
    expect(formatDate(null)).toBe("—");
  });

  it("prices a choice per billing period", () => {
    expect(unitPrice(plans[1], "month")).toBe(2500);
    expect(unitPrice(plans[1], "year")).toBe(25000);
    expect(recurringTotal(plans, { interval: "month", seats: { controller: 2, observer: 3 } })).toBe(6500);
    expect(recurringTotal(plans, { interval: "year", seats: { controller: 1, observer: 0 } })).toBe(25000);
    expect(seatCount({ controller: 2, observer: 3 })).toBe(5);
  });

  it("adds the organisation fee once, never as a seat, and limits free Observers to twice the paid seats", () => {
    const withFee = [
      { slug: "organisation", kind: "fee", monthly: { unitAmount: 9900 }, annual: { unitAmount: 99000 } },
      { slug: "observer", kind: "seat", monthly: { unitAmount: 0 }, annual: { unitAmount: 0 } },
      { slug: "operator", kind: "seat", monthly: { unitAmount: 600 }, annual: { unitAmount: 6000 } },
      { slug: "controller", kind: "seat", monthly: { unitAmount: 4900 }, annual: { unitAmount: 49000 } },
    ];
    expect(seatPlans(withFee).map((p) => p.slug)).toEqual(["observer", "operator", "controller"]);
    expect(feeTotal(withFee, "month")).toBe(9900);
    expect(recurringTotal(withFee, { interval: "month", seats: { controller: 1, operator: 5, observer: 4 } })).toBe(9900 + 4900 + 5 * 600);
    expect(recurringTotal(withFee, { interval: "year", seats: { controller: 1 } })).toBe(99000 + 49000);
    expect(seatCount({ controller: 1, operator: 2, organisation: 1 })).toBe(3);
    expect(freeObserverLimit({ controller: 1, operator: 2, observer: 9 })).toBe(6);
    expect(observerProblem({ controller: 1, operator: 2, observer: 6 })).toBeNull();
    expect(observerProblem({ controller: 1, operator: 2, observer: 7 })).toMatch(/free up to twice the paid seats \(6 here\)/);
  });

  it("ends the trial 14 days from now", () => {
    const from = new Date("2026-01-01T00:00:00Z");
    expect(trialEnd(from)).toBe("2026-01-15T00:00:00.000Z");
  });

  it("remembers the choice per organisation, and survives damaged storage", () => {
    expect(loadChoice("org-1")).toEqual(DEFAULT_CHOICE);
    saveChoice("org-1", { interval: "year", seats: { controller: 3 } });
    expect(loadChoice("org-1")).toEqual({ interval: "year", seats: { controller: 3, contributor: 0, operator: 0, observer: 0 } });
    expect(loadChoice("org-2")).toEqual(DEFAULT_CHOICE);
    sessionStorage.setItem("qms.checkoutChoice.org-3", "{not json");
    expect(loadChoice("org-3")).toEqual(DEFAULT_CHOICE);
    sessionStorage.setItem("qms.checkoutChoice.org-4", JSON.stringify({ interval: "week", seats: {} }));
    expect(loadChoice("org-4")).toEqual(DEFAULT_CHOICE);
    clearChoice("org-1");
    expect(loadChoice("org-1")).toEqual(DEFAULT_CHOICE);
  });
});

describe("seatChangeWords", () => {
  const base = { currency: "gbp", tax: 200, changes: [{ planSlug: "controller", from: 2, to: 3 }] };

  it("says a card is charged now for an increase, and how much of it is VAT", () => {
    expect(seatChangeWords({ ...base, amountDue: 1200, timing: "now", payment: "card" })).toBe("Your card is charged £12.00 now for the rest of this period (prorated, £2.00 of it VAT)");
  });

  it("says an invoice is issued now, due in 14 days, for an invoiced subscription", () => {
    expect(seatChangeWords({ ...base, tax: 0, amountDue: 1000, timing: "now", payment: "invoice" })).toBe("An invoice for £10.00 is issued now, due in 14 days (prorated)");
  });

  it("says a decrease is a credit on the next invoice, never a refund", () => {
    expect(seatChangeWords({ currency: "gbp", tax: 0, amountDue: -1000, timing: "next_invoice", payment: "card", changes: [{ planSlug: "controller", from: 3, to: 2 }] })).toBe("A credit of £10.00 is added to your next invoice");
  });

  it("says when a mixed change also credits a reduction, and when nothing is charged", () => {
    const mixed = { currency: "gbp", tax: 0, amountDue: 1000, timing: "now", payment: "card", changes: [{ planSlug: "controller", from: 2, to: 3 }, { planSlug: "observer", from: 4, to: 1 }] };
    expect(seatChangeWords(mixed)).toMatch(/charged £10\.00 now.*Any reduction is credited to your next invoice$/);
    expect(seatChangeWords({ ...mixed, amountDue: 0, changes: [{ planSlug: "controller", from: 2, to: 2 }] })).toBe("Nothing is charged now");
  });
});

describe("paying by invoice", () => {
  beforeEach(() => sessionStorage.clear());
  const company = { ...EMPTY_COMPANY, legalName: "Acme Ltd", billingEmail: "accounts@acme.test", addressLine1: "1 High Street", city: "Leeds", postcode: "LS1 1AA", country: "GB" };

  it("remembers card or invoice for the tab, card by default", () => {
    expect(loadRoute("org-1")).toBe("card");
    saveRoute("org-1", "invoice");
    expect(loadRoute("org-1")).toBe("invoice");
    expect(loadRoute("org-2")).toBe("card");
  });

  it("says what is still needed for the company, one thing at a time and in the form's order", () => {
    expect(companyProblems(EMPTY_COMPANY)[0]).toMatch(/legal name/);
    expect(companyProblems({ ...company, billingEmail: "nope" })).toEqual(["Enter the email address invoices should be sent to."]);
    expect(companyProblems({ ...company, postcode: " " })[0]).toMatch(/billing address/);
    expect(companyProblems({ ...company, country: "" })[0]).toMatch(/billing address/);
    expect(companyProblems(company)).toEqual([]);
  });

  it("builds the request: seats above zero, tidy text, empty optional fields left out", () => {
    const body = invoiceBody({ choice: { interval: "year", seats: { controller: 2, contributor: 0, observer: 0 } }, company: { ...company, legalName: "  Acme Ltd ", vatNumber: " GB123 ", poReference: "" }, clientKey: "iv-abc" });
    expect(body).toEqual({
      interval: "year",
      seats: { controller: 2 },
      company: { legalName: "Acme Ltd", billingEmail: "accounts@acme.test", addressLine1: "1 High Street", city: "Leeds", postcode: "LS1 1AA", country: "GB", vatNumber: "GB123" },
      clientKey: "iv-abc",
    });
    expect(newClientKey()).toMatch(/^iv-/);
    expect(newClientKey()).not.toBe(newClientKey());
  });

  it("says what is owed and how late", () => {
    const invoice = { number: "INV-0042", total: 7500, currency: "GBP", dueOn: "2026-12-03", overdueDays: 0 };
    expect(owedWords(invoice)).toBe("Invoice INV-0042 for £75.00 is due on 3 Dec 2026");
    expect(owedWords({ ...invoice, overdueDays: 1 })).toBe("Invoice INV-0042 for £75.00 was due on 3 Dec 2026 and is 1 day overdue");
    expect(owedWords({ ...invoice, overdueDays: 5 })).toMatch(/5 days overdue/);
    expect(owedWords({ ...invoice, number: null, dueOn: null })).toBe("An invoice for £75.00 is waiting to be paid");
    expect(owedWords(null)).toBe("");
  });

  it("explains the invoice route before it starts: the amount, the address, the terms, no trial", () => {
    const words = invoiceStartWords({ total: 7500, interval: "month", email: " accounts@acme.test " });
    expect(words).toContain("£75.00");
    expect(words).toContain("accounts@acme.test");
    expect(words).toContain(`within ${INVOICE_TERMS_DAYS} days`);
    expect(words).toContain("no free trial");
    expect(invoiceStartWords({ total: 7500, interval: "year", email: "" })).toContain("your billing address");
  });
});
