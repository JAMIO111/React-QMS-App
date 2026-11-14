import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

let permissions;
const apiFetch = vi.fn();
const upload = vi.fn();
const toast = vi.fn();
vi.mock("../../lib/api-client", async (importOriginal) => ({ ...(await importOriginal()), apiFetch: (...a) => apiFetch(...a) }));
vi.mock("../../api/supabaseApi", () => ({ uploadFileToSupabase: (...a) => upload(...a) }));
vi.mock("../../contexts/OrganisationProvider", () => ({ useOrganisation: () => ({ organisationId: "org-1" }) }));
vi.mock("../../hooks/useQmsApi", () => ({ usePermissions: () => ({ can: (p) => permissions.includes(p) }) }));
vi.mock("../../contexts/ToastProvider", () => ({ useToast: () => ({ showToast: toast }) }));

import { formToSettings, importBlockers, limitsWords, settingsProblems, settingsToForm } from "../../lib/measurementImports";
import { MeasurementFilesCard } from "./ImportFromFile";
import ImportPreviewPage from "./ImportPreviewPage";
import MeasurementProfilesCard from "./MeasurementProfilesCard";
import FeatureMapsCard from "./FeatureMapsCard";

const OD = "11111111-1111-1111-1111-111111111111";
const LEN = "22222222-2222-2222-2222-222222222222";
const VIS = "33333333-3333-3333-3333-333333333333";
const gauge = { id: "g1", assetNumber: "CMM-1", description: "Bridge CMM" };
const profile = (over = {}) => ({
  id: "p1", name: "Bench table", description: null, format: "table", currentVersion: 1, defaultGauge: gauge, active: true, retiredReason: null, updatedAt: "2026-11-14T09:00:00Z",
  settings: { delimiter: "auto", encoding: "auto", headingRow: "auto", columns: { feature: "Feature", balloon: "Balloon", actual: "Actual", lowerLimit: "Lower limit", upperLimit: "Upper limit" },
    lowerTolerance: "as_written", balloonFrom: "column", unit: null, decimal: ".", passValues: ["OK"], failValues: ["NOK"], header: { partNumber: "Part" } },
  ...over,
});
const row = (over) => ({
  id: over.id, position: 1, featureName: "Bore", charNumber: "1", raw: {}, valueText: "25.02", unitRead: "mm", readValue: 25.02, valueNumeric: 25.02, valuePass: null, valueCount: null,
  fileNominal: null, fileLower: 24.95, fileUpper: 25.05, requirementId: OD, matchKind: "balloon", problem: null, expectedResult: "pass", mismatch: false, measurementId: null, ...over,
});
const detail = (over = {}) => ({
  id: "i1", reference: "IMP-26-0001", inspectionId: "insp1", status: "previewed", fileName: "report.csv", profile: { id: "p1", name: "Bench table", version: 1 }, gauge,
  createdAt: "2026-11-14T09:00:00Z", createdBy: "Ada Owner", appliedAt: null, discardedAt: null,
  counts: { parts: 1, features: 3, matched: 2, toRecord: 2, unmatched: 1, problems: 0, failures: 1, mismatches: 1 },
  filePath: "org-1/inspection/insp1/x-report.csv", fileSha256: "a".repeat(64), sizeBytes: 100, format: "table", header: { partNumber: "HSG-1", serial: "SN-77" },
  warnings: [{ kind: "header", message: "The file names work order WO-2; this inspection is on WO-1" }], mismatchesConfirmedAt: null, mismatchesConfirmedBy: null,
  applyMode: null, applyReason: null, discardReason: null, expired: false, canRecord: true,
  inspection: { id: "insp1", reference: "IPI-26-0001", status: "in_progress", partId: "part1", partNumber: "HSG-1" },
  checks: [
    { id: OD, characteristicKey: "OD", charNumber: "1", name: "Bore", dataType: "variable", unit: "mm", nominal: 25, lowerLimit: 24.95, upperLimit: 25.05, applicable: true },
    { id: LEN, characteristicKey: "LEN", charNumber: "2", name: "Length", dataType: "variable", unit: "mm", nominal: 40, lowerLimit: 39.9, upperLimit: 40.1, applicable: true },
    { id: VIS, characteristicKey: "VIS", charNumber: null, name: "Visual", dataType: "attribute", unit: null, nominal: null, lowerLimit: null, upperLimit: null, applicable: true },
  ],
  units: [{ id: "u1", position: 1, unitReference: "SN-77", sampleId: null, rows: [
    row({ id: "r1" }),
    row({ id: "r2", position: 2, featureName: "Length", charNumber: "2", valueText: "40.15", readValue: 40.15, valueNumeric: 40.15, fileLower: 39.9, fileUpper: 40.2, requirementId: LEN, expectedResult: "fail", mismatch: true }),
    row({ id: "r3", position: 3, featureName: "Visual", charNumber: null, valueText: "OK", readValue: null, valueNumeric: null, valuePass: true, fileLower: null, fileUpper: null, requirementId: null, matchKind: "none", expectedResult: null }),
  ] }],
  ...over,
});

const routes = (handlers) =>
  apiFetch.mockImplementation((path, opts = {}) => {
    const method = opts.method ?? "GET";
    for (const [m, re, fn] of handlers) if (m === method && re.test(path)) return Promise.resolve(typeof fn === "function" ? fn(path, opts) : fn);
    return Promise.reject(new Error(`No mock for ${method} ${path}`));
  });

const wrap = (ui, at = "/") =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[at]}>
        <Routes>
          <Route path="/Inspections/:inspectionId/imports/:importId" element={<ImportPreviewPage />} />
          <Route path="/Inspections/:id" element={<p>Inspection page</p>} />
          <Route path="*" element={ui} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );

beforeEach(() => {
  permissions = ["inspection.read", "inspection.record", "inspection.correct", "inspection.override_gauge", "process_control.read", "process_control.manage"];
  apiFetch.mockReset();
  upload.mockReset();
  toast.mockReset();
  localStorage.clear();
});

describe("helpers", () => {
  it("settings survive the editor, and empty inputs are left out", () => {
    const s = formToSettings(settingsToForm(profile().settings));
    expect(s).toMatchObject({ headingRow: "auto", balloonFrom: "column", columns: { feature: "Feature", actual: "Actual" }, header: { partNumber: "Part" } });
    expect(s.columns).not.toHaveProperty("nominal");
  });
  it("says what a profile still needs", () => {
    const f = settingsToForm({ columns: { feature: "", upperTolerance: "+Tol" }, balloonFrom: "column" });
    expect(settingsProblems(f)).toEqual([
      "Name the column holding the feature name or id",
      "Name the column of the measured value or of pass / fail",
      "Tolerances need the nominal column",
      "Name the balloon column",
    ]);
  });
  it("says what stands in the way of recording a preview", () => {
    expect(importBlockers(detail())).toEqual(["Some features differ from the control plan: confirm you have checked them."]);
    expect(importBlockers(detail({ expired: true, mismatchesConfirmedAt: "x" }))).toEqual(["This preview is over a day old; upload the file again."]);
    expect(importBlockers(detail({ status: "applied" }))).toEqual([]);
    expect(limitsWords(24.95, 25.05, "mm")).toBe("24.95 – 25.05 mm");
    expect(limitsWords(null, 0.02, "mm")).toBe("≤ 0.02 mm");
  });
});

describe("the Measurement files card and upload", () => {
  const inspection = { id: "insp1", status: "in_progress", machine: { id: "m1" } };

  it("uploads the report to the inspection's folder, reads it with the profile and opens the preview", async () => {
    routes([
      ["GET", /\/inspections\/insp1\/imports$/, { data: [] }],
      ["GET", /\/measurement-profiles$/, { data: [profile()], canManage: true }],
      ["GET", /\/gauges/, { data: [gauge] }],
      ["POST", /\/inspections\/insp1\/imports$/, detail()],
      ["GET", /\/inspection-imports\/i1$/, detail()],
    ]);
    upload.mockResolvedValue({ path: "org-1/inspection/insp1/u-report.csv" });
    wrap(<MeasurementFilesCard inspection={inspection} canRecord />);
    await userEvent.click(await screen.findByRole("button", { name: "Import from CMM" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.upload(within(dialog).getByTestId("measurement-file"), new File(["Feature,Actual\nBore,25"], "report.csv", { type: "text/csv" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Read the file" }));
    await waitFor(() => expect(upload).toHaveBeenCalledWith(expect.any(File), "inspection-files", "org-1", "insp1", "inspection"));
    const post = apiFetch.mock.calls.find(([, o]) => o?.method === "POST");
    expect(post[1].body).toMatchObject({ path: "org-1/inspection/insp1/u-report.csv", fileName: "report.csv", profileId: "p1" });
    expect(await screen.findByRole("heading", { name: "IMP-26-0001" })).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("fortress.cmm-import.m1"))).toMatchObject({ profileId: "p1" });
  });

  it("lists the files read for the inspection, and offers no import to someone who cannot record", async () => {
    routes([["GET", /\/inspections\/insp1\/imports$/, { data: [detail()] }]]);
    wrap(<MeasurementFilesCard inspection={inspection} canRecord={false} />);
    expect(await screen.findByRole("link", { name: /IMP-26-0001 · report.csv/ })).toHaveAttribute("href", "/Inspections/insp1/imports/i1");
    expect(screen.getByText("Preview")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Import from CMM" })).not.toBeInTheDocument();
  });
});

describe("the preview", () => {
  it("shows what was read, waits for the differences to be confirmed, and records the readings", async () => {
    let current = detail();
    routes([
      ["GET", /\/inspection-imports\/i1$/, () => current],
      ["GET", /\/gauges/, { data: [gauge] }],
      ["POST", /confirm-mismatches$/, () => (current = { ...current, mismatchesConfirmedAt: "2026-11-14T09:05:00Z", mismatchesConfirmedBy: "Ada Owner" })],
      ["POST", /\/apply$/, () => (current = { ...current, status: "applied" })],
    ]);
    wrap(null, "/Inspections/insp1/imports/i1");
    expect(await screen.findByRole("heading", { name: "IMP-26-0001" })).toBeInTheDocument();
    expect(screen.getByText("The file names work order WO-2; this inspection is on WO-1")).toBeInTheDocument();
    expect(screen.getByText("Differs from the control plan")).toBeInTheDocument();
    const record = screen.getByRole("button", { name: "Record 2 readings" });
    expect(record).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "I have checked them" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Record 2 readings" })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: "Record 2 readings" }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/inspection-imports/i1/apply", expect.objectContaining({ method: "POST", body: expect.objectContaining({ mode: "new", gaugeId: "g1" }) })));
    expect(await screen.findByText("Inspection page")).toBeInTheDocument();
  });

  it("matches a feature by hand at once, remembering it for the part", async () => {
    routes([
      ["GET", /\/inspection-imports\/i1$/, detail({ mismatchesConfirmedAt: "x" })],
      ["GET", /\/gauges/, { data: [gauge] }],
      ["PUT", /\/inspection-import-rows\/r3\/match$/, () => new Promise(() => {})],
    ]);
    wrap(null, "/Inspections/insp1/imports/i1");
    const combo = await screen.findByRole("combobox", { name: "Check for Visual" });
    await userEvent.click(combo);
    await userEvent.click(await screen.findByRole("option", { name: /Visual/ }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/inspection-import-rows/r3/match", expect.objectContaining({ method: "PUT", body: { requirementId: VIS, remember: true } })));
    expect(screen.getAllByText("Matched by hand").length).toBeGreaterThan(0);
  });

  it("a correction needs a reason before it can be recorded", async () => {
    routes([["GET", /\/inspection-imports\/i1$/, detail({ mismatchesConfirmedAt: "x" })], ["GET", /\/gauges/, { data: [gauge] }]]);
    wrap(null, "/Inspections/insp1/imports/i1");
    await userEvent.click(await screen.findByRole("button", { name: "Correction" }));
    expect(screen.getByRole("button", { name: "Record 2 readings" })).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Why are the readings being corrected?"), "Probe not qualified");
    expect(screen.getByRole("button", { name: "Record 2 readings" })).toBeEnabled();
  });

  it("is read only once recorded", async () => {
    routes([["GET", /\/inspection-imports\/i1$/, detail({ status: "applied", mismatchesConfirmedAt: "x" })]]);
    wrap(null, "/Inspections/insp1/imports/i1");
    expect(await screen.findByText("Recorded", { selector: "p" })).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Check for Visual" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Record \d/ })).not.toBeInTheDocument();
  });
});

describe("profiles in Settings", () => {
  it("starts a profile from a ready-made one, tries a file with it, and saves it", async () => {
    routes([
      ["GET", /\/measurement-profiles\?all=true$/, { data: [], canManage: true }],
      ["GET", /\/measurement-profiles\/templates$/, { data: [{ key: "pcdmis_csv", name: "Hexagon PC-DMIS CSV export", description: "One line per dimension", format: "table",
        settings: { delimiter: "auto", columns: { feature: "Dimension", axis: "Axis", actual: "Measured", nominal: "Nominal", upperTolerance: "+Tol", lowerTolerance: "-Tol" }, lowerTolerance: "minus", balloonFrom: "feature", unit: "mm", header: {} } }] }],
      ["GET", /\/gauges/, { data: [gauge] }],
      ["POST", /\/measurement-profiles\/try$/, { ok: true, error: null, header: {}, headings: ["Dimension"], headingRow: 1, featureCount: 1, warnings: [],
        units: [{ position: 1, reference: null, featureCount: 1, features: [{ position: 1, line: 2, featureName: "LOC1 X", balloon: null, actualText: "1.0011", actual: 1.0011, pass: null, unit: "mm", nominal: 1, lower: 0.998, upper: 1.002 }] }] }],
      ["POST", /\/measurement-profiles$/, profile({ name: "Hexagon PC-DMIS CSV export" })],
    ]);
    wrap(<MeasurementProfilesCard />);
    await userEvent.click(await screen.findByRole("button", { name: "New profile" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("combobox", { name: "Start from" }));
    await userEvent.click(await screen.findByRole("option", { name: /PC-DMIS/ }));
    expect(within(dialog).getByLabelText("Feature name or id")).toHaveValue("Dimension");
    expect(within(dialog).getByLabelText("Name")).toHaveValue("Hexagon PC-DMIS CSV export");
    await userEvent.upload(within(dialog).getByTestId("try-file"), new File(["Dimension,Axis,Measured\nLOC1,X,1.0011"], "pcdmis.csv", { type: "text/csv" }));
    expect(await within(dialog).findByText("LOC1 X")).toBeInTheDocument();
    const tried = apiFetch.mock.calls.find(([p]) => p === "/measurement-profiles/try");
    expect(tried[1].body).toMatchObject({ fileName: "pcdmis.csv", settings: { columns: { feature: "Dimension" }, lowerTolerance: "minus" } });
    await userEvent.click(within(dialog).getByRole("button", { name: "Add profile" }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/measurement-profiles", expect.objectContaining({ method: "POST", body: expect.objectContaining({ name: "Hexagon PC-DMIS CSV export" }) })));
  });

  it("changing how files are read asks why; someone who cannot manage sees no changes offered", async () => {
    routes([["GET", /\/measurement-profiles\?all=true$/, { data: [profile()], canManage: true }], ["GET", /\/gauges/, { data: [gauge] }], ["GET", /templates$/, { data: [] }]]);
    wrap(<MeasurementProfilesCard />);
    await userEvent.click(await screen.findByRole("button", { name: "Actions" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Change" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByText(/Why is the way files are read changing/)).not.toBeInTheDocument();
    await userEvent.type(within(dialog).getByLabelText("Unit of the values"), "mm");
    expect(within(dialog).getByLabelText(/Why is the way files are read changing\? \(becomes version 2\)/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("offers nothing to change without the right", async () => {
    routes([["GET", /\/measurement-profiles\?all=true$/, { data: [profile()], canManage: false }]]);
    wrap(<MeasurementProfilesCard />);
    expect(await screen.findByText("Bench table")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New profile" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Actions" })).not.toBeInTheDocument();
  });
});

describe("feature matches on the part page", () => {
  it("lists the part's matches, adds one with the key in capitals, and removes one", async () => {
    routes([
      ["GET", /\/parts\/part1\/feature-maps$/, { data: [{ id: "fm1", featureName: "VISUAL", characteristicKey: "VIS", profile: null, createdAt: "2026-11-14T09:00:00Z", createdBy: "Ada Owner" }] }],
      ["GET", /\/measurement-profiles$/, { data: [profile()], canManage: true }],
      ["POST", /\/parts\/part1\/feature-maps$/, { data: [] }],
      ["POST", /\/measurement-feature-maps\/fm1\/end$/, { data: [] }],
    ]);
    wrap(<FeatureMapsCard partId="part1" canEdit />);
    expect(await screen.findByText("VISUAL")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Feature in the file"), "CIR_OD");
    await userEvent.type(screen.getByLabelText("Characteristic key"), "od");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/parts/part1/feature-maps", expect.objectContaining({ body: { featureName: "CIR_OD", characteristicKey: "OD", profileId: null } })));
    await userEvent.click(screen.getByRole("button", { name: "Remove the match for VISUAL" }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/measurement-feature-maps/fm1/end", expect.objectContaining({ method: "POST" })));
  });
});
