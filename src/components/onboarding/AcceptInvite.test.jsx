import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

let invitations;
let profile;
let permissions;
let mfaRequiredBy;
const acceptAsync = vi.fn();
const profileAsync = vi.fn();

vi.mock("../../contexts/AuthProvider", () => ({ useAuth: () => ({ user: { id: "u1", email: "ann@example.com" } }) }));
vi.mock("../../hooks/useQmsApi", () => ({
  useMe: () => ({ data: { profile, mfa: { level: "aal1", requiredBy: mfaRequiredBy } }, isLoading: false }),
  useMyInvitations: () => ({ data: { data: invitations }, isLoading: false }),
  useAcceptInvitation: () => ({ mutateAsync: acceptAsync, isPending: false }),
  useUpdateProfile: () => ({ mutateAsync: profileAsync, isPending: false }),
  usePermissions: () => ({ can: (p) => permissions.includes(p) }),
}));

import AcceptInvite from "./AcceptInvite";

const inv = (over = {}) => ({
  membershipId: "m1", organisationId: "o1", organisationName: "Acme Ltd", invitedByName: "Olivia Owner", invitedAt: "2026-11-01T00:00:00Z",
  message: "Glad to have you", expiresAt: new Date(Date.now() + 6 * 864e5).toISOString(), expired: false,
  roles: [{ key: "viewer", name: "Viewer" }], departments: ["Quality"], packageSlug: "contributor", packageName: "Contributor", ...over,
});
const renderIt = () => render(<MemoryRouter><AcceptInvite /></MemoryRouter>);

beforeEach(() => {
  acceptAsync.mockReset().mockResolvedValue({ organisationId: "o1" });
  profileAsync.mockReset().mockResolvedValue({});
  invitations = [inv()];
  profile = { firstName: "Ann", surname: "Smith" };
  permissions = ["ncr.read", "inspection.read"];
  mfaRequiredBy = [];
});

describe("the invitee's page", () => {
  it("says who invited you, as what, where, with which seat, and for how long", () => {
    renderIt();
    expect(screen.getByRole("heading", { name: "Acme Ltd" })).toBeInTheDocument();
    expect(screen.getByText("Olivia Owner invited you")).toBeInTheDocument();
    expect(screen.getByText("Viewer")).toBeInTheDocument();
    expect(screen.getByText("Quality")).toBeInTheDocument();
    expect(screen.getByText(/Contributor, already reserved for you/)).toBeInTheDocument();
    expect(screen.getByText("Glad to have you")).toBeInTheDocument();
    expect(screen.getByText(/Expires in [56] days/)).toBeInTheDocument();
    expect(screen.queryByLabelText("First name")).toBeNull();
  });

  it("joins, then welcomes you with your role, your seat and where to start for what you may do", async () => {
    renderIt();
    await userEvent.click(screen.getByRole("button", { name: "Join Acme Ltd" }));
    expect(acceptAsync).toHaveBeenCalledWith("m1");
    expect(await screen.findByRole("heading", { name: "Welcome to Acme Ltd" })).toBeInTheDocument();
    expect(screen.getByText(/You joined as Viewer with a Contributor seat/)).toBeInTheDocument();
    const start = screen.getByRole("region", { name: "Where to start" });
    expect(within(start).getByRole("link", { name: /Non-conformances/ })).toHaveAttribute("href", "/Non-Conformance");
    expect(within(start).getByRole("link", { name: /Inspections/ })).toHaveAttribute("href", "/Inspections");
    expect(within(start).queryByRole("link", { name: /Calibration/ })).toBeNull();
    expect(screen.getByRole("link", { name: "Settings → Account" })).toBeInTheDocument();
  });

  it("makes two-factor the first thing when the organisation requires it", async () => {
    mfaRequiredBy = [{ id: "o1", name: "Acme Ltd" }];
    renderIt();
    await userEvent.click(screen.getByRole("button", { name: "Join Acme Ltd" }));
    expect(await screen.findByText(/requires two-factor sign-in/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Set it up now" })).toHaveAttribute("href", "/mfa");
  });

  it("asks for a name first when the profile has none, and saves it before joining", async () => {
    profile = { firstName: null, surname: null };
    renderIt();
    const join = screen.getByRole("button", { name: "Join Acme Ltd" });
    expect(join).toBeDisabled();
    expect(screen.getByText("Enter your name to join.")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("First name"), "Ann");
    expect(join).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Surname"), "Smith");
    expect(join).toBeEnabled();
    await userEvent.click(join);
    expect(profileAsync).toHaveBeenCalledWith({ firstName: "Ann", surname: "Smith" });
    expect(acceptAsync).toHaveBeenCalledWith("m1");
    expect(profileAsync.mock.invocationCallOrder[0]).toBeLessThan(acceptAsync.mock.invocationCallOrder[0]);
  });

  it("explains an expired invitation and offers no way to join it", () => {
    invitations = [inv({ expired: true })];
    renderIt();
    expect(screen.getByRole("alert")).toHaveTextContent("This invitation has expired. Ask Olivia Owner to send you a new one.");
    expect(screen.queryByRole("button", { name: /Join/ })).toBeNull();
  });

  it("lists several invitations, each joinable", async () => {
    invitations = [inv(), inv({ membershipId: "m2", organisationId: "o2", organisationName: "Beta Co", packageName: null, packageSlug: null, message: null })];
    renderIt();
    expect(screen.getByText("You have been invited to join")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Join Beta Co" }));
    expect(acceptAsync).toHaveBeenCalledWith("m2");
  });

  it("shows why joining failed", async () => {
    acceptAsync.mockRejectedValue(Object.assign(new Error("This invitation has expired. Ask for a new one."), { code: "invitation_rule" }));
    renderIt();
    await userEvent.click(screen.getByRole("button", { name: "Join Acme Ltd" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/expired/);
  });

  it("says so, kindly, when there is no invitation for this address", () => {
    invitations = [];
    renderIt();
    expect(screen.getByRole("heading", { name: "No invitations for ann@example.com" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Continue" })).toHaveAttribute("href", "/");
  });
});
