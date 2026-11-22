import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Outlet, Route, Routes, useLocation } from "react-router-dom";

let ncrs;
let scars;
let capas;
let shares;
let home;
vi.mock("../../hooks/usePortal", () => ({
  usePortalNcrs: () => ({ data: { data: ncrs }, isLoading: false, error: null, refetch: vi.fn() }),
  usePortalScars: () => ({ data: { data: scars }, isLoading: false, error: null, refetch: vi.fn() }),
  usePortalCapas: () => ({ data: { data: capas }, isLoading: false, error: null, refetch: vi.fn() }),
  usePortalShares: () => ({ data: { data: shares }, isLoading: false, error: null, refetch: vi.fn() }),
  usePortalHome: () => home,
  usePortalPeople: () => ({ data: { data: [] }, isLoading: false }),
  usePortalMutation: () => ({ mutate: vi.fn(), isPending: false }),
  usePortalComplaints: () => ({ data: { data: [] }, isLoading: false }),
  usePortalComplaintParts: () => ({ data: { data: [] } }),
  usePortalComplaintMutation: () => ({ mutate: vi.fn(), isPending: false }),
  usePortalComplaintFileMutation: () => ({ mutate: vi.fn(), isPending: false }),
  usePortalEvidence: () => ({ data: { data: [] }, isLoading: false }),
  openPortalComplaintFile: vi.fn(),
  openPortalEvidence: vi.fn(),
}));

import { PortalCapasPage, PortalCertificatesPage, PortalComplaintsPage, PortalDocumentsPage, PortalNcrsPage, PortalScarsPage, PortalTeamPage } from "./PortalPages";

const supplier = { organisationId: "o1", organisationName: "Alpha Precision", partyName: "Acme Castings", partyKind: "supplier", role: "admin", mfaRequired: false };
const customer = { ...supplier, partyName: "Wayne Ltd", partyKind: "customer", role: "member" };

const nc = (over) => ({ id: "s1", reference: "NC-1", title: "Cracked bar stock", stage: "open", severity: "major", detectedAt: "2026-11-02", partNumber: "P-100", partName: "Bracket", lotNumber: "L-77",
  quantityAffected: 4, customerReference: "WAY-9", purchaseOrder: "PO-5", sharedAt: "2026-11-03T09:00:00Z", comments: 2, newComments: 1, viewed: true, lastCommentAt: null, closurePending: false, ...over });

const Where = () => <p data-testid="where">{useLocation().pathname}</p>;
const renderAt = (path, element, who = supplier) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/portal" element={<Outlet context={{ access: who }} />}>
          <Route index element={<Where />} />
          <Route path="non-conformances" element={element} />
          <Route path="scars" element={element} />
          <Route path="8ds" element={element} />
          <Route path="documents" element={element} />
          <Route path="complaints" element={element} />
          <Route path="certificates" element={element} />
          <Route path="team" element={element} />
          <Route path="shared/:id" element={<Where />} />
          <Route path="scars/:id" element={<Where />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );

beforeEach(() => {
  localStorage.clear();
  ncrs = [
    nc(),
    nc({ id: "s2", reference: "NC-2", title: "Burrs on flange", stage: "closed", severity: "minor", detectedAt: "2026-09-10", partNumber: "P-200", lotNumber: null, newComments: 0, viewed: false }),
    nc({ id: "s3", reference: "NC-10", title: "Wrong size", stage: "open", severity: "critical", detectedAt: "2026-10-20", comments: 0, newComments: 0, closurePending: true }),
  ];
  scars = [
    { id: "c1", reference: "SCAR-26-0001", title: "Cracked castings", severity: "major", status: "issued", issuedAt: "2026-11-10T09:00:00Z", responseDueOn: "2099-12-03", awaitingResponse: true, overdue: false, extensionWaiting: false, responses: 0, openActions: 0, lateActions: 0 },
    { id: "c2", reference: "SCAR-26-0002", title: "Late deliveries", severity: "minor", status: "closed", issuedAt: "2026-09-10T09:00:00Z", responseDueOn: "2026-09-20", awaitingResponse: false, overdue: false, extensionWaiting: false, responses: 2, openActions: 0, lateActions: 0 },
  ];
  capas = [{ id: "k1", reference: "CAPA-000001", title: "Casting 8D", severity: "major", stage: "actions_in_progress", startedAt: "2026-10-01T09:00:00Z", closedAt: null, sharedAt: "2026-10-02T09:00:00Z", comments: 0, newComments: 0, viewed: true, closurePending: false }];
  shares = [
    { id: "d1", kind: "document", reference: "SOP-001", title: "Packing instruction", status: "active", sharedAt: "2026-11-01T09:00:00Z", comments: 0, newComments: 0, viewed: true },
    { id: "d2", kind: "quality_alert", reference: "QA-001", title: "Burr on flange", status: "active", sharedAt: "2026-11-05T09:00:00Z", comments: 0, newComments: 0, viewed: true },
    { id: "n1", kind: "ncr", reference: "NC-1", title: "Not in this register", status: "open", sharedAt: "2026-11-05T09:00:00Z", comments: 0, newComments: 0, viewed: true },
  ];
  home = { data: { attention: [{ id: "d2", needsAcknowledgement: true }] }, isLoading: false };
});

const table = (name) => screen.getByRole("region", { name });
const refs = (name) => within(table(name)).getAllByRole("link").map((l) => l.textContent);

describe("the non-conformance register", () => {
  it("lists what is shared with the party, newest detection first, with the main columns and the rest hidden", () => {
    renderAt("/portal/non-conformances", <PortalNcrsPage />);
    expect(refs("Non-conformances")).toEqual(["NC-1", "NC-10", "NC-2"]);
    const t = within(table("Non-conformances"));
    expect(t.getByText("Cracked bar stock")).toBeInTheDocument();
    expect(t.getAllByText("P-100 · Bracket")).toHaveLength(2);
    expect(t.getByText("1 new")).toBeInTheDocument();
    expect(t.getByText("Confirm closure")).toBeInTheDocument();
    expect(t.getByText("New")).toBeInTheDocument(); // NC-2 has not been opened
    expect(t.queryByText("WAY-9")).toBeNull(); // hidden until chosen
    expect(screen.getByText("3 non-conformances")).toBeInTheDocument();
  });

  it("searches reference, title, part and lot", async () => {
    renderAt("/portal/non-conformances", <PortalNcrsPage />);
    await userEvent.type(screen.getByRole("searchbox", { name: /Search non-conformances/ }), "burrs");
    expect(await screen.findByText("1 non-conformance of 3")).toBeInTheDocument();
    expect(refs("Non-conformances")).toEqual(["NC-2"]);
    expect(screen.getByLabelText("Active filters")).toHaveTextContent("Search: “burrs”");
  });

  it("filters by stage and severity from the filter panel, shows a chip for each and clears them", async () => {
    renderAt("/portal/non-conformances", <PortalNcrsPage />);
    await userEvent.click(screen.getByRole("button", { name: /Filter/ }));
    const panel = within(screen.getByRole("dialog", { name: "Filter non-conformances" }));
    await userEvent.click(panel.getByRole("checkbox", { name: "Open" }));
    await userEvent.click(panel.getByRole("checkbox", { name: "Critical" }));
    // Nothing moves behind the drawer until Apply.
    expect(refs("Non-conformances")).toEqual(["NC-1", "NC-10", "NC-2"]);
    await userEvent.click(panel.getByRole("button", { name: "Apply" }));
    expect(refs("Non-conformances")).toEqual(["NC-10"]);
    const chips = screen.getByLabelText("Active filters");
    expect(chips).toHaveTextContent("Stage: Open");
    expect(chips).toHaveTextContent("Severity: Critical");
    await userEvent.click(within(chips).getByRole("button", { name: "Remove filter Severity: Critical" }));
    expect(refs("Non-conformances")).toEqual(["NC-1", "NC-10"]);
    await userEvent.click(within(screen.getByLabelText("Active filters")).getByRole("button", { name: "Clear all" }));
    expect(refs("Non-conformances")).toEqual(["NC-1", "NC-10", "NC-2"]);
  });

  it("'Needs my attention' keeps what is new, has new replies or waits for the person", async () => {
    renderAt("/portal/non-conformances", <PortalNcrsPage />);
    await userEvent.click(screen.getByRole("button", { name: /Filter/ }));
    const panel = within(screen.getByRole("dialog", { name: "Filter non-conformances" }));
    await userEvent.click(panel.getByRole("checkbox", { name: /Needs my attention/ }));
    await userEvent.click(panel.getByRole("button", { name: "Apply" }));
    expect(refs("Non-conformances")).toEqual(["NC-1", "NC-10", "NC-2"]); // new reply, closure, not opened
    ncrs = ncrs.map((n) => ({ ...n, viewed: true, newComments: 0, closurePending: false }));
  });

  it("filters in a drawer that slides in, closes without applying on Escape, and Reset all clears what was applied", async () => {
    renderAt("/portal/non-conformances", <PortalNcrsPage />);
    await userEvent.click(screen.getByRole("button", { name: /Filter/ }));
    const drawer = screen.getByRole("dialog", { name: "Filter non-conformances" });
    expect(drawer.className).toMatch(/slide-in-from-right/);
    await userEvent.click(within(drawer).getByRole("checkbox", { name: "Closed" }));
    await userEvent.keyboard("{Escape}");
    expect(drawer.className).toMatch(/slide-out-to-right/);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Filter non-conformances" })).toBeNull());
    expect(refs("Non-conformances")).toEqual(["NC-1", "NC-10", "NC-2"]);
    await userEvent.click(screen.getByRole("button", { name: /Filter/ }));
    await userEvent.click(within(screen.getByRole("dialog", { name: "Filter non-conformances" })).getByRole("checkbox", { name: "Closed" }));
    await userEvent.click(within(screen.getByRole("dialog", { name: "Filter non-conformances" })).getByRole("button", { name: "Apply" }));
    expect(refs("Non-conformances")).toEqual(["NC-2"]);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Filter non-conformances" })).toBeNull());
    await userEvent.click(screen.getByRole("button", { name: /Filter/ }));
    await userEvent.click(within(screen.getByRole("dialog", { name: "Filter non-conformances" })).getByRole("button", { name: "Reset all" }));
    expect(refs("Non-conformances")).toEqual(["NC-1", "NC-10", "NC-2"]);
  });

  it("sorts from a header click and puts a column back that was hidden", async () => {
    renderAt("/portal/non-conformances", <PortalNcrsPage />);
    await userEvent.click(within(table("Non-conformances")).getByTitle("Sort by Reference"));
    expect(refs("Non-conformances")).toEqual(["NC-1", "NC-2", "NC-10"]);
    await userEvent.click(screen.getByRole("button", { name: /Columns/ }));
    await userEvent.click(screen.getByRole("checkbox", { name: /Your reference/ }));
    expect(within(table("Non-conformances")).getAllByText("WAY-9")).toHaveLength(3);
  });

  it("opens a record from its reference", async () => {
    renderAt("/portal/non-conformances", <PortalNcrsPage />);
    await userEvent.click(within(table("Non-conformances")).getByRole("link", { name: "NC-1" }));
    expect(screen.getByTestId("where")).toHaveTextContent("/portal/shared/s1");
  });

  it("says when nothing is shared, and when nothing matches", async () => {
    ncrs = [];
    renderAt("/portal/non-conformances", <PortalNcrsPage />);
    expect(screen.getByText(/No non-conformances have been shared with you yet/)).toBeInTheDocument();
  });

  it("waits for two-factor when the organisation asks for it", () => {
    renderAt("/portal/non-conformances", <PortalNcrsPage />, { ...supplier, mfaRequired: true });
    expect(screen.getByText(/Two-factor authentication needed/)).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Non-conformances" })).toBeNull();
  });
});

describe("the other registers and pages", () => {
  it("lists a supplier's corrective action requests and opens one on its own page", async () => {
    renderAt("/portal/scars", <PortalScarsPage />);
    expect(refs("Corrective action requests")).toEqual(["SCAR-26-0001", "SCAR-26-0002"]);
    const t = within(table("Corrective action requests"));
    expect(t.getByText("Needs your response")).toBeInTheDocument();
    expect(t.getByText("Respond")).toBeInTheDocument();
    await userEvent.click(t.getByRole("link", { name: "SCAR-26-0001" }));
    expect(screen.getByTestId("where")).toHaveTextContent("/portal/scars/c1");
  });

  it("sends a customer away from corrective actions, and a supplier away from 8D reports, complaints and certificates", () => {
    renderAt("/portal/scars", <PortalScarsPage />, customer);
    expect(screen.getByTestId("where")).toHaveTextContent(/^\/portal$/);
  });
  it("keeps 8D reports for customers", () => {
    renderAt("/portal/8ds", <PortalCapasPage />);
    expect(screen.getByTestId("where")).toHaveTextContent(/^\/portal$/);
  });
  it("lists a customer's 8D reports with their stage", () => {
    renderAt("/portal/8ds", <PortalCapasPage />, customer);
    expect(refs("8D reports")).toEqual(["CAPA-000001"]);
    expect(within(table("8D reports")).getByText("Actions in progress")).toBeInTheDocument();
  });
  it("keeps complaints and certificates for customers", () => {
    renderAt("/portal/complaints", <PortalComplaintsPage />);
    expect(screen.getByTestId("where")).toHaveTextContent(/^\/portal$/);
  });
  it("keeps certificates for customers", () => {
    renderAt("/portal/certificates", <PortalCertificatesPage />);
    expect(screen.getByTestId("where")).toHaveTextContent(/^\/portal$/);
  });
  it("shows a customer their complaints and certificates pages", () => {
    renderAt("/portal/complaints", <PortalComplaintsPage />, customer);
    expect(screen.getByRole("heading", { name: "Your complaints" })).toBeInTheDocument();
  });

  it("lists only documents and quality alerts, marking the one to acknowledge", () => {
    renderAt("/portal/documents", <PortalDocumentsPage />);
    expect(refs("Documents and alerts")).toEqual(["QA-001", "SOP-001"]);
    const t = within(table("Documents and alerts"));
    expect(t.getByText("Acknowledge")).toBeInTheDocument();
    expect(t.queryByText("Not in this register")).toBeNull();
  });

  it("shows Team to a party admin and sends a member to the dashboard", () => {
    renderAt("/portal/team", <PortalTeamPage />, customer);
    expect(screen.getByTestId("where")).toHaveTextContent(/^\/portal$/);
  });
});
