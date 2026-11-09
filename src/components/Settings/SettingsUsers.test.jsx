import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const roles = [
  { id: "r-owner", key: "owner", name: "Owner", description: "Full control", permissions: ["roles.manage"] },
  { id: "r-viewer", key: "viewer", name: "Viewer", description: "Read-only", permissions: ["ncr.read"] },
];
const departments = [
  { id: "d-gi", siteId: "s1", code: "GI", name: "Goods-in", active: true },
  { id: "d-fi", siteId: "s1", code: "FI", name: "Final inspection", active: true },
];
const members = [
  { membershipId: "m-me", userId: "u-me", email: "me@example.test", firstName: "Mia", surname: "Owner", status: "active", roles: [{ assignmentId: "a1", roleId: "r-owner", roleKey: "owner", roleName: "Owner", siteId: null }], departments: [] },
  { membershipId: "m-bob", userId: "u-bob", email: "bob@example.test", firstName: "Bob", surname: "Builder", status: "active", roles: [{ assignmentId: "a2", roleId: "r-viewer", roleKey: "viewer", roleName: "Viewer", siteId: null }], departments: [{ id: "dm1", departmentId: "d-gi", code: "GI", name: "Goods-in", siteId: "s1", siteName: "Plant A", isPrimary: true, joinedAt: "2026-11-01T00:00:00Z" }, { id: "dm2", departmentId: "d-fi", code: "FI", name: "Final inspection", siteId: "s1", siteName: "Plant A", isPrimary: false, joinedAt: "2026-11-02T00:00:00Z" }] },
  { membershipId: "m-inv", userId: null, email: "new@example.test", firstName: null, surname: null, status: "invited", roles: [], departments: [] },
  { membershipId: "m-old", userId: "u-old", email: "old@example.test", firstName: "Old", surname: "Timer", status: "removed", roles: [], departments: [] },
];

let permissions;
let membersState;
let seatOverview;
const mutate = vi.fn();
const confirm = vi.fn();

vi.mock("../../hooks/useQmsApi", () => ({
  useMembers: () => membersState,
  useRoles: () => ({ data: { data: roles }, isLoading: false }),
  useSites: () => ({ data: { data: [{ id: "s1", code: "PA", name: "Plant A" }] } }),
  useAllDepartments: () => ({ data: { data: departments } }),
  usePermissions: () => ({ can: (p) => permissions.includes(p) }),
  useMemberMutation: () => ({ mutate, isPending: false, error: null }),
}));
const seatMutate = vi.fn();
let seatAssignments;
vi.mock("../../hooks/useSubscription", () => ({
  useSubscriptionOverview: () => ({ data: seatOverview }),
  useSeatAssignments: () => ({ data: seatAssignments }),
  useSubscriptionMutation: () => ({ mutate: seatMutate, isPending: false }),
}));
vi.mock("../../contexts/AuthProvider", () => ({ useAuth: () => ({ user: { id: "u-me" } }) }));
vi.mock("../../contexts/ConfirmationModalProvider", () => ({ useConfirm: () => confirm }));
vi.mock("../../contexts/ToastProvider", () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock("./SettingsOrganisation", () => ({ ApiUnavailable: () => <p>api unavailable</p> }));

import SettingsUsers from "./SettingsUsers";

const card = (name) => screen.getByRole("listitem", { name });
const pick = async (scope, label, option) => {
  await userEvent.click(within(scope).getByRole("combobox", { name: label }));
  await userEvent.click(await screen.findByRole("option", { name: new RegExp(`^${option}`) }));
};
const act = async (name, item) => {
  await userEvent.click(within(card(name)).getByRole("button", { name: "Actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: item }));
};

describe("SettingsUsers", () => {
  beforeEach(() => {
    mutate.mockReset();
    seatMutate.mockReset();
    confirm.mockReset();
    membersState = { data: { data: members }, isLoading: false, error: null };
    seatOverview = { items: [{ planSlug: "controller", planName: "Controller", available: 1 }, { planSlug: "contributor", planName: "Contributor", available: 1 }, { planSlug: "observer", planName: "Observer", available: 0 }] };
    seatAssignments = [{ membershipId: "m-me", plan: { slug: "controller", name: "Controller" } }, { membershipId: "m-bob", plan: null }];
  });

  it("lets a manager invite with a role and departments, one of them primary", async () => {
    permissions = ["members.read", "members.manage"];
    render(<SettingsUsers />);
    const form = screen.getByRole("form", { name: "Invite member" });
    await userEvent.type(within(form).getByLabelText("Email address"), "someone@example.test");
    await pick(form, "Role", "Viewer");
    await userEvent.click(within(form).getByRole("button", { name: "Send invitation" }));
    expect(mutate).not.toHaveBeenCalled();
    expect(within(form).getByRole("status")).toHaveTextContent("Choose at least one department");
    await userEvent.click(within(form).getByRole("checkbox", { name: /Goods-in/ }));
    await userEvent.click(within(form).getByRole("checkbox", { name: /Final inspection/ }));
    await userEvent.click(within(form).getAllByRole("radio", { name: "primary" })[1]);
    await userEvent.click(within(form).getByRole("button", { name: "Send invitation" }));
    expect(mutate).toHaveBeenCalledWith(
      { action: "invite", body: { email: "someone@example.test", roleId: "r-viewer", departmentIds: ["d-gi", "d-fi"], primaryDepartmentId: "d-fi" } },
      expect.any(Object),
    );
  });

  it("asks for a role, and needs no department for an organisation-wide role", async () => {
    permissions = ["members.read", "members.manage"];
    render(<SettingsUsers />);
    const form = screen.getByRole("form", { name: "Invite member" });
    await userEvent.type(within(form).getByLabelText("Email address"), "boss@example.test");
    await userEvent.click(within(form).getByRole("button", { name: "Send invitation" }));
    expect(within(form).getByRole("status")).toHaveTextContent("Choose a role");
    await pick(form, "Role", "Owner");
    expect(within(form).getByText(/Not needed for owners, admins and quality managers/)).toBeInTheDocument();
    await userEvent.click(within(form).getByRole("button", { name: "Send invitation" }));
    expect(mutate).toHaveBeenCalledWith({ action: "invite", body: { email: "boss@example.test", roleId: "r-owner" } }, expect.any(Object));
  });

  it("uses combo boxes, never a native drop-down", () => {
    permissions = ["members.read", "members.manage", "subscription.read", "subscription.seats"];
    const { container } = render(<SettingsUsers />);
    expect(container.querySelector("select")).toBeNull();
  });

  it("shows departments, with the primary one marked, and adds, switches and removes them", async () => {
    permissions = ["members.read", "members.manage"];
    render(<SettingsUsers />);
    const list = screen.getByRole("list", { name: "Department list of Bob Builder" });
    expect(within(list).getByText("Goods-in")).toBeInTheDocument();
    expect(within(list).getByText("primary")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Make Final inspection the primary department of Bob Builder" }));
    expect(mutate).toHaveBeenLastCalledWith({ action: "setPrimaryDepartment", departmentMembershipId: "dm2" }, expect.any(Object));
    await userEvent.click(screen.getByRole("button", { name: "Remove Bob Builder from Goods-in" }));
    expect(mutate).toHaveBeenLastCalledWith({ action: "endDepartment", departmentMembershipId: "dm1" }, expect.any(Object));
    await pick(card("Mia Owner"), "Add a department for Mia Owner", "PA · Goods-in");
    expect(mutate).toHaveBeenLastCalledWith({ action: "addDepartment", membershipId: "m-me", body: { departmentId: "d-gi" } }, expect.any(Object));
  });

  it("points out people without a department whose roles are not organisation-wide", async () => {
    permissions = ["members.read", "members.manage"];
    membersState = {
      data: { data: [...members, { membershipId: "m-lost", userId: "u-lost", email: "lost@example.test", firstName: "Lou", surname: "Lost", status: "active", roles: [{ assignmentId: "a9", roleId: "r-viewer", roleKey: "viewer", roleName: "Viewer", siteId: null }], departments: [] }] },
      isLoading: false,
      error: null,
    };
    render(<SettingsUsers />);
    expect(screen.getByText(/1 person has no department \(Lou Lost\)/)).toBeInTheDocument();
    expect(screen.getByText(/alerts to departments will not reach them/)).toBeInTheDocument();
  });

  it("offers no actions on your own membership, and asks before removing someone", async () => {
    permissions = ["members.read", "members.manage"];
    confirm.mockResolvedValue(true);
    render(<SettingsUsers />);
    expect(within(card("Mia Owner")).queryByRole("button", { name: "Actions" })).not.toBeInTheDocument();
    await act("Bob Builder", "Remove from organisation");
    expect(confirm).toHaveBeenCalled();
    expect(mutate).toHaveBeenCalledWith({ action: "status", membershipId: "m-bob", body: { status: "removed" } }, expect.any(Object));
    await act("new@example.test", "Revoke invitation");
    expect(mutate).toHaveBeenLastCalledWith({ action: "status", membershipId: "m-inv", body: { status: "removed" } }, expect.any(Object));
  });

  it("adds and removes roles", async () => {
    permissions = ["members.read", "members.manage"];
    render(<SettingsUsers />);
    await pick(card("Bob Builder"), "Add a role for Bob Builder", "Owner");
    expect(mutate).toHaveBeenCalledWith({ action: "assign", membershipId: "m-bob", body: { roleId: "r-owner" } }, expect.any(Object));
    await userEvent.click(screen.getByRole("button", { name: "Remove role Viewer from Bob Builder" }));
    expect(mutate).toHaveBeenLastCalledWith({ action: "unassign", assignmentId: "a2" }, expect.any(Object));
  });

  it("shows each person's seat and lets someone who manages seats change it", async () => {
    permissions = ["members.read", "members.manage", "subscription.read", "subscription.seats"];
    confirm.mockResolvedValue(true);
    render(<SettingsUsers />);
    expect(within(card("Mia Owner")).getByRole("combobox", { name: "Seat for Mia Owner" })).toHaveValue("Controller");
    await pick(card("Bob Builder"), "Seat for Bob Builder", "Contributor");
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ title: "Give Bob Builder a Contributor seat?" }));
    expect(seatMutate).toHaveBeenCalledWith({ action: "assign", membershipId: "m-bob", planSlug: "contributor" }, expect.any(Object));
  });

  it("shows the seat read-only to someone who may see seats but not change them, and hides it from others", () => {
    permissions = ["members.read", "subscription.read"];
    const { unmount } = render(<SettingsUsers />);
    expect(within(card("Mia Owner")).getByText("Controller")).toBeInTheDocument();
    expect(within(card("Mia Owner")).queryByRole("combobox", { name: "Seat for Mia Owner" })).toBeNull();
    unmount();
    permissions = ["members.read"];
    render(<SettingsUsers />);
    expect(screen.queryByRole("region", { name: "Seat of Mia Owner" })).toBeNull();
  });

  it("finds people by name or email", async () => {
    permissions = ["members.read"];
    render(<SettingsUsers />);
    await userEvent.type(screen.getByLabelText("Search people"), "bob");
    expect(screen.getByRole("listitem", { name: "Bob Builder" })).toBeInTheDocument();
    expect(screen.queryByRole("listitem", { name: "Mia Owner" })).toBeNull();
  });

  it("is read-only with members.read only, and hides removed members unless asked", async () => {
    permissions = ["members.read"];
    render(<SettingsUsers />);
    expect(screen.queryByRole("form", { name: "Invite member" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Actions" })).not.toBeInTheDocument();
    expect(screen.queryByText("Old Timer")).not.toBeInTheDocument();
    await userEvent.click(screen.getByLabelText("Show removed"));
    expect(screen.getByText("Old Timer")).toBeInTheDocument();
  });

  it("explains a missing members.read permission", () => {
    permissions = [];
    membersState = { isLoading: false, error: { status: 403, code: "forbidden" } };
    render(<SettingsUsers />);
    expect(screen.getByText(/members\.read permission/)).toBeInTheDocument();
  });

  it("sends a message and a seat with the invitation, offering only seats that are left", async () => {
    permissions = ["members.read", "members.manage", "subscription.seats"];
    render(<SettingsUsers />);
    const form = screen.getByRole("form", { name: "Invite member" });
    await userEvent.type(within(form).getByLabelText("Email address"), "boss@example.test");
    await pick(form, "Role", "Owner");
    await userEvent.click(within(form).getByRole("combobox", { name: "Seat" }));
    expect(await screen.findByRole("option", { name: /^Observer/ })).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(screen.getByRole("option", { name: /^Contributor/ }));
    await userEvent.type(within(form).getByLabelText("Message (optional)"), "Welcome aboard");
    await userEvent.click(within(form).getByRole("button", { name: "Send invitation" }));
    expect(mutate).toHaveBeenCalledWith(
      { action: "invite", body: { email: "boss@example.test", roleId: "r-owner", message: "Welcome aboard", packageSlug: "contributor" } },
      expect.any(Object),
    );
  });

  it("offers no seat to someone who cannot manage seats", () => {
    permissions = ["members.read", "members.manage"];
    render(<SettingsUsers />);
    expect(within(screen.getByRole("form", { name: "Invite member" })).queryByRole("combobox", { name: "Seat" })).toBeNull();
  });

  it("shows when an invitation expires and which seat is reserved, and resends or revokes it", async () => {
    permissions = ["members.read", "members.manage"];
    membersState = {
      data: { data: members.map((m) => (m.membershipId === "m-inv" ? { ...m, invite: { message: null, expiresAt: new Date(Date.now() + 5 * 864e5).toISOString(), lastSentAt: null, sendCount: 3, expired: false, packageSlug: "contributor", packageName: "Contributor" } } : m)) },
      isLoading: false,
      error: null,
    };
    render(<SettingsUsers />);
    const detail = screen.getByLabelText("Invitation to new@example.test");
    expect(detail).toHaveTextContent(/Expires in [45] days/);
    expect(detail).toHaveTextContent("Contributor seat reserved");
    expect(detail).toHaveTextContent("sent 3 times");
    await act("new@example.test", "Resend invitation");
    expect(mutate).toHaveBeenLastCalledWith({ action: "resend", membershipId: "m-inv" }, expect.any(Object));
  });

  it("says an invitation has expired", () => {
    permissions = ["members.read", "members.manage"];
    membersState = {
      data: { data: members.map((m) => (m.membershipId === "m-inv" ? { ...m, invite: { message: null, expiresAt: "2026-01-01T00:00:00Z", lastSentAt: null, sendCount: 1, expired: true, packageSlug: null, packageName: null } } : m)) },
      isLoading: false,
      error: null,
    };
    render(<SettingsUsers />);
    expect(screen.getByLabelText("Invitation to new@example.test")).toHaveTextContent("Expired");
  });
});
