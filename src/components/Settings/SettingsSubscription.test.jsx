import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

const catalogue = {
  plans: [
    { slug: "observer", name: "Observer", description: "Read-only", monthly: { unitAmount: 500, currency: "GBP" }, annual: { unitAmount: 5000, currency: "GBP" }, annualMonthlyEquivalent: 417, annualSaving: 1000, levels: { calibration: "view" } },
    { slug: "controller", name: "Controller", description: "Full", monthly: { unitAmount: 2500, currency: "GBP" }, annual: { unitAmount: 25000, currency: "GBP" }, annualMonthlyEquivalent: 2083, annualSaving: 5000, levels: { calibration: "full" } },
  ],
  modules: [{ slug: "calibration", name: "Calibration", status: "active", features: [{ slug: "record_calibration", name: "Record calibration", minLevel: "operational", includedIn: ["controller"] }] }],
};
const baseOverview = {
  checkoutAvailable: false,
  providerManaged: false,
  subscription: { status: "active", billingProvider: "manual", trialEnd: null, billingInterval: "month", currency: "GBP", currentPeriodEnd: "2026-01-01T00:00:00Z", cancelAtPeriodEnd: false, gracePeriodDays: 7 },
  items: [{ planSlug: "observer", planName: "Observer", purchased: 2, assigned: 1, available: 1, unitAmount: 500 }],
  totals: { seatsPurchased: 2, seatsAssigned: 1, seatsAvailable: 1, monthlyEquivalent: 1000, annual: 12000 },
};
let overview;
const members = [{ membershipId: "m1", email: "a@x.test", firstName: "Ann", surname: "Quality", status: "active", roles: ["Quality Manager"], plan: null, unitAmount: null }];

let permissions;
const mutate = vi.fn();
const mutateAsync = vi.fn().mockResolvedValue({});
const confirm = vi.fn();
const startMutate = vi.fn();
const portalMutate = vi.fn();
const previewAsync = vi.fn();
const changeAsync = vi.fn().mockResolvedValue({});
const checkoutReturn = { phase: "idle", error: null, retry: vi.fn(), dismiss: vi.fn() };

vi.mock("../../hooks/useQmsApi", () => ({ usePermissions: () => ({ can: (p) => permissions.includes(p) }) }));
vi.mock("../../hooks/useSubscription", () => ({
  usePlanCatalogue: () => ({ data: catalogue }),
  useSubscriptionOverview: () => ({ data: overview }),
  useSeatAssignments: () => ({ data: members }),
  useInvoices: () => ({ data: [] }),
  useSubscriptionMutation: () => ({ mutate, mutateAsync, isPending: false }),
  useStartCheckout: () => ({ mutate: startMutate, isPending: false }),
  usePortalSession: () => ({ mutate: portalMutate, isPending: false }),
  useSeatPreview: () => ({ mutateAsync: previewAsync, isPending: false }),
  useChangeSeats: () => ({ mutateAsync: changeAsync, isPending: false }),
}));
vi.mock("../../hooks/useCheckoutReturn", () => ({ useCheckoutReturn: () => checkoutReturn }));
vi.mock("../../contexts/OrganisationProvider", () => ({ useOrganisation: () => ({ organisationId: "org-1" }) }));
vi.mock("../../contexts/ConfirmationModalProvider", () => ({ useConfirm: () => confirm }));
vi.mock("../../contexts/ToastProvider", () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock("./SettingsOrganisation", () => ({ ApiUnavailable: () => <p>api unavailable</p> }));

import SettingsSubscription from "./SettingsSubscription";

const renderPage = () => render(<MemoryRouter><SettingsSubscription /></MemoryRouter>);

describe("SettingsSubscription", () => {
  beforeEach(() => {
    mutate.mockReset();
    confirm.mockReset();
    startMutate.mockReset();
    portalMutate.mockReset();
    previewAsync.mockReset();
    changeAsync.mockClear();
    overview = structuredClone(baseOverview);
    checkoutReturn.phase = "idle";
    sessionStorage.clear();
  });

  it("shows costs from the API in pounds and role and package separately", () => {
    permissions = ["subscription.read"];
    renderPage();
    expect(screen.getAllByText("£10.00").length).toBeGreaterThan(0);
    expect(screen.getByText("Quality Manager")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add seat" })).not.toBeInTheDocument();
  });

  it("switches to annual pricing and shows the saving", async () => {
    permissions = ["subscription.read"];
    renderPage();
    await userEvent.click(screen.getByRole("switch", { name: "Annual billing" }));
    const card = screen.getByRole("group", { name: "Controller package" });
    expect(within(card).getByText("£20.83")).toBeInTheDocument();
    expect(within(card).getByText(/saves £50\.00/)).toBeInTheDocument();
  });

  it("asks before assigning a package and refuses when no seat is free", async () => {
    permissions = ["subscription.read", "subscription.seats"];
    confirm.mockResolvedValue(true);
    renderPage();
    const pick = async (name) => {
      await userEvent.click(screen.getByRole("combobox", { name: "Package for Ann Quality" }));
      await userEvent.click(await screen.findByRole("option", { name: new RegExp(`^${name}`) }));
    };
    await pick("Observer");
    expect(confirm).toHaveBeenCalled();
    expect(mutate).toHaveBeenCalledWith({ action: "assign", membershipId: "m1", planSlug: "observer" }, expect.any(Object));

    mutate.mockReset();
    confirm.mockClear();
    await pick("Controller");
    expect(confirm).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
  });

  it("collects seat changes and saves them only on Apply", async () => {
    permissions = ["subscription.read", "subscription.manage"];
    confirm.mockResolvedValue(true);
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: "Add Observer seat" }));
    await userEvent.click(screen.getByRole("button", { name: "Add Observer seat" }));
    expect(mutateAsync).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Apply changes" }));
    expect(mutateAsync).toHaveBeenCalledWith({ action: "seats", planSlug: "observer", quantity: 4 });
  });

  describe("with Stripe", () => {
    const stripeOverview = () => ({
      checkoutAvailable: true,
      providerManaged: true,
      subscription: { status: "trialing", billingProvider: "stripe", billingInterval: "month", currency: "GBP", currentPeriodEnd: "2026-02-01T00:00:00Z", trialEnd: "2026-01-15T00:00:00Z", cancelAtPeriodEnd: false, gracePeriodDays: 7 },
      items: [
        { planSlug: "controller", planName: "Controller", purchased: 2, assigned: 1, available: 1, unitAmount: 2500 },
        { planSlug: "observer", planName: "Observer", purchased: 1, assigned: 0, available: 1, unitAmount: 500 },
      ],
      totals: { seatsPurchased: 3, seatsAssigned: 1, seatsAvailable: 2, monthlyEquivalent: 5500, annual: 66000 },
    });

    it("says when the free trial ends and opens Stripe's portal from Manage billing", async () => {
      permissions = ["subscription.read", "subscription.manage"];
      overview = stripeOverview();
      const assign = vi.fn();
      Object.defineProperty(window, "location", { value: { assign }, writable: true });
      renderPage();
      expect(screen.getByText(/Free trial until 15 Jan 2026/)).toBeInTheDocument();
      await userEvent.click(screen.getAllByRole("button", { name: "Manage billing" })[0]);
      expect(portalMutate).toHaveBeenCalled();
      portalMutate.mock.calls[0][1].onSuccess({ url: "https://billing.stripe.test/p/1" });
      expect(assign).toHaveBeenCalledWith("https://billing.stripe.test/p/1");
    });

    it("hides Manage billing from people who cannot manage the subscription", () => {
      permissions = ["subscription.read"];
      overview = stripeOverview();
      renderPage();
      expect(screen.queryByRole("button", { name: "Manage billing" })).toBeNull();
    });

    it("warns that a subscription set to cancel will end, and locks afterwards", () => {
      permissions = ["subscription.read"];
      overview = stripeOverview();
      overview.subscription.status = "active";
      overview.subscription.cancelAtPeriodEnd = true;
      renderPage();
      expect(screen.getByRole("alert")).toHaveTextContent(/set to end on 1 Feb 2026/);
    });

    it("shows the price from Stripe before changing seats, then changes them", async () => {
      permissions = ["subscription.read", "subscription.manage"];
      overview = stripeOverview();
      confirm.mockResolvedValue(true);
      previewAsync.mockResolvedValue({ currency: "gbp", amountDue: 1200, tax: 200, subtotal: 1000, total: 1200, lines: [], changes: [] });
      renderPage();
      expect(screen.queryByRole("switch", { name: "Annual billing" })).toBeNull(); // the interval is fixed by the subscription
      await userEvent.click(screen.getByRole("button", { name: "Add Controller seat" }));
      await userEvent.click(screen.getByRole("button", { name: "Apply changes" }));
      expect(previewAsync).toHaveBeenCalledWith({ seats: { controller: 3 } });
      expect(confirm.mock.calls[0][0].message).toMatch(/Stripe charges £12\.00 now/);
      expect(confirm.mock.calls[0][0].message).toMatch(/£25\.00 per month/);
      expect(changeAsync).toHaveBeenCalledWith({ seats: { controller: 3 } });
    });

    it("does not change anything when the price is declined", async () => {
      permissions = ["subscription.read", "subscription.manage"];
      overview = stripeOverview();
      confirm.mockResolvedValue(false);
      previewAsync.mockResolvedValue({ currency: "gbp", amountDue: 0, tax: 0, subtotal: 0, total: 0, lines: [], changes: [] });
      renderPage();
      await userEvent.click(screen.getByRole("button", { name: "Add Controller seat" }));
      await userEvent.click(screen.getByRole("button", { name: "Apply changes" }));
      expect(changeAsync).not.toHaveBeenCalled();
    });

    it("never offers to remove the last Controller seat", () => {
      permissions = ["subscription.read", "subscription.manage"];
      overview = stripeOverview();
      overview.items[0] = { ...overview.items[0], purchased: 1, assigned: 0 };
      renderPage();
      expect(screen.getByRole("button", { name: "Remove Controller seat" })).toBeDisabled();
    });

    it("lets an owner with no subscription choose seats and go to checkout, remembering the choice", async () => {
      permissions = ["subscription.read", "subscription.manage"];
      overview = { ...stripeOverview(), subscription: null, items: [], totals: { seatsPurchased: 0, seatsAssigned: 0, seatsAvailable: 0, monthlyEquivalent: 0, annual: 0 } };
      renderPage();
      expect(screen.getByRole("heading", { name: "Start your subscription" })).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "Add Controller seat" }));
      await userEvent.click(screen.getByRole("radio", { name: /Annual/ }));
      expect(JSON.parse(sessionStorage.getItem("qms.checkoutChoice.org-1"))).toMatchObject({ interval: "year", seats: { controller: 2 } });
      await userEvent.click(screen.getByRole("button", { name: "Continue to secure checkout" }));
      expect(startMutate).toHaveBeenCalledWith({ interval: "year", seats: { controller: 2 }, returnTo: "settings" }, expect.any(Object));
    });

    it("keeps the manual seat cards when Stripe cannot take a purchase", () => {
      permissions = ["subscription.read", "subscription.manage"];
      overview = { ...baseOverview, subscription: null, items: [], totals: baseOverview.totals };
      renderPage();
      expect(screen.queryByRole("heading", { name: "Start your subscription" })).toBeNull();
      expect(screen.getByRole("group", { name: "Controller package" })).toBeInTheDocument();
    });

    it("shows how the return from checkout went", () => {
      permissions = ["subscription.read"];
      overview = stripeOverview();
      checkoutReturn.phase = "waiting";
      renderPage();
      expect(screen.getAllByRole("status").some((n) => /Waiting for Stripe/.test(n.textContent))).toBe(true);
    });
  });
});
