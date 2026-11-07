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
