import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

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

const SP = {
  entityId: "https://ref.supabase.co/auth/v1/sso/saml/metadata",
  acsUrl: "https://ref.supabase.co/auth/v1/sso/saml/acs",
  metadataUrl: "https://ref.supabase.co/auth/v1/sso/saml/metadata",
  metadataDownloadUrl: "https://ref.supabase.co/auth/v1/sso/saml/metadata?download=true",
};
const connected = {
  id: "p1", supabaseProviderId: "aaaaaaaa-0000-4000-8000-000000000001", status: "active", entityId: "https://sts.windows.net/tenant/",
  metadataUrl: "https://login.example.com/metadata.xml", metadataKind: "url", domains: ["uk.acme.com"], lastSyncedAt: "2026-11-16T09:00:00Z",
  lastError: null, createdAt: "2026-11-16T09:00:00Z", createdBy: "Ada Owner",
};
const renderIt = (canManage = true) => render(<MemoryRouter><SingleSignOn canManage={canManage} /></MemoryRouter>);

beforeEach(() => {
  mutate.mockReset();
  showToast.mockReset();
  pending = null;
  sso = { available: true, serviceProvider: SP, provider: null, previousProviders: [], mode: "off", join: "invited", trustIdpMfa: true, canManage: true, allowedEmailDomains: [], domains: [waiting, verified, failing, removed],
    session: { viaSso: false, aal: "aal1" }, requireMfa: false, sessionHours: { stored: null, effective: null }, breakGlass: [], passwordMembers: [], signIns: [], changes: [] };
});

describe("Settings → Security → Single sign-on", () => {
  it("lists the domains with their state, the record to add while not verified, and folds removed ones away", async () => {
    renderIt();
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
    renderIt();
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
    renderIt();
    const acme = screen.getByRole("listitem", { name: "acme.com" });
    await userEvent.click(within(acme).getByRole("button", { name: "Check now" }));
    expect(mutate).toHaveBeenCalledWith({ action: "verifyDomain", id: "d1" }, expect.anything());
    mutate.mock.calls[0][1].onSuccess({ check: { outcome: "verified" } });
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: "success", title: "Verified" }));
  });

  it("removes with a reason", async () => {
    renderIt();
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
    renderIt(false);
    expect(screen.queryByRole("button", { name: "Check now" })).toBeNull();
    expect(screen.queryByLabelText("Add a domain")).toBeNull();
    expect(screen.queryByRole("button", { name: "Actions" })).toBeNull();
  });

  it("gives IT the values to enter and connects the company's sign-in from its metadata address", async () => {
    renderIt();
    const section = screen.getByRole("region", { name: "Your company's sign-in" });
    expect(within(section).getByText(SP.acsUrl)).toBeInTheDocument();
    expect(within(section).getByRole("button", { name: "Copy the reply url (acs)" })).toBeInTheDocument();
    await userEvent.click(within(section).getByRole("button", { name: "Connect your sign-in" }));
    const dialog = screen.getByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText(/Metadata address/), "http://not-secure.example.com/m.xml");
    await userEvent.click(within(dialog).getByRole("button", { name: "Connect" }));
    expect(within(dialog).getByRole("alert")).toHaveTextContent("starts with https://");
    expect(mutate).not.toHaveBeenCalled();
    await userEvent.clear(within(dialog).getByLabelText(/Metadata address/));
    await userEvent.type(within(dialog).getByLabelText(/Metadata address/), "https://login.example.com/metadata.xml");
    await userEvent.click(within(dialog).getByRole("button", { name: "Connect" }));
    expect(mutate).toHaveBeenCalledWith({ action: "saveProvider", body: { metadataUrl: "https://login.example.com/metadata.xml" } }, expect.anything());
  });

  it("reads a metadata file, refusing one that is not SAML metadata", async () => {
    renderIt();
    await userEvent.click(screen.getByRole("button", { name: "Connect your sign-in" }));
    const dialog = screen.getByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "A file" }));
    const input = within(dialog).getByLabelText(/Metadata file/);
    await userEvent.upload(input, new File(["<html>not it</html>"], "page.html", { type: "text/xml" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("not SAML metadata");
    const xml = '<EntityDescriptor entityID="https://idp"></EntityDescriptor>';
    await userEvent.upload(input, new File([xml], "federation.xml", { type: "text/xml" }));
    await within(dialog).findByText("federation.xml");
    await userEvent.click(within(dialog).getByRole("button", { name: "Connect" }));
    expect(mutate).toHaveBeenCalledWith({ action: "saveProvider", body: { metadataXml: xml } }, expect.anything());
  });

  it("shows the connected sign-in with Test sign-in, and disconnects with a reason", async () => {
    sso = { ...sso, provider: connected, previousProviders: [{ ...connected, id: "p0", status: "disabled", disabledAt: "2026-11-01T09:00:00Z", disabledBy: "Ada Owner", disabledReason: "Old tenant" }] };
    renderIt();
    const box = screen.getByRole("region", { name: "Connected sign-in" });
    expect(within(box).getByText("Connected")).toBeInTheDocument();
    expect(within(box).getByText(/For uk.acme.com/)).toBeInTheDocument();
    expect(within(box).getByRole("link", { name: /Test sign-in/ })).toHaveAttribute("href", `/sso?provider=${connected.supabaseProviderId}`);
    expect(screen.getByText(/Earlier connections \(1\)/)).toBeInTheDocument();
    await userEvent.click(within(box).getByRole("button", { name: "Disconnect" }));
    const dialog = screen.getByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText(/Why\?/), "Moving tenant");
    await userEvent.click(within(dialog).getByRole("button", { name: "Disconnect" }));
    expect(mutate).toHaveBeenCalledWith({ action: "disableProvider", body: { reason: "Moving tenant" } }, expect.anything());
  });

  it("says when the server cannot connect a sign-in yet, and when no domain is verified", () => {
    sso = { ...sso, available: false };
    const { unmount } = renderIt();
    expect(screen.getByText("Not available yet")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Connect your sign-in" })).toBeNull();
    unmount();
    sso = { ...sso, available: true, domains: [waiting] };
    renderIt();
    expect(screen.getByText("Verify a domain above first.")).toBeInTheDocument();
  });

  it("a sync problem is shown on the connected sign-in", () => {
    sso = { ...sso, provider: { ...connected, lastError: "Supabase answered 500" } };
    renderIt();
    expect(screen.getByText(/The domains could not be sent/)).toBeInTheDocument();
  });
});
