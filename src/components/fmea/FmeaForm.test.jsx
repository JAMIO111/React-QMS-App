import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("../../lib/api-client", async (orig) => ({ ...(await orig()), apiFetch: vi.fn() }));
vi.mock("../../contexts/OrganisationProvider", () => ({ useOrganisation: () => ({ organisationId: "org-1" }) }));
vi.mock("../../lib/breadcrumbs", async (orig) => ({ ...(await orig()), useBreadcrumbNames: () => {} }));

import { apiFetch } from "../../lib/api-client";
import { formatDay } from "../../lib/fmea";
import { FORM_COLUMNS, formCsv, formRows, revisedOf } from "../../lib/fmeaForm";
import FmeaFormPage from "./FmeaFormPage";

const done = { id: "a1", kind: "prevention", description: "Change the tool every 50 parts", owner: { name: "Bob Bloggs" }, dueOn: "2026-12-01", status: "done", doneAt: "2026-11-20T10:00:00.000Z", revisedOccurrence: 3, revisedDetection: 8, revisedRpn: 192, revisedPriority: "medium" };
const cancelled = { ...done, id: "a2", description: "Not needed", status: "cancelled", revisedRpn: null };
const net = {
  items: [
    {
      id: "i1", kind: "item", name: "Bracket", operationCode: null, functions: [],
      children: [
        {
          id: "i2", kind: "step", name: "Turning", operationCode: "OP10", children: [],
          functions: [
            {
              id: "f1", text: "Hold the bore", requirement: "Bore 10 H7",
              failureModes: [
                {
                  id: "m1", text: "Bore oversize", specialClass: "critical",
                  effects: [{ level: "end_user", text: "Leaks", severity: 8 }, { level: "own_plant", text: "Scrap", severity: 5 }],
                  causes: [
                    { id: "c1", text: "Tool wear", preventionControls: "Tool life counter", detectionControls: null, occurrence: 8, detection: 8, severityUsed: 8, rpn: 512, priority: "high", needsAttention: true, noActionReason: null, actions: [done, cancelled] },
                    { id: "c2", text: "=SUM(1)", preventionControls: null, detectionControls: "Air gauge", occurrence: 2, detection: 3, severityUsed: 8, rpn: 48, priority: "low", needsAttention: false, noActionReason: "Controlled", actions: [] },
                  ],
                },
                { id: "m2", text: "Burr left", specialClass: null, effects: [], causes: [] },
              ],
            },
          ],
        },
      ],
    },
  ],
  counts: {},
};
const revision = (over = {}) => ({
  id: "r1", fmeaId: "f1", fmea: { number: "FMEA-001", kind: "process", title: "Machining", scopeText: "Turning" }, sequence: 2, letter: "B", status: "effective", effectiveFrom: "2026-11-01",
  team: [{ name: "Ada", role: "lead" }], links: [{ kind: "operation_code", code: "OP10" }], approver: { name: "Quinn" }, changeSummary: "New tool",
  model: { version: 2, method: "rpn", rpnHighFrom: 200, rpnMediumFrom: 100, severityFloor: 9 }, net, ...over,
});

describe("laying the analysis out as a form", () => {
  it("makes one row for each cause, and rows of their own for a failure mode with no cause", () => {
    const rows = formRows(net);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => [r.mode.text, r.cause?.text ?? null])).toEqual([["Bore oversize", "Tool wear"], ["Bore oversize", "=SUM(1)"], ["Burr left", null]]);
    expect(rows[0].path).toEqual(["Bracket", "Turning"]);
    // the function spans all three rows, the first failure mode its two causes
    expect(rows.map((r) => r.fnSpan)).toEqual([3, 0, 0]);
    expect(rows.map((r) => r.modeSpan)).toEqual([2, 0, 1]);
  });

  it("takes the revised figures from the latest finished action that has them", () => {
    expect(revisedOf([done, cancelled])).toEqual({ occurrence: 3, detection: 8, rpn: 192, priority: "medium" });
    expect(revisedOf([cancelled])).toBeNull();
    expect(revisedOf(undefined)).toBeNull();
  });

  it("writes the CSV with what it is first, a header and a row for each cause, keeping a formula-looking cell as text", () => {
    const csv = formCsv(revision(), "2026-11-25T10:00:00.000Z");
    const lines = csv.trimEnd().split("\r\n");
    expect(lines[0]).toBe("Report,FMEA form: FMEA-001 rev B");
    expect(lines).toContain("Generated (UTC),2026-11-25T10:00:00.000Z");
    expect(lines).toContain("Rows,3");
    expect(lines.some((l) => l.startsWith('Rated with,"rating model version 2: RPN, high from 200'))).toBe(true);
    const header = lines.findIndex((l) => l.startsWith("Item / step / element,"));
    expect(header).toBeGreaterThan(0);
    expect(lines).toHaveLength(header + 1 + 3);
    expect(lines[header + 1]).toContain("Bracket › Turning,OP10,Hold the bore,Bore 10 H7,Bore oversize,Critical");
    expect(lines[header + 1]).toContain("The end user: Leaks (S 8); Our own plant: Scrap (S 5)");
    expect(lines[header + 1]).toContain(`Prevention: Change the tool every 50 parts — Bob Bloggs — due ${formatDay("2026-12-01")} — Done ${formatDay("2026-11-20")}`);
    expect(lines[header + 1]).not.toContain("Not needed");
    expect(lines[header + 2]).toContain(",'=SUM(1),");
    expect(FORM_COLUMNS.map((c) => c.label)).toContain("Revised RPN");
  });
});

const renderIt = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={["/FMEA/f1/revisions/r1/report"]}>
        <Routes>
          <Route path="/FMEA/:id/revisions/:revisionId/report" element={<FmeaFormPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );

describe("the form page", () => {
  beforeEach(() => {
    apiFetch.mockReset();
    apiFetch.mockImplementation(async () => revision());
  });

  it("shows the facts and the analysis as a table, with the repeated cells merged over their causes", async () => {
    renderIt();
    const table = await screen.findByRole("table", { name: "FMEA analysis" });
    expect(screen.getByRole("heading", { name: /FMEA-001 rev B · Machining/ })).toBeInTheDocument();
    expect(screen.getByText("Approver")).toBeInTheDocument();
    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(1 + 3);
    const bore = within(table).getByText("Bore oversize");
    expect(bore.closest("td")).toHaveAttribute("rowspan", "2");
    expect(within(table).getByText("Hold the bore").closest("td")).toHaveAttribute("rowspan", "3");
    expect(within(table).getByText(/The end user: Leaks \(S 8\)/)).toBeInTheDocument();
    expect(within(table).getByText("High")).toBeInTheDocument();
    expect(within(table).getByText("192 (O 3, D 8)")).toBeInTheDocument();
    expect(screen.queryByText(/not for use/i)).not.toBeInTheDocument();
  });

  it("says a draft is not in force, and offers the CSV", async () => {
    apiFetch.mockImplementation(async () => revision({ status: "draft", letter: null, effectiveFrom: null }));
    const create = vi.fn(() => "blob:x");
    URL.createObjectURL = create;
    URL.revokeObjectURL = vi.fn();
    renderIt();
    expect(await screen.findByText("Draft: not in force, not for use")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Export CSV/ }));
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("says so when nothing has been analysed", async () => {
    apiFetch.mockImplementation(async () => revision({ net: { items: [], counts: {} } }));
    renderIt();
    expect(await screen.findByText("Nothing has been analysed yet.")).toBeInTheDocument();
  });
});
