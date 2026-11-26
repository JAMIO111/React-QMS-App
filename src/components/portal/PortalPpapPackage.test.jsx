import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Outlet, Route, Routes } from "react-router-dom";

let pack;
let list = [];
const mutate = vi.fn();
vi.mock("../../hooks/usePortal", () => ({
  usePortalPpapPackages: () => ({ data: { data: list }, isLoading: false }),
  usePortalPpapPackage: () => ({ data: pack, isLoading: false, error: null }),
  usePortalPpapPackageMutation: () => ({ mutate, isPending: false, error: null, variables: undefined }),
  openPortalPpapPackageFile: vi.fn(),
}));

import PortalPpapPackagePage, { PpapPackageList } from "./PortalPpapPackagePage";

const access = { organisationId: "o1", organisationName: "Alpha Precision", partyKind: "supplier" };
const base = {
  id: "r1", status: "pending", requestedAt: "2026-11-20T10:00:00Z", requestNote: "Please send the package.", reference: "PPAP-26-0003", partNumber: "P-100", partName: "Bracket", revision: "A", level: 1,
  reason: "New part", submissionStatus: "in_preparation", submittedOn: null, contact: "Pat in Purchasing", answeredAt: null, decision: null, decisionNote: null, decisionExpiresOn: null, decidedOn: null,
  elements: [
    { key: "part_submission_warrant", name: "Part Submission Warrant", requirement: "Required", waived: false, provided: false, files: [] },
    { key: "master_sample", name: "Master sample", requirement: "Keep on file", waived: false, provided: true, files: [{ id: "f1", name: "sample.pdf", sizeBytes: 2048, addedAt: "2026-11-21T09:00:00Z", mine: true }] },
  ],
  missing: ["Part Submission Warrant"], canEdit: true, canSubmit: false,
};

const renderIt = () =>
  render(
    <MemoryRouter initialEntries={["/portal/ppap-packages/r1"]}>
      <Routes>
        <Route path="/portal" element={<Outlet />}>
          <Route path="ppap-packages/:requestId" element={<PortalPpapPackagePage />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );

vi.mock("react-router-dom", async (orig) => ({ ...(await orig()), useOutletContext: () => ({ access }) }));

beforeEach(() => {
  mutate.mockReset();
  pack = base;
  list = [];
});

describe("a supplier preparing a part approval package in the portal", () => {
  it("shows what is asked of them, their own files, and what is still missing", () => {
    renderIt();
    expect(screen.getByRole("heading", { name: /PPAP-26-0003 · P-100 Bracket/ })).toBeInTheDocument();
    expect(screen.getByText("To prepare")).toBeInTheDocument();
    expect(screen.getByText("Please send the package.")).toBeInTheDocument();
    const elements = screen.getByRole("list", { name: "Elements" });
    expect(within(elements).getByText("Part Submission Warrant")).toBeInTheDocument();
    expect(within(elements).getByRole("button", { name: "sample.pdf" })).toBeInTheDocument();
    expect(screen.getByText(/Still needed before you can submit: Part Submission Warrant/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Submit the package" })).toBeDisabled();
  });

  it("adds a file to an element and takes their own back", async () => {
    renderIt();
    const file = new File(["x"], "warrant.pdf", { type: "application/pdf" });
    await userEvent.upload(screen.getByLabelText("Choose a file for Part Submission Warrant"), file);
    expect(mutate).toHaveBeenCalledWith({ action: "add", elementKey: "part_submission_warrant", file });
    await userEvent.click(screen.getByRole("button", { name: "Take back sample.pdf" }));
    expect(mutate).toHaveBeenCalledWith({ action: "remove", fileId: "f1" });
  });

  it("submits with a note once nothing is missing", async () => {
    pack = { ...base, missing: [], canSubmit: true };
    renderIt();
    await userEvent.click(screen.getByRole("button", { name: "Submit the package" }));
    const dialog = await screen.findByRole("dialog", { name: /Submit PPAP-26-0003/ });
    await userEvent.type(within(dialog).getByLabelText("Note"), "All attached.");
    await userEvent.click(within(dialog).getByRole("button", { name: "Submit the package" }));
    expect(mutate).toHaveBeenCalledWith({ action: "submit", note: "All attached." }, expect.anything());
  });

  it("offers no changes once it is submitted, and shows our decision", () => {
    pack = { ...base, status: "answered", canEdit: false, missing: [], submissionStatus: "rejected", decision: "rejected", decisionNote: "The capability study is missing.", answeredAt: "2026-11-22T09:00:00Z" };
    renderIt();
    expect(screen.queryByRole("button", { name: "Submit the package" })).toBeNull();
    expect(screen.queryByLabelText("Choose a file for Part Submission Warrant")).toBeNull();
    expect(screen.getByText("The capability study is missing.")).toBeInTheDocument();
    expect(screen.getByText("Rejected", { selector: "span" })).toBeInTheDocument();
  });

  it("says until when an interim approval stands, and shows an approval without a note", () => {
    pack = { ...base, status: "answered", canEdit: false, missing: [], submissionStatus: "interim_approved", decision: "interim_approved", decisionNote: "Until the trial.", decisionExpiresOn: "2026-12-31", answeredAt: "2026-11-22T09:00:00Z" };
    renderIt();
    expect(screen.getByText(/Approved for now until/)).toBeInTheDocument();
  });
});

describe("the part approval packages list", () => {
  it("lists only what is to prepare when asked, and nothing for a customer", () => {
    list = [
      { id: "r1", reference: "PPAP-26-0003", partNumber: "P-100", partName: "Bracket", level: 1, status: "pending", submissionStatus: "in_preparation", requestedAt: "2026-11-20T10:00:00Z", answeredAt: null, canEdit: true },
      { id: "r2", reference: "PPAP-26-0004", partNumber: "P-200", partName: "Housing", level: 1, status: "answered", submissionStatus: "approved", requestedAt: "2026-11-01T10:00:00Z", answeredAt: "2026-11-02T10:00:00Z", canEdit: false },
    ];
    const { rerender } = render(<MemoryRouter><PpapPackageList access={access} onlyEditable heading="To prepare" /></MemoryRouter>);
    const items = screen.getByRole("list", { name: "To prepare" });
    expect(within(items).getAllByRole("link")).toHaveLength(1);
    expect(within(items).getByRole("link")).toHaveAttribute("href", "/portal/ppap-packages/r1?org=o1");
    rerender(<MemoryRouter><PpapPackageList access={access} heading="All" /></MemoryRouter>);
    expect(within(screen.getByRole("list", { name: "All" })).getAllByRole("link")).toHaveLength(2);
    expect(within(screen.getByRole("list", { name: "All" })).getByText("Approved")).toBeInTheDocument();
    rerender(<MemoryRouter><PpapPackageList access={{ ...access, partyKind: "customer" }} heading="Customer" /></MemoryRouter>);
    expect(screen.queryByRole("list", { name: "Customer" })).toBeNull();
  });
});
