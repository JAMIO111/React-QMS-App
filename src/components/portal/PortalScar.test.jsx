import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Outlet, Route, Routes } from "react-router-dom";

let scarState;
const mutate = vi.fn();
let mutationState;

vi.mock("../../hooks/usePortal", () => ({
  usePortalScar: () => scarState,
  usePortalScarMutation: () => ({ mutate, isPending: false, variables: null, error: null, reset: vi.fn(), ...mutationState }),
}));

import PortalScarPage from "./PortalScarPage";

const access = { organisationId: "o1", organisationName: "Alpha Precision", partyName: "Acme Castings", mfaRequired: false };
const base = {
  reference: "SCAR-26-0001", title: "Cracked castings", severity: "major", status: "issued", issuedAt: "2026-11-10T09:00:00Z", responseDueOn: "2099-12-03", originalResponseDueOn: "2099-12-03",
  overdue: false, problemDescription: "Cracks in the bar stock", requirementBreached: "No visible cracks", objectiveEvidence: "3 of 10 cracked", containmentRequirements: "Sort the stock", cancelReason: null,
  items: [{ partNumber: "BAR-1", partName: "Bar", material: null, lotNumber: "LOT-77", receiptReference: null, quantity: 10, notes: "Whole delivery" }],
  responses: [], extensions: [], canAcknowledge: true, canRespond: true, canRequestExtension: true, contact: "Pat in Quality",
};

const renderIt = () =>
  render(
    <MemoryRouter initialEntries={["/portal/scars/c1"]}>
      <Routes>
        <Route path="/portal" element={<Outlet context={{ access }} />}>
          <Route path="scars/:scarId" element={<PortalScarPage />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );

beforeEach(() => {
  mutate.mockReset();
  mutationState = {};
  scarState = { data: { id: "c1", scar: base }, isLoading: false, error: null };
});

describe("a corrective action request in the portal", () => {
  it("shows what is asked, what is affected, who to contact and what to do next", () => {
    renderIt();
    expect(screen.getByRole("heading", { name: /SCAR-26-0001/ })).toBeInTheDocument();
    expect(screen.getByText(/from Alpha Precision/)).toHaveTextContent("contact: Pat in Quality");
    expect(screen.getByText("Needs your response")).toBeInTheDocument();
    expect(screen.getByText("Cracks in the bar stock")).toBeInTheDocument();
    expect(screen.getByText("No visible cracks")).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Affected items" })).toHaveTextContent("BAR-1 · Bar · Lot LOT-77");
    expect(screen.getByRole("button", { name: "Acknowledge we have it" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Respond" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ask for more time" })).toBeInTheDocument();
  });

  it("acknowledges with one click", async () => {
    renderIt();
    await userEvent.click(screen.getByRole("button", { name: "Acknowledge we have it" }));
    expect(mutate).toHaveBeenCalledWith({ action: "acknowledge" });
  });

  it("offers only what the server allows", () => {
    scarState = { data: { id: "c1", scar: { ...base, status: "response_received", canAcknowledge: false, canRespond: false, canRequestExtension: false, responses: [{ seq: 1, respondedOn: "2026-11-12", respondedBy: "Sam (Acme Castings)", rootCause: "Mould too cold", correctiveAction: "Raise the temperature", review: null }] } }, isLoading: false, error: null };
    renderIt();
    expect(screen.getByText("With us for review")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Respond|Acknowledge|more time/ })).toBeNull();
    expect(screen.getByRole("list", { name: "Responses" })).toHaveTextContent("Mould too cold");
  });

  it("needs a root cause and a corrective action before it will send, then sends only what was written", async () => {
    renderIt();
    await userEvent.click(screen.getByRole("button", { name: "Respond" }));
    const dialog = screen.getByRole("dialog");
    const send = within(dialog).getByRole("button", { name: "Send response" });
    expect(send).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText("Root cause"), "Mould too cold");
    expect(send).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText("Corrective action"), "Raise the temperature and check each shift");
    expect(send).toBeEnabled();
    await userEvent.click(send);
    expect(mutate).toHaveBeenCalledWith({ action: "respond", body: { rootCause: "Mould too cold", correctiveAction: "Raise the temperature and check each shift" } }, expect.any(Object));
  });

  it("shows our review and invites a revised response", () => {
    scarState = {
      data: { id: "c1", scar: { ...base, status: "revision_requested", responses: [{ seq: 1, respondedOn: "2026-11-12", respondedBy: "Sam (Acme Castings)", rootCause: "Mould too cold", correctiveAction: "Fix", review: { decision: "revision_requested", note: "Show the evidence of the check" } }] } },
      isLoading: false, error: null,
    };
    renderIt();
    expect(screen.getByText("Revised response needed")).toBeInTheDocument();
    expect(screen.getByText("Show the evidence of the check")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send a revised response" })).toBeInTheDocument();
  });

  it("asks for more time with a reason, and lets the person who asked take it back", async () => {
    renderIt();
    await userEvent.click(screen.getByRole("button", { name: "Ask for more time" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "Ask for more time" })).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText("Why you need more time"), "Parts are on a slow boat");
    expect(within(dialog).getByRole("button", { name: "Ask for more time" })).toBeDisabled(); // the new date is still missing
  });

  it("lists requests for more time with the decision, and a take-back only on your own waiting request", async () => {
    scarState = {
      data: { id: "c1", scar: { ...base, canRequestExtension: false, extensions: [
        { id: "x1", newDueOn: "2099-12-20", reason: "Slow boat", status: "pending", mine: true, decisionNote: null },
        { id: "x0", newDueOn: "2099-12-10", reason: "Holiday", status: "rejected", mine: true, decisionNote: "Too long" },
      ] } },
      isLoading: false, error: null,
    };
    renderIt();
    const list = screen.getByRole("list", { name: "Requests for more time" });
    expect(list).toHaveTextContent("Waiting for a decision");
    expect(list).toHaveTextContent("Not agreed");
    expect(list).toHaveTextContent("Too long");
    expect(within(list).getAllByRole("button", { name: "Take back" })).toHaveLength(1);
    await userEvent.click(within(list).getByRole("button", { name: "Take back" }));
    const dialog = screen.getByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText("Why"), "Found a faster route");
    await userEvent.click(within(dialog).getByRole("button", { name: "Take it back" }));
    expect(mutate).toHaveBeenCalledWith({ action: "withdrawExtension", id: "x1", body: { reason: "Found a faster route" } }, expect.any(Object));
  });

  it("says plainly when the request is not theirs", () => {
    scarState = { data: undefined, isLoading: false, error: { status: 404, message: "SCAR not found" } };
    renderIt();
    expect(screen.getByRole("alert")).toHaveTextContent("This request is not available to you.");
  });
});
