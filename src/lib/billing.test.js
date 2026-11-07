import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CHOICE, clearChoice, formatDate, loadChoice, money, recurringTotal, saveChoice, seatCount, trialEnd, unitPrice } from "./billing";

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

  it("ends the trial 14 days from now", () => {
    const from = new Date("2026-01-01T00:00:00Z");
    expect(trialEnd(from)).toBe("2026-01-15T00:00:00.000Z");
  });

  it("remembers the choice per organisation, and survives damaged storage", () => {
    expect(loadChoice("org-1")).toEqual(DEFAULT_CHOICE);
    saveChoice("org-1", { interval: "year", seats: { controller: 3 } });
    expect(loadChoice("org-1")).toEqual({ interval: "year", seats: { controller: 3, contributor: 0, observer: 0 } });
    expect(loadChoice("org-2")).toEqual(DEFAULT_CHOICE);
    sessionStorage.setItem("qms.checkoutChoice.org-3", "{not json");
    expect(loadChoice("org-3")).toEqual(DEFAULT_CHOICE);
    sessionStorage.setItem("qms.checkoutChoice.org-4", JSON.stringify({ interval: "week", seats: {} }));
    expect(loadChoice("org-4")).toEqual(DEFAULT_CHOICE);
    clearChoice("org-1");
    expect(loadChoice("org-1")).toEqual(DEFAULT_CHOICE);
  });
});
