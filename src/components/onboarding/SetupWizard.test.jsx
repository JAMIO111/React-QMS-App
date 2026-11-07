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
vi.mock("../../hooks/useSubscription", () => ({ useSubscriptionOverview: () => ({ data: { subscription: { status: "trialing" } } }) }));
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
  permissions = ["organisation.manage"];
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
    expect(screen.getByRole("button", { name: /Continue/ })).toBeDisabled();
    expect(screen.getByRole("link", { name: /Open Subscription & billing/ })).toHaveAttribute("href", "/Settings/Subscription");
  });

  it("with a valid subscription everything opens and the plan says so", () => {
    state = makeState({ billingRequired: true, accessState: "open" }, { plan: "done" });
    renderAt("/setup/plan");
    expect(screen.getByText(/valid subscription/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Continue/ })).toBeEnabled();
    expect(within(screen.getByRole("navigation", { name: "Set-up steps" })).getAllByRole("link")).toHaveLength(7);
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
