import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Outlet, Route, Routes } from "react-router-dom";

let request;
const mutate = vi.fn();
vi.mock("../../hooks/usePortal", () => ({
  usePortalChangeApprovals: () => ({ data: { data: [] }, isLoading: false }),
  usePortalChangeApproval: () => ({ data: request, isLoading: false, error: null }),
  usePortalChangeApprovalMutation: () => ({ mutate, isPending: false, error: null }),
}));

import PortalChangeApprovalPage from "./PortalChangeApprovalPage";

const access = { organisationId: "o1", organisationName: "Alpha Precision", partyKind: "customer" };
const pending = {
  id: "r1", status: "pending", requestedAt: "2026-11-20T10:00:00Z", requestNote: "Please approve the tighter radius.", reference: "ECR-26-0001", title: "Tighten the bend radius",
  whatIsChanging: "Bend radius from 3 mm to 2 mm", why: "Fits the new assembly", type: "Product design", expedited: false, appliesFrom: "From 01 Dec 2026", stock: "Use up what we have",
  parts: [{ partNumber: "P-100", name: "Bracket", theirPartNumber: "W-77" }], contact: "Pat in Quality", decidedAt: null, decidedBy: null, decisionNote: null, yourReference: null, open: true, canDecide: true,
};

const renderIt = () =>
  render(
    <MemoryRouter initialEntries={["/portal/change-approvals/r1"]}>
      <Routes>
        <Route path="/portal" element={<Outlet />}>
          <Route path="change-approvals/:approvalId" element={<PortalChangeApprovalPage />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );

// The page reads `access` from the portal layout's outlet context.
vi.mock("react-router-dom", async (orig) => ({ ...(await orig()), useOutletContext: () => ({ access }) }));

beforeEach(() => {
  mutate.mockReset();
  request = pending;
});

describe("a customer approving a change in the portal", () => {
  it("shows what the change is in the customer's terms, and only their parts", () => {
    renderIt();
    expect(screen.getByRole("heading", { name: /ECR-26-0001 · Tighten the bend radius/ })).toBeInTheDocument();
    expect(screen.getByText("Waiting for your answer")).toBeInTheDocument();
    expect(screen.getByText("Bend radius from 3 mm to 2 mm")).toBeInTheDocument();
    expect(screen.getByText("From 01 Dec 2026")).toBeInTheDocument();
    expect(screen.getByText("Please approve the tighter radius.")).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "Parts" })).getByText(/your number W-77/)).toBeInTheDocument();
  });

  it("approves with their own reference", async () => {
    renderIt();
    await userEvent.click(screen.getByRole("button", { name: "Approve this change" }));
    await userEvent.type(screen.getByLabelText("Your own reference"), "WAYNE-ECN-12");
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(mutate).toHaveBeenCalledWith({ approve: true, note: null, reference: "WAYNE-ECN-12" }, expect.anything());
  });

  it("will not send a no without saying what cannot be accepted", async () => {
    renderIt();
    await userEvent.click(screen.getByRole("button", { name: "I cannot accept it" }));
    const send = screen.getByRole("button", { name: "Send" });
    expect(send).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/What you cannot accept/), "A 2 mm radius cracks on our press.");
    await userEvent.click(send);
    expect(mutate).toHaveBeenCalledWith({ approve: false, note: "A 2 mm radius cracks on our press.", reference: null }, expect.anything());
  });

  it("shows the answer, and no buttons, once it has been given", () => {
    request = { ...pending, status: "approved", canDecide: false, decidedAt: "2026-11-21T09:00:00Z", decidedBy: "Pat", yourReference: "WAYNE-ECN-12", decisionNote: "Fine after our trial." };
    renderIt();
    expect(screen.queryByRole("button", { name: "Approve this change" })).toBeNull();
    expect(screen.getByText("WAYNE-ECN-12")).toBeInTheDocument();
    expect(screen.getByText("Fine after our trial.")).toBeInTheDocument();
  });

  it("says when the change is no longer open", () => {
    request = { ...pending, open: false, canDecide: false };
    renderIt();
    expect(screen.getByText(/no longer needs your answer/)).toBeInTheDocument();
    expect(screen.getByText("Nothing is needed from you.")).toBeInTheDocument();
  });
});
