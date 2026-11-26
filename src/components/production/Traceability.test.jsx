import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

let permissions;
let orgSettings = {};
const apiFetch = vi.fn();
vi.mock("../../lib/api-client", async (importOriginal) => ({ ...(await importOriginal()), apiFetch: (...a) => apiFetch(...a) }));
vi.mock("../../contexts/OrganisationProvider", () => ({ useOrganisation: () => ({ organisationId: "org-1" }) }));
vi.mock("../../hooks/useQmsApi", () => ({
  usePermissions: () => ({ can: (p) => permissions.includes(p) }),
  useOrganisationDetails: () => ({ data: { settings: orgSettings } }),
}));

import TraceabilityPage from "./TraceabilityPage";
import TraceLinks from "./TraceLinks";

const rod = { id: "p1", partNumber: "ROD-100", name: "Rod" };
const trace = (over = {}) => ({
  subject: { type: "order", id: "o1", number: "WO-154789", status: "in_progress", part: rod, partRevision: "A v2", customer: { id: "c1", name: "Acme" }, supplier: null, site: { id: "s1", name: "Main site" }, quantity: 24 },
  order: { id: "o1", orderNumber: "WO-154789", status: "in_progress", quantityPlanned: 24, dueDate: "2026-12-01", operations: [{ id: "op1", sequence: 10, code: "OP-10", description: "Turning", status: "completed", machine: { id: "m1", code: "CNC-1", name: "Lathe" } }] },
  lots: { total: 0, data: [] },
  serials: { total: 0, data: [] },
  inspections: { available: true, total: 2, passed: 1, failed: 1, inProgress: 0, data: [
    { id: "i1", reference: "IPI-26-0001", status: "completed", result: "pass", operationCode: "OP-10", startedAt: "2026-11-02T09:00:00Z", failures: 0, machine: { id: "m1", code: "CNC-1", name: "Lathe" }, lot: null, serial: null },
    { id: "i2", reference: "IPI-26-0002", status: "completed", result: "fail", operationCode: "OP-10", startedAt: "2026-11-02T11:00:00Z", failures: 2, machine: null, lot: "LOT-1", serial: null },
  ] },
  ncrs: { available: true, total: 1, data: [{ id: "n1", reference: "NCM-26-001", title: "Bore oversize", stage: "dispositioned", source: "internal", severity: "minor", quantityAffected: 3, matchedVia: "linked", containment: { open: 0, done: 1 }, dispositions: { proposed: 0, approved: 1, approvedQuantity: 3 }, capas: [{ id: "c1", reference: "CAPA-000001", stage: "open", title: "Bore" }] }] },
  equipment: { machines: [{ id: "m1", code: "CNC-1", name: "Lathe", inspections: 1, operations: 1 }], gauges: [{ id: "g1", assetNumber: "MIC-7", readings: 4, outOfCalibration: 1, lastUsed: "2026-11-02T10:00:00Z" }] },
  ...over,
});

const Where = () => {
  const l = useLocation();
  return <p data-testid="where">{l.pathname + l.search}</p>;
};
const renderAt = (url) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="/Production/Traceability" element={<><TraceabilityPage /><Where /></>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );

let result;
let searchResult;
beforeEach(() => {
  permissions = ["production.read", "calibration.read"];
  orgSettings = {};
  result = trace();
  searchResult = [];
  apiFetch.mockReset();
  apiFetch.mockImplementation(async (path) => {
    const p = path.split("?")[0];
    if (p === "/traceability") return result;
    if (p === "/traceability/search") return { data: searchResult };
    throw new Error(`unexpected ${path}`);
  });
});

describe("traceability page", () => {
  it("asks for a number when nothing is chosen, and loads nothing", async () => {
    renderAt("/Production/Traceability");
    expect(screen.getByText(/Search for a number above/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Print or save as PDF/ })).toBeNull();
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("shows an order alone as the whole story: operations, inspections, NCs with their containment, dispositions and 8D, and the equipment", async () => {
    orgSettings = { useLotsAndSerials: false };
    renderAt("/Production/Traceability?type=order&id=o1");
    expect(await screen.findByRole("heading", { name: "WO-154789" })).toBeInTheDocument();
    expect(apiFetch.mock.calls[0][0]).toBe("/traceability?type=order&id=o1");
    const ops = screen.getByRole("table", { name: "Operations" });
    expect(within(ops).getByText("OP-10")).toBeInTheDocument();
    expect(within(ops).getByText("CNC-1 · Lathe")).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "Lots" })).toBeNull();
    expect(screen.queryByText(/The order stands for everything made on it/)).toBeNull();
    expect(screen.queryByText("Serial numbers")).toBeNull();
    expect(screen.getByText("2 inspections: 1 passed, 1 failed, 0 in progress.")).toBeInTheDocument();
    const insp = screen.getByRole("table", { name: "Inspections" });
    expect(within(insp).getByRole("link", { name: "IPI-26-0002" })).toHaveAttribute("href", "/Inspections/i2");
    const ncs = screen.getByRole("table", { name: "Non-conformances" });
    expect(within(ncs).getByRole("link", { name: "NCM-26-001" })).toHaveAttribute("href", "/Non-Conformance/Register/n1");
    expect(within(ncs).getByText("1 done, 0 open")).toBeInTheDocument();
    expect(within(ncs).getByText("1 approved (3)")).toBeInTheDocument();
    expect(within(ncs).getByRole("link", { name: "CAPA-000001" })).toHaveAttribute("href", "/CAPA/c1/D0");
    expect(within(screen.getByRole("list", { name: "Machines" })).getByText(/1 operation, 1 inspection/)).toBeInTheDocument();
    const gauges = screen.getByRole("list", { name: "Gauges" });
    expect(within(gauges).getByRole("link", { name: "MIC-7" })).toHaveAttribute("href", "/Calibration/Gauges/g1");
    expect(within(gauges).getByText("1 when out of calibration")).toBeInTheDocument();
  });

  it("shows lots and serial numbers with links to trace them, and says when an NC only names an affected lot", async () => {
    result = trace({
      lots: { total: 1, data: [{ id: "l1", lotNumber: "LOT-1", status: "on_hold", statusReason: "Suspect material", origin: "produced", quantity: 24, supplier: null }] },
      serials: { total: 2, data: [{ id: "s1", serialNumber: "SN-0001", status: "completed", lot: { id: "l1", lotNumber: "LOT-1" } }, { id: "s2", serialNumber: "SN-0002", status: "scrapped", lot: { id: "l1", lotNumber: "LOT-1" } }] },
      ncrs: { available: true, total: 1, data: [{ ...trace().ncrs.data[0], matchedVia: "affected_lot", capas: [] }] },
    });
    renderAt("/Production/Traceability?type=order&id=o1");
    const lots = await screen.findByRole("table", { name: "Lots" });
    expect(within(lots).getByRole("link", { name: "LOT-1" })).toHaveAttribute("href", "/Production/Traceability?type=lot&id=l1");
    expect(within(lots).getByText("Suspect material")).toBeInTheDocument();
    const serials = screen.getByRole("list", { name: "Serial numbers" });
    expect(within(serials).getByRole("link", { name: "SN-0001" })).toHaveAttribute("href", "/Production/Traceability?type=serial&id=s1");
    expect(within(serials).getByText(/scrapped/)).toBeInTheDocument();
    expect(screen.getByText("Names an affected lot")).toBeInTheDocument();
  });

  it("says an order with no lots stands for everything made on it, while lots are in use", async () => {
    renderAt("/Production/Traceability?type=order&id=o1");
    expect(await screen.findByText(/No lots\. The order stands for everything made on it/)).toBeInTheDocument();
  });

  it("writes 0, not a dash, when nothing was inspected or found", async () => {
    result = trace({ inspections: { available: true, total: 0, passed: 0, failed: 0, inProgress: 0, data: [] }, ncrs: { available: true, total: 0, data: [] } });
    renderAt("/Production/Traceability?type=order&id=o1");
    await screen.findByRole("heading", { name: "WO-154789" });
    expect(screen.getByText("Inspections", { selector: "dt" }).nextSibling).toHaveTextContent(/^0$/);
    expect(screen.getByText("Non-conformances", { selector: "dt" }).nextSibling).toHaveTextContent(/^0$/);
  });

  it("says a section cannot be read, rather than that it is empty", async () => {
    result = trace({ inspections: { available: false, total: 0, passed: 0, failed: 0, inProgress: 0, data: [] }, ncrs: { available: false, total: 0, data: [] } });
    renderAt("/Production/Traceability?type=order&id=o1");
    await screen.findByRole("heading", { name: "WO-154789" });
    expect(screen.getAllByText(/You do not have access to (inspections|non-conformances)/)).toHaveLength(2);
    expect(screen.queryByText(/No non-conformances are recorded/)).toBeNull();
    expect(screen.queryByRole("table", { name: "Inspections" })).toBeNull();
  });

  it("says when a long list is cut off", async () => {
    result = trace({ inspections: { ...trace().inspections, total: 140 } });
    renderAt("/Production/Traceability?type=order&id=o1");
    expect(await screen.findByText("Showing the latest 2 of 140 inspections.")).toBeInTheDocument();
  });

  it("does not link gauges to people who may not read calibration", async () => {
    permissions = ["production.read"];
    renderAt("/Production/Traceability?type=order&id=o1");
    const gauges = await screen.findByRole("list", { name: "Gauges" });
    expect(within(gauges).queryByRole("link")).toBeNull();
    expect(within(gauges).getByText("MIC-7")).toBeInTheDocument();
  });

  it("shows the changes that cover the order, with their cut-in point and which side of it this record is on", async () => {
    result = trace({
      changes: {
        available: true,
        data: [
          { id: "ch1", reference: "ECR-26-0001", title: "Move rod to CNC 7", stage: "implementing", cutIn: { kind: "order", label: "WO-154700", date: null, stockAction: null }, position: "after" },
          { id: "ch2", reference: "ECR-26-0002", title: "New drawing", stage: "closed", cutIn: { kind: "date", label: null, date: "2026-12-01", stockAction: null }, position: null },
        ],
      },
    });
    renderAt("/Production/Traceability?type=order&id=o1");
    const table = await screen.findByRole("table", { name: "Changes" });
    expect(within(table).getByRole("link", { name: "ECR-26-0001" })).toHaveAttribute("href", "/Change/ch1");
    expect(within(table).getByText("From production order WO-154700")).toBeInTheDocument();
    expect(within(table).getByText("Made after the cut-in point")).toBeInTheDocument();
    expect(within(table).getByText(/From 1 Dec 2026|From .*2026/)).toBeInTheDocument();
    expect(within(table).getByText("Not decided by a fixed point")).toBeInTheDocument();
  });

  it("leaves the Changes section out when the reader may not read changes", async () => {
    result = trace({ changes: { available: false, data: [] } });
    renderAt("/Production/Traceability?type=order&id=o1");
    await screen.findByRole("heading", { name: "WO-154789" });
    expect(screen.queryByRole("table", { name: "Changes" })).toBeNull();
  });

  it("shows the FMEAs that cover the part with the revision in force then and now, and says when the analysis has moved on", async () => {
    result = trace({
      fmeas: {
        available: true,
        data: [
          { id: "f1", number: "FMEA-001", title: "Turning the rod", kind: "process", then: { id: "r1", letter: "A", effectiveFrom: "2026-06-01" }, now: { id: "r2", letter: "B", effectiveFrom: "2026-10-01" }, changedSince: true },
          { id: "f2", number: "FMEA-002", title: "Rod design", kind: "design", then: null, now: { id: "r3", letter: "A", effectiveFrom: "2026-11-01" }, changedSince: true },
          { id: "f3", number: "FMEA-003", title: "Old process", kind: "process", then: { id: "r4", letter: "A", effectiveFrom: "2026-01-01" }, now: null, changedSince: true },
        ],
      },
    });
    renderAt("/Production/Traceability?type=order&id=o1");
    const table = await screen.findByRole("table", { name: "FMEAs" });
    expect(within(table).getByRole("link", { name: "FMEA-001" })).toHaveAttribute("href", "/FMEA/f1");
    const rows = within(table).getAllByRole("row");
    expect(within(rows[1]).getByRole("link", { name: /Rev A/ })).toHaveAttribute("href", "/FMEA/f1/revisions/r1");
    expect(within(rows[1]).getByRole("link", { name: /Rev B/ })).toHaveAttribute("href", "/FMEA/f1/revisions/r2");
    expect(within(rows[1]).getByText("The analysis has changed since")).toBeInTheDocument();
    expect(within(rows[2]).getByText("None yet")).toBeInTheDocument();
    expect(within(rows[3]).getByText("Not in force")).toBeInTheDocument();
    expect(within(table).getAllByText("The analysis has changed since")).toHaveLength(1);
  });

  it("says no FMEA covers the part, and leaves the section out when the reader may not read FMEAs", async () => {
    result = trace({ fmeas: { available: true, data: [] } });
    const first = renderAt("/Production/Traceability?type=order&id=o1");
    expect(await screen.findByText("No FMEA covers this part.")).toBeInTheDocument();
    first.unmount();
    result = trace({ fmeas: { available: false, data: [] } });
    renderAt("/Production/Traceability?type=order&id=o1");
    await screen.findByRole("heading", { name: "WO-154789" });
    expect(screen.queryByRole("table", { name: "FMEAs" })).toBeNull();
  });

  it("shows each part approval with where it stood when the record was created and where it stands now", async () => {
    result = trace({
      ppaps: {
        available: true,
        data: [
          { id: "p1", reference: "PPAP-26-0001", direction: "submitted", party: "Wayne Ltd", level: 3, revision: "A", status: "approved", sentOn: "2026-05-01", then: "approved", thenOn: "2026-05-20", thenExpiresOn: null, interimExpiresOn: null },
          { id: "p2", reference: "PPAP-26-0002", direction: "submitted", party: "Stark Ltd", level: 1, revision: "A", status: "interim_approved", sentOn: "2026-06-01", then: "interim_lapsed", thenOn: "2026-06-10", thenExpiresOn: "2026-06-30", interimExpiresOn: "2026-12-31" },
          { id: "p3", reference: "PPAP-26-0003", direction: "received", party: "Acme Castings", level: 3, revision: "B", status: "submitted", sentOn: "2026-11-01", then: "not_sent", thenOn: null, thenExpiresOn: null, interimExpiresOn: null },
        ],
      },
    });
    renderAt("/Production/Traceability?type=order&id=o1");
    const table = await screen.findByRole("table", { name: "Part approvals" });
    expect(within(table).getByRole("link", { name: "PPAP-26-0001" })).toHaveAttribute("href", "/PPAP/p1");
    const rows = within(table).getAllByRole("row");
    // approved when this was created, and approved now
    expect(within(rows[1]).getAllByText("Approved", { selector: "span" })).toHaveLength(2);
    expect(within(rows[2]).getByText("Interim approval had run out")).toBeInTheDocument();
    expect(within(rows[2]).getByText("Interim approval")).toBeInTheDocument();
    expect(within(rows[3]).getByText("Not sent yet")).toBeInTheDocument();
    expect(within(rows[3]).getByText("Acme Castings (supplier)")).toBeInTheDocument();
  });

  it("says no part approval has been sent, and leaves the section out when the reader may not read them", async () => {
    result = trace({ ppaps: { available: true, data: [] } });
    const first = renderAt("/Production/Traceability?type=order&id=o1");
    expect(await screen.findByText("No part approval has been sent or received for this part.")).toBeInTheDocument();
    first.unmount();
    result = trace({ ppaps: { available: false, data: [] } });
    renderAt("/Production/Traceability?type=order&id=o1");
    await screen.findByRole("heading", { name: "WO-154789" });
    expect(screen.queryByRole("table", { name: "Part approvals" })).toBeNull();
  });

  it("finds a number and opens its report", async () => {
    searchResult = [{ type: "lot", id: "l1", number: "LOT-1", status: "open", part: rod }];
    renderAt("/Production/Traceability");
    await userEvent.type(screen.getByLabelText("Find an order, lot or serial number"), "lot-1");
    const matches = await screen.findByRole("list", { name: "Matches" }, { timeout: 2000 });
    await userEvent.click(within(matches).getByRole("button", { name: /LOT-1/ }));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/Production/Traceability?type=lot&id=l1"));
    expect(apiFetch.mock.calls.some(([p]) => p === "/traceability?type=lot&id=l1")).toBe(true);
  });

  it("says when nothing has a number like the text", async () => {
    renderAt("/Production/Traceability");
    await userEvent.type(screen.getByLabelText("Find an order, lot or serial number"), "zzz");
    expect(await screen.findByText(/Nothing has a number like “zzz”/, {}, { timeout: 2000 })).toBeInTheDocument();
  });

  it("offers printing only once there is a report", async () => {
    renderAt("/Production/Traceability?type=order&id=o1");
    expect(await screen.findByRole("button", { name: /Print or save as PDF/ })).toBeInTheDocument();
  });

  it("refuses to guess at an unknown type", async () => {
    renderAt("/Production/Traceability?type=gauge&id=g1");
    expect(screen.getByText(/Search for a number above/)).toBeInTheDocument();
    expect(apiFetch).not.toHaveBeenCalled();
  });
});

describe("trace links", () => {
  it("link to the order, lot and serial number a record is linked to, and to nothing when it has none", () => {
    const { unmount } = render(
      <MemoryRouter>
        <TraceLinks links={{ productionOrder: { id: "o1", orderNumber: "WO-1" }, lot: { id: "l1", lotNumber: "LOT-1" }, serial: null }} />
      </MemoryRouter>
    );
    expect(screen.getByRole("link", { name: "order WO-1" })).toHaveAttribute("href", "/Production/Traceability?type=order&id=o1");
    expect(screen.getByRole("link", { name: "lot LOT-1" })).toHaveAttribute("href", "/Production/Traceability?type=lot&id=l1");
    expect(screen.queryByRole("link", { name: /serial/ })).toBeNull();
    unmount();
    const { container } = render(<MemoryRouter><TraceLinks links={{ productionOrder: null, lot: null, serial: null }} /></MemoryRouter>);
    expect(container).toBeEmptyDOMElement();
  });
});
