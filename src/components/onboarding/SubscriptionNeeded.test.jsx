import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

let access;
let permissions;
vi.mock("../../contexts/OrganisationProvider", () => ({ useOrganisation: () => ({ organisation: { name: "Acme Ltd" } }) }));
vi.mock("../../hooks/useQmsApi", () => ({
  useOrganisationAccess: () => access,
  usePermissions: () => ({ can: (p) => permissions.includes(p) }),
}));

import SubscriptionNeeded from "./SubscriptionNeeded";

const renderIt = () => render(<MemoryRouter><SubscriptionNeeded /></MemoryRouter>);

beforeEach(() => {
  access = { accessState: "needs_subscription", onboarding: "in_progress" };
  permissions = ["subscription.manage", "subscription.read", "organisation.manage"];
});

describe("an organisation without a valid subscription", () => {
  it("tells an owner to choose a plan, and offers to continue the set-up and the billing page", () => {
    renderIt();
    expect(screen.getByRole("heading", { name: "Choose a plan to get started" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Continue set-up" })).toHaveAttribute("href", "/setup/plan");
    expect(screen.getByRole("link", { name: /Subscription & billing/ })).toHaveAttribute("href", "/Settings/Subscription");
  });

  it("says a lapsed subscription needs attention and that nothing is lost", () => {
    access = { accessState: "lapsed", onboarding: "complete" };
    renderIt();
    expect(screen.getByRole("heading", { name: "Your subscription needs attention" })).toBeInTheDocument();
    expect(screen.getByText(/comes back as soon as it is fixed/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Continue set-up" })).toBeNull();
  });

  it("sends everyone else to someone who can fix it", () => {
    permissions = [];
    renderIt();
    expect(screen.getByText(/Ask an owner or administrator of Acme Ltd/)).toBeInTheDocument();
    expect(screen.queryByRole("link")).toBeNull();
  });
});
