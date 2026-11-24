import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";

let permissions = [];
const mutate = vi.fn();
const record = vi.fn();
const parse = vi.fn();
const listCalls = [];
let study;
let analysis;
let parsed;
let coverage;
const coverageCalls = [];

const crossedResult = {
  studyType: "grr_crossed",
  options: { sigma: 6, alpha: 0.05, lower: 9.9, upper: 10.1, tolerance: 0.2, resolution: 0.001 },
  variation: [
    { name: "repeatability", variance: 0.0004, sd: 0.02, studyVariation: 0.12, pctContribution: 4, pctStudyVar: 20, pctTolerance: 60 },
    { name: "reproducibility", variance: 0.0001, sd: 0.01, studyVariation: 0.06, pctContribution: 1, pctStudyVar: 10, pctTolerance: 30 },
    { name: "grr", variance: 0.0005, sd: 0.0224, studyVariation: 0.1342, pctContribution: 5, pctStudyVar: 22.4, pctTolerance: 67.1 },
    { name: "part", variance: 0.0095, sd: 0.0975, studyVariation: 0.585, pctContribution: 95, pctStudyVar: 97.5, pctTolerance: 292 },
    { name: "total", variance: 0.01, sd: 0.1, studyVariation: 0.6, pctContribution: 100, pctStudyVar: 100, pctTolerance: 300 },
  ],
  ndc: 6,
  anova: { rows: [{ source: "part", df: 9, ss: 1, ms: 0.1, f: 20, p: 0.001 }, { source: "total", df: 89, ss: 2, ms: null, f: null, p: null }], alpha: 0.05, interactionP: 0.4, interactionKept: false, clamped: [] },
  rangeMethod: { available: true, repeatability: 0.1, reproducibility: 0.05, grr: 0.11, partVariation: 0.5, totalVariation: 0.51, ndc: 6, pctStudyVar: 21.5 },
  charts: {
    cellMeans: [[10, 10.1], [10.01, 10.12]],
    appraiserMeans: [10.05, 10.06],
    partMeans: [10.005, 10.11],
    range: { centre: 0.02, ucl: 0.05, lcl: 0, points: [{ appraiser: 1, part: 1, value: 0.02 }], outside: [] },
    average: { centre: 10.05, ucl: 10.1, lcl: 10, points: [{ appraiser: 1, part: 1, value: 10 }], fractionOutside: 0.8 },
  },
  verdict: { band: "marginal", reasons: ["Gauge R&R is 22.4% of the study variation (marginal)."] },
  warnings: [{ code: "few_parts", level: "warning", text: "Fewer than 10 parts were used." }],
};

const base = {
  id: "s1", reference: "MSA-26-0001", studyType: "grr_crossed", status: "collecting",
  gauge: { id: "g1", assetNumber: "CAL-001", description: "Micrometer" }, part: null, characteristicKey: null, operationCode: null,
  characteristicName: "Outside diameter", unitCode: "mm", partCount: 2, appraiserCount: 2, trialCount: 1,
  progress: { filled: 1, total: 4 }, verdict: null, headline: null, conclusion: null, validUntil: null, validity: null,
  startedAt: "2026-11-24T09:00:00Z", completedAt: null, completedBy: null, createdAt: "2026-11-23T09:00:00Z", createdBy: { name: "Ann" },
  canManage: true, canRecord: true, rowVersion: "v1", conclusionNote: null, cancelReason: null, algorithmVersion: null, criteriaId: null,
  design: { nominal: 10, lowerLimit: 9.9, upperLimit: 10.1, gaugeResolution: 0.001, sigmaMultiplier: 6, interactionAlpha: 0.05, referenceValue: null, kPercent: 20, lMultiplier: 6 },
  appraisers: [{ id: "a1", position: 1, name: "Ada", employeeId: null }, { id: "a2", position: 2, name: "Ben", employeeId: null }],
  parts: [{ id: "p1", position: 1, label: "Part 1", referenceDecision: null }, { id: "p2", position: 2, label: "Part 2", referenceDecision: null }],
  cells: [
    { appraiser: 1, part: 2, trial: 1, runOrder: 1, value: null, decision: null },
    { appraiser: 1, part: 1, trial: 1, runOrder: 2, value: "10.01", decision: null, enteredAt: "2026-11-24T09:05:00Z", enteredBy: "Ada" },
    { appraiser: 2, part: 1, trial: 1, runOrder: 1, value: null, decision: null },
    { appraiser: 2, part: 2, trial: 1, runOrder: 2, value: null, decision: null },
  ],
};

vi.mock("recharts", async (importOriginal) => ({ ...(await importOriginal()), ResponsiveContainer: ({ children }) => <div data-testid="chart-area">{children}</div> }));
vi.mock("../../hooks/useQmsApi", () => ({ usePermissions: () => ({ can: (p) => permissions.includes(p) }) }));
vi.mock("../../contexts/ToastProvider", () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock("../../contexts/SearchProvider", () => ({ useGlobalSearch: () => ({ debouncedSearchTerm: "", setSearchTerm: vi.fn() }) }));
vi.mock("../../hooks/useCalibration", () => ({ useGauges: () => ({ data: { data: [{ id: "g1", assetNumber: "CAL-001", description: "Micrometer" }] }, isFetching: false }) }));
vi.mock("../../hooks/useNcr", () => ({ useEmployees: () => ({ data: [{ id: "e1", name: "Ada Lovelace", active: true }] }), useNcrs: () => ({ data: { items: [] } }) }));
vi.mock("../../hooks/useMasterData", () => ({ useParts: () => ({ data: { items: [] }, isFetching: false }), usePart: () => ({ data: undefined }), useParties: () => ({ data: { items: [] } }) }));
vi.mock("../../hooks/useProcessControl", async (importOriginal) => ({ ...(await importOriginal()), useSpecValues: () => ({ data: [] }), useMachines: () => ({ data: { items: [] } }) }));
vi.mock("../../hooks/useMsa", async (importOriginal) => ({
  ...(await importOriginal()),
  useMsaStudies: (params) => (listCalls.push(params), { data: { data: [{ ...base, status: "completed", verdict: "marginal", headline: { pctGrr: 22.4 }, conclusion: "accepted_with_conditions", validUntil: "2027-11-24", validity: { state: "valid", daysLeft: 365 }, progress: { filled: 4, total: 4 }, completedAt: "2026-11-24T10:00:00Z" }], page: 1, pageSize: 25, total: 1 }, isLoading: false, isFetching: false, error: null, refetch: vi.fn() }),
  useMsaStudy: () => ({ data: study, isLoading: false, isError: false }),
  useMsaAnalysis: () => ({ data: analysis, isLoading: false, isError: false }),
  useMsaReport: () => ({ data: { study, result: crossedResult, dataHash: "a".repeat(64), dataMatchesResult: true }, isLoading: false, isError: false }),
  useMsaCoverage: (params) => (coverageCalls.push(params), { data: coverage, isLoading: false, isError: false }),
  useGaugeMsa: () => ({ data: { current: [{ ...base, status: "completed", verdict: "acceptable", validity: { state: "expiring", daysLeft: 12 }, validUntil: "2026-12-06", completedAt: "2026-11-24T10:00:00Z", headline: { pctGrr: 8 } }], open: [{ ...base, id: "s2", reference: "MSA-26-0002", status: "draft" }], earlier: [] }, isLoading: false, isError: false }),
  useMsaMutation: () => ({ mutate, isPending: false, error: null }),
  useRecordMeasurements: () => ({ mutate: record, isPending: false }),
  useParsePaste: () => ({ mutate: parse, data: parsed, isPending: false, reset: vi.fn() }),
}));

import MsaStudiesPage from "./MsaStudiesPage";
import MsaStudyPage from "./MsaStudyPage";
import MsaReportPage from "./MsaReportPage";
import GaugeStudies from "./GaugeStudies";
import MsaHome from "./MsaHome";
import AnalysisView from "./AnalysisView";

beforeEach(() => {
  mutate.mockReset();
  record.mockReset();
  parse.mockReset();
  listCalls.length = 0;
  study = base;
  analysis = { frozen: false, complete: false, filled: 1, total: 4, problem: "3 of 4 readings are still missing.", result: null, dataHash: null };
  parsed = undefined;
  coverageCalls.length = 0;
  coverage = {
    available: true, reason: null, today: "2026-11-24", total: 2, truncated: false,
    counts: { not_accepted: 0, expired: 1, no_study: 1, not_judged: 0, marginal: 0, no_readings: 1, acceptable: 3 },
    rows: [
      { plan: { id: "cp1", code: "CP-001", title: "Rods", revisionId: "cr1", revisionCode: "B" }, characteristic: { key: "OD", name: "Outer diameter", charNumber: "3", criticality: "critical", dataType: "variable", operationCode: "OP-020" }, gauge: { id: "g1", assetNumber: "CAL-001", description: "Micrometer" }, readings: 42, lastMeasuredAt: "2026-11-20T10:00:00Z", part: { id: "p1", partNumber: "HCR-100", name: "Rod" }, study: { id: "s9", reference: "MSA-26-0009", studyType: "grr_crossed", completedAt: "2025-10-01T10:00:00Z", validUntil: "2026-10-01", conclusion: "accepted", verdict: "acceptable" }, state: "expired" },
      { plan: { id: "cp1", code: "CP-001", title: "Rods", revisionId: "cr1", revisionCode: "B" }, characteristic: { key: "BORE", name: "Bore", charNumber: null, criticality: "major", dataType: "variable", operationCode: "OP-030" }, gauge: { id: "g2", assetNumber: "CAL-002", description: "Bore gauge" }, readings: 7, lastMeasuredAt: "2026-11-21T10:00:00Z", part: null, study: null, state: "no_study" },
    ],
  };
  permissions = ["calibration.read", "calibration.record", "calibration.manage"];
});

const openStudy = () =>
  render(
    <MemoryRouter initialEntries={["/Calibration/Gauge-RR/s1"]}>
      <Routes>
        <Route path="/Calibration/Gauge-RR/:id" element={<MsaStudyPage />} />
      </Routes>
    </MemoryRouter>,
  );

describe("the register", () => {
  it("lists studies with the result, the headline figure and how long it stays valid, and asks for every study but cancelled ones", () => {
    render(<MemoryRouter><MsaStudiesPage /></MemoryRouter>);
    const table = screen.getByRole("region", { name: "Measurement system studies" });
    expect(within(table).getByRole("link", { name: "MSA-26-0001" })).toHaveAttribute("href", "/Calibration/Gauge-RR/s1");
    expect(within(table).getByText("Marginal")).toBeInTheDocument();
    expect(within(table).getByText("22.4% of the study variation")).toBeInTheDocument();
    expect(within(table).getByText(/Valid until/)).toBeInTheDocument();
    expect(listCalls.at(-1)).toMatchObject({ status: "all", page: 1 });
  });

  it("offers Plan a study only to people who may manage calibrations", () => {
    permissions = ["calibration.read"];
    const { unmount } = render(<MemoryRouter><MsaStudiesPage /></MemoryRouter>);
    expect(screen.queryByRole("button", { name: /Plan a study/ })).not.toBeInTheDocument();
    unmount();
    permissions = ["calibration.read", "calibration.manage"];
    render(<MemoryRouter><MsaStudiesPage /></MemoryRouter>);
    expect(screen.getByRole("button", { name: /Plan a study/ })).toBeInTheDocument();
  });

  it("plans a study in a dialog that asks for the gauge and what is measured before it can be saved", async () => {
    render(<MemoryRouter><MsaStudiesPage /></MemoryRouter>);
    await userEvent.click(screen.getByRole("button", { name: /Plan a study/ }));
    const dialog = screen.getByRole("dialog", { name: "Plan a measurement system study" });
    expect(within(dialog).getByRole("button", { name: "Plan the study" })).toBeDisabled();
    expect(within(dialog).getByText("Say what is measured.")).toBeInTheDocument();
  });
});

describe("a study that is collecting", () => {
  it("shows the run sheet in run order for the first appraiser and says what is still missing", () => {
    openStudy();
    expect(screen.getByRole("heading", { name: /MSA-26-0001/ })).toBeInTheDocument();
    const trial = screen.getByRole("region", { name: "Trial 1" });
    const boxes = within(trial).getAllByRole("textbox");
    expect(boxes[0]).toHaveAccessibleName("Ada, Part 2, trial 1");
    expect(boxes[1]).toHaveValue("10.01");
    expect(screen.getByText("3 of 4 readings are still missing.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Complete the study" })).toBeDisabled();
  });

  it("saves a reading when its box is left, as the digits typed with a point for a comma", async () => {
    openStudy();
    const box = screen.getByRole("textbox", { name: "Ada, Part 2, trial 1" });
    await userEvent.type(box, "9,987");
    await userEvent.tab();
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0][0]).toEqual({ cells: [{ appraiser: 1, part: 2, trial: 1, value: "9.987" }], source: "grid" });
  });

  it("does not send text that is not a number, and does not send a reading that has not changed", async () => {
    openStudy();
    const box = screen.getByRole("textbox", { name: "Ada, Part 2, trial 1" });
    await userEvent.type(box, "abc");
    expect(box).toHaveAttribute("aria-invalid", "true");
    await userEvent.tab();
    const stored = screen.getByRole("textbox", { name: "Ada, Part 1, trial 1" });
    await userEvent.click(stored);
    await userEvent.tab();
    expect(record).not.toHaveBeenCalled();
  });

  it("moves to the next box with Enter after saving", async () => {
    openStudy();
    const box = screen.getByRole("textbox", { name: "Ada, Part 2, trial 1" });
    await userEvent.type(box, "10.2{Enter}");
    expect(record).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("textbox", { name: "Ada, Part 1, trial 1" })).toHaveFocus();
  });

  it("switches appraiser and lays the same cells out by part", async () => {
    openStudy();
    await userEvent.click(screen.getByRole("tab", { name: /Ben/ }));
    expect(screen.getByRole("textbox", { name: "Ben, Part 1, trial 1" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "By part" }));
    const table = screen.getByRole("table");
    expect(within(table).getByRole("columnheader", { name: "Trial 1" })).toBeInTheDocument();
    expect(within(table).getByRole("rowheader", { name: "Part 2" })).toBeInTheDocument();
  });

  it("does not let someone without the right to record type, and says why", () => {
    study = { ...base, canRecord: false };
    openStudy();
    expect(screen.getByText(/you can read this study but not enter readings/i)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Ada, Part 2, trial 1" })).toBeDisabled();
  });

  it("can be completed once every reading is in, with a conclusion and a reason", async () => {
    analysis = { frozen: false, complete: true, filled: 4, total: 4, problem: null, result: crossedResult, dataHash: null };
    openStudy();
    await userEvent.click(screen.getByRole("button", { name: "Complete the study" }));
    const dialog = screen.getByRole("dialog", { name: /Complete MSA-26-0001/ });
    const go = within(dialog).getByRole("button", { name: "Complete the study" });
    expect(go).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText(/Why/), "Fine for this tolerance");
    await userEvent.click(go);
    expect(mutate.mock.calls[0][0]).toMatchObject({ path: "/msa/studies/s1/complete", body: { conclusion: "accepted", note: "Fine for this tolerance" } });
  });

  it("shows the figures, the verdict in words and the warnings of the analysis so far", () => {
    analysis = { frozen: false, complete: true, filled: 4, total: 4, problem: null, result: crossedResult, dataHash: null };
    openStudy();
    expect(screen.getByText("Marginal")).toBeInTheDocument();
    expect(screen.getByText("Gauge R&R is 22.4% of the study variation (marginal).")).toBeInTheDocument();
    expect(screen.getByText("Fewer than 10 parts were used.")).toBeInTheDocument();
  });
});

describe("an attribute study", () => {
  const attribute = {
    ...base, studyType: "attribute", appraiserCount: 2, partCount: 2, trialCount: 1,
    parts: [{ id: "p1", position: 1, label: "Sample 1", referenceDecision: true }, { id: "p2", position: 2, label: "Sample 2", referenceDecision: false }],
    cells: [{ appraiser: 1, part: 1, trial: 1, runOrder: 1, value: null, decision: null }, { appraiser: 1, part: 2, trial: 1, runOrder: 2, value: null, decision: true }],
  };
  it("records Accept and Reject as decisions and shows the chosen one as pressed", async () => {
    study = attribute;
    openStudy();
    const sample1 = screen.getByRole("group", { name: "Ada, Sample 1, trial 1" });
    await userEvent.click(within(sample1).getByRole("button", { name: "Reject" }));
    expect(record.mock.calls[0][0]).toEqual({ cells: [{ appraiser: 1, part: 1, trial: 1, decision: false }], source: "grid" });
    const sample2 = screen.getByRole("group", { name: "Ada, Sample 2, trial 1" });
    expect(within(sample2).getByRole("button", { name: "Accept" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(within(sample2).getByRole("button", { name: "Accept" }));
    expect(record).toHaveBeenCalledTimes(1);
  });
});

describe("pasting readings", () => {
  it("sends the text to be read, lists the rows that cannot be placed and records only what was found", async () => {
    parsed = { ok: false, rows: 3, cells: [{ appraiser: 1, part: 1, trial: 1, value: "10.1" }, { appraiser: 2, part: 1, trial: 1, value: "10.2" }], problems: [{ line: 4, message: 'Part "P9" is not in this study.' }] };
    openStudy();
    await userEvent.click(screen.getByRole("button", { name: "Paste readings" }));
    const dialog = screen.getByRole("dialog", { name: "Paste readings" });
    await userEvent.type(within(dialog).getByLabelText("Readings"), "appraiser,part,value");
    await userEvent.click(within(dialog).getByRole("button", { name: "Check" }));
    expect(parse.mock.calls[0][0]).toBe("appraiser,part,value");
    expect(within(dialog).getByText(/2 of 3 rows could be placed/)).toBeInTheDocument();
    expect(within(dialog).getByText('Part "P9" is not in this study.')).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Record 2 readings" }));
    expect(record.mock.calls[0][0]).toEqual({
      cells: [{ appraiser: 1, part: 1, trial: 1, value: "10.1" }, { appraiser: 2, part: 1, trial: 1, value: "10.2" }],
      source: "paste",
    });
  });
});

describe("a draft study", () => {
  it("starts collecting after a confirmation, and not before every attribute sample has its reference decision", async () => {
    study = { ...base, status: "draft", cells: [], progress: { filled: 0, total: 0 } };
    const { unmount } = openStudy();
    await userEvent.click(screen.getByRole("button", { name: "Start collecting" }));
    const dialog = screen.getByRole("dialog", { name: "Start collecting readings?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Start collecting" }));
    expect(mutate.mock.calls[0][0]).toEqual({ path: "/msa/studies/s1/start" });
    unmount();
    study = { ...base, status: "draft", studyType: "attribute", cells: [], progress: { filled: 0, total: 0 } };
    openStudy();
    expect(screen.getByRole("button", { name: "Start collecting" })).toBeDisabled();
  });
});

describe("a completed study", () => {
  beforeEach(() => {
    study = { ...base, status: "completed", verdict: "marginal", conclusion: "accepted_with_conditions", conclusionNote: "Repeat after calibration", validUntil: "2026-12-06", validity: { state: "expiring", daysLeft: 12 }, completedAt: "2026-11-24T10:00:00Z", completedBy: { name: "Ann" }, algorithmVersion: "msa-1", criteriaId: "aiag-msa-4", progress: { filled: 4, total: 4 } };
    analysis = { frozen: true, complete: true, filled: null, total: null, problem: null, result: crossedResult, dataHash: "a".repeat(64) };
  });
  it("shows the conclusion, how long it is valid, a warning near the end, and the way to the report", () => {
    openStudy();
    expect(screen.getByText("Accepted with conditions")).toBeInTheDocument();
    expect(screen.getByText("Repeat after calibration")).toBeInTheDocument();
    expect(screen.getByText("This study expires soon")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Report" })).toHaveAttribute("href", "/Calibration/Gauge-RR/s1/report");
    expect(screen.queryByRole("button", { name: "Complete the study" })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });
  it("repeats the study from the same design", async () => {
    openStudy();
    await userEvent.click(screen.getByRole("button", { name: "Repeat the study" }));
    expect(mutate.mock.calls[0][0]).toEqual({ path: "/msa/studies/s1/repeat" });
  });
});

describe("the report", () => {
  it("says what the study was, the conclusion, the result and the fingerprint of the data", () => {
    study = { ...base, status: "completed", conclusion: "accepted", conclusionNote: "Good", completedAt: "2026-11-24T10:00:00Z", algorithmVersion: "msa-1", criteriaId: "aiag-msa-4", validity: { state: "valid", daysLeft: 300 }, validUntil: "2027-11-24" };
    render(<MemoryRouter initialEntries={["/Calibration/Gauge-RR/s1/report"]}><Routes><Route path="/Calibration/Gauge-RR/:id/report" element={<MsaReportPage />} /></Routes></MemoryRouter>);
    const article = screen.getByRole("article");
    expect(within(article).getByText(/Gauge R&R \(crossed\): MSA-26-0001/)).toBeInTheDocument();
    expect(within(article).getByText("Good")).toBeInTheDocument();
    expect(within(article).getByText("a".repeat(64))).toBeInTheDocument();
    expect(within(article).getByText("The stored readings still give this fingerprint.")).toBeInTheDocument();
  });
});

describe("the gauge page card", () => {
  it("lists the current study with its validity, the ones in progress, and offers a new one to people who manage calibrations", () => {
    render(<MemoryRouter><GaugeStudies gauge={{ id: "g1", assetNumber: "CAL-001", description: "Micrometer" }} /></MemoryRouter>);
    const current = screen.getByRole("region", { name: "Current studies" });
    expect(within(current).getByRole("link", { name: /MSA-26-0001/ })).toHaveAttribute("href", "/Calibration/Gauge-RR/s1");
    expect(within(current).getByText("Valid for 12 more days")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Studies in progress" })).getByText("Draft")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Plan a study" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "All studies of this gauge" })).toHaveAttribute("href", "/Calibration/Gauge-RR?gauge=g1");
  });
});

describe("the analysis of the other kinds of study", () => {
  it("shows a Type 1 study's Cg and Cgk and its bias", () => {
    const result = { studyType: "type1", n: 25, reference: 10, tolerance: 0.2, k: 20, l: 6, mean: 10.001, sd: 0.002, min: 9.998, max: 10.004, bias: 0.001, biasT: 2.5, biasP: 0.02, cg: 1.67, cgk: 1.5, pctRepeatability: 6, pctRepeatabilityAndBias: 10, resolutionPct: 0.5, verdict: { band: "acceptable", reasons: ["Cgk is 1.50."] }, warnings: [] };
    render(<AnalysisView result={result} study={{ ...base, studyType: "type1", cells: [{ trial: 1, value: "10.001" }, { trial: 2, value: "10.002" }], appraisers: [{ name: "Ada" }] }} />);
    expect(within(screen.getByText("Cgk").closest("[data-figure]")).getByText("1.5")).toBeInTheDocument();
    expect(screen.getByText("Acceptable")).toBeInTheDocument();
  });
  it("shows each appraiser's effectiveness in an attribute study", () => {
    const fraction = { matched: 9, total: 10, rate: 0.9 };
    const result = {
      studyType: "attribute",
      design: { samples: 10, appraisers: 1, trials: 2, goodSamples: 5, badSamples: 5 },
      appraisers: [{ appraiser: 1, within: fraction, vsStandard: fraction, goodAccepted: 5, goodRejected: 0, badAccepted: 1, badRejected: 4, effectiveness: 0.9, missRate: 0.1, falseAlarmRate: 0, kappaWithin: 0.8, kappaVsStandard: 0.7, bands: {}, verdict: "marginal" }],
      between: fraction, kappaBetween: 0.8, allVsStandard: fraction, overall: { effectiveness: 0.9, missRate: 0.1, falseAlarmRate: 0 },
      verdict: { band: "marginal", reasons: ["Ada misses 10% of the bad samples."] }, warnings: [],
    };
    render(<AnalysisView result={result} study={{ ...base, studyType: "attribute", appraisers: [{ name: "Ada" }], cells: [] }} />);
    const table = screen.getByRole("table", { name: "Appraisers" });
    expect(within(table).getByText("Ada")).toBeInTheDocument();
    expect(within(table).getAllByText("90%").length).toBeGreaterThan(0);
    expect(screen.getByText("Ada misses 10% of the bad samples.")).toBeInTheDocument();
  });
});


describe("coverage", () => {
  const openCoverage = (url = "/Calibration/Gauge-RR?view=coverage") => render(<MemoryRouter initialEntries={[url]}><MsaHome /></MemoryRouter>);

  it("switches between the studies and coverage with a toggle kept in the address", async () => {
    render(<MemoryRouter><MsaHome /></MemoryRouter>);
    expect(screen.getByRole("region", { name: "Measurement system studies" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Coverage" }));
    expect(screen.getByRole("table", { name: "Gauge R&R coverage" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Studies" }));
    expect(screen.getByRole("region", { name: "Measurement system studies" })).toBeInTheDocument();
  });

  it("lists what needs attention first: the characteristic, gauge, readings, state in words and the study behind it", () => {
    openCoverage();
    const table = screen.getByRole("table", { name: "Gauge R&R coverage" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText("Outer diameter")).toBeInTheDocument();
    expect(within(rows[0]).getByRole("link", { name: "CAL-001" })).toHaveAttribute("href", "/Calibration/Gauges/g1");
    expect(within(rows[0]).getByText("Study expired")).toBeInTheDocument();
    expect(within(rows[0]).getByRole("link", { name: "MSA-26-0009" })).toHaveAttribute("href", "/Calibration/Gauge-RR/s9");
    expect(within(rows[0]).getByRole("link", { name: "CP-001" })).toHaveAttribute("href", "/Process-Control/Plans/cp1/revisions/cr1");
    expect(within(rows[1]).getByText("No study")).toBeInTheDocument();
    expect(coverageCalls.at(-1)).toMatchObject({ state: "attention" });
  });

  it("shows the number in each state and asks for that state when one is chosen", async () => {
    openCoverage();
    const group = screen.getByRole("group", { name: "Filter by state" });
    expect(within(group).getByRole("button", { name: /Needs attention/ })).toHaveTextContent("2");
    expect(within(group).getByRole("button", { name: /Acceptable/ })).toHaveTextContent("3");
    await userEvent.click(within(group).getByRole("button", { name: /^No study/ }));
    expect(coverageCalls.at(-1)).toMatchObject({ state: "no_study" });
  });

  it("plans a study from a row with the kind, gauge and characteristic already chosen, only for people who manage calibrations", async () => {
    openCoverage();
    await userEvent.click(screen.getByRole("button", { name: "Plan a study for Outer diameter on CAL-001" }));
    const dialog = screen.getByRole("dialog", { name: "Plan a measurement system study" });
    expect(within(dialog).getByDisplayValue("Outer diameter")).toBeInTheDocument();
    expect(within(dialog).getByRole("combobox", { name: /Gauge/ })).toHaveValue("CAL-001 · Micrometer");
  });

  it("offers no study to someone who cannot manage calibrations", () => {
    permissions = ["calibration.read"];
    openCoverage();
    expect(screen.queryByRole("button", { name: /Plan a study for/ })).toBeNull();
  });

  it("says why it cannot be shown when the person may not read the plans or inspections, and says so when all is well", () => {
    coverage = { available: false, reason: "Coverage reads control plans (process_control.read), which you may not read.", today: "2026-11-24", counts: {}, rows: [], truncated: false };
    const { unmount } = openCoverage();
    expect(screen.getByText(/which you may not read/)).toBeInTheDocument();
    unmount();
    coverage = { available: true, reason: null, today: "2026-11-24", counts: {}, rows: [], total: 0, truncated: false };
    openCoverage();
    expect(screen.getByText(/Nothing needs attention/)).toBeInTheDocument();
  });
});
