import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

let permissions;
let policy;
let denials;
const mutate = vi.fn();
const showToast = vi.fn();

vi.mock("../../hooks/useQmsApi", () => ({
  useOrganisationDetails: () => ({ data: { settings: { requireMfa: false } } }),
  usePermissions: () => ({ can: (p) => permissions.includes(p), isLoading: false }),
}));
vi.mock("../../hooks/useSecurity", () => ({
  useAccessPolicy: () => ({ data: policy, isLoading: false, error: null }),
  useAccessDenials: ({ mode } = {}) => ({ data: { data: mode ? denials.filter((d) => d.mode === mode) : denials }, isLoading: false, error: null }),
  useSecurityMutation: () => ({ mutate, isPending: false, variables: null }),
}));
vi.mock("./RequireMfaSetting", () => ({ default: ({ canManage }) => <div>two-factor switch {String(canManage)}</div> }));
vi.mock("../../contexts/ToastProvider", () => ({ useToast: () => ({ showToast }) }));

import SettingsSecurity from "./SettingsSecurity";
import { enforceProblems } from "../../lib/security";

const hq = { id: "n1", name: "Head office", network: "203.0.113.0/24", count: "256 addresses", single: false, active: true, removed: false, includesYou: true, updatedAt: "2026-11-14T09:00:00Z", updatedBy: "Ada Owner" };
const old = { id: "n2", name: "Old VPN", network: "198.51.100.0/28", count: "16 addresses", active: false, removed: true, removedAt: "2026-11-13T09:00:00Z", removedBy: "Ada Owner", removedReason: "Provider changed", includesYou: false };

const renderIt = () => render(<MemoryRouter><SettingsSecurity /></MemoryRouter>);

beforeEach(() => {
  mutate.mockReset();
  showToast.mockReset();
  permissions = ["security.read", "security.manage", "organisation.manage"];
  policy = { mode: "monitor", changedAt: null, changedBy: null, canManage: true, address: "203.0.113.10", covered: true, activeCount: 1, networks: [hq, old] };
  denials = [{ id: "d1", person: { id: "u2", name: "Ben Inspector" }, address: "198.51.100.200", mode: "monitor", attempts: 3, lastPath: "/api/v1/ncrs", firstAt: "2026-11-14T08:00:00Z", lastAt: "2026-11-14T08:30:00Z", nowAllowed: false }];
});

describe("Settings → Security", () => {
  it("is only for owners and administrators", () => {
    permissions = [];
    renderIt();
    expect(screen.getByText(/Only the organisation's owners and administrators/)).toBeInTheDocument();
    expect(screen.queryByText("Access restrictions")).toBeNull();
  });

  it("holds the two-factor switch, the mode, the address as Fortress sees it and the approved networks", () => {
    renderIt();
    expect(screen.getByText("two-factor switch true")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Monitor" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText("203.0.113.10")).toBeInTheDocument();
    expect(screen.getByText("In an approved network")).toBeInTheDocument();
    const list = screen.getByRole("list", { name: "Approved networks" });
    expect(within(list).getByText("Head office")).toBeInTheDocument();
    expect(within(list).getByText("Includes you")).toBeInTheDocument();
    expect(within(list).queryByText("Old VPN")).toBeNull();
  });

  it("switches a network off at once and changes the mode without a dialog, except for enforce", async () => {
    renderIt();
    await userEvent.click(screen.getByRole("switch", { name: "Head office active" }));
    expect(mutate).toHaveBeenCalledWith({ action: "updateNetwork", id: "n1", body: { active: false } }, expect.anything());
    await userEvent.click(screen.getByRole("radio", { name: "Off" }));
    expect(mutate).toHaveBeenLastCalledWith({ action: "setMode", body: { mode: "off" } }, expect.anything());
  });

  it("enforcing needs the typed confirmation and says who would be blocked", async () => {
    renderIt();
    await userEvent.click(screen.getByRole("radio", { name: "Enforce" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/1 person or address was outside the approved networks/)).toBeInTheDocument();
    const go = within(dialog).getByRole("button", { name: "Enforce" });
    expect(go).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText(/Type "enforce" to confirm/), "Enforce");
    expect(go).toBeEnabled();
    await userEvent.click(go);
    expect(mutate).toHaveBeenCalledWith({ action: "setMode", body: { mode: "enforce", confirm: true } }, expect.anything());
  });

  it("will not offer enforcing while the person's own address is outside every approved network", async () => {
    policy = { ...policy, covered: false, address: "198.51.100.9" };
    renderIt();
    await userEvent.click(screen.getByRole("radio", { name: "Enforce" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/Your own address \(198\.51\.100\.9\) is not in an approved network/)).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/Type "enforce" to confirm/)).toBeDisabled();
  });

  it("adds this address as a network, and shows the server's reason when it is refused", async () => {
    policy = { ...policy, covered: false, address: "198.51.100.9" };
    mutate.mockImplementation((_vars, { onError }) => onError(Object.assign(new Error("has bits set after the /24: did you mean 198.51.100.0/24?"), { code: "security_rule" })));
    renderIt();
    await userEvent.click(screen.getAllByRole("button", { name: "Add this address" })[0]);
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByLabelText(/Address or range/)).toHaveValue("198.51.100.9");
    await userEvent.type(within(dialog).getByLabelText(/^Name/), "Factory 2");
    await userEvent.click(within(dialog).getByRole("button", { name: "Add network" }));
    expect(mutate).toHaveBeenCalledWith({ action: "addNetwork", body: { name: "Factory 2", network: "198.51.100.9" } }, expect.anything());
    expect(within(dialog).getByRole("alert")).toHaveTextContent(/did you mean/);
  });

  it("removes a network with a reason, and brings a removed one back", async () => {
    renderIt();
    await userEvent.click(within(screen.getByRole("list", { name: "Approved networks" })).getByRole("button", { name: "Actions" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Remove" }));
    const dialog = screen.getByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    expect(mutate).not.toHaveBeenCalled();
    await userEvent.type(within(dialog).getByLabelText(/Why/), "Office closed");
    await userEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    expect(mutate).toHaveBeenCalledWith({ action: "removeNetwork", id: "n1", body: { reason: "Office closed" } }, expect.anything());
    await userEvent.click(screen.getByRole("button", { name: /Show removed networks/ }));
    expect(screen.getByText(/Provider changed/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Bring back" }));
    expect(mutate).toHaveBeenLastCalledWith({ action: "restoreNetwork", id: "n2" }, expect.anything());
  });

  it("lists blocked attempts with a way to approve that address", async () => {
    renderIt();
    const list = screen.getByRole("list", { name: "Recent blocked attempts" });
    expect(within(list).getByText(/Ben Inspector from 198\.51\.100\.200, 3 times/)).toBeInTheDocument();
    expect(within(list).getByText("Would be blocked")).toBeInTheDocument();
    await userEvent.click(within(list).getByRole("button", { name: "Add this address" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByLabelText(/Address or range/)).toHaveValue("198.51.100.200");
  });

  it("shows the changes, with an operator's recovery and why", () => {
    policy = {
      ...policy,
      history: [
        { id: "h2", kind: "recovery", from: "enforce", to: "monitor", by: "Fortress support", reason: "Provider changed overnight", verification: "Called the owner back", summary: "", at: "2026-11-14T10:00:00Z" },
        { id: "h1", kind: "change", from: "off", to: "enforce", by: "Ada Owner", reason: null, verification: null, summary: "", at: "2026-11-14T09:00:00Z" },
      ],
    };
    renderIt();
    const list = screen.getByRole("list", { name: "Changes to network restrictions" });
    expect(within(list).getByText(/Enforce → Monitor by Fortress support/)).toBeInTheDocument();
    expect(within(list).getByText(/Provider changed overnight \(checked by: Called the owner back\)/)).toBeInTheDocument();
    expect(within(list).getByText(/Off → Enforce by Ada Owner/)).toBeInTheDocument();
  });

  it("is read-only for someone who may only read it", () => {
    permissions = ["security.read"];
    renderIt();
    expect(screen.queryByRole("button", { name: "Add network" })).toBeNull();
    expect(screen.getByRole("switch", { name: "Head office active" })).toBeDisabled();
    expect(screen.getByRole("radio", { name: "Off" })).toBeDisabled();
    expect(screen.getByText("two-factor switch false")).toBeInTheDocument();
  });
});

describe("Settings → Security: who can be invited and signing in again", () => {
  it("adds and removes allowed email domains, saved at once, and lists members already outside", async () => {
    policy = { ...policy, allowedEmailDomains: ["acme.test"], outsideDomains: [{ membershipId: "m1", name: "Tim Temp", email: "tim@gmail.test", status: "active" }], maxSessionHours: null };
    renderIt();
    expect(screen.getByRole("list", { name: "Allowed email domains" })).toHaveTextContent("@acme.test");
    expect(screen.getByRole("list", { name: "Members outside the allowed domains" })).toHaveTextContent("Tim Temp — tim@gmail.test");
    await userEvent.type(screen.getByLabelText("Add a domain"), "not a domain");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(screen.getByText("Type a domain such as acme.com.")).toBeInTheDocument();
    expect(mutate).not.toHaveBeenCalled();
    await userEvent.clear(screen.getByLabelText("Add a domain"));
    await userEvent.type(screen.getByLabelText("Add a domain"), "@Acme-Group.test");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(mutate).toHaveBeenCalledWith({ action: "setEmailDomains", body: { domains: ["acme.test", "acme-group.test"] } }, expect.anything());
    await userEvent.click(screen.getByRole("button", { name: "Remove acme.test" }));
    expect(mutate).toHaveBeenLastCalledWith({ action: "setEmailDomains", body: { domains: [] } }, expect.anything());
  });

  it("says anyone can be invited when there are no domains, and offers no editing to someone who may only read", () => {
    permissions = ["security.read"];
    policy = { ...policy, allowedEmailDomains: [], outsideDomains: [], maxSessionHours: 12 };
    renderIt();
    expect(screen.getByText("Anyone can be invited.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Add a domain")).toBeNull();
    expect(screen.getByRole("combobox", { name: /Sign in again after/ })).toBeDisabled();
  });

  it("chooses how long before people sign in again", async () => {
    policy = { ...policy, allowedEmailDomains: [], outsideDomains: [], maxSessionHours: null };
    renderIt();
    const combo = screen.getByRole("combobox", { name: /Sign in again after/ });
    await userEvent.click(combo);
    await userEvent.click(await screen.findByRole("option", { name: /8 hours/ }));
    expect(mutate).toHaveBeenCalledWith({ action: "setSessionAge", body: { hours: 8 } }, expect.anything());
  });
});

describe("what stops enforcing", () => {
  it("needs a network that is on and the person's own address inside one", () => {
    expect(enforceProblems({ activeCount: 0, address: "203.0.113.10", covered: false })).toEqual([
      "Add and switch on at least one approved network.",
      "Your own address (203.0.113.10) is not in an approved network. Add it first, or you would be blocked.",
    ]);
    expect(enforceProblems({ activeCount: 1, address: null, covered: false })[0]).toMatch(/cannot see your address/);
    expect(enforceProblems({ activeCount: 1, address: "203.0.113.10", covered: true })).toEqual([]);
  });
});
