/** Helpers shared by the plan step, the seat picker and Settings → Subscription. Amounts are integer pence, excluding VAT. */

export const TRIAL_DAYS = 14;

export const money = (pence, currency = "GBP") =>
  pence === null || pence === undefined ? "—" : new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(pence / 100);

export const formatDate = (iso) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "—");

export const trialEnd = (from = new Date()) => new Date(from.getTime() + TRIAL_DAYS * 864e5).toISOString();

export const DEFAULT_CHOICE = { interval: "month", seats: { controller: 1, contributor: 0, observer: 0 } };

/** The price per seat for one package at an interval, in pence per month or per year. */
export const unitPrice = (plan, interval) => (interval === "year" ? plan.annual : plan.monthly)?.unitAmount ?? null;

/** What the choice costs per billing period (pence, excluding VAT). */
export const recurringTotal = (plans, { interval, seats }) =>
  plans.reduce((total, plan) => total + (seats[plan.slug] ?? 0) * (unitPrice(plan, interval) ?? 0), 0);

export const seatCount = (seats) => Object.values(seats).reduce((n, q) => n + q, 0);

// The choice survives a trip to Stripe and back (cancelled checkout), per organisation and per browser tab.
const draftKey = (organisationId) => `qms.checkoutChoice.${organisationId}`;

export const loadChoice = (organisationId) => {
  try {
    const saved = JSON.parse(sessionStorage.getItem(draftKey(organisationId)) ?? "null");
    if (saved && (saved.interval === "month" || saved.interval === "year") && saved.seats && typeof saved.seats === "object") {
      return { interval: saved.interval, seats: { ...DEFAULT_CHOICE.seats, ...saved.seats } };
    }
  } catch {
    /* storage unavailable or damaged: start from the default */
  }
  return DEFAULT_CHOICE;
};

/** True when a choice was saved earlier in this tab (a trip to Stripe and back), as opposed to the default. */
export const hasSavedChoice = (organisationId) => {
  try {
    return sessionStorage.getItem(draftKey(organisationId)) !== null;
  } catch {
    return false;
  }
};

export const saveChoice = (organisationId, choice) => {
  try {
    sessionStorage.setItem(draftKey(organisationId), JSON.stringify(choice));
  } catch {
    /* ignore */
  }
};

export const clearChoice = (organisationId) => {
  try {
    sessionStorage.removeItem(draftKey(organisationId));
  } catch {
    /* ignore */
  }
};

/**
 * What a seat change does to the bill, in words (docs/invoice-billing-plan.md I10). Increases are billed at once (a card is charged, an invoiced
 * subscription gets an invoice due in 14 days); decreases are only a credit on the next invoice. `quote` is the API's seat preview.
 */
export const seatChangeWords = (quote) => {
  const code = (quote.currency ?? "gbp").toUpperCase();
  const due = quote.amountDue ?? 0;
  const changes = quote.changes ?? [];
  const mixed = changes.some((c) => c.to > c.from) && changes.some((c) => c.to < c.from);
  const vat = quote.tax > 0 ? `, ${money(quote.tax, code)} of it VAT` : "";
  let words;
  if (quote.timing === "next_invoice") {
    words = due < 0 ? `A credit of ${money(-due, code)} is added to your next invoice` : "Nothing is charged now";
  } else if (due > 0) {
    words =
      quote.payment === "invoice"
        ? `An invoice for ${money(due, code)} is issued now, due in 14 days (prorated${vat})`
        : `Your card is charged ${money(due, code)} now for the rest of this period (prorated${vat})`;
  } else {
    words = "Nothing is charged now";
  }
  return mixed && quote.timing !== "next_invoice" ? `${words}. Any reduction is credited to your next invoice` : words;
};
