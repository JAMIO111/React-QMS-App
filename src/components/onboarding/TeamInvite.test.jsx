import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

const roles = [
  { id: "r-owner", key: "owner", name: "Owner" },
  { id: "r-viewer", key: "viewer", name: "Viewer" },
];
const departments = [
  { id: "d-qa", siteId: "s1", code: "QA", name: "Quality", active: true },
  { id: "d-gi", siteId: "s1", code: "GI", name: "Goods-in", active: true },
];
let permissions;
let members;
let overview;
const mutate = vi.fn();
const showToast = vi.fn();

vi.mock("../../hooks/useQmsApi", () => ({
  useRoles: () => ({ data: { data: roles } }),
  useSites: () => ({ data: { data: [{ id: "s1", code: "PA", name: "Plant A" }] } }),
  useAllDepartments: () => ({ data: { data: departments } }),
  useMembers: () => ({ data: { data: members } }),
  usePermissions: () => ({ can: (p) => permissions.includes(p) }),
  useMemberMutation: () => ({ mutate, isPending: false }),
}));
vi.mock("../../hooks/useSubscription", () => ({ useSubscriptionOverview: () => ({ data: overview }) }));
vi.mock("../../contexts/ToastProvider", () => ({ useToast: () => ({ showToast }) }));

import TeamInvite from "./TeamInvite";

const renderIt = () => render(<MemoryRouter><TeamInvite /></MemoryRouter>);
const addPeople = async (text) => {
  await userEvent.type(screen.getByLabelText("Email addresses"), text);
  await userEvent.click(screen.getByRole("button", { name: "Add to the list" }));
};

beforeEach(() => {
  mutate.mockReset();
  showToast.mockReset();
  permissions = ["members.read", "members.manage", "subscription.seats"];
  members = [];
  overview = { items: [{ planSlug: "controller", planName: "Controller", purchased: 2, assigned: 1, available: 1 }, { planSlug: "contributor", planName: "Contributor", purchased: 3, assigned: 1, available: 2 }, { planSlug: "observer", planName: "Observer", purchased: 0, assigned: 0, available: 0 }] };
});

describe("inviting a team", () => {
  it("turns pasted text into a list of people, once each, ignoring what is not an address", async () => {
    renderIt();
    await addPeople("Ann <ann@example.com>, bob@example.com; BOB@example.com\nnot an address, cy@example.com.");
    expect(screen.getByText("To invite (3)")).toBeInTheDocument();
    for (const e of ["ann@example.com", "bob@example.com", "cy@example.com"]) expect(screen.getByLabelText(`Role for ${e}`)).toBeInTheDocument();
  });

  it("sets role and department for everyone at once, and sends one request with a message", async () => {
    renderIt();
    await addPeople("a@example.com b@example.com");
    const all = screen.getByRole("group", { name: "Set for everyone" });
    await userEvent.selectOptions(within(all).getByLabelText("Role for everyone"), "r-viewer");
    await userEvent.selectOptions(within(all).getByLabelText("Department for everyone"), "d-qa");
    await userEvent.type(screen.getByLabelText("Message"), "Welcome to the team");
    await userEvent.click(screen.getByRole("button", { name: "Send 2 invitations" }));
    expect(mutate).toHaveBeenCalledWith(
      {
        action: "inviteMany",
        body: {
          invitations: [
            { email: "a@example.com", roleId: "r-viewer", departmentIds: ["d-qa"], message: "Welcome to the team" },
            { email: "b@example.com", roleId: "r-viewer", departmentIds: ["d-qa"], message: "Welcome to the team" },
          ],
        },
      },
      expect.any(Object),
    );
  });

  it("will not send until each person has a role and, for most roles, a department", async () => {
    renderIt();
    await addPeople("a@example.com");
    const send = screen.getByRole("button", { name: "Send 1 invitation" });
    expect(screen.getByRole("alert")).toHaveTextContent("a@example.com: choose a role");
    expect(send).toBeDisabled();
    await userEvent.selectOptions(screen.getByLabelText("Role for a@example.com"), "r-viewer");
    expect(screen.getByRole("alert")).toHaveTextContent("a@example.com: choose a department");
    expect(send).toBeDisabled();
    await userEvent.click(screen.getByRole("checkbox", { name: "PA · Quality for a@example.com" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(send).toBeEnabled();
  });

  it("needs no department for an organisation-wide role", async () => {
    renderIt();
    await addPeople("boss@example.com");
    await userEvent.selectOptions(screen.getByLabelText("Role for boss@example.com"), "r-owner");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "Send 1 invitation" })).toBeEnabled();
  });

  describe("seats", () => {
    it("shows the seats left as packages are chosen, and stops offering a package that has run out", async () => {
      renderIt();
      await addPeople("a@example.com b@example.com c@example.com");
      const seats = screen.getByRole("group", { name: "Seats left" });
      expect(seats).toHaveTextContent("Contributor: 2 left of 3");
      expect(seats).toHaveTextContent("Controller: 1 left of 2");
      await userEvent.selectOptions(screen.getByLabelText("Package for a@example.com"), "contributor");
      await userEvent.selectOptions(screen.getByLabelText("Package for b@example.com"), "contributor");
      expect(screen.getByRole("group", { name: "Seats left" })).toHaveTextContent("Contributor: 0 left of 3");
      const third = screen.getByLabelText("Package for c@example.com");
      expect(within(third).getByRole("option", { name: "Contributor (0 left)" })).toBeDisabled();
      expect(within(screen.getByLabelText("Package for a@example.com")).getByRole("option", { name: "Contributor (1 left)" })).toBeEnabled();
      expect(within(third).getByRole("option", { name: "Observer (0 left)" })).toBeDisabled();
      expect(screen.getByRole("link", { name: "Buy more seats" })).toHaveAttribute("href", "/Settings/Subscription");
    });

    it("blocks sending when everyone is given a package there are not enough seats for, and says how many more", async () => {
      renderIt();
      await addPeople("a@example.com b@example.com c@example.com");
      const all = screen.getByRole("group", { name: "Set for everyone" });
      await userEvent.selectOptions(within(all).getByLabelText("Role for everyone"), "r-owner");
      await userEvent.selectOptions(within(all).getByLabelText("Package for everyone"), "controller");
      expect(screen.getByRole("alert")).toHaveTextContent("Not enough Controller seats: 2 more needed");
      expect(screen.getByRole("button", { name: "Send 3 invitations" })).toBeDisabled();
    });

    it("sends the package with the person", async () => {
      renderIt();
      await addPeople("a@example.com");
      await userEvent.selectOptions(screen.getByLabelText("Role for a@example.com"), "r-owner");
      await userEvent.selectOptions(screen.getByLabelText("Package for a@example.com"), "controller");
      await userEvent.click(screen.getByRole("button", { name: "Send 1 invitation" }));
      expect(mutate.mock.calls[0][0].body.invitations[0]).toMatchObject({ email: "a@example.com", packageSlug: "controller" });
    });

    it("offers no packages to someone who cannot manage seats, and says so", async () => {
      permissions = ["members.read", "members.manage"];
      renderIt();
      await addPeople("a@example.com");
      expect(screen.queryByLabelText("Package for a@example.com")).toBeNull();
      expect(screen.queryByRole("group", { name: "Seats left" })).toBeNull();
      expect(screen.getByText(/invite people without a package/)).toBeInTheDocument();
    });
  });

  describe("what happened", () => {
    it("lists the outcome for each person, removes those who were invited and keeps the rest to fix", async () => {
      renderIt();
      await addPeople("a@example.com b@example.com c@example.com");
      const all = screen.getByRole("group", { name: "Set for everyone" });
      await userEvent.selectOptions(within(all).getByLabelText("Role for everyone"), "r-owner");
      await userEvent.click(screen.getByRole("button", { name: "Send 3 invitations" }));
      mutate.mock.calls[0][1].onSuccess({
        invited: 2,
        failed: 1,
        results: [
          { email: "a@example.com", ok: true, emailOutcome: { sent: true } },
          { email: "b@example.com", ok: true, emailOutcome: { sent: false, reason: "not_configured" } },
          { email: "c@example.com", ok: false, error: { code: "already_member", message: "This person is already a member of the organisation" } },
        ],
      });
      const results = await screen.findByRole("list", { name: "Results" });
      expect(within(results).getByText(/An email is on its way/)).toBeInTheDocument();
      expect(within(results).getByText(/Email is not set up here/)).toBeInTheDocument();
      expect(within(results).getByText(/already a member/)).toBeInTheDocument();
      expect(screen.getByText("To invite (1)")).toBeInTheDocument();
      expect(screen.getByLabelText("Role for c@example.com")).toBeInTheDocument();
      expect(screen.queryByLabelText("Role for a@example.com")).toBeNull();
      expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: "warning", title: "2 invited" }));
    });

    it("tells people with an existing account a link was emailed", async () => {
      renderIt();
      await addPeople("a@example.com");
      await userEvent.selectOptions(screen.getByLabelText("Role for a@example.com"), "r-owner");
      await userEvent.click(screen.getByRole("button", { name: "Send 1 invitation" }));
      mutate.mock.calls[0][1].onSuccess({ invited: 1, failed: 0, results: [{ email: "a@example.com", ok: true, emailOutcome: { sent: true, kind: "sign_in_link" } }] });
      expect(await screen.findByText(/emailed a sign-in link/)).toBeInTheDocument();
    });
  });

  describe("waiting for an answer", () => {
    const pending = (over = {}) => ({
      membershipId: "m1", email: "wait@example.com", status: "invited", roles: [{ roleName: "Viewer" }],
      invite: { expiresAt: new Date(Date.now() + 9 * 864e5).toISOString(), expired: false, sendCount: 2, packageName: "Contributor", ...over },
    });

    it("lists pending invitations with expiry, seat and send count, and resends or revokes them", async () => {
      members = [pending(), { membershipId: "m0", email: "member@example.com", status: "active", roles: [] }];
      renderIt();
      const list = screen.getByRole("list", { name: "Pending invitations" });
      expect(within(list).getAllByRole("listitem")).toHaveLength(1);
      expect(list).toHaveTextContent("Viewer · Contributor seat reserved · expires in 9 days · sent 2 times");
      await userEvent.click(screen.getByRole("button", { name: "Resend to wait@example.com" }));
      expect(mutate).toHaveBeenLastCalledWith({ action: "resend", membershipId: "m1" }, expect.any(Object));
      await userEvent.click(screen.getByRole("button", { name: "Revoke wait@example.com" }));
      expect(mutate).toHaveBeenLastCalledWith({ action: "revoke", membershipId: "m1" }, expect.any(Object));
    });

    it("says an invitation has expired, and shows no buttons to people who cannot manage members", () => {
      members = [pending({ expired: true })];
      permissions = ["members.read"];
      renderIt();
      expect(screen.getByRole("list", { name: "Pending invitations" })).toHaveTextContent("expired");
      expect(screen.queryByRole("button", { name: /Resend|Revoke/ })).toBeNull();
    });

    it("shows nothing when nobody is waiting", () => {
      renderIt();
      expect(screen.queryByRole("list", { name: "Pending invitations" })).toBeNull();
    });
  });
});
