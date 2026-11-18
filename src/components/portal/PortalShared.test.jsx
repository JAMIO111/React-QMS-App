import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Outlet, Route, Routes } from "react-router-dom";

let share;
let shareState;
const mutateAsync = vi.fn();
const mutate = vi.fn();
const openFile = vi.fn();

vi.mock("../../hooks/usePortal", () => ({
  usePortalShare: () => shareState,
  usePortalShareMutation: () => ({ mutate, mutateAsync, isPending: false, variables: null, error: null }),
  openPortalDocumentFile: (...a) => openFile(...a),
}));
vi.mock("../../contexts/ToastProvider", () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock("../documents/DocumentEditor", () => ({ default: () => <div>Document text</div> }));

import PortalSharedPage from "./PortalSharedPage";

const access = { organisationId: "o1", organisationName: "Alpha Precision", partyName: "Acme Castings", mfaRequired: false };
const ncr = {
  reference: "NC-1", title: "Cracked bar stock", description: "Cracks on lot 77", requirement: "No cracks", actualResult: "3 of 10", severity: "major", stage: "open", detectedAt: "2026-11-10",
  quantityAffected: 10, quantityInspected: 10, partNumber: "BAR-1", partName: "Bar", partRevision: "B v2", lotNumber: "LOT-77", serialNumber: null, purchaseOrder: "PO-1", customerReference: null,
  containment: [{ kind: "quarantine", description: "Quarantine lot 77", dueDate: null, status: "done", quantityContained: 10, resultNote: "Held in the cage" }],
  disposition: [{ decision: "return_to_supplier", quantity: 5, instructions: "Return the cracked bars", reference: null }], sharedAt: "2026-11-18T09:00:00Z", contact: "Pat in Quality",
};
const capa = {
  reference: "CAPA-1", title: "Casting 8D", severity: "major", stage: "actions_in_progress", problemStatement: "Cracks in castings",
  problem: { who: null, what: "Cracks", where: "Final inspection", when: "10 Nov", why: null, how: null, howMany: "3 of 10" },
  containment: [], noContainmentReason: "Nothing left in the plant", rootCauses: [{ kind: "occurrence", description: "Mould too cold" }],
  correctiveActions: [{ description: "Pre-heat the mould", dueDate: "2026-12-01", status: "open", resultNote: null }], verification: { effective: true, method: "Audit of 3 lots", date: "2026-11-17T09:00:00Z" },
  preventiveActions: [], noPreventiveReason: null, lessonsLearned: "Check mould temperature", closedAt: null, teamSize: 4, sharedAt: "2026-11-18T09:00:00Z", contact: "Alpha Precision",
};
const comments = [
  { id: "c1", side: "staff", author: "Alpha Precision", body: "Please confirm lot 77", createdAt: "2026-11-18T10:00:00Z", withdrawn: false, mine: false, canWithdraw: false },
  { id: "c2", side: "external", author: "sam", body: "Held in our cage", createdAt: "2026-11-18T10:05:00Z", withdrawn: false, mine: true, canWithdraw: true },
  { id: "c3", side: "external", author: "sam", body: null, createdAt: "2026-11-18T10:06:00Z", withdrawn: true, mine: true, canWithdraw: false },
];

const renderIt = () =>
  render(
    <MemoryRouter initialEntries={["/portal/shared/s1"]}>
      <Routes>
        <Route path="/portal" element={<Outlet context={{ access }} />}>
          <Route path="shared/:shareId" element={<PortalSharedPage />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );

beforeEach(() => {
  mutate.mockReset();
  openFile.mockReset().mockResolvedValue();
  mutateAsync.mockReset().mockResolvedValue({});
  share = { id: "s1", kind: "ncr", record: ncr, comments };
  shareState = { data: share, isLoading: false, error: null };
});

describe("a shared record in the portal", () => {
  it("shows a non-conformance: what was found, the parts, containment and the approved decision, with who to contact", () => {
    renderIt();
    expect(screen.getByRole("heading", { name: /NC-1/ })).toBeInTheDocument();
    expect(screen.getByText(/shared by Alpha Precision/)).toHaveTextContent("contact: Pat in Quality");
    expect(screen.getByText("Cracks on lot 77")).toBeInTheDocument();
    expect(screen.getByText("BAR-1 · Bar")).toBeInTheDocument();
    expect(screen.getByText("B v2")).toBeInTheDocument();
    const containment = screen.getByRole("list", { name: "Containment actions" });
    expect(within(containment).getByText(/Quarantine: Quarantine lot 77/)).toBeInTheDocument();
    expect(within(containment).getByText(/Result: Held in the cage/)).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Approved decisions" })).toHaveTextContent("Return to supplier · 5");
    expect(screen.queryByText(/cost/i)).toBeNull();
  });

  it("shows an 8D: the problem, verified root causes, actions, verification and lessons", () => {
    shareState = { data: { id: "s1", kind: "capa", record: capa, comments: [] }, isLoading: false, error: null };
    renderIt();
    expect(screen.getByText("Cracks in castings")).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Root causes" })).toHaveTextContent("Mould too cold");
    expect(screen.getByRole("list", { name: "Corrective actions" })).toHaveTextContent("Pre-heat the mould");
    expect(screen.getByText(/Verified effective · Audit of 3 lots/)).toBeInTheDocument();
    expect(screen.getByText(/Check mould temperature/)).toBeInTheDocument();
    expect(screen.getByText(/No containment needed: Nothing left in the plant/)).toBeInTheDocument();
  });

  it("shows the conversation: the organisation by name, your own comment withdrawable, a withdrawn one as such", async () => {
    renderIt();
    const thread = screen.getByRole("list", { name: "Conversation so far" });
    expect(within(thread).getByText("Alpha Precision")).toBeInTheDocument();
    expect(within(thread).getByText("Comment withdrawn")).toBeInTheDocument();
    await userEvent.click(within(thread).getByRole("button", { name: /Withdraw/ }));
    expect(mutate).toHaveBeenCalledWith({ action: "withdraw", id: "c2" });
  });

  it("sends a comment and clears the box", async () => {
    renderIt();
    const box = screen.getByRole("textbox", { name: /Write a comment/ });
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    await userEvent.type(box, "Will return the bars on Friday");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(mutateAsync).toHaveBeenCalledWith({ action: "comment", body: { body: "Will return the bars on Friday" } });
    expect(box).toHaveValue("");
  });

  it("says so when it is not shared with you (any more)", () => {
    shareState = { data: null, isLoading: false, error: Object.assign(new Error("x"), { status: 404 }) };
    renderIt();
    expect(screen.getByText(/not shared with you/)).toBeInTheDocument();
  });

  const doc = {
    number: "SOP-004", title: "Packing instruction", type: "Procedure", revision: "B", effectiveFrom: "2026-11-17", changeSummary: "Added the label position", description: "How we pack",
    contentKind: "file", body: null, files: [{ id: "f1", fileName: "packing.pdf", sizeBytes: 2048, role: "main" }], acknowledgedAt: null, canAcknowledge: true, sharedAt: "2026-11-18T09:00:00Z", contact: "Alpha Precision",
  };

  it("shows a document: its revision, what changed, files that open on a short link, and acknowledges with a note", async () => {
    shareState = { data: { id: "s1", kind: "document", record: doc, comments: [] }, isLoading: false, error: null };
    renderIt();
    expect(screen.getByRole("heading", { name: /SOP-004/ })).toBeInTheDocument();
    expect(screen.getByText("Added the label position")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Open packing.pdf" }));
    expect(openFile).toHaveBeenCalledWith("o1", "s1", "f1");
    await userEvent.type(screen.getByRole("textbox", { name: /Note/ }), "Read it");
    await userEvent.click(screen.getByRole("button", { name: "Acknowledge" }));
    expect(mutate).toHaveBeenCalledWith({ action: "acknowledge", body: { note: "Read it" } }, expect.any(Object));
  });

  it("a document already acknowledged says so and offers no button", () => {
    shareState = { data: { id: "s1", kind: "document", record: { ...doc, acknowledgedAt: "2026-11-18T10:00:00Z", canAcknowledge: false }, comments: [] }, isLoading: false, error: null };
    renderIt();
    expect(screen.getByText("You have acknowledged this")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Acknowledge" })).toBeNull();
  });

  it("shows a quality alert: what happened, what is asked, and no button once it is not in force", () => {
    const alert = { reference: "QA-007", title: "Cracks in bar stock", severity: "high", category: "supplier", status: "expired", description: "Cracks in lot 77", effectiveDate: "2026-11-10", expiryDate: null,
      acknowledgeBy: "2026-11-20", actions: [{ position: 1, description: "Sort your stock" }], acknowledgedAt: null, canAcknowledge: false, sharedAt: "2026-11-18T09:00:00Z", contact: "Alpha Precision", revision: 1 };
    shareState = { data: { id: "s1", kind: "quality_alert", record: alert, comments: [] }, isLoading: false, error: null };
    renderIt();
    expect(screen.getByRole("heading", { name: /QA-007/ })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Actions" })).toHaveTextContent("Sort your stock");
    expect(screen.queryByRole("button", { name: "Acknowledge" })).toBeNull();
  });
});
