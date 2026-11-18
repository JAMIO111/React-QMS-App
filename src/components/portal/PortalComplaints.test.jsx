import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

let list;
const mutate = vi.fn();
vi.mock("../../hooks/usePortal", () => ({
  usePortalComplaints: () => ({ data: { data: list }, error: null }),
  usePortalComplaintParts: () => ({ data: { data: [{ id: "p1", partNumber: "P-100", name: "Bracket", customerPartNumber: "W-77" }] } }),
  usePortalComplaintMutation: () => ({ mutate, isPending: false }),
}));

import PortalComplaints from "./PortalComplaints";

const access = { organisationId: "o1", organisationName: "Alpha Precision" };
const item = { id: "c1", reference: "SNC-26-0001", title: "Bracket cracked", description: "x", status: "received", raisedAt: "2026-11-17T09:00:00Z", raisedByMe: true, partNumber: "P-100", partName: "Bracket", quantity: 3, lot: "LOT-9", customerReference: null, detectedOn: "2026-11-16", shareId: null };

beforeEach(() => {
  mutate.mockReset();
  list = [item];
});

const renderIt = () => render(<MemoryRouter><PortalComplaints access={access} /></MemoryRouter>);

describe("complaints in the portal", () => {
  it("lists what was raised with a plain status", () => {
    renderIt();
    expect(screen.getByRole("list", { name: "Your complaints" })).toHaveTextContent("SNC-26-0001 · Bracket cracked");
    expect(screen.getByText("Received")).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Your complaints" })).toHaveTextContent("Lot LOT-9");
  });

  it("links a complaint to its record once it is shared", () => {
    list = [{ ...item, status: "in_progress", shareId: "s9" }];
    renderIt();
    expect(screen.getByRole("link", { name: /SNC-26-0001/ })).toHaveAttribute("href", "/portal/shared/s9?org=o1");
  });

  it("says so when there are none", () => {
    list = [];
    renderIt();
    expect(screen.getByText("You have not raised any complaints yet.")).toBeInTheDocument();
  });

  it("asks for a title and a description before sending", async () => {
    renderIt();
    await userEvent.click(screen.getByRole("button", { name: "Raise a complaint" }));
    await userEvent.click(screen.getByRole("button", { name: "Send complaint" }));
    expect(screen.getByText("Give the complaint a short title.")).toBeInTheDocument();
    expect(mutate).not.toHaveBeenCalled();
  });

  it("sends the complaint with a client key so a retry cannot double it", async () => {
    renderIt();
    await userEvent.click(screen.getByRole("button", { name: "Raise a complaint" }));
    await userEvent.type(screen.getByLabelText("Title"), "Bracket cracked");
    await userEvent.type(screen.getByLabelText("What is wrong"), "Three brackets had cracks at the bend.");
    await userEvent.click(screen.getByRole("button", { name: "Send complaint" }));
    expect(mutate).toHaveBeenCalledTimes(1);
    const body = mutate.mock.calls[0][0];
    expect(body).toMatchObject({ title: "Bracket cracked", description: "Three brackets had cracks at the bend.", partId: null, quantity: null });
    expect(body.clientKey).toMatch(/.{8,}/);
  });
});
