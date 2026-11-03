import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

let invitations;
const mutate = vi.fn();
vi.mock("../hooks/useQmsApi", () => ({
  useMyInvitations: () => invitations,
  useAcceptInvitation: () => ({ mutate, isPending: false, error: null }),
}));

import PendingInvitations from "./PendingInvitations";

describe("PendingInvitations", () => {
  it("renders nothing without invitations or when the API is unavailable", () => {
    invitations = { data: { data: [] } };
    const { container, rerender } = render(<PendingInvitations />);
    expect(container).toBeEmptyDOMElement();
    invitations = { error: new Error("unreachable") };
    rerender(<PendingInvitations />);
    expect(container).toBeEmptyDOMElement();
  });

  it("accepts an invitation", async () => {
    invitations = { data: { data: [{ membershipId: "m1", organisationId: "o1", organisationName: "Alpha Precision", invitedByName: "Ada Owner" }] } };
    render(<PendingInvitations />);
    expect(screen.getByText("Invited by Ada Owner")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Accept" }));
    expect(mutate).toHaveBeenCalledWith("m1");
  });
});
