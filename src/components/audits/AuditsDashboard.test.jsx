import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { format, subDays, subMonths } from "date-fns";

const apiFetch = vi.fn();
vi.mock("../../lib/api-client", async (importOriginal) => ({ ...(await importOriginal()), apiFetch: (...a) => apiFetch(...a) }));
vi.mock("../../contexts/OrganisationProvider", () => ({ useOrganisation: () => ({ organisationId: "org-1" }) }));
// Charts measure their container; jsdom has no layout, so give them a size.
vi.mock("recharts", async (importOriginal) => {
  const mod = await importOriginal();
  const { cloneElement } = await import("react");
  return { ...mod, ResponsiveContainer: ({ children }) => cloneElement(children, { width: 600, height: 300 }) };
});

import AuditsDashboard from "./AuditsDashboard";

const dashboard = (over = {}) => ({
  period: { from: "2026-08-10", to: "2026-11-08", previousFrom: "2026-05-12", previousTo: "2026-08-09", bucket: "week" },
  kpis: {
    planned: 12, done: 8, doneOnTime: 6, missed: 2, overdue: 1, completionRate: 72.7, onTimeRate: 60,
    completed: 10, completedPrevious: 8, passRate: 70, passRatePrevious: 75, averageScore: 88.4,
    openFindings: 5, overdueFindings: 2, findingsRaised: 6, findingsRaisedPrevious: 4, nonconformances: 3, versionsSaved: 2,
  },
  planned: [{ start: "2026-10-26", done: 2, late: 1, missed: 0, overdue: 0, upcoming: 0 }, { start: "2026-11-02", done: 1, late: 0, missed: 1, overdue: 1, upcoming: 0 }],
  results: [{ start: "2026-10-26", pass: 2, fail: 1 }, { start: "2026-11-02", pass: 1, fail: 0 }],
  findingsByClassification: [
    { key: "major_nc", label: "Major non-conformity", kind: "nonconformity", count: 2 }, { key: "minor_nc", label: "Minor non-conformity", kind: "nonconformity", count: 3 },
    { key: "observation", label: "Observation", kind: "observation", count: 1 }, { key: "ofi", label: "Opportunity for improvement", kind: "opportunity", count: 0 },
  ],
  findingsByStatus: [{ key: "open", label: "Open", count: 4 }, { key: "closed", label: "Closed", count: 2 }, { key: "withdrawn", label: "Withdrawn", count: 0 }],
  failedQuestions: [{ auditId: "a1", auditReference: "AUD-001", auditTitle: "Cell audit", question: "Guard fitted?", failed: 3, answered: 10, failRate: 30 }],
  coverage: {
    listed: 5, never: 1, stale: 1, staleAfterDays: 90,
    items: [
      { kind: "department", label: "MACH · Machining", audits: ["AUD-001"], lastAuditedOn: null, daysSince: null },
      { kind: "operation", label: "OP-99", audits: ["AUD-002"], lastAuditedOn: "2026-06-01", daysSince: 160 },
      { kind: "machine", label: "CNC-1 · Lathe", audits: ["AUD-001", "AUD-003"], lastAuditedOn: "2026-11-07", daysSince: 1 },
    ],
  },
  slotsNeedingAttention: [{ auditId: "a1", auditReference: "AUD-001", auditTitle: "Cell audit", dueOn: "2026-11-07", state: "overdue" }, { auditId: "a1", auditReference: "AUD-001", auditTitle: "Cell audit", dueOn: "2026-10-20", state: "missed" }],
  overdueFindings: [{ id: "f1", reference: "AF-26-0001", title: "Guard missing", classification: "Major non-conformity", dueOn: "2026-11-01", daysOverdue: 7, owner: "Grace Hopper" }],
  failedRecords: [{ id: "r1", reference: "AR-26-0002", auditReference: "AUD-001", auditTitle: "Cell audit", performedOn: "2026-11-02", score: 50, criticalFailed: 1 }],
  recentVersions: [{ auditId: "a2", auditReference: "AUD-002", auditTitle: "Grinding audit", version: 3, reason: "Added a purpose", at: "2026-11-05T10:00:00Z", by: "Ada Owner" }],
  ...over,
});

const Where = () => {
  const l = useLocation();
  return <p data-testid="where">{l.pathname + l.search}</p>;
};
const renderAt = (url = "/Audits") =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="/Audits" element={<><AuditsDashboard /><Where /></>} />
          <Route path="/Audits/*" element={<Where />} />
        </Routes>
        <div id="modal-root" />
      </MemoryRouter>
    </QueryClientProvider>
  );

beforeEach(() => {
  apiFetch.mockReset();
  apiFetch.mockResolvedValue(dashboard());
});

describe("audits dashboard", () => {
  it("asks for the last 90 days by default and says what is as of today", async () => {
    renderAt();
    expect(await screen.findByRole("heading", { name: "Audits dashboard" })).toBeInTheDocument();
    const today = new Date();
    expect(apiFetch.mock.calls[0][0]).toBe(`/audits-dashboard?from=${format(subDays(today, 89), "yyyy-MM-dd")}&to=${format(today, "yyyy-MM-dd")}`);
    expect(screen.getByText(/findings and coverage as of today/)).toBeInTheDocument();
  });

  it("shows the figures: done as planned, what is late, completed with the pass rate and its change, findings, and template changes", async () => {
    renderAt();
    const planned = await screen.findByRole("link", { name: /Done as planned/ });
    expect(planned).toHaveTextContent("8 of 12");
    expect(planned).toHaveTextContent("60% on time");
    expect(screen.getByRole("link", { name: /Overdue or missed/ })).toHaveTextContent("3");
    expect(screen.getByRole("link", { name: /Overdue or missed/ })).toHaveTextContent("1 overdue · 2 missed");
    const completed = screen.getByRole("link", { name: /Audits completed/ });
    expect(completed).toHaveTextContent("10");
    expect(completed).toHaveTextContent("Up 25% on previous period");
    expect(completed).toHaveTextContent("70% passed · average score 88.4%");
    expect(screen.getByRole("link", { name: /Open findings/ })).toHaveTextContent("2 overdue");
    const raised = screen.getByRole("link", { name: /Findings raised/ });
    expect(raised).toHaveTextContent("6");
    expect(raised).toHaveTextContent("3 became a non-conformance");
    expect(screen.getByText("Template changes").closest("div").parentElement).toHaveTextContent("2");
  });

  it("links the figures to the registers they come from", async () => {
    renderAt();
    await userEvent.click(await screen.findByRole("link", { name: /Open findings/ }));
    expect(screen.getByTestId("where")).toHaveTextContent("/Audits/Findings?status=open");
  });

  it("links an overdue count to the schedule filtered to overdue", async () => {
    renderAt();
    await userEvent.click(await screen.findByRole("link", { name: /Overdue or missed/ }));
    expect(screen.getByTestId("where")).toHaveTextContent("/Audits/Schedule?state=overdue");
  });

  it("says when nothing has been decided, and when nothing was completed", async () => {
    apiFetch.mockResolvedValue(dashboard({ kpis: { ...dashboard().kpis, planned: 0, done: 0, onTimeRate: null, completed: 0, completedPrevious: 0, passRate: null, averageScore: null, overdue: 0, missed: 0 } }));
    renderAt();
    expect(await screen.findByRole("link", { name: /Done as planned/ })).toHaveTextContent("Nothing decided yet");
    expect(screen.getByRole("link", { name: /Audits completed/ })).toHaveTextContent("None in the period");
  });

  it("changes the period and keeps it in the URL", async () => {
    renderAt();
    await screen.findByRole("link", { name: /Done as planned/ });
    await userEvent.click(screen.getByRole("button", { name: /^Period/ }));
    await userEvent.click(within(screen.getByRole("dialog", { name: "Choose period" })).getByRole("button", { name: /^Last 12 months/ }));
    const today = new Date();
    await waitFor(() => expect(apiFetch.mock.calls.at(-1)[0]).toContain(`from=${format(subDays(subMonths(today, 12), -1), "yyyy-MM-dd")}`));
    expect(screen.getByTestId("where")).toHaveTextContent("/Audits?period=12m");
  });

  it("starts from the period in the URL", async () => {
    renderAt("/Audits?period=30d");
    await screen.findByRole("link", { name: /Done as planned/ });
    expect(apiFetch.mock.calls[0][0]).toContain(`from=${format(subDays(new Date(), 29), "yyyy-MM-dd")}`);
  });

  it("lists the questions that fail most, with how often, and the audit they are in", async () => {
    renderAt();
    const table = await screen.findByRole("table", { name: "Questions that fail most often" });
    const row = within(table).getByText("Guard fitted?").closest("tr");
    expect(row).toHaveTextContent("3 of 10 (30%)");
    expect(within(row).getByRole("link", { name: "AUD-001" })).toHaveAttribute("href", "/Audits/Templates/a1");
  });

  it("shows coverage: what was never audited and what has not been for a long time are marked", async () => {
    renderAt();
    const table = await screen.findByRole("table", { name: "Coverage" });
    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(4);
    expect(rows[1]).toHaveTextContent("MACH · Machining");
    expect(within(rows[1]).getByText("Never")).toBeInTheDocument();
    expect(rows[2]).toHaveTextContent("160 days ago");
    expect(rows[3]).toHaveTextContent("1 day ago");
    expect(rows[3]).toHaveTextContent("AUD-001, AUD-003");
    expect(screen.getByText(/5 machines, operations, departments and suppliers named by active audits · 1 never audited · 1 not audited for over 90 days/)).toBeInTheDocument();
    expect(screen.getByText("The 3 longest without an audit are shown.")).toBeInTheDocument();
  });

  it("does not say some were left out when every one is shown, and shows how the period's findings stand", async () => {
    apiFetch.mockResolvedValue(dashboard({ coverage: { ...dashboard().coverage, listed: 3 } }));
    renderAt();
    await screen.findByRole("table", { name: "Coverage" });
    expect(screen.queryByText(/longest without an audit are shown/)).toBeNull();
    expect(screen.getByText("Open 4 · Closed 2 · Withdrawn 0")).toBeInTheDocument();
  });

  it("lists what needs attention: overdue and missed audits, findings past due, failed audits and template changes, each with a link", async () => {
    renderAt();
    const slots = await screen.findByRole("list", { name: "Audits that need doing" });
    expect(within(slots).getAllByRole("listitem")).toHaveLength(2);
    expect(slots).toHaveTextContent("Overdue, due 07 Nov 2026");
    expect(slots).toHaveTextContent("Missed, due 20 Oct 2026");
    const findings = screen.getByRole("list", { name: "Findings past their due date" });
    expect(within(findings).getByRole("link", { name: "AF-26-0001" })).toHaveAttribute("href", "/Audits/Findings/f1");
    expect(findings).toHaveTextContent("7 days late");
    expect(findings).toHaveTextContent("Grace Hopper");
    const failed = screen.getByRole("list", { name: "Latest failed audits" });
    expect(within(failed).getByRole("link", { name: "AR-26-0002" })).toHaveAttribute("href", "/Audits/Records/r1");
    expect(failed).toHaveTextContent("50% · 1 critical");
    const versions = screen.getByRole("list", { name: "Recent changes to audits" });
    expect(versions).toHaveTextContent("AUD-002 · Grinding audit · version 3");
    expect(versions).toHaveTextContent("Added a purpose");
    expect(versions).toHaveTextContent("Ada Owner");
  });

  it("says so when there is nothing to list", async () => {
    apiFetch.mockResolvedValue(
      dashboard({
        planned: [], results: [], failedQuestions: [], slotsNeedingAttention: [], overdueFindings: [], failedRecords: [], recentVersions: [],
        findingsByClassification: [{ key: "major_nc", label: "Major non-conformity", kind: "nonconformity", count: 0 }],
        coverage: { listed: 0, never: 0, stale: 0, staleAfterDays: 90, items: [] },
      }),
    );
    renderAt();
    expect(await screen.findByText("Nothing is overdue or missed.")).toBeInTheDocument();
    expect(screen.getByText("No open finding is past its due date.")).toBeInTheDocument();
    expect(screen.getByText("No audit failed in this period.")).toBeInTheDocument();
    expect(screen.getByText("No question failed in this period.")).toBeInTheDocument();
    expect(screen.getByText("No findings were raised in this period.")).toBeInTheDocument();
    expect(screen.getByText("No active audit names a machine, operation, department or supplier.")).toBeInTheDocument();
    expect(screen.getByText("No audit was changed in this period.")).toBeInTheDocument();
  });

  it("explains a failed load", async () => {
    const { ApiClientError } = await import("../../lib/api-client");
    apiFetch.mockRejectedValue(new ApiClientError({ status: 403, code: "forbidden", message: "You do not have permission" }));
    renderAt();
    expect(await screen.findByRole("alert")).toHaveTextContent("permission");
  });
});
