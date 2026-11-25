import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

let list;
const mutate = vi.fn();
vi.mock("../../hooks/usePortal", () => ({
  usePortalChangeRequests: () => ({ data: { data: list }, error: null }),
  usePortalChangeParts: () => ({ data: { data: [{ id: "p1", partNumber: "P-100", name: "Bracket", theirPartNumber: "W-77" }] } }),
  usePortalChangeRequestMutation: () => ({ mutate, isPending: false }),
}));

import PortalChangeRequests from "./PortalChangeRequests";
import { portalMenu } from "../../lib/portal";

const customer = { organisationId: "o1", organisationName: "Alpha Precision", partyKind: "customer" };
const supplier = { ...customer, partyKind: "supplier" };
const item = { id: "r1", reference: "ECR-26-0001", kind: "customer_request", title: "Tighten the bend radius", description: "x", status: "received", raisedAt: "2026-11-24T09:00:00Z", raisedByMe: true, partNumber: "P-100", partName: "Bracket", wantedOn: "2026-12-15" };

beforeEach(() => {
  mutate.mockReset();
  list = [item];
});

describe("change requests in the portal", () => {
  it("lists what was sent with a plain status and the date asked for", () => {
    render(<PortalChangeRequests access={customer} />);
    const ul = screen.getByRole("list", { name: "Your change requests" });
    expect(ul).toHaveTextContent("ECR-26-0001 · Tighten the bend radius");
    expect(ul).toHaveTextContent("P-100");
    expect(ul).toHaveTextContent("wanted from 15 Dec 2026");
    expect(screen.getByText("Received")).toBeInTheDocument();
  });

  it("says what each status means in its own words", () => {
    list = [{ ...item, status: "under_review" }, { ...item, id: "r2", status: "declined" }, { ...item, id: "r3", status: "done" }];
    render(<PortalChangeRequests access={customer} />);
    expect(screen.getByText("Under review")).toBeInTheDocument();
    expect(screen.getByText("Declined")).toBeInTheDocument();
    expect(screen.getByText("Done")).toBeInTheDocument();
  });

  it("speaks to a supplier about notifying a change, not asking for one", () => {
    list = [];
    render(<PortalChangeRequests access={supplier} />);
    expect(screen.getByRole("heading", { name: "Your process change notices" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Notify a change" })).toBeInTheDocument();
    expect(screen.getByText("You have not notified any process changes yet.")).toBeInTheDocument();
  });

  it("asks for a title and a description before sending", async () => {
    render(<PortalChangeRequests access={customer} />);
    await userEvent.click(screen.getByRole("button", { name: "Ask for a change" }));
    await userEvent.click(screen.getByRole("button", { name: "Send request" }));
    expect(screen.getByText("Give the change a short title.")).toBeInTheDocument();
    expect(mutate).not.toHaveBeenCalled();
  });

  it("sends the request with a client key so a retry cannot double it", async () => {
    render(<PortalChangeRequests access={customer} />);
    await userEvent.click(screen.getByRole("button", { name: "Ask for a change" }));
    await userEvent.type(screen.getByLabelText(/What would you like changed/), "Reduce the bend radius");
    await userEvent.type(screen.getByLabelText(/Describe the change/), "From 3 mm to 2 mm on the bracket.");
    await userEvent.click(screen.getByRole("button", { name: "Send request" }));
    expect(mutate).toHaveBeenCalledTimes(1);
    const body = mutate.mock.calls[0][0];
    expect(body).toMatchObject({ title: "Reduce the bend radius", description: "From 3 mm to 2 mm on the bracket.", reason: null, partId: null, wantedOn: null });
    expect(body.clientKey).toMatch(/.{8,}/);
  });
});

describe("the portal menu for change requests", () => {
  it("is Change requests for a customer and Process changes for a supplier, and nothing for anyone else", () => {
    expect(portalMenu(customer).find((m) => m.key === "changes")).toMatchObject({ name: "Change requests", path: "/portal/change-requests" });
    expect(portalMenu(supplier).find((m) => m.key === "changes")).toMatchObject({ name: "Process changes", path: "/portal/change-requests" });
    expect(portalMenu({ partyKind: "other" }).find((m) => m.key === "changes")).toBeUndefined();
  });
});
