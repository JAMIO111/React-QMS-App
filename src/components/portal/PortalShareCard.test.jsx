import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

let shares;
let comments;
const mutate = vi.fn();
const mutateAsync = vi.fn();
const showToast = vi.fn();

vi.mock("../../hooks/usePortal", () => ({
  useShares: () => ({ data: shares, isLoading: false, error: null }),
  useShareAcknowledgements: () => ({ data: { data: [{ person: "Sam Smith", subject: "SOP-004 rev B", note: "Read it", acknowledgedAt: "2026-11-18T10:00:00Z", current: true }] }, isLoading: false }),
  useShareComments: () => ({ data: { data: comments }, isLoading: false }),
  useShareMutation: () => ({ mutate, mutateAsync, isPending: false, variables: null }),
}));
vi.mock("../../contexts/ToastProvider", () => ({ useToast: () => ({ showToast }) }));

import PortalShareCard from "./PortalShareCard";

const live = { id: "s1", partyId: "p1", partyKind: "supplier", partyName: "Acme Castings", sharedAt: "2026-11-17T09:00:00Z", sharedBy: "Ada Owner", withdrawnAt: null, withdrawnReason: null, viewers: 1, firstViewedAt: "2026-11-17T10:00:00Z", lastViewedAt: new Date().toISOString(), comments: 2, externalComments: 1 };

beforeEach(() => {
  mutate.mockReset();
  mutateAsync.mockReset().mockResolvedValue({});
  showToast.mockReset();
  shares = { data: [live], eligible: [{ partyId: "p2", partyKind: "supplier", partyName: "Bolt Ltd" }] };
  comments = [{ id: "c1", side: "external", author: "Sam Smith (Acme Castings)", body: "Held in our cage", createdAt: "2026-11-17T11:00:00Z", withdrawn: false, mine: false, canWithdraw: false }];
});

describe("the share card on a record", () => {
  it("shows nothing when there is nobody to share with and nothing shared", () => {
    shares = { data: [], eligible: [] };
    const { container } = render(<PortalShareCard kind="ncr" recordId="n1" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("lists who it is shared with, whether they have looked and how much has been said", () => {
    render(<PortalShareCard kind="ncr" recordId="n1" />);
    const list = screen.getByRole("list", { name: "Shared with" });
    expect(within(list).getByText("Acme Castings")).toBeInTheDocument();
    expect(list).toHaveTextContent("Seen by 1 person");
    expect(list).toHaveTextContent("2 comments (1 from them)");
  });

  it("an unopened share says so", () => {
    shares = { data: [{ ...live, viewers: 0, firstViewedAt: null, lastViewedAt: null }], eligible: [] };
    render(<PortalShareCard kind="ncr" recordId="n1" />);
    expect(screen.getByRole("list", { name: "Shared with" })).toHaveTextContent("Not opened yet");
  });

  it("shares with a party the record names", async () => {
    render(<PortalShareCard kind="capa" recordId="c9" />);
    expect(screen.getByRole("button", { name: "Share" })).toBeDisabled();
    await userEvent.click(screen.getByRole("combobox", { name: /Share with/ }));
    await userEvent.click(await screen.findByRole("option", { name: /Bolt Ltd/ }));
    await userEvent.click(screen.getByRole("button", { name: "Share" }));
    expect(mutate).toHaveBeenCalledWith({ action: "share", body: { partyId: "p2" } }, expect.anything());
  });

  it("stopping asks for a reason", async () => {
    render(<PortalShareCard kind="ncr" recordId="n1" />);
    await userEvent.click(screen.getByRole("button", { name: "Stop sharing with Acme Castings" }));
    const dialog = screen.getByRole("dialog");
    const go = within(dialog).getByRole("button", { name: "Stop sharing" });
    expect(go).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText(/Reason/), "Shared by mistake");
    await userEvent.click(go);
    expect(mutate).toHaveBeenCalledWith({ action: "withdraw", id: "s1", body: { reason: "Shared by mistake" } }, expect.anything());
  });

  it("opens the conversation and writes to them", async () => {
    render(<PortalShareCard kind="ncr" recordId="n1" />);
    await userEvent.click(screen.getByRole("button", { name: "Conversation with Acme Castings" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Held in our cage")).toBeInTheDocument();
    await userEvent.type(within(dialog).getByRole("textbox", { name: /Write a comment/ }), "Thanks, please send the certificate");
    await userEvent.click(within(dialog).getByRole("button", { name: "Send" }));
    expect(mutateAsync).toHaveBeenCalledWith({ action: "comment", id: "s1", shareId: "s1", body: { body: "Thanks, please send the certificate" } });
  });

  it("on a document it says how many have acknowledged and who", async () => {
    shares = { data: [{ ...live, acknowledgement: { acknowledged: 1, people: 3, subject: "SOP-004 rev B" } }], eligible: [] };
    render(<PortalShareCard kind="document" recordId="d1" />);
    expect(screen.getByRole("list", { name: "Shared with" })).toHaveTextContent("Acknowledged by 1 of 3 (SOP-004 rev B)");
    await userEvent.click(screen.getByRole("button", { name: "Who at Acme Castings acknowledged" }));
    expect(screen.getByRole("list", { name: "Acknowledgements" })).toHaveTextContent("Sam Smith");
    expect(screen.getByRole("list", { name: "Acknowledgements" })).toHaveTextContent("Read it");
  });
});
