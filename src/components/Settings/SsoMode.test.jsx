import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

let pending;
const mutate = vi.fn();
const showToast = vi.fn();
vi.mock("../../hooks/useSecurity", () => ({ useSsoMutation: () => ({ mutate, isPending: !!pending, variables: pending }) }));
vi.mock("../../hooks/useQmsApi", () => ({ useAllDepartments: () => ({ data: { data: [{ id: "dep-qa", name: "Quality", active: true }] } }) }));
vi.mock("../../contexts/ToastProvider", () => ({ useToast: () => ({ showToast }) }));

import SsoMode from "./SsoMode";

const provider = { supabaseProviderId: "aaaaaaaa-0000-4000-8000-000000000001", domains: ["acme.com"] };
const ada = { userId: "u-ada", name: "Ada Owner", email: "ada@acme.com", breakGlass: false, ownerOrAdmin: true };
const ivy = { userId: "u-ivy", name: "Ivy Inspector", email: "ivy@acme.com", breakGlass: false, ownerOrAdmin: false };
const base = (over = {}) => ({
  provider,
  mode: "optional",
  modeChangedAt: "2026-11-16T09:00:00Z",
  modeChangedBy: "Ada Owner",
  trustIdpMfa: true,
  session: { viaSso: true, aal: "aal1" },
  sessionHours: { stored: null, effective: null },
  breakGlass: [],
  passwordMembers: [ada, ivy],
  signIns: [{ userId: "u-sam", name: "Sam Smith", method: "sso", requests: 4, firstAt: "2026-11-16T08:00:00Z", lastAt: "2026-11-16T09:00:00Z" }],
  join: "invited",
  joining: { roleId: null, departmentId: null, roleOptions: [{ id: "r-viewer", key: "viewer", name: "Viewer" }, { id: "r-insp", key: "inspector", name: "Inspector" }] },
  moves: [{ id: "mv1", email: "ivy@acme.com", name: "Ivy Inspector", bySelf: true, moved: { "saved_filters.user_id": 2, "risks.owner_user_id": 1 }, skipped: {}, at: "2026-11-16T10:00:00Z" }],
  changes: [{ id: "c1", kind: "mode", summary: "Single sign-on is now optional (passwords still work) — changed by Ada Owner", at: "2026-11-16T09:00:00Z" }],
  ...over,
});
const renderIt = (sso, canManage = true) => render(<MemoryRouter><SsoMode sso={sso} canManage={canManage} /></MemoryRouter>);

beforeEach(() => {
  mutate.mockReset();
  showToast.mockReset();
  pending = null;
});

describe("Settings → Security → Single sign-on: using it", () => {
  it("offers off and optional at once, and needs a connected sign-in for either of the others", async () => {
    renderIt(base({ mode: "off", provider: null }));
    expect(screen.getByRole("radio", { name: "Optional" })).toBeDisabled();
    expect(screen.getByRole("radio", { name: "Required" })).toBeDisabled();
    expect(screen.getByText(/Connect your company's sign-in above/)).toBeInTheDocument();
  });

  it("switching to off or optional saves straight away", async () => {
    renderIt(base());
    await userEvent.click(screen.getByRole("radio", { name: "Off" }));
    expect(mutate).toHaveBeenCalledWith({ action: "setMode", body: { mode: "off" } }, expect.anything());
  });

  it("requiring it asks for confirmation, says who will be blocked and that nobody is break-glass", async () => {
    renderIt(base());
    await userEvent.click(screen.getByRole("radio", { name: "Required" }));
    const dialog = screen.getByRole("dialog", { name: "Require single sign-on?" });
    expect(within(dialog).getByText(/2 members sign in with a password/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Ada Owner, Ivy Inspector/)).toBeInTheDocument();
    expect(within(dialog).getByText("No break-glass members")).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Require single sign-on" }));
    expect(within(dialog).getByRole("alert")).toHaveTextContent('Type "require" to confirm.');
    expect(mutate).not.toHaveBeenCalled();
    await userEvent.type(within(dialog).getByLabelText(/Type "require" to confirm/), "require");
    await userEvent.click(within(dialog).getByRole("button", { name: "Require single sign-on" }));
    expect(mutate).toHaveBeenCalledWith({ action: "setMode", body: { mode: "required", confirm: true } }, expect.anything());
  });

  it("cannot be required from a password session: it says to sign in with the company account first", async () => {
    renderIt(base({ session: { viaSso: false, aal: "aal2" } }));
    await userEvent.click(screen.getByRole("radio", { name: "Required" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Sign in with your company account first")).toBeInTheDocument();
    expect(within(dialog).getByRole("link", { name: "Sign in with your company account" })).toHaveAttribute("href", `/sso?provider=${provider.supabaseProviderId}`);
    expect(within(dialog).getByRole("button", { name: "Require single sign-on" })).toBeDisabled();
  });

  it("while required, says sessions end after 12 hours unless another limit is set", () => {
    renderIt(base({ mode: "required" }));
    expect(screen.getByText(/sign in again every 12 hours/)).toBeInTheDocument();
  });

  it("switches two-factor trust at once", async () => {
    renderIt(base());
    await userEvent.click(screen.getByRole("switch", { name: "A company sign-in meets the two-factor rule" }));
    expect(mutate).toHaveBeenCalledWith({ action: "setTrust", body: { trust: false } }, expect.anything());
  });

  it("break-glass members: only owners and admins who sign in with a password are offered; they can be taken off", async () => {
    const { rerender } = renderIt(base());
    await userEvent.click(screen.getByLabelText("Add a break-glass member"));
    expect(screen.getByRole("option", { name: /Ada Owner/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Ivy Inspector/ })).toBeNull();
    await userEvent.click(screen.getByRole("option", { name: /Ada Owner/ }));
    expect(mutate).toHaveBeenCalledWith({ action: "setBreakGlass", body: { userIds: ["u-ada"] } }, expect.anything());

    mutate.mockReset();
    rerender(<MemoryRouter><SsoMode sso={base({ breakGlass: [{ userId: "u-ada", name: "Ada Owner", email: "ada@acme.com" }], passwordMembers: [{ ...ada, breakGlass: true }, ivy] })} canManage /></MemoryRouter>);
    await userEvent.click(screen.getByRole("button", { name: "Take Ada Owner off the list" }));
    expect(mutate).toHaveBeenCalledWith({ action: "setBreakGlass", body: { userIds: [] } }, expect.anything());
  });

  it("shows recent sign-ins and the history, and is read-only without the permission", async () => {
    renderIt(base(), false);
    expect(screen.getByRole("radio", { name: "Off" })).toBeDisabled();
    expect(screen.getByRole("switch")).toBeDisabled();
    expect(screen.queryByLabelText("Add a break-glass member")).toBeNull();
    await userEvent.click(screen.getByText(/sign-ins in the last 30 days \(1\)/));
    expect(screen.getByRole("list", { name: "Recent sign-ins" })).toHaveTextContent("Sam Smith — company sign-in");
    await userEvent.click(screen.getByText(/History of changes \(1\)/));
    expect(screen.getByRole("list", { name: "Single sign-on changes" })).toHaveTextContent("now optional");
  });

  it("lets anyone at the domains join as a viewer, then chooses their role and department", async () => {
    const { rerender } = renderIt(base());
    await userEvent.click(screen.getByRole("radio", { name: "Anyone at your domains" }));
    expect(mutate).toHaveBeenCalledWith({ action: "setJoining", body: { join: "domain", roleId: "r-viewer", departmentId: null } }, expect.anything());
    mutate.mockReset();
    rerender(<MemoryRouter><SsoMode sso={base({ join: "domain", joining: { ...base().joining, roleId: "r-viewer" } })} canManage /></MemoryRouter>);
    await userEvent.click(screen.getByLabelText(/They start as/));
    await userEvent.click(screen.getByRole("option", { name: /Inspector/ }));
    expect(mutate).toHaveBeenCalledWith({ action: "setJoining", body: { join: "domain", roleId: "r-insp", departmentId: null } }, expect.anything());
  });

  it("lists accounts moved to company sign-in", async () => {
    renderIt(base());
    await userEvent.click(screen.getByText(/Accounts moved to company sign-in \(1\)/));
    expect(screen.getByRole("list", { name: "Accounts moved" })).toHaveTextContent("Ivy Inspector (confirmed with their old password) — 3 open items moved");
  });
});
