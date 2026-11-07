import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

let permissions;
let overview;
let enabledSeen;
vi.mock("../hooks/useQmsApi", () => ({ usePermissions: () => ({ can: (p) => permissions.includes(p) }) }));
vi.mock("../hooks/useSubscription", () => ({
  useSubscriptionOverview: ({ enabled }) => {
    enabledSeen = enabled;
    return { data: enabled ? overview : undefined };
  },
}));

import SubscriptionBanner from "./SubscriptionBanner";

const DAY = 24 * 60 * 60 * 1000;
const renderAt = (path = "/") => render(<MemoryRouter initialEntries={[path]}><SubscriptionBanner /></MemoryRouter>);

beforeEach(() => {
  permissions = ["subscription.read"];
  overview = { subscription: { status: "active", cancelAtPeriodEnd: false } };
  sessionStorage.clear();
});

describe("SubscriptionBanner", () => {
  it("shows nothing for a healthy subscription", () => {
    const { container } = renderAt();
    expect(container).toBeEmptyDOMElement();
  });

  it("warns loudly about overdue payment with the date access stops, and cannot be dismissed", () => {
    overview = { subscription: { status: "past_due", pastDueSince: new Date(Date.now() - DAY).toISOString(), gracePeriodDays: 7 } };
    renderAt();
    expect(screen.getByRole("alert")).toHaveTextContent(/last payment failed/i);
    expect(screen.getByRole("alert")).toHaveTextContent(/access to fortress qms stops on/i);
    expect(screen.getByRole("link", { name: "Update payment details" })).toHaveAttribute("href", "/Settings/Subscription");
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
  });

  it("tells people the trial is ending, and stays dismissed for the session", async () => {
    overview = { subscription: { status: "trialing", trialEnd: new Date(Date.now() + 2 * DAY).toISOString() } };
    renderAt();
    expect(screen.getByRole("status")).toHaveTextContent(/free trial ends in 2 days/i);
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("status")).toBeNull();
    renderAt(); // a new render in the same session stays quiet
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("warns that a cancelled-at-period-end subscription is ending", () => {
    overview = { subscription: { status: "active", cancelAtPeriodEnd: true, currentPeriodEnd: new Date(Date.now() + 10 * DAY).toISOString() } };
    renderAt();
    expect(screen.getByRole("status")).toHaveTextContent(/subscription ends on/i);
  });

  it("stays out of the way on the billing page itself", () => {
    overview = { subscription: { status: "past_due", pastDueSince: new Date().toISOString(), gracePeriodDays: 7 } };
    const { container } = renderAt("/Settings/Subscription");
    expect(container).toBeEmptyDOMElement();
  });

  it("is only for people who can read the subscription, and does not even ask for others", () => {
    permissions = [];
    overview = { subscription: { status: "past_due", pastDueSince: new Date().toISOString(), gracePeriodDays: 7 } };
    const { container } = renderAt();
    expect(container).toBeEmptyDOMElement();
    expect(enabledSeen).toBe(false);
  });
});
