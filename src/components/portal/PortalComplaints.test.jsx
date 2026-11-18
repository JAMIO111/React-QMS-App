import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

let list;
let figures;
const fileMutate = vi.fn();
const openFile = vi.fn();
const mutate = vi.fn();
vi.mock("../../hooks/usePortal", () => ({
  usePortalComplaints: () => ({ data: { data: list }, error: null }),
  usePortalComplaintParts: () => ({ data: { data: [{ id: "p1", partNumber: "P-100", name: "Bracket", customerPartNumber: "W-77" }] } }),
  usePortalComplaintMutation: () => ({ mutate, isPending: false }),
  usePortalComplaintFileMutation: () => ({ mutate: fileMutate, isPending: false, variables: null, error: null }),
  openPortalComplaintFile: (...a) => openFile(...a),
  usePortalFigures: () => ({ data: figures, isLoading: false, error: null }),
}));

import PortalComplaints, { PortalFigures } from "./PortalComplaints";

const access = { organisationId: "o1", organisationName: "Alpha Precision" };
const item = { id: "c1", reference: "SNC-26-0001", title: "Bracket cracked", description: "x", status: "received", raisedAt: "2026-11-17T09:00:00Z", raisedByMe: true, partNumber: "P-100", partName: "Bracket", quantity: 3, lot: "LOT-9", customerReference: null, detectedOn: "2026-11-16", shareId: null, files: [{ id: "f1", name: "crack.jpg", sizeBytes: 2048, addedAt: "2026-11-17T09:05:00Z", mine: true, canRemove: true }] };

beforeEach(() => {
  figures = { available: true, period: { from: "2026-08-20", to: "2026-11-17", days: 90 }, ncs: { raised: 4, critical: 0, major: 1, minor: 3, open: 2, oldestOpenDays: 12, averageOpenDays: 7.5, closedInPeriod: 2, averageDaysToClose: 9.5 }, capas: { started: 1, inProgress: 1, closedInPeriod: 0, averageDaysToClose: null } };
  mutate.mockReset();
  fileMutate.mockReset();
  openFile.mockReset();
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

describe("quality figures for a customer", () => {
  it("states every figure in words", () => {
    render(<PortalFigures access={access} />);
    expect(screen.getByText("Non-conformances raised").nextSibling).toHaveTextContent("4");
    expect(screen.getByText(/2 open, the oldest 12 days \(on average 7.5 days\)/)).toBeInTheDocument();
    expect(screen.getByText(/2 closed in this period, taking 9.5 days on average/)).toBeInTheDocument();
    expect(screen.getByText(/0 closed in this period, taking — on average/)).toBeInTheDocument();
  });

  it("shows nothing when staff switched the figures off", () => {
    figures = { available: false, period: { from: "2026-08-20", to: "2026-11-17", days: 90 } };
    const { container } = render(<PortalFigures access={access} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("files on a complaint", () => {
  it("lists them, opens one and takes one back", async () => {
    renderIt();
    const ul = await screen.findByRole("list", { name: "Files on SNC-26-0001" });
    expect(ul).toHaveTextContent("crack.jpg2 kB");
    await userEvent.click(screen.getByRole("button", { name: "crack.jpg" }));
    expect(openFile).toHaveBeenCalledWith("o1", "f1");
    await userEvent.click(screen.getByRole("button", { name: "Take back crack.jpg" }));
    expect(fileMutate).toHaveBeenCalledWith({ action: "remove", id: "f1" });
  });

  it("adds a file while the complaint is only received", async () => {
    renderIt();
    const file = new File(["x"], "photo.png", { type: "image/png" });
    await userEvent.upload(screen.getByLabelText("Choose a file for SNC-26-0001"), file);
    expect(fileMutate).toHaveBeenCalledWith({ action: "add", id: "c1", file });
  });

  it("offers no adding once we are working on it, but still shows the files", () => {
    list = [{ ...item, status: "in_progress" }];
    renderIt();
    expect(screen.queryByRole("button", { name: /Add a file to/ })).toBeNull();
    expect(screen.getByRole("list", { name: "Files on SNC-26-0001" })).toBeInTheDocument();
  });
});
