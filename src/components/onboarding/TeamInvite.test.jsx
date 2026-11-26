import { describe, expect, it, vi, beforeEach } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
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
vi.mock("../../contexts/OrganisationProvider", () => ({ useOrganisation: () => ({ organisationId: "org-1" }) }));
vi.mock("../../contexts/ToastProvider", () => ({ useToast: () => ({ showToast }) }));

import TeamInvite from "./TeamInvite";

const renderIt = () => render(<MemoryRouter><TeamInvite /></MemoryRouter>);
// The custom combo box: open it, then choose an option by its words.
const choose = async (name, option) => {
  await userEvent.click(screen.getByRole("combobox", { name }));
  await userEvent.click(await screen.findByRole("option", { name: option }));
};
const addPeople = async (text) => {
  await userEvent.type(screen.getByLabelText("Email addresses"), text);
  await userEvent.click(screen.getByRole("button", { name: "Add to the list" }));
};

beforeEach(() => {
  localStorage.clear();
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

  it("sets each person's role and department with the custom drop-downs, and sends one request with a message", async () => {
    renderIt();
    await addPeople("a@example.com b@example.com");
    expect(screen.queryByRole("group", { name: "Set for everyone" })).toBeNull();
    expect(document.querySelector("select")).toBeNull(); // no native drop-down is left
    for (const e of ["a@example.com", "b@example.com"]) {
      await choose(`Role for ${e}`, "Viewer");
      await choose(`Add a department for ${e}`, "PA · Quality");
      await choose(`Package for ${e}`, /^Contributor/);
    }
    await userEvent.type(screen.getByLabelText("Message"), "Welcome to the team");
    await userEvent.click(screen.getByRole("button", { name: "Send 2 invitations" }));
    expect(mutate).toHaveBeenCalledWith(
      {
        action: "inviteMany",
        body: {
          invitations: [
            { email: "a@example.com", roleId: "r-viewer", departmentIds: ["d-qa"], packageSlug: "contributor", message: "Welcome to the team" },
            { email: "b@example.com", roleId: "r-viewer", departmentIds: ["d-qa"], packageSlug: "contributor", message: "Welcome to the team" },
          ],
        },
      },
      expect.any(Object),
    );
  });

  it("shows the chosen departments as chips that can be taken off, and offers only the ones not yet chosen", async () => {
    renderIt();
    await addPeople("a@example.com");
    await choose("Add a department for a@example.com", "PA · Quality");
    const chips = screen.getByRole("list", { name: "Departments for a@example.com" });
    expect(chips).toHaveTextContent("PA · Quality");
    await userEvent.click(screen.getByRole("combobox", { name: "Add a department for a@example.com" }));
    expect(screen.queryByRole("option", { name: "PA · Quality" })).toBeNull();
    expect(await screen.findByRole("option", { name: "PA · Goods-in" })).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await userEvent.click(screen.getByRole("button", { name: "Remove PA · Quality from a@example.com" }));
    expect(screen.queryByRole("list", { name: "Departments for a@example.com" })).toBeNull();
  });

  it("will not send until each person has a role and, for most roles, a department", async () => {
    renderIt();
    await addPeople("a@example.com");
    const send = screen.getByRole("button", { name: "Send 1 invitation" });
    expect(screen.getByRole("alert")).toHaveTextContent("a@example.com: choose a role");
    expect(send).toBeDisabled();
    await choose("Role for a@example.com", "Viewer");
    expect(screen.getByRole("alert")).toHaveTextContent("a@example.com: choose a department");
    expect(send).toBeDisabled();
    await choose("Add a department for a@example.com", "PA · Quality");
    expect(screen.getByRole("alert")).toHaveTextContent("a@example.com: choose a package");
    expect(send).toBeDisabled();
    await choose("Package for a@example.com", /^Contributor/);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(send).toBeEnabled();
  });

  it("needs no department for an organisation-wide role", async () => {
    renderIt();
    await addPeople("boss@example.com");
    await choose("Role for boss@example.com", "Owner");
    await choose("Package for boss@example.com", /^Controller/);
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
      await choose("Package for a@example.com", "Contributor (2 left)");
      await choose("Package for b@example.com", "Contributor (1 left)");
      expect(screen.getByRole("group", { name: "Seats left" })).toHaveTextContent("Contributor: 0 left of 3");
      await userEvent.click(screen.getByRole("combobox", { name: "Package for c@example.com" }));
      expect(await screen.findByRole("option", { name: "Contributor (0 left)" })).toHaveAttribute("aria-disabled", "true");
      expect(screen.getByRole("option", { name: "Observer (0 left)" })).toHaveAttribute("aria-disabled", "true");
      expect(screen.getByRole("link", { name: "Buy more seats" })).toHaveAttribute("href", "/setup/plan");
    });

    it("cannot give more people a package than there are seats for: the last seat is taken and the option is switched off", async () => {
      renderIt();
      await addPeople("a@example.com b@example.com");
      await choose("Package for a@example.com", /^Controller/);
      expect(screen.getByRole("group", { name: "Seats left" })).toHaveTextContent("Controller: 0 left of 2");
      await userEvent.click(screen.getByRole("combobox", { name: "Package for b@example.com" }));
      expect(await screen.findByRole("option", { name: "Controller (0 left)" })).toHaveAttribute("aria-disabled", "true");
    });

    it("sends the package with the person", async () => {
      renderIt();
      await addPeople("a@example.com");
      await choose("Role for a@example.com", "Owner");
      await choose("Package for a@example.com", /^Controller/);
      await userEvent.click(screen.getByRole("button", { name: "Send 1 invitation" }));
      expect(mutate.mock.calls[0][0].body.invitations[0]).toMatchObject({ email: "a@example.com", packageSlug: "controller" });
    });

    it("offers no packages to someone who cannot manage seats, and says so", async () => {
      permissions = ["members.read", "members.manage"];
      renderIt();
      await addPeople("a@example.com");
      expect(screen.queryByRole("combobox", { name: "Package for a@example.com" })).toBeNull();
      expect(screen.queryByRole("group", { name: "Seats left" })).toBeNull();
      expect(screen.getByText(/invite people without a package/)).toBeInTheDocument();
    });
  });

  describe("what happened", () => {
    it("lists the outcome for each person, removes those who were invited and keeps the rest to fix", async () => {
      renderIt();
      await addPeople("a@example.com b@example.com c@example.com");
      for (const e of ["a@example.com", "b@example.com", "c@example.com"]) {
        await choose(`Role for ${e}`, "Owner");
        await choose(`Package for ${e}`, e === "c@example.com" ? /^Controller/ : /^Contributor/);
      }
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
      expect(screen.getByRole("combobox", { name: "Role for c@example.com" })).toBeInTheDocument();
      expect(screen.queryByRole("combobox", { name: "Role for a@example.com" })).toBeNull();
      expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: "warning", title: "2 invited" }));
    });

    it("tells people with an existing account a link was emailed", async () => {
      renderIt();
      await addPeople("a@example.com");
      await choose("Role for a@example.com", "Owner");
      await choose("Package for a@example.com", /^Controller/);
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

describe("planning the team before the plan is active", () => {
  const renderDraft = () => render(<MemoryRouter><TeamInvite live={false} /></MemoryRouter>);

  it("explains that nobody is emailed yet, offers the standard roles and sends nothing", async () => {
    renderDraft();
    expect(screen.getByText(/Plan your team now, invite them after you choose a plan/)).toBeInTheDocument();
    await addPeople("a@example.com, b@example.com");
    await userEvent.click(screen.getByRole("combobox", { name: "Role for a@example.com" }));
    expect((await screen.findAllByRole("option")).map((o) => o.textContent)).toEqual(expect.arrayContaining(["Quality engineer", "Inspector", "Viewer"]));
    await userEvent.click(screen.getByRole("option", { name: "Viewer" }));
    expect(screen.queryByRole("button", { name: /Send \d invitation/ })).toBeNull();
    expect(screen.getByText(/Nobody is emailed until your plan is active/)).toBeInTheDocument();
    expect(mutate).not.toHaveBeenCalled();
  });

  it("says how many seats the planned team needs, counting the owner's Controller seat", async () => {
    renderDraft();
    await addPeople("a@example.com, b@example.com");
    await choose("Package for a@example.com", "Contributor");
    await choose("Package for b@example.com", "Contributor");
    const needs = screen.getByRole("group", { name: "Seats this team needs" });
    expect(needs).toHaveTextContent("Controller: 1");
    expect(needs).toHaveTextContent("Contributor: 2");
  });

  it("remembers the list when the page is left and opened again, and offers it ready to send once the plan is active", async () => {
    const first = renderDraft();
    await addPeople("a@example.com");
    await choose("Role for a@example.com", "Owner");
    await choose("Package for a@example.com", /^Controller/);
    first.unmount();
    renderDraft();
    expect(screen.getByText("To invite (1)")).toBeInTheDocument();
    cleanup();
    renderIt(); // the plan is active now: the same list, ready to send, with the real roles
    expect(screen.getByText("Your planned team is ready to send")).toBeInTheDocument();
    expect(screen.getByText("To invite (1)")).toBeInTheDocument();
  });

  it("does not say the planned team is ready while someone still has no role or package", async () => {
    const first = renderDraft();
    await addPeople("a@example.com, b@example.com");
    await choose("Role for a@example.com", "Owner");
    await choose("Package for a@example.com", /^Controller/);
    first.unmount();
    renderIt();
    expect(screen.queryByText("Your planned team is ready to send")).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent("b@example.com: choose a role");
    expect(screen.getByRole("button", { name: "Send 2 invitations" })).toBeDisabled();
  });

  it("turns a planned standard role into the organisation's own role when invitations can be sent", async () => {
    const first = renderDraft();
    await addPeople("a@example.com");
    await choose("Role for a@example.com", "Viewer");
    await choose("Add a department for a@example.com", "PA · Quality");
    first.unmount();
    renderIt();
    expect(screen.getByRole("combobox", { name: "Role for a@example.com" })).toHaveAttribute("placeholder", "Viewer");
    expect(screen.getByRole("list", { name: "Departments for a@example.com" })).toHaveTextContent("PA · Quality");
  });
});
