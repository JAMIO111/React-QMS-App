import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const permissionList = [
  { code: "ncr.read", description: "View non-conformances", module: "Nonconformance", needs: "observer" },
  { code: "ncr.create", description: "Raise non-conformances", module: "Nonconformance", needs: "contributor" },
  { code: "ncr.update", description: "Edit non-conformances", module: "Nonconformance", needs: "controller" },
  { code: "calibration.read", description: "View calibration", module: "Calibration", needs: "observer" },
  { code: "members.manage", description: "Invite and manage people", module: "Administration", needs: null },
  { code: "roles.manage", description: "Manage roles", module: "Administration", needs: null },
];
let roles;
let permissions;
let freshRoles;
const mutateAsync = vi.fn();
const confirm = vi.fn();
const showToast = vi.fn();
const refetch = vi.fn();

vi.mock("../../hooks/useQmsApi", () => ({
  usePermissions: () => ({ can: (p) => permissions.includes(p), isLoading: false }),
  useRoles: () => ({ data: { data: roles }, isLoading: false, refetch }),
  usePermissionList: () => ({ data: { data: permissionList }, isLoading: false }),
  useRoleMutation: () => ({ mutateAsync, isPending: false }),
}));
vi.mock("../../contexts/ConfirmationModalProvider", () => ({ useConfirm: () => confirm }));
vi.mock("../../contexts/ToastProvider", () => ({ useToast: () => ({ showToast }) }));

import SettingsRoles from "./SettingsRoles";

const owner = { id: "r-owner", key: "owner", name: "Owner", description: "Full control", isSystem: true, permissions: ["ncr.read", "roles.manage"], holders: 1 };
const tech = { id: "r-tech", key: "custom_tech", name: "Calibration tech", description: "Records calibrations", isSystem: false, permissions: ["calibration.read"], holders: 2, rowVersion: "100" };
const spare = { id: "r-spare", key: "custom_spare", name: "Spare", description: null, isSystem: false, permissions: ["ncr.read"], holders: 0, rowVersion: "200" };

beforeEach(() => {
  vi.clearAllMocks();
  permissions = ["roles.manage"];
  roles = [owner, tech, spare];
  freshRoles = roles;
  refetch.mockImplementation(async () => ({ data: { data: freshRoles } }));
  mutateAsync.mockResolvedValue({});
  confirm.mockResolvedValue(true);
});

const openMenu = async (user, name) => {
  const row = screen.getByText(name, { selector: "p" }).closest("li");
  await user.click(within(row).getByRole("button", { name: "Actions" }));
};

describe("Settings → Roles", () => {
  it("is for people who may manage roles", () => {
    permissions = [];
    render(<SettingsRoles />);
    expect(screen.getByText(/Only the organisation's owners can make or change roles/)).toBeInTheDocument();
  });

  it("lists custom and built-in roles with who holds them", () => {
    render(<SettingsRoles />);
    const mine = screen.getByRole("region", { name: "Your roles" });
    expect(within(mine).getByText("Calibration tech")).toBeInTheDocument();
    expect(within(mine).getByText(/2 people hold it/)).toBeInTheDocument();
    expect(within(mine).getByText(/Nobody holds it yet/)).toBeInTheDocument();
    const builtIn = screen.getByRole("region", { name: "Built-in roles" });
    expect(within(builtIn).getByText("Owner")).toBeInTheDocument();
    expect(within(builtIn).getByText("Built in")).toBeInTheDocument();
  });

  it("makes a role from a blank one and never offers roles.manage", async () => {
    const user = userEvent.setup();
    render(<SettingsRoles />);
    await user.click(screen.getByRole("button", { name: /New role/ }));
    const dialog = screen.getByRole("dialog", { name: "New role" });
    expect(within(dialog).queryByText("Manage roles")).not.toBeInTheDocument();
    expect(within(dialog).getByText("Invite and manage people")).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Make the role" }));
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Give the role a name. Choose at least one permission.");
    expect(mutateAsync).not.toHaveBeenCalled();

    await user.type(within(dialog).getByLabelText("Name"), "Auditor");
    await user.click(within(dialog).getByRole("button", { name: "Choose only the viewing permissions of Nonconformance" }));
    await user.click(within(dialog).getByRole("checkbox", { name: /View calibration/ }));
    await user.click(within(dialog).getByRole("button", { name: "Make the role" }));
    expect(mutateAsync).toHaveBeenCalledWith({
      action: "create",
      body: { name: "Auditor", description: null, permissions: ["ncr.read", "calibration.read"] },
    });
  });

  it("starts a copy from a built-in role without the permission a custom role cannot carry", async () => {
    const user = userEvent.setup();
    render(<SettingsRoles />);
    await openMenu(user, "Owner");
    await user.click(screen.getByRole("menuitem", { name: "Make a copy" }));
    const dialog = screen.getByRole("dialog", { name: "Copy of Owner" });
    expect(within(dialog).getByLabelText("Name")).toHaveValue("Owner copy");
    await user.click(within(dialog).getByRole("button", { name: "Make the role" }));
    expect(mutateAsync).toHaveBeenCalledWith({ action: "create", body: { name: "Owner copy", description: "Full control", permissions: ["ncr.read"] } });
  });

  it("warns that a change reaches the people who hold the role, then saves it", async () => {
    const user = userEvent.setup();
    render(<SettingsRoles />);
    await openMenu(user, "Calibration tech");
    await user.click(screen.getByRole("menuitem", { name: "Edit" }));
    const dialog = screen.getByRole("dialog", { name: "Change Calibration tech" });
    expect(within(dialog).getByText(/2 people hold it\. What you change here takes effect for all of them/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("checkbox", { name: /Raise non-conformances/ }));
    await user.click(within(dialog).getByRole("button", { name: "Save changes" }));
    expect(mutateAsync).toHaveBeenCalledWith({
      action: "update",
      roleId: "r-tech",
      body: { name: "Calibration tech", description: "Records calibrations", permissions: ["calibration.read", "ncr.create"] },
    });
  });

  it("does not save over a change someone else made since the window opened", async () => {
    const user = userEvent.setup();
    render(<SettingsRoles />);
    await openMenu(user, "Calibration tech");
    await user.click(screen.getByRole("menuitem", { name: "Edit" }));
    freshRoles = [owner, { ...tech, rowVersion: "101", permissions: ["calibration.read", "ncr.read"] }, spare];
    const dialog = screen.getByRole("dialog", { name: "Change Calibration tech" });
    await user.click(within(dialog).getByRole("button", { name: "Save changes" }));
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Someone else changed this role since you opened it");
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it("says why the server refused", async () => {
    const user = userEvent.setup();
    mutateAsync.mockRejectedValue(new Error("A role called \"Auditor\" already exists"));
    render(<SettingsRoles />);
    await user.click(screen.getByRole("button", { name: /New role/ }));
    const dialog = screen.getByRole("dialog", { name: "New role" });
    await user.type(within(dialog).getByLabelText("Name"), "Auditor");
    await user.click(within(dialog).getByRole("checkbox", { name: /View calibration/ }));
    await user.click(within(dialog).getByRole("button", { name: "Make the role" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent('A role called "Auditor" already exists');
  });

  it("deletes a role nobody holds after asking, and will not offer it for a role someone holds", async () => {
    const user = userEvent.setup();
    render(<SettingsRoles />);
    await openMenu(user, "Calibration tech");
    expect(screen.getByRole("menuitem", { name: /Delete \(2 people hold it\)/ })).toHaveAttribute("aria-disabled", "true");
    await user.keyboard("{Escape}");
    await openMenu(user, "Spare");
    await user.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ title: "Delete the Spare role?" }));
    expect(mutateAsync).toHaveBeenCalledWith({ action: "delete", roleId: "r-spare" });
  });
});
