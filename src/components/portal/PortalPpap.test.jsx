import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Outlet, Route, Routes } from "react-router-dom";

let request;
let list = [];
const mutate = vi.fn();
vi.mock("../../hooks/usePortal", () => ({
  usePortalPpaps: () => ({ data: { data: list }, isLoading: false }),
  usePortalPpap: () => ({ data: request, isLoading: false, error: null }),
  usePortalPpapMutation: () => ({ mutate, isPending: false, error: null }),
}));

import PortalPpapPage, { PpapList } from "./PortalPpapPage";

const access = { organisationId: "o1", organisationName: "Alpha Precision", partyKind: "customer" };
const pending = {
  id: "r1", status: "pending", requestedAt: "2026-11-20T10:00:00Z", requestNote: "Please approve the submission.", reference: "PPAP-26-0001", partNumber: "P-100", partName: "Bracket",
  theirPartNumber: "W-77", revision: "B", level: 3, reason: "New part", sentOn: "2026-11-19", submissionStatus: "submitted", interimExpiresOn: null,
  elements: [
    { name: "Design records", requirement: "Submitted", provided: true, waived: false },
    { name: "Master sample", requirement: "Kept on file", provided: false, waived: true },
  ],
  warrant: { partWeight: 1.25, weightUnit: "kg", purchaseOrder: "PO-77", engineeringChangeLevel: null, resultsMeetRequirements: true, declaration: null, signerName: "Quinn Manager", signerTitle: "Quality Manager", signerPhone: "01234 567890", signedOn: "2026-11-18" },
  contact: "Pat in Quality", answeredAt: null, answeredBy: null, decision: null, decisionNote: null, yourReference: null, decisionExpiresOn: null, canDecide: true,
};

const renderIt = () =>
  render(
    <MemoryRouter initialEntries={["/portal/ppaps/r1"]}>
      <Routes>
        <Route path="/portal" element={<Outlet />}>
          <Route path="ppaps/:requestId" element={<PortalPpapPage />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );

// The page reads `access` from the portal layout's outlet context.
vi.mock("react-router-dom", async (orig) => ({ ...(await orig()), useOutletContext: () => ({ access }) }));

beforeEach(() => {
  mutate.mockReset();
  request = pending;
  list = [];
});

describe("a customer answering a part approval submission in the portal", () => {
  it("shows the submission in the customer's terms: their part, the elements by name and the signed warrant", () => {
    renderIt();
    expect(screen.getByRole("heading", { name: /PPAP-26-0001 · P-100 Bracket/ })).toBeInTheDocument();
    expect(screen.getByText("Waiting for your answer")).toBeInTheDocument();
    expect(screen.getByText("Please approve the submission.")).toBeInTheDocument();
    expect(screen.getByText("W-77")).toBeInTheDocument();
    const elements = screen.getByRole("list", { name: "Elements" });
    expect(within(elements).getByText("Design records")).toBeInTheDocument();
    expect(within(elements).getByText("Provided")).toBeInTheDocument();
    expect(within(elements).getByText("Waived")).toBeInTheDocument();
    const warrant = screen.getByRole("region", { name: "Part Submission Warrant" });
    expect(within(warrant).getByText("1.25 kg")).toBeInTheDocument();
    expect(within(warrant).getByText("Quinn Manager, Quality Manager")).toBeInTheDocument();
  });

  it("approves with their own reference", async () => {
    renderIt();
    await userEvent.click(screen.getByRole("button", { name: "Approve it" }));
    const dialog = await screen.findByRole("dialog", { name: /Answer PPAP-26-0001/ });
    await userEvent.type(within(dialog).getByLabelText("Your own reference"), "WAYNE-PPAP-9");
    await userEvent.click(within(dialog).getByRole("button", { name: "Send my answer" }));
    expect(mutate).toHaveBeenCalledWith({ kind: "approved", note: null, reference: "WAYNE-PPAP-9", expiresOn: null }, expect.anything());
  });

  it("will not send an approval for now without its conditions and the day it runs to", async () => {
    renderIt();
    await userEvent.click(screen.getByRole("button", { name: "Approve it for now" }));
    const dialog = await screen.findByRole("dialog", { name: /Answer PPAP-26-0001/ });
    const send = within(dialog).getByRole("button", { name: "Send my answer" });
    expect(send).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText(/The conditions/), "Until our line trial is done.");
    expect(send).toBeDisabled();
    expect(within(dialog).getByText("Approved until")).toBeInTheDocument();
  });

  it("will not send a rejection without saying what cannot be accepted", async () => {
    renderIt();
    await userEvent.click(screen.getByRole("button", { name: "I cannot accept it" }));
    const dialog = await screen.findByRole("dialog", { name: /Answer PPAP-26-0001/ });
    const send = within(dialog).getByRole("button", { name: "Send my answer" });
    expect(send).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText(/What you cannot accept/), "The weight is wrong on the warrant.");
    await userEvent.click(send);
    expect(mutate).toHaveBeenCalledWith({ kind: "rejected", note: "The weight is wrong on the warrant.", reference: null, expiresOn: null }, expect.anything());
  });

  it("shows the answer, and no buttons, once it has been given", () => {
    request = { ...pending, status: "answered", canDecide: false, decision: "approved", answeredAt: "2026-11-21T09:00:00Z", answeredBy: "Pat", yourReference: "WAYNE-PPAP-9", decisionNote: "Fine after our trial.", submissionStatus: "approved" };
    renderIt();
    expect(screen.queryByRole("button", { name: "Approve it" })).toBeNull();
    expect(screen.getByText("WAYNE-PPAP-9")).toBeInTheDocument();
    expect(screen.getByText("Fine after our trial.")).toBeInTheDocument();
  });

  it("says when the submission no longer needs an answer", () => {
    request = { ...pending, canDecide: false, submissionStatus: "withdrawn" };
    renderIt();
    expect(screen.getAllByText(/no longer needs your answer/).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Approve it" })).toBeNull();
  });

  it("says until when an interim approval stands", () => {
    request = { ...pending, status: "answered", canDecide: false, decision: "interim_approved", submissionStatus: "interim_approved", interimExpiresOn: "2026-12-31", decisionExpiresOn: "2026-12-31" };
    renderIt();
    expect(screen.getByText(/Approved for now until/)).toBeInTheDocument();
  });
});

describe("the part approvals list", () => {
  it("lists only what waits when asked, and nothing at all for a supplier", () => {
    list = [
      { id: "r1", reference: "PPAP-26-0001", partNumber: "P-100", partName: "Bracket", theirPartNumber: "W-77", level: 3, status: "pending", submissionStatus: "submitted", requestedAt: "2026-11-20T10:00:00Z", answeredAt: null, canDecide: true },
      { id: "r2", reference: "PPAP-26-0002", partNumber: "P-200", partName: "Housing", theirPartNumber: null, level: 1, status: "answered", submissionStatus: "approved", requestedAt: "2026-11-01T10:00:00Z", answeredAt: "2026-11-02T10:00:00Z", canDecide: false },
    ];
    const { rerender } = render(<MemoryRouter><PpapList access={access} onlyWaiting heading="Waiting" /></MemoryRouter>);
    const items = screen.getByRole("list", { name: "Waiting" });
    expect(within(items).getAllByRole("link")).toHaveLength(1);
    expect(within(items).getByRole("link")).toHaveAttribute("href", "/portal/ppaps/r1?org=o1");
    rerender(<MemoryRouter><PpapList access={access} heading="All" /></MemoryRouter>);
    expect(within(screen.getByRole("list", { name: "All" })).getAllByRole("link")).toHaveLength(2);
    expect(within(screen.getByRole("list", { name: "All" })).getByText("Approved")).toBeInTheDocument();
    rerender(<MemoryRouter><PpapList access={{ ...access, partyKind: "supplier" }} heading="Supplier" /></MemoryRouter>);
    expect(screen.queryByRole("list", { name: "Supplier" })).toBeNull();
  });
});
