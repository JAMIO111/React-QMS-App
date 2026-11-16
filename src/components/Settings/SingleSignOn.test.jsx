import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

let sso;
let pending;
const mutate = vi.fn();
const showToast = vi.fn();

vi.mock("../../hooks/useSecurity", () => ({
  useSso: () => ({ data: sso, isLoading: false, isError: false }),
  useSsoMutation: () => ({ mutate, isPending: !!pending, variables: pending }),
}));
vi.mock("../../contexts/ToastProvider", () => ({ useToast: () => ({ showToast }) }));

import SingleSignOn from "./SingleSignOn";

const record = (domain) => ({ type: "TXT", name: domain, value: "fortress-verification=0123456789abcdef0123456789abcdef" });
const waiting = { id: "d1", domain: "acme.com", state: "unverified", record: record("acme.com"), checkError: "No Fortress verification record was found at acme.com yet." };
const verified = { id: "d2", domain: "uk.acme.com", state: "verified", record: record("uk.acme.com"), verifiedAt: "2026-11-15T09:00:00Z", verifiedBy: "Ada Owner" };
const failing = { id: "d3", domain: "old.acme.com", state: "failing", record: record("old.acme.com"), verifiedAt: "2026-11-01T09:00:00Z", checkError: "The verification record was not found" };
const removed = { id: "d4", domain: "acme.net", state: "removed", record: null, removedAt: "2026-11-14T09:00:00Z", removedBy: "Ada Owner", removedReason: "Wrong domain" };

beforeEach(() => {
  mutate.mockReset();
  showToast.mockReset();
  pending = null;
  sso = { mode: "off", join: "invited", trustIdpMfa: true, canManage: true, allowedEmailDomains: [], domains: [waiting, verified, failing, removed] };
});

describe("Settings → Security → Single sign-on", () => {
  it("lists the domains with their state, the record to add while not verified, and folds removed ones away", async () => {
    render(<SingleSignOn canManage />);
    const list = screen.getByRole("list", { name: "Single sign-on domains" });
    const acme = within(list).getByRole("listitem", { name: "acme.com" });
    expect(within(acme).getByText("Waiting for the record")).toBeInTheDocument();
    expect(within(acme).getByText("fortress-verification=0123456789abcdef0123456789abcdef")).toBeInTheDocument();
    expect(within(acme).getByRole("button", { name: "Copy the record value for acme.com" })).toBeInTheDocument();
    expect(within(acme).getByText(/not found at acme.com yet|was found at acme.com yet/)).toBeInTheDocument();

    const uk = within(list).getByRole("listitem", { name: "uk.acme.com" });
    expect(within(uk).getByText("Verified")).toBeInTheDocument();
    expect(within(uk).getByText(/by Ada Owner/)).toBeInTheDocument();
    expect(within(uk).queryByText(/fortress-verification=/)).toBeNull();

    const old = within(list).getByRole("listitem", { name: "old.acme.com" });
    expect(within(old).getByText("Record missing")).toBeInTheDocument();
    expect(within(old).getByText(/stays verified for now/)).toBeInTheDocument();

    expect(within(list).queryByText("acme.net")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /Show removed domains \(1\)/ }));
    expect(screen.getByRole("list", { name: "Removed domains" })).toHaveTextContent("acme.net: removed");
  });

  it("adds a domain as typed, refusing what is not one", async () => {
    render(<SingleSignOn canManage />);
    await userEvent.type(screen.getByLabelText("Add a domain"), "not a domain");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Type a domain such as acme.com.");
    expect(mutate).not.toHaveBeenCalled();
    await userEvent.clear(screen.getByLabelText("Add a domain"));
    await userEvent.type(screen.getByLabelText("Add a domain"), "@Acme.org");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(mutate).toHaveBeenCalledWith({ action: "addDomain", body: { domain: "acme.org" } }, expect.anything());
  });

  it("checks now and says what was found", async () => {
    render(<SingleSignOn canManage />);
    const acme = screen.getByRole("listitem", { name: "acme.com" });
    await userEvent.click(within(acme).getByRole("button", { name: "Check now" }));
    expect(mutate).toHaveBeenCalledWith({ action: "verifyDomain", id: "d1" }, expect.anything());
    mutate.mock.calls[0][1].onSuccess({ check: { outcome: "verified" } });
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: "success", title: "Verified" }));
  });

  it("removes with a reason", async () => {
    render(<SingleSignOn canManage />);
    await userEvent.click(within(screen.getByRole("listitem", { name: "uk.acme.com" })).getByRole("button", { name: "Actions" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Remove…" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/another organisation could then prove it/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Say why");
    await userEvent.type(within(dialog).getByLabelText(/Why\?/), "Moved to a new provider");
    await userEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    expect(mutate).toHaveBeenCalledWith({ action: "removeDomain", id: "d2", body: { reason: "Moved to a new provider" } }, expect.anything());
  });

  it("shows no controls to someone who may only read", () => {
    render(<SingleSignOn canManage={false} />);
    expect(screen.queryByRole("button", { name: "Check now" })).toBeNull();
    expect(screen.queryByLabelText("Add a domain")).toBeNull();
    expect(screen.queryByRole("button", { name: "Actions" })).toBeNull();
  });
});
