import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";

let permissions = [];
const mutate = vi.fn();
const skillCmm = { id: "s1", code: "CMM", name: "CMM operation", active: true, refreshMonths: 12, category: { id: "c1", label: "Inspection" } };
const skillVis = { id: "s2", code: "VIS", name: "Visual inspection", active: true, refreshMonths: null, category: { id: "c1", label: "Inspection" } };
const profile = {
  employee: { id: "e1", name: "Xavier Xu", employeeNumber: "E-1", jobTitle: "Inspector", department: { id: "d1", name: "Quality" }, site: null },
  positions: [
    { id: "h1", position: { id: "p1", code: "INSP", name: "Inspector", active: true }, startedOn: "2026-08-01", endedOn: null },
    { id: "h0", position: { id: "p2", code: "SET", name: "Setter", active: true }, startedOn: "2025-01-01", endedOn: "2025-12-31" },
  ],
  skills: [
    { skill: skillCmm, level: 2, required: 3, requiredBy: [], gap: 1, status: "gap", expiry: "valid", assessedOn: "2026-10-01", expiresOn: "2027-10-01", assessor: "Ann Assessor", note: null,
      history: [{ id: "a2", level: 2, assessedOn: "2026-10-01", expiresOn: "2027-10-01", assessor: "Ann Assessor", note: "Supervised run", current: true }, { id: "a1", level: 1, assessedOn: "2026-06-01", expiresOn: null, assessor: null, note: null, current: false }] },
    { skill: skillVis, level: null, required: 2, requiredBy: [], gap: 2, status: "not_assessed", expiry: "none", assessedOn: null, expiresOn: null, assessor: null, note: null, history: [] },
  ],
  summary: { required: 2, gaps: 2, expired: 0, expiring: 0, ok: 0 },
  training: [{ id: "t1", sessionId: "ts1", reference: "TS-26-0001", title: "CMM basics", kind: "course", startsOn: "2026-10-01", sessionStatus: "closed", status: "completed", completedOn: "2026-10-03", note: null }],
};
const matrix = {
  skills: [skillCmm, skillVis],
  skillsTruncated: false,
  employeesTruncated: false,
  data: [{ employee: profile.employee, positions: [{ id: "p1", name: "Inspector" }], cells: {
    s1: { level: 2, required: 3, gap: 1, status: "gap", expiry: "valid", expiresOn: "2027-10-01", assessedOn: "2026-10-01" },
    s2: { level: null, required: 2, gap: 2, status: "not_assessed", expiry: "none", expiresOn: null, assessedOn: null },
  } }],
  page: 1, pageSize: 25, total: 1, today: "2026-11-11",
};
let mine = { linked: true, ...profile };
const matrixCalls = [];
const exportMatrix = vi.fn();
const downloadReport = vi.fn();

vi.mock("../../lib/reportCsv", () => ({ downloadReport: (...a) => downloadReport(...a) }));
vi.mock("../../hooks/useQmsApi", () => ({ usePermissions: () => ({ can: (p) => permissions.includes(p) }) }));
vi.mock("../../contexts/ToastProvider", () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock("../../hooks/useCompetence", () => ({
  useCompetenceSkills: () => ({ data: { data: [skillCmm, skillVis] }, isLoading: false }),
  useCompetencePositions: () => ({ data: { data: [{ id: "p1", name: "Inspector", code: "INSP" }, { id: "p3", name: "Auditor", code: "AUD" }] }, isLoading: false }),
  useCompetenceCategories: () => ({ data: { data: [{ id: "c1", label: "Inspection" }] }, isLoading: false }),
  useMatrixExport: () => exportMatrix,
  useCompetenceMatrix: (params) => (matrixCalls.push(params), { data: matrix, isLoading: false }),
  useCompetencePerson: () => ({ data: profile, isLoading: false }),
  useMyCompetence: () => ({ data: mine, isLoading: false }),
  useCompetenceMutation: () => ({ mutate, isPending: false, error: null }),
}));

import MatrixPage from "./MatrixPage";
import PersonPage from "./PersonPage";
import MyCompetencePage from "./MyCompetencePage";

beforeEach(() => {
  mutate.mockReset();
  matrixCalls.length = 0;
  exportMatrix.mockReset();
  downloadReport.mockReset();
  permissions = ["competence.read", "competence.manage", "competence.assess"];
  mine = { linked: true, ...profile };
});

describe("skills matrix", () => {
  it("shows people by skills with each cell's level and its words", () => {
    render(<MemoryRouter><MatrixPage /></MemoryRouter>);
    const grid = screen.getByRole("table", { name: "Skills matrix" });
    expect(within(grid).getByRole("link", { name: "Xavier Xu" })).toHaveAttribute("href", "/Competence/People/e1");
    expect(within(grid).getByLabelText("Xavier Xu, CMM operation: Supervised (2) · needs 3 · expires 2027-10-01")).toHaveTextContent("2");
    expect(within(grid).getByLabelText(/Visual inspection: Not assessed · needs 2/)).toHaveTextContent("–");
    expect(screen.getByText("1 person")).toBeInTheDocument();
  });

  it("asks the server for the chosen status", async () => {
    render(<MemoryRouter><MatrixPage /></MemoryRouter>);
    await userEvent.click(screen.getByRole("button", { name: "Gaps" }));
    expect(matrixCalls.at(-1)).toMatchObject({ status: "gap" });
  });
});

describe("matrix export", () => {
  it("fetches every page for the current filters and downloads them as a report", async () => {
    exportMatrix.mockResolvedValue(matrix);
    render(<MemoryRouter initialEntries={["/Competence/Matrix?status=gap&position=p1"]}><MatrixPage /></MemoryRouter>);
    await userEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    expect(exportMatrix).toHaveBeenCalledWith(expect.objectContaining({ positionId: "p1", status: "gap" }));
    expect(downloadReport).toHaveBeenCalledTimes(1);
    const [report, slug] = downloadReport.mock.calls[0];
    expect(slug).toBe("skills-matrix");
    expect(report.meta.title).toBe("Skills matrix");
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]).toMatchObject({ name: "Xavier Xu", s_s1: "Below required" });
  });
});

describe("person page", () => {
  const open = () => render(<MemoryRouter initialEntries={["/Competence/People/e1"]}><Routes><Route path="/Competence/People/:employeeId" element={<PersonPage />} /></Routes></MemoryRouter>);

  it("shows positions with dates, skills by what needs attention first, and history on request", async () => {
    open();
    expect(screen.getByRole("heading", { name: "Xavier Xu" })).toBeInTheDocument();
    expect(screen.getByText(/since 2026-08-01/)).toBeInTheDocument();
    expect(screen.getByText("Earlier positions (1)")).toBeInTheDocument();
    const skills = within(screen.getByRole("list", { name: "Skills" }));
    expect(skills.getByText("Below required")).toBeInTheDocument();
    expect(skills.getByText("Not assessed", { selector: "span.rounded-full" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Show history for CMM operation" }));
    expect(screen.getByRole("list", { name: "Assessment history" })).toHaveTextContent("Supervised (2) · 2026-10-01 · until 2027-10-01 · by Ann Assessor · current");
  });

  it("lists the training they were on, linked to the session", () => {
    open();
    const training = within(screen.getByRole("list", { name: "Training" }));
    expect(training.getByRole("link", { name: "CMM basics" })).toHaveAttribute("href", "/Competence/Training/ts1");
    expect(training.getByText(/TS-26-0001 · Course · completed 2026-10-03/)).toBeInTheDocument();
  });

  it("records an assessment with the level, date and note", async () => {
    open();
    await userEvent.click(screen.getByRole("button", { name: "Assess CMM operation" }));
    const dialog = screen.getByRole("dialog");
    await userEvent.click(within(dialog).getByLabelText("Level"));
    await userEvent.click(await screen.findByRole("option", { name: /3 · Competent/ }));
    await userEvent.type(within(dialog).getByLabelText("Note"), "Worked alone");
    await userEvent.click(within(dialog).getByRole("button", { name: "Record assessment" }));
    expect(mutate).toHaveBeenCalledWith(
      { action: "assess", id: "e1", body: expect.objectContaining({ skillId: "s1", level: 3, note: "Worked alone", expiresOn: null }) },
      expect.any(Object),
    );
  });

  it("needs a note when the level goes down", async () => {
    open();
    await userEvent.click(screen.getByRole("button", { name: "Assess CMM operation" }));
    const dialog = screen.getByRole("dialog");
    await userEvent.click(within(dialog).getByLabelText("Level"));
    await userEvent.click(await screen.findByRole("option", { name: /1 · Learning/ }));
    expect(within(dialog).getByRole("button", { name: "Record assessment" })).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText("Note"), "Needs a refresher");
    expect(within(dialog).getByRole("button", { name: "Record assessment" })).toBeEnabled();
  });

  it("gives a position from a date and ends one", async () => {
    open();
    await userEvent.click(screen.getByRole("button", { name: "Give a position" }));
    const dialog = screen.getByRole("dialog");
    // Inspector is already held, so only the other position is offered.
    await userEvent.click(within(dialog).getByLabelText("Position"));
    expect(screen.queryByRole("option", { name: /Inspector/ })).not.toBeInTheDocument();
    await userEvent.click(await screen.findByRole("option", { name: /Auditor/ }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Give position" }));
    expect(mutate).toHaveBeenCalledWith({ action: "assignPosition", id: "e1", body: expect.objectContaining({ positionId: "p3" }) }, expect.any(Object));
  });

  it("hides assessing and giving positions without the rights", () => {
    permissions = ["competence.read"];
    open();
    expect(screen.queryByRole("button", { name: "Record an assessment" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Give a position" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Assess / })).not.toBeInTheDocument();
  });
});

describe("my competence", () => {
  it("shows my own record without any action buttons", () => {
    permissions = [];
    render(<MemoryRouter><MyCompetencePage /></MemoryRouter>);
    expect(screen.getByRole("heading", { name: "My competence" })).toBeInTheDocument();
    expect(screen.getByText("Below required")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Assess|Record an assessment|Give a position/ })).not.toBeInTheDocument();
  });

  it("explains when the sign-in is not linked to an employee", () => {
    mine = { linked: false };
    render(<MemoryRouter><MyCompetencePage /></MemoryRouter>);
    expect(screen.getByText("Your sign-in is not linked to an employee record")).toBeInTheDocument();
  });
});
