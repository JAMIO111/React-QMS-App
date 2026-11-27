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

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// Paying by invoice (docs/invoice-billing-plan.md): the company an invoice is for, the route choice and the words for what is owed.
// ---------------------------------------------------------------------------------------------------------------------------------------------------

/** Days an invoice is payable within (the API fixes it too). */
export const INVOICE_TERMS_DAYS = 14;

export const EMPTY_COMPANY = { legalName: "", billingEmail: "", addressLine1: "", addressLine2: "", city: "", region: "", postcode: "", country: "GB", vatNumber: "", poReference: "" };

const routeKey = (organisationId) => `qms.payRoute.${organisationId}`;
/** Card or invoice, remembered for this tab so a trip away and back keeps the choice. */
export const loadRoute = (organisationId) => {
  try {
    return sessionStorage.getItem(routeKey(organisationId)) === "invoice" ? "invoice" : "card";
  } catch {
    return "card";
  }
};
export const saveRoute = (organisationId, route) => {
  try {
    sessionStorage.setItem(routeKey(organisationId), route);
  } catch {
    /* ignore */
  }
};

/** What is wrong with the company details so far, in the order the form asks for them (nothing is said about a field that is still empty and optional). */
export const companyProblems = (c) => {
  const out = [];
  if (c.legalName.trim().length < 2) out.push("Enter the legal name of the company the invoice is for.");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(c.billingEmail.trim())) out.push("Enter the email address invoices should be sent to.");
  if (c.addressLine1.trim().length < 2 || c.city.trim().length < 2 || c.postcode.trim().length < 2 || !/^[A-Z]{2}$/.test(c.country ?? "")) {
    out.push("Enter the billing address: first line, town or city, postcode and country.");
  }
  return out;
};

/** The body of POST /billing/invoice-subscription: empty optional text is left out. */
export const invoiceBody = ({ choice, company, clientKey }) => {
  const clean = Object.fromEntries(Object.entries(company).map(([k, v]) => [k, typeof v === "string" ? v.trim() : v]).filter(([, v]) => v !== "" && v !== null && v !== undefined));
  return { interval: choice.interval, seats: Object.fromEntries(Object.entries(choice.seats).filter(([, q]) => q > 0)), company: clean, clientKey };
};

/** A fresh key for one attempt at starting (a retry of the same attempt is the same subscription). */
export const newClientKey = () =>
  typeof crypto !== "undefined" && crypto.randomUUID ? `iv-${crypto.randomUUID()}` : `iv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/** One line about the invoice that is owed: "Invoice INV-0042 for £75.00 is due on 3 Dec 2026", or how late it is. */
export const owedWords = (invoice, currency = "GBP") => {
  if (!invoice) return "";
  const what = `${invoice.number ? `Invoice ${invoice.number}` : "An invoice"} for ${money(invoice.total, invoice.currency ?? currency)}`;
  if (!invoice.dueOn) return `${what} is waiting to be paid`;
  if (invoice.overdueDays > 0) return `${what} was due on ${formatDate(invoice.dueOn)} and is ${invoice.overdueDays} ${invoice.overdueDays === 1 ? "day" : "days"} overdue`;
  return `${what} is due on ${formatDate(invoice.dueOn)}`;
};

/** The plain-words summary shown before an invoiced subscription is started. */
export const invoiceStartWords = ({ total, interval, email }) =>
  `We will email an invoice for ${money(total)} (excluding VAT) to ${email.trim() || "your billing address"}, payable within ${INVOICE_TERMS_DAYS} days by bank transfer or card. Your seats are available now. ${
    interval === "year" ? "It renews each year" : "A new invoice follows each month"
  }; there is no free trial on this route.`;
