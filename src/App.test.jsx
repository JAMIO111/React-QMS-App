import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";

let org;
let access;
let permissions;
let me;
const refetch = vi.fn(async () => ({ data: me }));
const signOutNow = vi.fn();
vi.mock("./hooks/useSignOut", () => ({ default: () => [signOutNow, false] }));
vi.mock("./App.css", () => ({}));
vi.mock("./components/Navbar", () => ({ default: () => <nav>navbar</nav> }));
vi.mock("./components/Header", () => ({ default: () => <header>header</header> }));
vi.mock("./components/NotificationPane", () => ({ default: () => null }));
vi.mock("./components/ThemeColourSync", () => ({ default: () => null }));
vi.mock("./components/NoOrganisation", () => ({ default: () => <p>no organisation</p> }));
vi.mock("./components/onboarding/SubscriptionNeeded", () => ({ default: () => <p>subscription needed</p> }));
vi.mock("./components/SubscriptionBanner", () => ({ default: () => <div data-testid="subscription-banner" /> }));
const invalidateQueries = vi.fn();
vi.mock("@tanstack/react-query", async (importOriginal) => ({ ...(await importOriginal()), useQueryClient: () => ({ invalidateQueries }) }));
vi.mock("./components/onboarding/SeatWaiting", () => ({ default: ({ wait }) => <p>waiting for a seat in {wait.name}</p> }));
vi.mock("./contexts/SearchProvider.jsx", () => ({ SearchProvider: ({ children }) => children }));
vi.mock("./contexts/NotificationProvider", () => ({ NotificationProvider: ({ children }) => children }));
vi.mock("./contexts/OrganisationProvider", () => ({ useOrganisation: () => ({ organisation: org, error: null }) }));
vi.mock("./hooks/useQmsApi", () => ({
  useOrganisationAccess: () => access,
  useMe: () => ({ data: me, refetch, isLoading: false }),
  usePermissions: () => ({ can: (p) => permissions.includes(p) }),
}));

import App from "./App";
import { deferSetup, resumeSetup } from "./lib/onboarding";

const renderAt = (url) =>
  render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route element={<App />}>
          <Route path="/Dashboard" element={<p>dashboard page</p>} />
          <Route path="/Settings/Subscription" element={<p>subscription settings</p>} />
        </Route>
        <Route path="/setup" element={<p>setup wizard</p>} />
      </Routes>
    </MemoryRouter>,
  );

beforeEach(() => {
  org = { id: "org-1", name: "Acme Ltd" };
  access = { accessState: "open", onboarding: "complete", isLoading: false };
  permissions = ["organisation.manage"];
  me = { memberships: [{ organisation: { id: "org-1" }, network: { state: "open", address: "203.0.113.10" } }] };
  refetch.mockClear();
  resumeSetup();
});

describe("the app shell", () => {
  it("shows the waiting screen instead of an organisation where the person has no seat (seats plan SM4)", () => {
    me = { ...me, seats: { waitingIn: [{ id: "org-1", name: "Acme Ltd", managers: [], lastToldAt: null }] } };
    renderAt("/Dashboard");
    expect(screen.getByText("waiting for a seat in Acme Ltd")).toBeInTheDocument();
    expect(screen.queryByText("dashboard page")).toBeNull();
  });

  it("tells a suspended person who suspended them and when, instead of offering to start an organisation", async () => {
    org = null;
    me = { memberships: [], suspended: [{ id: "org-1", name: "Acme Ltd", suspendedAt: "2026-11-17T14:05:00.000Z", suspendedBy: "Olga Owner" }] };
    renderAt("/Dashboard");
    expect(screen.getByRole("heading", { name: "You have been suspended from Acme Ltd" })).toBeInTheDocument();
    expect(screen.getByText(/Suspended from Acme Ltd by Olga Owner on/)).toBeInTheDocument();
    expect(screen.queryByText("no organisation")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(signOutNow).toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["api", "me"] });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["memberships"] });
  });

  it("lets a suspended person look for another organisation", async () => {
    org = null;
    me = { memberships: [], suspended: [{ id: "org-1", name: "Acme Ltd", suspendedAt: null, suspendedBy: null }] };
    renderAt("/Dashboard");
    await userEvent.click(screen.getByRole("button", { name: "Use a different organisation" }));
    expect(screen.getByText("no organisation")).toBeInTheDocument();
  });

  it("still offers to start an organisation to someone who was never suspended", () => {
    org = null;
    me = { memberships: [], suspended: [] };
    renderAt("/Dashboard");
    expect(screen.getByText("no organisation")).toBeInTheDocument();
  });

  it("reads /me again when a request is refused for want of a seat", () => {
    renderAt("/Dashboard");
    window.dispatchEvent(new CustomEvent("qms:seat-required", { detail: { organisationId: "org-1" } }));
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["api", "me"] });
  });

  it("shows the app when the organisation is ready", () => {
    renderAt("/Dashboard");
    expect(screen.getByText("dashboard page")).toBeInTheDocument();
  });

  it("sends an owner with an unfinished set-up to the wizard", () => {
    access = { accessState: "open", onboarding: "in_progress", isLoading: false };
    renderAt("/Dashboard");
    expect(screen.getByText("setup wizard")).toBeInTheDocument();
  });

  it("lets them into the app after Finish later, for the session", () => {
    access = { accessState: "open", onboarding: "in_progress", isLoading: false };
    deferSetup();
    renderAt("/Dashboard");
    expect(screen.getByText("dashboard page")).toBeInTheDocument();
  });

  it("does not send people who cannot set the organisation up", () => {
    access = { accessState: "open", onboarding: "in_progress", isLoading: false };
    permissions = [];
    renderAt("/Dashboard");
    expect(screen.getByText("dashboard page")).toBeInTheDocument();
  });

  it("waits for the access state before deciding", () => {
    access = { accessState: "open", onboarding: "in_progress", isLoading: true };
    renderAt("/Dashboard");
    expect(screen.getByText("dashboard page")).toBeInTheDocument();
  });

  it("shows the subscription warning strip above the page when the app is open, never in place of the lock screen", () => {
    renderAt("/Dashboard");
    expect(screen.getByTestId("subscription-banner")).toBeInTheDocument();
  });

  it("does not show the warning strip on the lock screen", () => {
    access = { accessState: "needs_subscription", onboarding: "complete", isLoading: false };
    renderAt("/Dashboard");
    expect(screen.queryByTestId("subscription-banner")).toBeNull();
  });

  it("without a valid subscription, shows the subscription page instead of the app, but still lets Settings open", () => {
    access = { accessState: "needs_subscription", onboarding: "complete", isLoading: false };
    renderAt("/Dashboard");
    expect(screen.getByText("subscription needed")).toBeInTheDocument();
    expect(screen.queryByText("dashboard page")).toBeNull();
  });

  it("keeps Settings (billing) reachable while locked", () => {
    access = { accessState: "lapsed", onboarding: "complete", isLoading: false };
    renderAt("/Settings/Subscription");
    expect(screen.getByText("subscription settings")).toBeInTheDocument();
  });

  it("shows the no-organisation page to someone with none", () => {
    org = null;
    renderAt("/Dashboard");
    expect(screen.getByText("no organisation")).toBeInTheDocument();
  });

  it("shows the blocked screen, with the address, when the organisation does not allow this network (and nothing of the app)", () => {
    me = { memberships: [{ organisation: { id: "org-1" }, network: { state: "denied", address: "198.51.100.200" } }] };
    renderAt("/Settings/Subscription");
    expect(screen.getByRole("heading", { name: "Acme Ltd is not available on this network" })).toBeInTheDocument();
    expect(screen.getByText("198.51.100.200")).toBeInTheDocument();
    expect(screen.queryByText("subscription settings")).toBeNull();
  });

  it("switches to the blocked screen as soon as a request answers 403 network_not_allowed, and Try again checks /me", async () => {
    renderAt("/Dashboard");
    expect(screen.getByText("dashboard page")).toBeInTheDocument();
    act(() => {
      window.dispatchEvent(new CustomEvent("qms:network-blocked", { detail: { organisationId: "org-1", address: "198.51.100.200" } }));
    });
    expect(screen.getByRole("heading", { name: /not available on this network/ })).toBeInTheDocument();
    expect(screen.queryByText("dashboard page")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(refetch).toHaveBeenCalled();
    expect(await screen.findByText("dashboard page")).toBeInTheDocument();
  });

  it("monitor mode blocks nobody", () => {
    me = { memberships: [{ organisation: { id: "org-1" }, network: { state: "monitored", address: "198.51.100.200" } }] };
    renderAt("/Dashboard");
    expect(screen.getByText("dashboard page")).toBeInTheDocument();
  });

  it("signs out, and leaves the reason for the sign-in page, when the organisation asks people to sign in again", () => {
    renderAt("/Dashboard");
    act(() => {
      window.dispatchEvent(new CustomEvent("qms:reauthentication-required", { detail: { organisationId: "org-1", message: "This organisation asks you to sign in again every 12 hours. Please sign in again." } }));
    });
    expect(signOutNow).toHaveBeenCalled();
    expect(sessionStorage.getItem("qms:reauth-note")).toMatch(/every 12 hours/);
    sessionStorage.removeItem("qms:reauth-note");
  });
});
