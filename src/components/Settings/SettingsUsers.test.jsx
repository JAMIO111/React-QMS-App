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
vi.mock("../../hooks/useSubscription", () => ({ useSubscriptionOverview: () => ({ data: seatOverview }) }));
vi.mock("../../contexts/AuthProvider", () => ({ useAuth: () => ({ user: { id: "u-me" } }) }));
vi.mock("../../contexts/ConfirmationModalProvider", () => ({ useConfirm: () => confirm }));
vi.mock("../../contexts/ToastProvider", () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock("./SettingsOrganisation", () => ({ ApiUnavailable: () => <p>api unavailable</p> }));

import SettingsUsers from "./SettingsUsers";

const row = (name) => screen.getByText(name).closest("tr");

describe("SettingsUsers", () => {
  beforeEach(() => {
    mutate.mockReset();
    confirm.mockReset();
    membersState = { data: { data: members }, isLoading: false, error: null };
    seatOverview = { items: [{ planSlug: "contributor", planName: "Contributor", available: 1 }, { planSlug: "observer", planName: "Observer", available: 0 }] };
  });

  it("lets a manager invite with a role and departments, one of them primary", async () => {
    permissions = ["members.read", "members.manage"];
    render(<SettingsUsers />);
    const form = screen.getByRole("form", { name: "Invite member" });
    await userEvent.type(within(form).getByLabelText("Email address"), "someone@example.test");
    await userEvent.selectOptions(within(form).getByLabelText("Role"), "r-viewer");
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

  it("needs no department for an organisation-wide role", async () => {
    permissions = ["members.read", "members.manage"];
    render(<SettingsUsers />);
    const form = screen.getByRole("form", { name: "Invite member" });
    await userEvent.type(within(form).getByLabelText("Email address"), "boss@example.test");
    await userEvent.selectOptions(within(form).getByLabelText("Role"), "r-owner");
    expect(within(form).getByText(/Not needed for owners, admins and quality managers/)).toBeInTheDocument();
    await userEvent.click(within(form).getByRole("button", { name: "Send invitation" }));
    expect(mutate).toHaveBeenCalledWith({ action: "invite", body: { email: "boss@example.test", roleId: "r-owner" } }, expect.any(Object));
  });

  it("shows departments, with the primary one marked, and adds, switches and removes them", async () => {
    permissions = ["members.read", "members.manage"];
    render(<SettingsUsers />);
    const list = screen.getByRole("list", { name: "Departments of Bob Builder" });
    expect(within(list).getByText("Goods-in")).toBeInTheDocument();
    expect(within(list).getByText("primary")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Make Final inspection the primary department of Bob Builder" }));
    expect(mutate).toHaveBeenLastCalledWith({ action: "setPrimaryDepartment", departmentMembershipId: "dm2" }, expect.any(Object));
    await userEvent.click(screen.getByRole("button", { name: "Remove Bob Builder from Goods-in" }));
    expect(mutate).toHaveBeenLastCalledWith({ action: "endDepartment", departmentMembershipId: "dm1" }, expect.any(Object));
    const addForm = screen.getByRole("form", { name: "Add department to Mia Owner" });
    await userEvent.selectOptions(within(addForm).getByLabelText("Department to add for Mia Owner"), "d-gi");
    await userEvent.click(within(addForm).getByRole("button", { name: "Add" }));
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
    expect(within(row("Mia Owner")).queryByRole("button", { name: "Suspend" })).not.toBeInTheDocument();

    await userEvent.click(within(row("Bob Builder")).getByRole("button", { name: "Remove" }));
    expect(confirm).toHaveBeenCalled();
    expect(mutate).toHaveBeenCalledWith({ action: "status", membershipId: "m-bob", body: { status: "removed" } }, expect.any(Object));

    await userEvent.click(within(row("new@example.test")).getByRole("button", { name: "Revoke" }));
    expect(mutate).toHaveBeenLastCalledWith({ action: "status", membershipId: "m-inv", body: { status: "removed" } }, expect.any(Object));
  });

  it("adds and removes roles", async () => {
    permissions = ["members.read", "members.manage"];
    render(<SettingsUsers />);
    await userEvent.selectOptions(screen.getByLabelText("Role to add for Bob Builder"), "r-owner");
    await userEvent.click(within(screen.getByRole("form", { name: "Add role to Bob Builder" })).getByRole("button", { name: "Add" }));
    expect(mutate).toHaveBeenCalledWith({ action: "assign", membershipId: "m-bob", body: { roleId: "r-owner" } }, expect.any(Object));
    await userEvent.click(screen.getByRole("button", { name: "Remove role Viewer from Bob Builder" }));
    expect(mutate).toHaveBeenLastCalledWith({ action: "unassign", assignmentId: "a2" }, expect.any(Object));
  });

  it("is read-only with members.read only, and hides removed members unless asked", async () => {
    permissions = ["members.read"];
    render(<SettingsUsers />);
    expect(screen.queryByRole("form", { name: "Invite member" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove" })).not.toBeInTheDocument();
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

  it("sends a message and a package with the invitation, offering only packages with a seat left", async () => {
    permissions = ["members.read", "members.manage", "subscription.seats"];
    render(<SettingsUsers />);
    const form = screen.getByRole("form", { name: "Invite member" });
    await userEvent.type(within(form).getByLabelText("Email address"), "boss@example.test");
    await userEvent.selectOptions(within(form).getByLabelText("Role"), "r-owner");
    const pkg = within(form).getByLabelText("Package");
    expect(within(pkg).getByRole("option", { name: "Contributor (1 left)" })).toBeEnabled();
    expect(within(pkg).getByRole("option", { name: "Observer (0 left)" })).toBeDisabled();
    await userEvent.selectOptions(pkg, "contributor");
    await userEvent.type(within(form).getByLabelText("Message (optional)"), "Welcome aboard");
    await userEvent.click(within(form).getByRole("button", { name: "Send invitation" }));
    expect(mutate).toHaveBeenCalledWith(
      { action: "invite", body: { email: "boss@example.test", roleId: "r-owner", message: "Welcome aboard", packageSlug: "contributor" } },
      expect.any(Object),
    );
  });

  it("offers no package to someone who cannot manage seats", () => {
    permissions = ["members.read", "members.manage"];
    render(<SettingsUsers />);
    expect(within(screen.getByRole("form", { name: "Invite member" })).queryByLabelText("Package")).toBeNull();
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
    await userEvent.click(screen.getByRole("button", { name: "Resend invitation to new@example.test" }));
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
