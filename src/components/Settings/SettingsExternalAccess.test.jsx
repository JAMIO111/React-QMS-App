import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

let permissions;
let overview;
let people;
const mutate = vi.fn();
const showToast = vi.fn();

vi.mock("../../hooks/useQmsApi", () => ({ usePermissions: () => ({ can: (p) => permissions.includes(p), isLoading: false }) }));
vi.mock("../../hooks/usePortal", () => ({
  useExternalAccess: () => ({ data: overview, isLoading: false, error: null }),
  useExternalPeople: ({ partyId } = {}) => ({ data: { data: partyId ? people.filter((p) => p.partyId === partyId) : people }, isLoading: false }),
  useExternalAccessMutation: () => ({ mutate, isPending: false, variables: null }),
}));
vi.mock("../../contexts/ToastProvider", () => ({ useToast: () => ({ showToast }) }));

import SettingsExternalAccess from "./SettingsExternalAccess";

const acme = { kind: "supplier", recordId: "s1", partyId: "p1", code: "ACME", name: "Acme Castings", active: true, enabled: true, contactName: "Pat in Quality", tiles: {}, activePeople: 1, invitedPeople: 1 };
const bolt = { kind: "supplier", recordId: "s2", partyId: null, code: "BOLT", name: "Bolt Ltd", active: true, enabled: false, contactName: null, tiles: {}, activePeople: 0, invitedPeople: 0 };
const big = { kind: "customer", recordId: "c1", partyId: null, code: "BIG", name: "Big Customer", active: true, enabled: false, contactName: null, tiles: {}, activePeople: 0, invitedPeople: 0 };
const sam = { id: "a1", partyId: "p1", partyKind: "supplier", partyName: "Acme Castings", email: "sam@acme.test", name: "Sam Smith", role: "admin", status: "active", lastSignInAt: null, inviteExpiresAt: null };
const kim = { id: "a2", partyId: "p1", partyKind: "supplier", partyName: "Acme Castings", email: "kim@acme.test", name: null, role: "member", status: "invited", lastSignInAt: null, inviteExpiresAt: "2026-11-25T09:00:00Z" };

beforeEach(() => {
  mutate.mockReset();
  showToast.mockReset();
  permissions = ["external_access.read", "external_access.manage"];
  overview = { settings: { enabled: true, rankingEnabled: false, requireMfa: true }, canManage: true, parties: [acme, bolt, big] };
  people = [sam, kim];
});

describe("Settings → External access", () => {
  it("is only for people who may see it", () => {
    permissions = [];
    render(<SettingsExternalAccess />);
    expect(screen.getByText(/Only the organisation's owners, administrators and quality managers/)).toBeInTheDocument();
    expect(screen.queryByText("Supplier and customer portal")).toBeNull();
  });

  it("shows the portal switch, two-factor and every supplier and customer with whether they are on", () => {
    render(<SettingsExternalAccess />);
    expect(screen.getByRole("switch", { name: "Supplier and customer portal" })).toBeChecked();
    expect(screen.getByRole("switch", { name: /Require two-factor authentication for external people/ })).toBeChecked();
    const list = screen.getByRole("list", { name: "Suppliers and customers" });
    expect(within(list).getByText("Acme Castings")).toBeInTheDocument();
    expect(within(list).getByText(/1 active, 1 invited/)).toBeInTheDocument();
    expect(within(list).getByRole("switch", { name: "Portal access for Bolt Ltd" })).not.toBeChecked();
    expect(within(list).getByText(/Customer · BIG/)).toBeInTheDocument();
  });

  it("switches the portal and a party on or off at once", async () => {
    render(<SettingsExternalAccess />);
    await userEvent.click(screen.getByRole("switch", { name: "Supplier and customer portal" }));
    expect(mutate).toHaveBeenCalledWith({ action: "settings", body: { enabled: false } }, expect.anything());
    await userEvent.click(screen.getByRole("switch", { name: "Portal access for Bolt Ltd" }));
    expect(mutate).toHaveBeenLastCalledWith({ action: "party", body: { kind: "supplier", partyId: "s2", enabled: true } }, expect.anything());
  });

  it("chooses the ranking and the performance tiles for a supplier, each saved at once", async () => {
    render(<SettingsExternalAccess />);
    await userEvent.click(screen.getByRole("switch", { name: /Show suppliers where they stand/ }));
    expect(mutate).toHaveBeenCalledWith({ action: "settings", body: { rankingEnabled: true } }, expect.anything());
    expect(screen.queryByRole("button", { name: "Performance tiles for Big Customer" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Performance tiles for Acme Castings" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("switch", { name: "Monthly trend" })).toBeChecked();
    await userEvent.click(within(dialog).getByRole("switch", { name: "Monthly trend" }));
    expect(mutate).toHaveBeenLastCalledWith({ action: "party", body: { kind: "supplier", partyId: "s1", tiles: { trend: false } } }, expect.anything());
  });

  it("someone who may only read cannot change anything", () => {
    permissions = ["external_access.read"];
    render(<SettingsExternalAccess />);
    expect(screen.getByRole("switch", { name: "Supplier and customer portal" })).toBeDisabled();
    expect(screen.queryByRole("switch", { name: "Portal access for Bolt Ltd" })).toBeNull();
  });

  it("the access report lists everyone with their last sign-in", () => {
    render(<SettingsExternalAccess />);
    const report = screen.getByRole("list", { name: "External people" });
    expect(within(report).getByText("Sam Smith (sam@acme.test)")).toBeInTheDocument();
    expect(within(report).getAllByText(/Last sign-in: Never/).length).toBe(2);
  });

  it("invites someone from the party's people dialog, as an admin first", async () => {
    render(<SettingsExternalAccess />);
    await userEvent.click(screen.getByRole("button", { name: "People at Acme Castings" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Sam Smith (sam@acme.test)")).toBeInTheDocument();
    await userEvent.type(within(dialog).getByLabelText(/Email address/), "new@acme.test");
    await userEvent.click(within(dialog).getByRole("button", { name: "Send invitation" }));
    expect(mutate).toHaveBeenCalledWith({ action: "invite", body: { partyId: "p1", email: "new@acme.test", role: "admin", message: undefined } }, expect.anything());
  });

  it("withdrawing an invitation asks for a reason first", async () => {
    render(<SettingsExternalAccess />);
    await userEvent.click(screen.getByRole("button", { name: "People at Acme Castings" }));
    const dialog = screen.getByRole("dialog");
    const menus = within(dialog).getAllByRole("button", { name: "Actions" });
    await userEvent.click(menus[1]); // Kim, whose invitation is still pending
    await userEvent.click(await screen.findByRole("menuitem", { name: "Withdraw invitation" }));
    const ask = screen.getByRole("dialog", { name: /Remove kim@acme.test/ });
    const go = within(ask).getByRole("button", { name: "Remove" });
    expect(go).toBeDisabled();
    await userEvent.type(within(ask).getByLabelText(/Reason/), "Wrong address");
    await userEvent.click(go);
    expect(mutate).toHaveBeenCalledWith({ action: "remove", id: "a2", body: { reason: "Wrong address" } }, expect.anything());
  });
});
