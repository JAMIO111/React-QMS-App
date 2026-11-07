import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

let permissions;
let state;
let queryError = null;
const mutate = vi.fn();
vi.mock("../../contexts/OrganisationProvider", () => ({ useOrganisation: () => ({ organisation: { id: "org-1", name: "Acme Ltd" }, organisationId: "org-1" }) }));
vi.mock("../../hooks/useQmsApi", () => ({
  usePermissions: () => ({ can: (p) => permissions.includes(p), isLoading: false }),
  useOrganisationDetails: () => ({ data: { name: "Acme Ltd", legalName: null, country: null, settings: { logoPath: null, themeColour: "purple", requireMfa: false } } }),
  useSites: () => ({ data: { data: [{ id: "s1", name: "Plant A", code: "PA", timezone: "Europe/London" }] } }),
  useUpdateOrganisation: () => ({ mutate: vi.fn(), isPending: false }),
}));
let overview;
const startMutate = vi.fn();
const portalMutate = vi.fn();
const checkoutReturn = { phase: "idle", error: null, retry: vi.fn(), dismiss: vi.fn() };
const planCatalogue = {
  plans: [
    { slug: "observer", name: "Observer", description: "Read only", monthly: { unitAmount: 500, currency: "GBP" }, annual: { unitAmount: 5000, currency: "GBP" }, annualSaving: 1000 },
    { slug: "contributor", name: "Contributor", description: "Record work", monthly: { unitAmount: 1000, currency: "GBP" }, annual: { unitAmount: 10000, currency: "GBP" }, annualSaving: 2000 },
    { slug: "controller", name: "Controller", description: "Everything", monthly: { unitAmount: 2500, currency: "GBP" }, annual: { unitAmount: 25000, currency: "GBP" }, annualSaving: 5000 },
  ],
};
vi.mock("../../hooks/useSubscription", () => ({
  useSubscriptionOverview: () => ({ data: overview }),
  usePlanCatalogue: () => ({ data: planCatalogue }),
  useStartCheckout: () => ({ mutate: startMutate, isPending: false, error: null }),
  usePortalSession: () => ({ mutate: portalMutate, isPending: false }),
}));
vi.mock("../../hooks/useCheckoutReturn", () => ({ useCheckoutReturn: () => checkoutReturn }));
vi.mock("../../contexts/ToastProvider", () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock("../../hooks/useOnboarding", () => ({
  useOnboarding: () => ({ data: state, isLoading: false, error: queryError }),
  useOnboardingMutation: () => ({ mutate, isPending: false, error: null }),
}));
vi.mock("../Settings/SitesManager", () => ({ default: () => <p>sites manager</p> }));
vi.mock("../Settings/TwoFactorCard", () => ({ default: () => <p>two factor card</p> }));
vi.mock("../Settings/RequireMfaSetting", () => ({ default: () => <p>require mfa setting</p> }));
vi.mock("../Settings/OrganisationLogo", () => ({ default: () => <p>organisation logo</p> }));
vi.mock("../Settings/ThemeColourPicker", () => ({ default: () => <p>theme colour picker</p> }));

import SetupWizard from "./SetupWizard";
import { setupDeferred, resumeSetup } from "../../lib/onboarding";

const KEYS = ["organisation", "plan", "details", "sites", "security", "team", "review"];
const makeState = (over = {}, statuses = {}) => ({
  billingRequired: false, accessState: "open", currentStep: "plan", canFinish: true, completedAt: null, sites: 1,
  steps: KEYS.map((key) => ({ key, status: statuses[key] ?? (key === "organisation" || key === "sites" ? "done" : "pending"), required: key === "organisation" || key === "sites", auto: ["organisation", "plan", "sites", "review"].includes(key) })),
  ...over,
});
const Where = () => <p>at {useLocation().pathname}</p>;
const renderAt = (url) =>
  render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/setup" element={<SetupWizard />} />
        <Route path="/setup/:step" element={<SetupWizard />} />
        <Route path="/Dashboard" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );

beforeEach(() => {
  mutate.mockReset();
  startMutate.mockReset();
  portalMutate.mockReset();
  checkoutReturn.phase = "idle";
  sessionStorage.clear();
  overview = { checkoutAvailable: true, providerManaged: false, subscription: null, items: [] };
  permissions = ["organisation.manage", "subscription.manage"];
  state = makeState();
  queryError = null;
  resumeSetup();
});

describe("the set-up wizard", () => {
  it("opens on the first step still to do and lists every step with whether it is required", () => {
    renderAt("/setup");
    expect(screen.getByRole("heading", { name: "Set up Acme Ltd" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Plan and seats" })).toBeInTheDocument();
    const rail = screen.getByRole("navigation", { name: "Set-up steps" });
    expect(within(rail).getAllByRole("link")).toHaveLength(7);
    expect(within(rail).getByRole("link", { name: /Plan & seats/ })).toHaveAttribute("aria-current", "step");
    expect(within(rail).getAllByText("Required")).toHaveLength(2);
    expect(within(rail).getAllByText("Optional").length).toBeGreaterThan(0);
  });

  it("marks details as done and moves to sites, or skips it", async () => {
    renderAt("/setup/details");
    expect(screen.getByLabelText("Legal name")).toBeInTheDocument();
    expect(screen.getByText("organisation logo")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Done, continue" }));
    expect(mutate).toHaveBeenCalledWith({ action: "setStep", body: { step: "details", status: "done" } }, expect.objectContaining({ onSuccess: expect.any(Function) }));
    await userEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    expect(mutate).toHaveBeenLastCalledWith({ action: "setStep", body: { step: "details", status: "skipped" } }, expect.anything());
  });

  it("shows each step's own content", () => {
    renderAt("/setup/sites");
    expect(screen.getByText("sites manager")).toBeInTheDocument();
  });

  it("security offers two-factor for the owner and for everyone", () => {
    renderAt("/setup/security");
    expect(screen.getByText("two factor card")).toBeInTheDocument();
    expect(screen.getByText("require mfa setting")).toBeInTheDocument();
  });

  it("the organisation step shows the name and the first site", () => {
    renderAt("/setup/organisation");
    expect(screen.getByRole("textbox", { name: "Organisation name" })).toHaveValue("Acme Ltd");
    expect(screen.getByText(/Europe\/London/)).toBeInTheDocument();
  });

  it("when a subscription is required, the later steps wait for the plan and the plan step cannot be passed", async () => {
    state = makeState({ billingRequired: true, accessState: "needs_subscription", canFinish: false });
    renderAt("/setup/details");
    // Visiting a locked step lands on the plan.
    expect(await screen.findByRole("region", { name: "Plan and seats" })).toBeInTheDocument();
    const rail = screen.getByRole("navigation", { name: "Set-up steps" });
    expect(within(rail).getAllByRole("link")).toHaveLength(2); // organisation and plan
    expect(rail.querySelectorAll('[aria-disabled="true"]')).toHaveLength(5);
    expect(screen.getByText(/subscription must be active/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Continue to secure checkout" })).toBeEnabled();
  });

  it("with a valid subscription everything opens and the plan shows it", () => {
    state = makeState({ billingRequired: true, accessState: "open" }, { plan: "done" });
    overview = {
      checkoutAvailable: true,
      providerManaged: true,
      subscription: { status: "trialing", billingProvider: "stripe", billingInterval: "month", currency: "GBP", trialEnd: "2026-01-15T00:00:00Z", currentPeriodEnd: "2026-01-15T00:00:00Z", cancelAtPeriodEnd: false },
      items: [{ planSlug: "controller", planName: "Controller", purchased: 2, assigned: 1, available: 1, unitAmount: 2500 }],
    };
    renderAt("/setup/plan");
    expect(screen.getByText(/Free trial until 15 Jan 2026/)).toBeInTheDocument();
    expect(screen.getByText(/2 × Controller/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
    expect(within(screen.getByRole("navigation", { name: "Set-up steps" })).getAllByRole("link")).toHaveLength(7);
    expect(screen.queryByRole("button", { name: "Continue to secure checkout" })).toBeNull();
  });

  describe("buying the plan", () => {
    beforeEach(() => {
      state = makeState({ billingRequired: true, accessState: "needs_subscription", canFinish: false });
    });

    it("chooses seats and goes to Stripe's checkout with the owner's Controller seat included", async () => {
      renderAt("/setup/plan");
      expect(screen.getByRole("group", { name: "Controller package" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Remove Controller seat" })).toBeDisabled(); // at least one
      await userEvent.click(screen.getByRole("button", { name: "Add Controller seat" }));
      await userEvent.click(screen.getByRole("button", { name: "Add Contributor seat" }));
      await userEvent.click(screen.getByRole("radio", { name: /Annual/ }));
      expect(screen.getByText(/14-day free trial/)).toBeInTheDocument();
      expect(screen.getByText(/£600\.00/)).toBeInTheDocument(); // 2 x 250 + 1 x 100 a year, excluding VAT
      await userEvent.click(screen.getByRole("button", { name: "Continue to secure checkout" }));
      expect(startMutate).toHaveBeenCalledWith({ interval: "year", seats: { controller: 2, contributor: 1 }, returnTo: "setup" }, expect.any(Object));
      const assign = vi.fn();
      Object.defineProperty(window, "location", { value: { assign }, writable: true });
      startMutate.mock.calls[0][1].onSuccess({ url: "https://checkout.stripe.test/c/cs_1", sessionId: "cs_1" });
      expect(assign).toHaveBeenCalledWith("https://checkout.stripe.test/c/cs_1");
    });

    it("remembers the choice for a cancelled checkout", async () => {
      const first = renderAt("/setup/plan");
      await userEvent.click(screen.getByRole("button", { name: "Add Observer seat" }));
      first.unmount();
      renderAt("/setup/plan");
      expect(screen.getByLabelText("Observer seats")).toHaveTextContent("1");
    });

    it("explains how the return from Stripe went", () => {
      checkoutReturn.phase = "cancelled";
      renderAt("/setup/plan");
      expect(screen.getByText(/Checkout was cancelled and nothing was charged/)).toBeInTheDocument();
    });

    it("says it is waiting while Stripe confirms, and offers to check again if it takes too long", async () => {
      checkoutReturn.phase = "waiting";
      const first = renderAt("/setup/plan");
      expect(screen.getByText(/Waiting for Stripe to confirm/)).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Check again" })).toBeNull();
      first.unmount();
      checkoutReturn.phase = "timeout";
      renderAt("/setup/plan");
      await userEvent.click(screen.getByRole("button", { name: "Check again" }));
      expect(checkoutReturn.retry).toHaveBeenCalled();
    });

    it("is not available to people who cannot manage the subscription", () => {
      permissions = ["organisation.manage"];
      renderAt("/setup/plan");
      expect(screen.getByText(/Only an owner or administrator can start the subscription/)).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Continue to secure checkout" })).toBeNull();
    });

    it("says so when Stripe is not set up on this server, without a dead end", () => {
      overview = { ...overview, checkoutAvailable: false };
      renderAt("/setup/plan");
      expect(screen.getByText(/Online payment is not switched on for this server yet/)).toBeInTheDocument();
      expect(screen.getByRole("link", { name: /Open Subscription & billing/ })).toHaveAttribute("href", "/Settings/Subscription");
    });

    it("sends someone whose payment lapsed to Stripe's billing portal", async () => {
      state = makeState({ billingRequired: true, accessState: "lapsed", canFinish: false });
      overview = { checkoutAvailable: true, providerManaged: true, subscription: { status: "past_due", billingProvider: "stripe", billingInterval: "month", currency: "GBP" }, items: [] };
      renderAt("/setup/plan");
      expect(screen.getByText(/needs attention/)).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "Manage billing" }));
      expect(portalMutate).toHaveBeenCalled();
    });
  });

  it("the review lists what is done and what is not, and cannot finish while a required step is open", () => {
    state = makeState({ canFinish: false }, { sites: "pending", details: "skipped" });
    renderAt("/setup/review");
    const list = screen.getByRole("list", { name: "Set-up summary" });
    expect(within(list).getByText("Skipped")).toBeInTheDocument();
    expect(within(list).getAllByText("Not done").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Some required steps are still open/).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /Finish set-up/ })).toBeDisabled();
  });

  it("finishes the set-up and goes to the app", async () => {
    mutate.mockImplementation((_, opts) => opts?.onSuccess?.());
    renderAt("/setup/review");
    await userEvent.click(screen.getByRole("button", { name: /Finish set-up/ }));
    expect(mutate).toHaveBeenCalledWith({ action: "complete" }, expect.anything());
    expect(await screen.findByText("at /Dashboard")).toBeInTheDocument();
  });

  it("Finish later leaves for the app and remembers it for the session", async () => {
    renderAt("/setup");
    expect(setupDeferred()).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "Finish later" }));
    expect(await screen.findByText("at /Dashboard")).toBeInTheDocument();
    expect(setupDeferred()).toBe(true);
  });

  it("is only for people who can set the organisation up, and is over once finished", async () => {
    permissions = [];
    const { unmount } = renderAt("/setup");
    expect(await screen.findByText("at /Dashboard")).toBeInTheDocument();
    unmount();
    permissions = ["organisation.manage"];
    state = makeState({ completedAt: "2026-11-07T10:00:00Z" });
    renderAt("/setup");
    await waitFor(() => expect(screen.getByText("at /Dashboard")).toBeInTheDocument());
  });

  it("explains a failure to load", () => {
    queryError = Object.assign(new Error("API unreachable"), { code: "api_unreachable" });
    renderAt("/setup");
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });
});
