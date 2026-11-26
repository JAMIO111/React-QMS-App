import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";

let me;
let home;
let people;
let shares;
let scars = [];
let approvals = [];
const mutate = vi.fn();
const signOut = vi.fn();

vi.mock("../../hooks/useQmsApi", () => ({ useMe: () => ({ data: me, isLoading: false }) }));
vi.mock("../../hooks/usePortal", () => ({
  usePortalHome: () => home,
  usePortalPeople: () => ({ data: { data: people }, isLoading: false }),
  usePortalShares: () => ({ data: { data: shares }, isLoading: false }),
  usePortalScars: () => ({ data: { data: scars }, isLoading: false }),
  usePortalPerformance: () => ({ data: null, isLoading: true }),
  usePortalFigures: () => ({ data: null, isLoading: true }),
  usePortalNcrs: () => ({ data: { data: [] }, isLoading: false }),
  usePortalCapas: () => ({ data: { data: [] }, isLoading: false }),
  usePortalChangeApprovals: () => ({ data: { data: approvals }, isLoading: false }),
  usePortalPpaps: () => ({ data: { data: [] }, isLoading: false }),
  usePortalPpapPackages: () => ({ data: { data: [] }, isLoading: false }),
  usePortalMutation: () => ({ mutate, isPending: false, variables: null }),
}));
vi.mock("../../hooks/useSignOut", () => ({ default: () => [signOut, false] }));

import PortalApp from "./PortalApp";
import PortalDashboard from "./PortalDashboard";
import { PortalTeamPage } from "./PortalPages";

const acme = { id: "a1", organisationId: "o1", organisationName: "Alpha Precision", partyId: "p1", partyKind: "supplier", partyName: "Acme Castings", role: "admin", contactName: "Pat in Quality", mfaRequired: false };
const beta = { ...acme, id: "a2", organisationId: "o2", organisationName: "Beta Castings", partyName: "Bolt Ltd", role: "member", contactName: null };

const renderIt = (path = "/portal") =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/portal" element={<PortalApp />}>
          <Route index element={<PortalDashboard />} />
          <Route path="team" element={<PortalTeamPage />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );

beforeEach(() => {
  mutate.mockReset();
  signOut.mockReset();
  sessionStorage.clear();
  me = { profile: { email: "sam@acme.test" }, memberships: [], portal: [acme], portalInvitations: [] };
  home = { data: { access: acme, attention: [], shared: 0, scarsAwaiting: [], scars: 0 }, isLoading: false, error: null };
  shares = [];
  approvals = [];
  people = [{ id: "x1", email: "sam@acme.test", name: "Sam Smith", role: "admin", status: "active", lastSignInAt: null }];
});

describe("the supplier and customer portal", () => {
  it("welcomes the party, names the organisation and the contact, and says nothing is shared yet", () => {
    renderIt();
    expect(screen.getByRole("heading", { name: "Acme Castings" })).toBeInTheDocument();
    expect(screen.getByText(/Supplier portal for Alpha Precision/)).toBeInTheDocument();
    expect(screen.getByText("Pat in Quality")).toBeInTheDocument();
    expect(screen.getByText(/Nothing has been shared with you yet/)).toBeInTheDocument();
    // The portal has its own side menu and no staff menu.
    const menu = screen.getByRole("navigation", { name: "Portal menu" });
    expect(within(menu).queryByRole("link", { name: "Settings" })).toBeNull();
  });

  it("a supplier's menu has corrective actions, part approvals and process changes and not 8D reports, complaints or certificates; an admin also has Team", () => {
    renderIt();
    const names = within(screen.getByRole("navigation", { name: "Portal menu" })).getAllByRole("link").map((l) => l.getAttribute("title"));
    expect(names).toEqual(["Dashboard", "Non-conformances", "Corrective actions", "Part approvals", "Process changes", "Documents and alerts", "Team"]);
  });

  it("a customer's menu has 8D reports, part approvals, complaints, change requests and certificates, and no corrective actions; a member has no Team", () => {
    const customer = { ...acme, partyKind: "customer", partyName: "Wayne Ltd", role: "member" };
    me = { ...me, portal: [customer] };
    home = { data: { access: customer, attention: [], shared: 0, scarsAwaiting: [], scars: 0 }, isLoading: false, error: null };
    renderIt();
    const names = within(screen.getByRole("navigation", { name: "Portal menu" })).getAllByRole("link").map((l) => l.getAttribute("title"));
    expect(names).toEqual(["Dashboard", "Non-conformances", "8D reports", "Part approvals", "Complaints", "Change requests", "Documents and alerts", "Certificates and reports"]);
  });

  it("highlights only the page the person is on, so Dashboard is not lit on every page", () => {
    renderIt("/portal/team");
    const menu = within(screen.getByRole("navigation", { name: "Portal menu" }));
    expect(menu.getByTitle("Dashboard")).not.toHaveAttribute("aria-current");
    expect(menu.getByTitle("Team")).toHaveAttribute("aria-current", "page");
  });

  it("lays the dashboard out as figures across the top, then the company's numbers beside what needs attention", () => {
    const fresh = { id: "s2", kind: "ncr", reference: "NC-2", title: "Burrs", status: "open", sharedAt: "2026-11-18T09:00:00Z", comments: 0, newComments: 0, viewed: false };
    home = { data: { access: acme, attention: [fresh], shared: 1, scarsAwaiting: [], scars: 0, toAcknowledge: 2, toConfirm: 0 }, isLoading: false, error: null };
    renderIt();
    const tile = (label) => document.querySelector(`[data-tile="${label}"]`);
    expect(tile("Needing attention")).toHaveTextContent("1");
    expect(tile("Open non-conformances")).toBeInTheDocument();
    expect(tile("Corrective actions waiting")).toBeInTheDocument();
    expect(tile("To acknowledge or confirm")).toHaveTextContent("2");
    expect(screen.getByRole("complementary", { name: "Your attention and open records" })).toBeInTheDocument();
  });

  it("shows on a menu item how many things are waiting there", () => {
    const fresh = { id: "s2", kind: "ncr", reference: "NC-2", title: "Burrs", status: "open", sharedAt: "2026-11-18T09:00:00Z", comments: 0, newComments: 0, viewed: false };
    const doc = { ...fresh, id: "s3", kind: "document", reference: "SOP-1", needsAcknowledgement: true };
    home = { data: { access: acme, attention: [fresh, doc], shared: 2, scarsAwaiting: [], scars: 0 }, isLoading: false, error: null };
    renderIt();
    const menu = within(screen.getByRole("navigation", { name: "Portal menu" }));
    expect(menu.getByTitle("Non-conformances")).toBeInTheDocument();
    expect(menu.getByTitle("Documents and alerts")).toBeInTheDocument();
  });

  it("falls back to the organisation's name when no contact is set", () => {
    me = { ...me, portal: [beta] };
    home = { data: { access: beta, attention: [], shared: 0, scarsAwaiting: [], scars: 0 }, isLoading: false, error: null };
    renderIt();
    expect(screen.getAllByText("Beta Castings").length).toBeGreaterThan(0);
    expect(screen.getByText(/Your contact at Beta Castings:/).textContent).toMatch(/Beta Castings$/);
  });

  it("an admin sees their colleagues and can invite; an ordinary member does not", async () => {
    renderIt("/portal/team");
    expect(screen.getByRole("heading", { name: "People at Acme Castings" })).toBeInTheDocument();
    await userEvent.type(screen.getByRole("textbox", { name: /Invite a colleague/ }), "kim@acme.test");
    await userEvent.click(screen.getByRole("button", { name: "Send invitation" }));
    expect(mutate).toHaveBeenCalledWith({ action: "invite", body: { email: "kim@acme.test", message: undefined } }, expect.anything());
  });

  it("an ordinary member has no people section", () => {
    me = { ...me, portal: [beta] };
    home = { data: { access: beta, attention: [], shared: 0, scarsAwaiting: [], scars: 0 }, isLoading: false, error: null };
    renderIt("/portal/team"); // an ordinary member is sent back to the dashboard
    expect(screen.queryByRole("heading", { name: /People at/ })).toBeNull();
    expect(screen.getByRole("heading", { name: "Bolt Ltd" })).toBeInTheDocument();
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
  it("lists what needs attention and everything shared, with what is new", () => {
    const item = { id: "s1", kind: "ncr", reference: "NC-1", title: "Cracked bar stock", status: "open", sharedAt: "2026-11-18T09:00:00Z", comments: 2, newComments: 1, viewed: true };
    const fresh = { ...item, id: "s2", kind: "capa", reference: "CAPA-1", title: "Casting 8D", newComments: 0, viewed: false };
    home = { data: { access: acme, attention: [item, fresh], shared: 2, scarsAwaiting: [], scars: 0 }, isLoading: false, error: null };
    shares = [item, fresh];
    renderIt();
    const attention = screen.getByRole("list", { name: "Needs your attention" });
    expect(within(attention).getByText(/NC-1 · Cracked bar stock/)).toBeInTheDocument();
    expect(within(attention).getByText("1 new reply")).toBeInTheDocument();
    expect(within(attention).getByText("New")).toBeInTheDocument();
    expect(within(attention).getAllByRole("link")[0]).toHaveAttribute("href", expect.stringContaining("/portal/shared/s1"));
  });

  it("puts the corrective action requests that wait for a response first, with when they are due", () => {
    const due = { id: "c1", reference: "SCAR-26-0001", title: "Cracked castings", severity: "major", status: "issued", issuedAt: "2026-11-10T09:00:00Z", responseDueOn: "2099-12-03", awaitingResponse: true, overdue: false, extensionWaiting: false, responses: 0 };
    const late = { ...due, id: "c2", reference: "SCAR-26-0002", title: "Late deliveries", status: "revision_requested", overdue: true, extensionWaiting: true };
    const done = { ...due, id: "c3", reference: "SCAR-26-0003", title: "Old one", status: "closed", awaitingResponse: false };
    home = { data: { access: acme, attention: [], shared: 0, scarsAwaiting: [due, late], scars: 3 }, isLoading: false, error: null };
    scars = [due, late, done];
    renderIt();
    const waiting = screen.getByRole("list", { name: "Requests waiting for your response" });
    expect(within(waiting).getByText(/SCAR-26-0001 · Cracked castings/)).toBeInTheDocument();
    expect(within(waiting).getByText(/Needs your response · Due 3 Dec 2099/)).toBeInTheDocument();
    expect(within(waiting).getByText(/Revised response needed · Overdue since 3 Dec 2099 · more time asked for/)).toBeInTheDocument();
    expect(within(waiting).getByText("Overdue")).toBeInTheDocument();
    expect(within(waiting).getAllByRole("link")[0]).toHaveAttribute("href", expect.stringContaining("/portal/scars/c1"));
    scars = [];
  });

  it("lists the requests with actions for the supplier to do, saying how many and when one is late", () => {
    const withActions = { id: "c1", reference: "SCAR-26-0001", title: "Cracked castings", severity: "major", status: "response_received", issuedAt: "2026-11-10T09:00:00Z", responseDueOn: "2099-12-03", awaitingResponse: false, overdue: false, extensionWaiting: false, responses: 1, openActions: 2, lateActions: 1 };
    home = { data: { access: acme, attention: [], shared: 0, scarsAwaiting: [], scarsWithActions: [withActions], scars: 1 }, isLoading: false, error: null };
    scars = [withActions];
    renderIt();
    const list = screen.getByRole("list", { name: "Requests with actions for you" });
    expect(within(list).getByText(/2 actions to do/)).toBeInTheDocument();
    expect(within(list).getByText("Action overdue")).toBeInTheDocument();
    scars = [];
  });

  it("says when everything has been seen", () => {
    home = { data: { access: acme, attention: [], shared: 3, scarsAwaiting: [], scars: 0 }, isLoading: false, error: null };
    renderIt();
    expect(screen.getByText(/You have seen everything shared with you/)).toBeInTheDocument();
  });

  it("a customer sees the changes waiting for their approval on the dashboard", () => {
    const customer = { ...acme, partyKind: "customer", partyName: "Wayne Ltd", role: "member" };
    me = { ...me, portal: [customer] };
    approvals = [{ id: "r1", reference: "ECR-26-0001", title: "Tighten the bend radius", status: "pending", requestedAt: "2026-11-20T10:00:00Z", decidedAt: null, canDecide: true }];
    home = { data: { access: customer, attention: [], shared: 0, scarsAwaiting: [], scars: 0, changesToApprove: 1 }, isLoading: false, error: null };
    renderIt();
    const list = screen.getByRole("list", { name: "Changes waiting for your approval" });
    expect(within(list).getByRole("link", { name: /ECR-26-0001 · Tighten the bend radius/ })).toHaveAttribute("href", "/portal/change-approvals/r1?org=o1");
    expect(within(list).getByText("Waiting for your answer")).toBeInTheDocument();
  });

  it("a supplier is never shown changes to approve", () => {
    approvals = [{ id: "r1", reference: "ECR-26-0001", title: "x", status: "pending", requestedAt: "2026-11-20T10:00:00Z", decidedAt: null, canDecide: true }];
    renderIt();
    expect(screen.queryByText("Changes waiting for your approval")).toBeNull();
  });
});
