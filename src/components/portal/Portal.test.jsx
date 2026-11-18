import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

let me;
let home;
let people;
const mutate = vi.fn();
const signOut = vi.fn();

vi.mock("../../hooks/useQmsApi", () => ({ useMe: () => ({ data: me, isLoading: false }) }));
vi.mock("../../hooks/usePortal", () => ({
  usePortalHome: () => home,
  usePortalPeople: () => ({ data: { data: people }, isLoading: false }),
  usePortalMutation: () => ({ mutate, isPending: false, variables: null }),
}));
vi.mock("../../hooks/useSignOut", () => ({ default: () => [signOut, false] }));

import PortalApp from "./PortalApp";

const acme = { id: "a1", organisationId: "o1", organisationName: "Alpha Precision", partyId: "p1", partyKind: "supplier", partyName: "Acme Castings", role: "admin", contactName: "Pat in Quality", mfaRequired: false };
const beta = { ...acme, id: "a2", organisationId: "o2", organisationName: "Beta Castings", partyName: "Bolt Ltd", role: "member", contactName: null };

const renderIt = () => render(<MemoryRouter><PortalApp /></MemoryRouter>);

beforeEach(() => {
  mutate.mockReset();
  signOut.mockReset();
  sessionStorage.clear();
  me = { profile: { email: "sam@acme.test" }, memberships: [], portal: [acme], portalInvitations: [] };
  home = { data: { access: acme, attention: [] }, isLoading: false, error: null };
  people = [{ id: "x1", email: "sam@acme.test", name: "Sam Smith", role: "admin", status: "active", lastSignInAt: null }];
});

describe("the supplier and customer portal", () => {
  it("welcomes the party, names the organisation and the contact, and says nothing is shared yet", () => {
    renderIt();
    expect(screen.getByRole("heading", { name: "Acme Castings" })).toBeInTheDocument();
    expect(screen.getByText(/Supplier portal for Alpha Precision/)).toBeInTheDocument();
    expect(screen.getByText("Pat in Quality")).toBeInTheDocument();
    expect(screen.getByText(/Nothing has been shared with you yet/)).toBeInTheDocument();
    expect(screen.queryByRole("navigation")).toBeNull(); // no staff menu
  });

  it("falls back to the organisation's name when no contact is set", () => {
    me = { ...me, portal: [beta] };
    home = { data: { access: beta, attention: [] }, isLoading: false, error: null };
    renderIt();
    expect(screen.getAllByText("Beta Castings").length).toBeGreaterThan(0);
    expect(screen.getByText(/Your contact at Beta Castings:/).textContent).toMatch(/Beta Castings$/);
  });

  it("an admin sees their colleagues and can invite; an ordinary member does not", async () => {
    renderIt();
    expect(screen.getByRole("heading", { name: "People at Acme Castings" })).toBeInTheDocument();
    await userEvent.type(screen.getByRole("textbox", { name: /Invite a colleague/ }), "kim@acme.test");
    await userEvent.click(screen.getByRole("button", { name: "Send invitation" }));
    expect(mutate).toHaveBeenCalledWith({ action: "invite", body: { email: "kim@acme.test", message: undefined } }, expect.anything());
  });

  it("an ordinary member has no people section", () => {
    me = { ...me, portal: [beta] };
    home = { data: { access: beta, attention: [] }, isLoading: false, error: null };
    renderIt();
    expect(screen.queryByRole("heading", { name: /People at/ })).toBeNull();
  });

  it("someone with several organisations can choose which portal to use", () => {
    me = { ...me, portal: [acme, beta] };
    renderIt();
    expect(screen.getByLabelText("Organisation")).toBeInTheDocument();
  });

  it("an invitation waiting is accepted from the page", async () => {
    me = { ...me, portal: [], portalInvitations: [{ id: "i1", organisationName: "Alpha Precision", partyName: "Acme Castings", expired: false }] };
    renderIt();
    const list = screen.getByRole("list", { name: "Portal invitations" });
    expect(within(list).getByText("Alpha Precision")).toBeInTheDocument();
    await userEvent.click(within(list).getByRole("button", { name: "Accept" }));
    expect(mutate).toHaveBeenCalledWith({ action: "accept", id: "i1" }, expect.anything());
  });

  it("an expired invitation cannot be accepted", () => {
    me = { ...me, portal: [], portalInvitations: [{ id: "i1", organisationName: "Alpha Precision", partyName: "Acme Castings", expired: true }] };
    renderIt();
    expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
    expect(screen.getByText(/Expired/)).toBeInTheDocument();
  });

  it("with no access and no invitation it says so", () => {
    me = { ...me, portal: [], portalInvitations: [] };
    renderIt();
    expect(screen.getByText(/No portal access for sam@acme.test/)).toBeInTheDocument();
  });

  it("asks for two-factor when the organisation requires it and the session has not passed it", () => {
    me = { ...me, portal: [{ ...acme, mfaRequired: true }] };
    renderIt();
    expect(screen.getByText(/Two-factor authentication needed/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Set it up or enter your code/ })).toHaveAttribute("href", expect.stringContaining("/mfa"));
  });

  it("someone who is also a member can open the QMS", () => {
    me = { ...me, memberships: [{ organisation: { id: "o9" } }] };
    renderIt();
    expect(screen.getByRole("link", { name: "Open the QMS" })).toBeInTheDocument();
  });
});
