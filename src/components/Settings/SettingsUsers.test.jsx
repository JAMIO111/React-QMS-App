import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const roles = [
  { id: "r-owner", key: "owner", name: "Owner", description: "Full control", permissions: ["roles.manage"] },
  { id: "r-viewer", key: "viewer", name: "Viewer", description: "Read-only", permissions: ["ncr.read"] },
];
const members = [
  { membershipId: "m-me", userId: "u-me", email: "me@example.test", firstName: "Mia", surname: "Owner", status: "active", roles: [{ assignmentId: "a1", roleId: "r-owner", roleName: "Owner", siteId: null }] },
  { membershipId: "m-bob", userId: "u-bob", email: "bob@example.test", firstName: "Bob", surname: "Builder", status: "active", roles: [{ assignmentId: "a2", roleId: "r-viewer", roleName: "Viewer", siteId: null }] },
  { membershipId: "m-inv", userId: null, email: "new@example.test", firstName: null, surname: null, status: "invited", roles: [] },
  { membershipId: "m-old", userId: "u-old", email: "old@example.test", firstName: "Old", surname: "Timer", status: "removed", roles: [] },
];

let permissions;
let membersState;
const mutate = vi.fn();
const confirm = vi.fn();

vi.mock("../../hooks/useQmsApi", () => ({
  useMembers: () => membersState,
  useRoles: () => ({ data: { data: roles }, isLoading: false }),
  useSites: () => ({ data: { data: [] } }),
  usePermissions: () => ({ can: (p) => permissions.includes(p) }),
  useMemberMutation: () => ({ mutate, isPending: false, error: null }),
}));
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
  });

  it("lets a manager invite with a role", async () => {
    permissions = ["members.read", "members.manage"];
    render(<SettingsUsers />);
    const form = screen.getByRole("form", { name: "Invite member" });
    await userEvent.type(within(form).getByLabelText("Email address"), "someone@example.test");
    await userEvent.selectOptions(within(form).getByLabelText("Role"), "r-viewer");
    await userEvent.click(within(form).getByRole("button", { name: "Send invitation" }));
    expect(mutate).toHaveBeenCalledWith({ action: "invite", body: { email: "someone@example.test", roleId: "r-viewer" } }, expect.any(Object));
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
});
