import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

let org;
let access;
let permissions;
vi.mock("./App.css", () => ({}));
vi.mock("./components/Navbar", () => ({ default: () => <nav>navbar</nav> }));
vi.mock("./components/Header", () => ({ default: () => <header>header</header> }));
vi.mock("./components/NotificationPane", () => ({ default: () => null }));
vi.mock("./components/ThemeColourSync", () => ({ default: () => null }));
vi.mock("./components/NoOrganisation", () => ({ default: () => <p>no organisation</p> }));
vi.mock("./components/onboarding/SubscriptionNeeded", () => ({ default: () => <p>subscription needed</p> }));
vi.mock("./components/SubscriptionBanner", () => ({ default: () => <div data-testid="subscription-banner" /> }));
vi.mock("./contexts/SearchProvider.jsx", () => ({ SearchProvider: ({ children }) => children }));
vi.mock("./contexts/NotificationProvider", () => ({ NotificationProvider: ({ children }) => children }));
vi.mock("./contexts/OrganisationProvider", () => ({ useOrganisation: () => ({ organisation: org, error: null }) }));
vi.mock("./hooks/useQmsApi", () => ({
  useOrganisationAccess: () => access,
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
  resumeSetup();
});

describe("the app shell", () => {
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
});
