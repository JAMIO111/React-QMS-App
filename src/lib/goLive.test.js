import { describe, expect, it } from "vitest";
import { subscriptionWarning } from "./goLive";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-11-07T12:00:00Z");
const iso = (offsetDays) => new Date(NOW + offsetDays * DAY).toISOString();

describe("subscriptionWarning", () => {
  it("says nothing for a healthy or missing subscription", () => {
    expect(subscriptionWarning(null, NOW)).toBeNull();
    expect(subscriptionWarning({ status: "active", cancelAtPeriodEnd: false }, NOW)).toBeNull();
  });
  it("warns about overdue payment with the date access stops, and cannot be dismissed", () => {
    const w = subscriptionWarning({ status: "past_due", pastDueSince: iso(-2), gracePeriodDays: 7 }, NOW);
    expect(w).toMatchObject({ kind: "past_due", dismissible: false });
    expect(new Date(w.accessEnds).getTime()).toBe(NOW + 5 * DAY);
  });
  it("warns in the last three days of a trial, not before and not after", () => {
    expect(subscriptionWarning({ status: "trialing", trialEnd: iso(2.5) }, NOW)).toMatchObject({ kind: "trial_ending", daysLeft: 3, dismissible: true });
    expect(subscriptionWarning({ status: "trialing", trialEnd: iso(0.2) }, NOW)).toMatchObject({ daysLeft: 1 });
    expect(subscriptionWarning({ status: "trialing", trialEnd: iso(4) }, NOW)).toBeNull();
    expect(subscriptionWarning({ status: "trialing", trialEnd: iso(-1) }, NOW)).toBeNull();
  });
  it("warns about a subscription set to end, unless it has already been cancelled", () => {
    expect(subscriptionWarning({ status: "active", cancelAtPeriodEnd: true, currentPeriodEnd: iso(20) }, NOW)).toMatchObject({ kind: "cancelling" });
    expect(subscriptionWarning({ status: "cancelled", cancelAtPeriodEnd: true }, NOW)).toBeNull();
  });
});

describe("subscriptionWarning for an invoiced subscription", () => {
  const day = (offset) => new Date(NOW + offset * DAY).toISOString().slice(0, 10);
  const invoiced = (openInvoice, extra = {}) => ({ status: "active", paymentRoute: "invoice", gracePeriodDays: 3, openInvoice, ...extra });
  const inv = (dueOffset, overdueDays = 0) => ({ number: "INV-1", total: 7500, currency: "GBP", dueOn: day(dueOffset), overdueDays, hostedUrl: "https://pay.test/i/1" });

  it("says nothing when nothing is owed or the due date is far off", () => {
    expect(subscriptionWarning(invoiced(null), NOW)).toBeNull();
    expect(subscriptionWarning(invoiced(inv(10)), NOW)).toBeNull();
  });
  it("warns in the last week before the due date, and the warning can be dismissed", () => {
    const w = subscriptionWarning(invoiced(inv(5)), NOW);
    expect(w).toMatchObject({ kind: "invoice_due", dismissible: true });
    expect(w.daysLeft).toBeGreaterThanOrEqual(5);
    expect(w.invoice.hostedUrl).toBe("https://pay.test/i/1");
  });
  it("warns loudly once it is overdue, with the day access stops (the due date plus the grace days, then the next day), and cannot be dismissed", () => {
    const w = subscriptionWarning(invoiced(inv(-2, 2)), NOW);
    expect(w).toMatchObject({ kind: "invoice_overdue", dismissible: false });
    expect(w.accessEnds.slice(0, 10)).toBe(day(-2 + 3 + 1));
  });
  it("leaves a card subscription alone", () => {
    expect(subscriptionWarning({ status: "active", paymentRoute: "card", openInvoice: inv(-2, 2) }, NOW)).toBeNull();
  });
});
