import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

let permissions = [];
let result;
const calls = [];
vi.mock("../../hooks/useQmsApi", () => ({ usePermissions: () => ({ can: (p) => permissions.includes(p) }) }));
vi.mock("../../hooks/useCompetence", () => ({ useCompetenceDashboard: (params) => (calls.push(params), { data: result, isLoading: false, isFetching: false, error: null }) }));
vi.mock("../Breadcrumb", () => ({ default: () => null }));
vi.mock("../dashboard/DashboardPeriod", () => ({ DashboardPeriodPicker: () => <div>Period picker</div> }));
vi.mock("recharts", async (importOriginal) => {
  const mod = await importOriginal();
  const { cloneElement } = await import("react");
  return { ...mod, ResponsiveContainer: ({ children }) => cloneElement(children, { width: 600, height: 300 }) };
});

import CompetenceDashboard from "./CompetenceDashboard";

const dashboard = (over = {}) => ({
  period: { from: "2026-08-12", to: "2026-11-11", bucket: "week" },
  kpis: { people: 20, withRequirements: 15, withGaps: 4, gaps: 7, expired: 2, expiring30: 3, expiring60: 5, expiring90: 6, neverAssessed: 3, sessions: 4, completions: 12, failures: 1 },
  gapsBySkill: [{ skillId: "s1", code: "CMM", name: "CMM operation", people: 3, required: 8 }],
  levels: [0, 1, 2, 3, 4].map((level) => ({ level, label: ["None", "Learning", "Supervised", "Competent", "Can train others"][level], count: level === 3 ? 9 : 1 })),
  training: [{ start: "2026-11-02", completed: 5, failed: 1 }],
  worstGaps: [{ employeeId: "e1", name: "Xavier Xu", gapSkills: 2, totalGap: 3, skills: ["CMM operation", "Visual inspection"] }],
  nextExpiries: [
    { employeeId: "e2", name: "Wes West", skillId: "s2", skill: "Visual inspection", level: 2, expiresOn: "2026-11-10", days: -1 },
    { employeeId: "e3", name: "Yara Yu", skillId: "s1", skill: "CMM operation", level: 3, expiresOn: "2026-12-01", days: 20 },
  ],
  neverAssessedPeople: [{ employeeId: "e4", name: "Zed Zhou", positions: [] }],
  recentTraining: [{ id: "t1", reference: "TS-26-0001", title: "CMM basics", startsOn: "2026-11-01", status: "closed", completed: 2, attendees: 3 }],
  ...over,
});

const open = () =>
  render(
    <MemoryRouter initialEntries={["/Competence"]}>
      <Routes>
        <Route path="/Competence" element={<CompetenceDashboard />} />
        <Route path="/Competence/Mine" element={<div>My competence page</div>} />
      </Routes>
    </MemoryRouter>,
  );

beforeEach(() => {
  permissions = ["competence.read"];
  result = dashboard();
  calls.length = 0;
});

describe("competence dashboard", () => {
  it("shows the headline figures with links to the matrix", () => {
    open();
    expect(screen.getByRole("heading", { name: /Competence dashboard/ })).toBeInTheDocument();
    const gaps = screen.getByRole("link", { name: /People with gaps/ });
    expect(gaps).toHaveAttribute("href", "/Competence/Matrix?status=gap");
    expect(within(gaps).getByText("4")).toBeInTheDocument();
    expect(within(gaps).getByText(/7 skills short · of 15 with requirements/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Expired assessments/ })).toHaveAttribute("href", "/Competence/Matrix?status=expired");
    expect(within(screen.getByRole("link", { name: /Expiring soon/ })).getByText(/within 30 days · 5 in 60 · 6 in 90/)).toBeInTheDocument();
    expect(screen.getByText("of 20 active people")).toBeInTheDocument();
  });

  it("lists who is furthest short, what expires next, who was never assessed and the latest training", () => {
    open();
    const worst = within(screen.getByRole("table", { name: "People furthest short" }));
    expect(worst.getByRole("link", { name: "Xavier Xu" })).toHaveAttribute("href", "/Competence/People/e1");
    expect(worst.getByText("CMM operation, Visual inspection")).toBeInTheDocument();
    const expiring = within(screen.getByRole("table", { name: "Assessments expiring" }));
    expect(expiring.getByText(/1 day ago/)).toBeInTheDocument();
    expect(expiring.getByText(/in 20 days/)).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "People never assessed" })).getByText("No position")).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "Latest training sessions" })).getByRole("link", { name: /TS-26-0001 · CMM basics/ })).toHaveAttribute("href", "/Competence/Training/t1");
  });

  it("says so when there is nothing to list", () => {
    result = dashboard({ gapsBySkill: [], worstGaps: [], nextExpiries: [], neverAssessedPeople: [], recentTraining: [], training: [], levels: [0, 1, 2, 3, 4].map((level) => ({ level, label: "x", count: 0 })) });
    open();
    expect(screen.getByText("No one is short of a required level.")).toBeInTheDocument();
    expect(screen.getByText("Nobody has a gap.")).toBeInTheDocument();
    expect(screen.getByText("Nothing has expired or expires within 90 days.")).toBeInTheDocument();
    expect(screen.getByText("Everyone has been assessed on something.")).toBeInTheDocument();
    expect(screen.getByText("No training results recorded in this period.")).toBeInTheDocument();
  });

  it("sends someone without the right to read competence to their own record, without asking for the figures", () => {
    permissions = [];
    open();
    expect(screen.getByText("My competence page")).toBeInTheDocument();
    expect(calls.every((c) => c.from === undefined)).toBe(true);
  });
});
