import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { nextSample, previewResult } from "../../lib/inspection";

let permissions;
const apiFetch = vi.fn();
vi.mock("../../lib/api-client", async (importOriginal) => ({ ...(await importOriginal()), apiFetch: (...a) => apiFetch(...a) }));
vi.mock("../../contexts/OrganisationProvider", () => ({ useOrganisation: () => ({ organisationId: "org-1" }) }));
vi.mock("../../hooks/useQmsApi", () => ({
  usePermissions: () => ({ can: (p) => permissions.includes(p) }),
  useSites: () => ({ data: { data: [{ id: "s1", name: "Plant A" }] } }),
}));
vi.mock("../../contexts/ToastProvider", () => ({ useToast: () => ({ showToast: vi.fn() }) }));

import InspectionPage from "./InspectionPage";
import StartInspectionPage from "./StartInspectionPage";
import NcrInspectionSource from "./NcrInspectionSource";
import GaugeUsage from "./GaugeUsage";

const page = (data, nextCursor = null) => ({ data, nextCursor });
const req = (over) => ({
  id: "q-od",
  sequence: 1,
  characteristicKey: "OD",
  charNumber: "3",
  name: "Outer diameter",
  operationCode: "OP-020",
  dataType: "variable",
  valueSource: "plan",
  specKey: null,
  applicable: true,
  applicability: "All parts in scope",
  nominal: 25,
  lowerLimit: 24.95,
  upperLimit: 25.05,
  unitCode: "mm",
  method: "Micrometer, 3 positions",
  gaugeType: { id: "t-mic", name: "Micrometer 0-25" },
  criticality: "critical",
  spcEligible: true,
  chartType: "xbar_r",
  subgroupSize: 5,
  decimals: 2,
  sampling: [{ triggerType: "first_off", intervalValue: null, sampleSize: 1 }],
  reactions: [],
  ...over,
});
const inspection = (over) => ({
  id: "i1",
  reference: "IPI-26-0001",
  status: "in_progress",
  result: null,
  part: { id: "p1", partNumber: "HCR-100", name: "Rod 100" },
  partRevision: "A",
  plan: { id: "cp1", planCode: "CP-HCR-001", revisionCode: "B" },
  operationCode: null,
  site: { id: "s1", name: "Plant A" },
  machine: null,
  workOrder: "WO-77",
  lot: "L-1",
  lotSize: null,
  serial: null,
  triggerType: "first_off",
  startedAt: "2026-11-05T08:00:00Z",
  startedBy: { id: "u1", name: "Ada Owner" },
  failures: 0,
  notes: null,
  completedAt: null,
  completedBy: null,
  abandonReason: null,
  requirements: [
    req({}),
    req({ id: "q-vis", characteristicKey: "VISUAL", charNumber: null, name: "No chatter marks", dataType: "attribute", nominal: null, lowerLimit: null, upperLimit: null, unitCode: null, gaugeType: null, criticality: "minor", sampling: [] }),
    req({ id: "q-groove", characteristicKey: "GROOVE_POS", name: "Groove position", applicable: false, applicability: "Only for HCR-200" }),
  ],
  schedule: [{ number: 1, position: 1, trigger: "first_off", requirementIds: ["q-od", "q-vis"] }],
  samples: [],
  measurements: [],
  ncrs: [],
  ...over,
});
const gauges = {
  data: [
    { id: "g1", assetNumber: "MIC-1", description: "Mic", type: { id: "t-mic", name: "Micrometer 0-25" }, status: "active", nextDueOn: "2099-01-01" },
    { id: "g2", assetNumber: "MIC-2", description: "Old mic", type: { id: "t-mic", name: "Micrometer 0-25" }, status: "active", nextDueOn: "2020-01-01" },
  ],
};

const routeApi = (routes) =>
  apiFetch.mockImplementation(async (path, opts = {}) => {
    const k = `${opts.method ?? "GET"} ${path.split("?")[0]}`;
    if (!(k in routes)) throw new Error(`unexpected ${k}`);
    return typeof routes[k] === "function" ? routes[k](path, opts) : routes[k];
  });

const renderAt = (url) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="/Inspections/new" element={<StartInspectionPage />} />
          <Route path="/Inspections/:id" element={<InspectionPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );

beforeEach(() => {
  apiFetch.mockReset();
  permissions = ["inspection.read", "inspection.record", "inspection.correct", "inspection.override_gauge", "process_control.read"];
});

describe("pass/fail preview", () => {
  const q = { lowerLimit: 24.95, upperLimit: 25.05 };
  it("uses inclusive limits on the exact decimal", () => {
    expect(previewResult(q, "25.05")).toBe("pass");
    expect(previewResult(q, "25.0500000001")).toBe("fail");
    expect(previewResult(q, "24.95")).toBe("pass");
    expect(previewResult(q, "24.9499")).toBe("fail");
    expect(previewResult({ lowerLimit: null, upperLimit: 1.6 }, "-3")).toBe("pass");
    expect(previewResult(q, "abc")).toBeNull();
  });

  it("works out the next sample: the planned one plus timed checks that are due", () => {
    const now = new Date("2026-11-05T10:00:00Z");
    const taken = { id: "s1", isRetest: false, triggerType: "first_off" };
    const insp = inspection({
      requirements: [req({ sampling: [{ triggerType: "first_off", intervalValue: null, sampleSize: 1 }, { triggerType: "every_n_minutes", intervalValue: 30, sampleSize: 1 }] }), req({ id: "q-len", sampling: [{ triggerType: "every_n_parts", intervalValue: 1, sampleSize: 1 }] })],
      schedule: [
        { number: 1, position: 1, trigger: "first_off", requirementIds: ["q-od", "q-len"] },
        { number: 2, position: 2, trigger: "every_n_parts", requirementIds: ["q-len"] },
      ],
      samples: [taken],
      measurements: [{ id: "m1", sampleId: "s1", requirementId: "q-od", measuredAt: "2026-11-05T09:00:00Z", supersedesId: null }],
    });
    expect(nextSample(insp, now)).toMatchObject({ kind: "planned", number: 2, requirementIds: ["q-len", "q-od"] });
    expect(nextSample(inspection({ ...insp, samples: [taken, { id: "s2", isRetest: false, triggerType: "every_n_parts" }] }), new Date("2026-11-05T09:10:00Z"))).toBeNull();
  });
});

describe("Start inspection", () => {
  it("starts only when the requirements resolve, sending the production context", async () => {
    let body;
    routeApi({
      "GET /machines": page([{ id: "m1", code: "LATHE-01", name: "Lathe", active: true }]),
      "GET /control-plan-resolution": { status: "ok", problems: [], part: { id: "p1", partNumber: "HCR-100", name: "Rod 100" }, partRevision: { revision: "A" }, plan: { id: "cp1", planCode: "CP-1" }, planRevision: { revisionCode: "B" }, requirements: [], overriddenPlans: [] },
      "POST /inspections": (_p, opts) => ((body = opts.body), inspection()),
      "GET /inspections/i1": inspection(),
      "GET /gauges": gauges,
    });
    renderAt("/Inspections/new?partId=p1");
    await screen.findByText("Ready for inspection");
    await userEvent.type(screen.getByLabelText("Work order"), "WO-77");
    await userEvent.selectOptions(screen.getByLabelText("Machine"), "m1");
    await userEvent.click(screen.getByRole("button", { name: "Start inspection" }));
    expect(body).toEqual({ siteId: "s1", partId: "p1", machineId: "m1", workOrder: "WO-77", lot: "", serial: "", triggerType: "manual" });
    expect(await screen.findByRole("heading", { name: "IPI-26-0001" })).toBeInTheDocument();
  });

  it("requires a lot size when the plan samples every N parts", async () => {
    let body;
    routeApi({
      "GET /machines": page([]),
      "GET /control-plan-resolution": { status: "ok", problems: [], part: { id: "p1", partNumber: "HCR-100", name: "Rod 100" }, partRevision: { revision: "A" }, plan: { id: "cp1", planCode: "CP-1" }, planRevision: { revisionCode: "B" }, requirements: [req({ sampling: [{ triggerType: "first_off", intervalValue: null, sampleSize: 1 }, { triggerType: "every_n_parts", intervalValue: 50, sampleSize: 1 }] })], overriddenPlans: [] },
      "POST /inspections": (_p, opts) => ((body = opts.body), inspection()),
      "GET /inspections/i1": inspection(),
      "GET /gauges": gauges,
    });
    renderAt("/Inspections/new?partId=p1");
    const start = await screen.findByRole("button", { name: "Start inspection" });
    expect(start).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Lot size (parts)"), "120");
    expect(start).toBeEnabled();
    await userEvent.click(start);
    expect(body).toMatchObject({ lotSize: 120, triggerType: "first_off" });
  });

  it("cannot start while blocked", async () => {
    routeApi({
      "GET /machines": page([]),
      "GET /control-plan-resolution": { status: "blocked", problems: [{ code: "ambiguous_plan", message: "More than one control plan applies" }], part: { id: "p1", partNumber: "HCR-100", name: "Rod 100" }, requirements: [] },
    });
    renderAt("/Inspections/new?partId=p1");
    expect(await screen.findByText("An inspection could not start")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start inspection" })).toBeDisabled();
  });
});

const pickGauge = async (form, name, option) => {
  await userEvent.click(within(within(form).getByRole("group", { name: `Gauge for ${name}` })).getByRole("combobox"));
  await userEvent.click(await screen.findByRole("option", { name: option }));
};

describe("Inspection page", () => {
  it("records samples in order, listing exactly the checks the plan requires for the next one", async () => {
    const withSample = inspection({
      schedule: [
        { number: 1, position: 1, trigger: "first_off", requirementIds: ["q-od", "q-vis"] },
        { number: 2, position: 2, trigger: "every_n_parts", requirementIds: ["q-od"] },
      ],
      samples: [{ id: "s1", sampleNumber: 1, sampledAt: new Date().toISOString(), unitReference: null, triggerType: "first_off", isRetest: false, notes: null, takenBy: null }],
      measurements: [{ id: "m1", sampleId: "s1", requirementId: "q-od", valueNumeric: "25.00", valuePass: null, unitCode: "mm", result: "pass", gauge: null, gaugeOverrideReason: null, measuredAt: new Date().toISOString(), measuredBy: null, supersedesId: null, supersededById: null, correctionReason: null, retestOfId: null, notes: null }],
    });
    routeApi({ "GET /inspections/i1": withSample, "GET /gauges": gauges });
    renderAt("/Inspections/i1");
    const form = await screen.findByRole("form", { name: "New sample" });
    expect(within(form).getByText("Sample 2")).toBeInTheDocument();
    expect(within(form).getByLabelText("Outer diameter reading")).toBeInTheDocument();
    expect(within(form).queryByRole("radiogroup")).not.toBeInTheDocument();
    expect(screen.getByText("1 of 2 planned samples recorded. Record them in order.")).toBeInTheDocument();
  });

  it("offers a gauge for pass/fail checks whose plan names a gauge type", async () => {
    let body;
    const gonogo = inspection({
      requirements: [req({ id: "q-thread", name: "Thread go/no-go", dataType: "attribute", nominal: null, lowerLimit: null, upperLimit: null, unitCode: null, gaugeType: { id: "t-mic", name: "Micrometer 0-25" } })],
      schedule: [{ number: 1, position: 1, trigger: "first_off", requirementIds: ["q-thread"] }],
    });
    routeApi({ "GET /inspections/i1": gonogo, "GET /gauges": gauges, "POST /inspections/i1/samples": (_p, opts) => ((body = opts.body), gonogo) });
    renderAt("/Inspections/i1");
    const form = await screen.findByRole("form", { name: "New sample" });
    await pickGauge(form, "Thread go/no-go", /MIC-1/);
    await userEvent.click(within(form).getByRole("radio", { name: "Pass" }));
    await userEvent.click(within(form).getByRole("button", { name: "Save sample" }));
    expect(body.readings).toEqual([{ requirementId: "q-thread", valuePass: true, gaugeId: "g1" }]);
    // No gauge type (e.g. a visual check): no picker.
    expect(within(form).queryByRole("group", { name: "Gauge for No chatter marks" })).not.toBeInTheDocument();
  });

  it("cannot complete while planned samples remain", async () => {
    routeApi({ "GET /inspections/i1": inspection(), "GET /gauges": gauges });
    renderAt("/Inspections/i1");
    expect(await screen.findByRole("button", { name: "Complete inspection" })).toBeDisabled();
    expect(screen.getByText(/1 planned sample still to record/)).toBeInTheDocument();
  });

  it("shows the unit next to the value input", async () => {
    routeApi({ "GET /inspections/i1": inspection(), "GET /gauges": gauges });
    renderAt("/Inspections/i1");
    const form = await screen.findByRole("form", { name: "New sample" });
    expect(within(form).getAllByText("mm").length).toBeGreaterThan(0);
  });

  it("records a sample: limits beside each input, live pass/fail, empty checks skipped", async () => {
    let body;
    routeApi({
      "GET /inspections/i1": inspection(),
      "GET /gauges": gauges,
      "POST /inspections/i1/samples": (_p, opts) => ((body = opts.body), inspection()),
    });
    renderAt("/Inspections/i1");
    const form = await screen.findByRole("form", { name: "New sample" });
    expect(within(form).getByText("LSL 24.95 · Nom 25 · USL 25.05 mm")).toBeInTheDocument();
    expect(screen.getByText("Groove position — Only for HCR-200")).toBeInTheDocument();
    await pickGauge(form, "Outer diameter", /MIC-1/);
    await userEvent.type(within(form).getByLabelText("Outer diameter reading"), "25.06");
    expect(within(form).getByRole("status", { name: "Result for Outer diameter" })).toHaveTextContent("Fail");
    await userEvent.clear(within(form).getByLabelText("Outer diameter reading"));
    await userEvent.type(within(form).getByLabelText("Outer diameter reading"), "25.05");
    expect(within(form).getByRole("status", { name: "Result for Outer diameter" })).toHaveTextContent("Pass");
    await userEvent.click(within(form).getByRole("button", { name: "Save sample" }));
    expect(within(form).getByRole("alert")).toHaveTextContent("No chatter marks: enter a reading");
    await userEvent.click(within(form).getByRole("radio", { name: "Pass" }));
    await userEvent.click(within(form).getByRole("button", { name: "Save sample" }));
    expect(body).toEqual({ unitReference: "", readings: [{ requirementId: "q-od", valueNumeric: "25.05", gaugeId: "g1" }, { requirementId: "q-vis", valuePass: true }] });
  });

  it("asks for an override reason for an overdue gauge", async () => {
    let body;
    routeApi({ "GET /inspections/i1": inspection(), "GET /gauges": gauges, "POST /inspections/i1/samples": (_p, opts) => ((body = opts.body), inspection()) });
    renderAt("/Inspections/i1");
    const form = await screen.findByRole("form", { name: "New sample" });
    await pickGauge(form, "Outer diameter", /MIC-2/);
    expect(within(form).getByText(/Gauge MIC-2 is overdue/)).toBeInTheDocument();
    await userEvent.type(within(form).getByLabelText("Override reason for Outer diameter"), "Only mic on shift");
    await userEvent.type(within(form).getByLabelText("Outer diameter reading"), "25");
    await userEvent.click(within(form).getByRole("radio", { name: "Pass" }));
    await userEvent.click(within(form).getByRole("button", { name: "Save sample" }));
    expect(body.readings).toEqual([
      { requirementId: "q-od", valueNumeric: "25", gaugeId: "g2", gaugeOverrideReason: "Only mic on shift" },
      { requirementId: "q-vis", valuePass: true },
    ]);
  });

  it("shows the latest value of a corrected reading and corrects with a reason", async () => {
    let body;
    const withReadings = inspection({
      samples: [{ id: "s1", sampleNumber: 1, sampledAt: "2026-11-05T08:05:00Z", unitReference: null, triggerType: "first_off", isRetest: false, notes: null, takenBy: null }],
      measurements: [
        { id: "m1", sampleId: "s1", requirementId: "q-od", valueNumeric: "25.50", valuePass: null, unitCode: "mm", result: "fail", gauge: null, gaugeOverrideReason: null, measuredAt: "2026-11-05T08:05:00Z", measuredBy: { id: "u1", name: "Ada" }, supersedesId: null, supersededById: "m2", correctionReason: null, retestOfId: null, notes: null, acknowledgement: null, ncrs: [] },
        { id: "m2", sampleId: "s1", requirementId: "q-od", valueNumeric: "25.00", valuePass: null, unitCode: "mm", result: "pass", gauge: null, gaugeOverrideReason: null, measuredAt: "2026-11-05T08:06:00Z", measuredBy: { id: "u1", name: "Ada" }, supersedesId: "m1", supersededById: null, correctionReason: "Typo", retestOfId: null, notes: null, acknowledgement: null, ncrs: [] },
      ],
    });
    routeApi({ "GET /inspections/i1": withReadings, "GET /gauges": gauges, "POST /inspection-measurements/m2/correction": (_p, opts) => ((body = opts.body), withReadings) });
    renderAt("/Inspections/i1");
    const grid = await screen.findByRole("table", { name: "Readings" });
    expect(within(grid).getByText("25.00")).toBeInTheDocument();
    expect(within(grid).queryByText("25.50")).toBeNull();
    await userEvent.click(within(grid).getByRole("button", { name: "Outer diameter, sample 1: details" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Correction: “Typo”")).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Correct this reading" }));
    await userEvent.type(within(dialog).getByLabelText("Corrected value"), "25.01");
    await userEvent.type(within(dialog).getByLabelText("Reason for the correction"), "Re-read the micrometer");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save correction" }));
    expect(body).toEqual({ valueNumeric: "25.01", gaugeId: null, reason: "Re-read the micrometer" });
  });

  it("is read-only for viewers and once completed", async () => {
    permissions = ["inspection.read"];
    routeApi({ "GET /inspections/i1": inspection(), "GET /gauges": gauges });
    renderAt("/Inspections/i1");
    await screen.findByRole("heading", { name: "IPI-26-0001" });
    expect(screen.queryByRole("form", { name: "New sample" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Complete inspection" })).toBeNull();
  });
});

describe("Failures and non-conformances (PC5)", () => {
  const failing = () =>
    inspection({
      requirements: [req({}), ...inspection().requirements.slice(1)].map((q) => (q.id === "q-od" ? { ...q, reactions: [{ triggerType: "any", action: "stop_line", instruction: "Stop the line and call the supervisor" }] } : q)),
      samples: [{ id: "s1", sampleNumber: 1, sampledAt: "2026-11-05T08:05:00Z", unitReference: null, triggerType: "first_off", isRetest: false, notes: null, takenBy: null }],
      measurements: [
        { id: "m1", sampleId: "s1", requirementId: "q-od", valueNumeric: "25.50", valuePass: null, unitCode: "mm", result: "fail", gauge: null, gaugeOverrideReason: null, measuredAt: "2026-11-05T08:05:00Z", measuredBy: null, supersedesId: null, supersededById: null, correctionReason: null, retestOfId: null, notes: null, acknowledgement: null, ncrs: [] },
      ],
    });
  const draft = {
    title: "Outer diameter out of limits: HCR-100 (IPI-26-0001)",
    description: "Context…",
    severity: "critical",
    quantityAffected: 1,
    requirement: "24.95–25.05 mm",
    actualResult: "25.50 mm",
    readings: [{ id: "m1", requirementName: "Outer diameter", sampleNumber: 1, value: "25.50 mm", limits: "24.95–25.05 mm", measuredAt: "2026-11-05T08:05:00Z", alreadyLinked: [] }],
    containment: [],
  };

  it("shows the reaction plan and acknowledges a failed reading with a note", async () => {
    let body;
    const f = failing();
    routeApi({ "GET /inspections/i1": f, "GET /gauges": gauges, "POST /inspection-measurements/m1/acknowledge": (_p, o) => ((body = o.body), f) });
    permissions.push("ncr.create");
    renderAt("/Inspections/i1");
    const list = await screen.findByRole("list", { name: "Failed readings" });
    expect(within(list).getByText("Stop the line and call the supervisor")).toBeInTheDocument();
    await userEvent.click(within(list).getByRole("button", { name: "Acknowledge" }));
    const dialog = screen.getByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText("What is being done"), "Quarantined the tray");
    await userEvent.click(within(dialog).getByRole("button", { name: "Acknowledge" }));
    expect(body).toEqual({ note: "Quarantined the tray" });
  });

  it("raises a pre-filled NC for ticked readings and never without the permission", async () => {
    let body;
    const f = failing();
    routeApi({
      "GET /inspections/i1": f,
      "GET /gauges": gauges,
      "GET /inspections/i1/ncr-draft": draft,
      "POST /inspections/i1/raise-ncr": (_p, o) => ((body = o.body), { ncr: { id: "n1", reference: "NC-1", stage: "draft", source: "internal" }, inspection: f }),
      "GET /ncrs/n1": {},
    });
    permissions.push("ncr.create");
    renderAt("/Inspections/i1");
    await userEvent.click(await screen.findByRole("checkbox", { name: /Select Outer diameter sample 1/ }));
    await userEvent.click(screen.getByRole("button", { name: "Raise NC for 1 selected reading" }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByLabelText("Title")).toHaveValue(draft.title);
    await userEvent.click(within(dialog).getByRole("button", { name: "Raise non-conformance" }));
    expect(body).toMatchObject({ measurementIds: ["m1"], title: draft.title, severity: "critical", quantityAffected: 1, open: false });
  });

  it("offers no NC controls without ncr.create", async () => {
    routeApi({ "GET /inspections/i1": failing(), "GET /gauges": gauges });
    renderAt("/Inspections/i1");
    await screen.findByRole("list", { name: "Failed readings" });
    expect(screen.queryByRole("button", { name: /Raise NC/ })).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("shows source readings on an NC, including a later correction", () => {
    render(
      <MemoryRouter>
        <NcrInspectionSource
          source={{
            inspections: [
              {
                id: "i1", reference: "IPI-26-0001", part: { partNumber: "HCR-100" }, plan: { planCode: "CP-1", revisionCode: "A" }, operationCode: "OP-020", startedAt: "2026-11-05T08:00:00Z", wholeInspection: false,
                readings: [{ id: "m1", requirementName: "Outer diameter", sampleNumber: 1, valueNumeric: "25.50", valuePass: null, unitCode: "mm", limits: "24.95–25.05", result: "fail", measuredAt: "2026-11-05T08:05:00Z", gaugeAssetNumber: "MIC-1", correctedTo: { valueNumeric: "25.00", valuePass: null, result: "pass", reason: "Typo" } }],
              },
            ],
          }}
        />
      </MemoryRouter>
    );
    expect(screen.getByRole("link", { name: "IPI-26-0001" })).toHaveAttribute("href", "/Inspections/i1");
    expect(screen.getByText(/Corrected later to/)).toHaveTextContent("The original reading stays on record");
  });

  it("lists the inspections that used an out-of-tolerance gauge", async () => {
    routeApi({
      "GET /calibrations/c1/gauge-usage": {
        gauge: { id: "g1", assetNumber: "MIC-1" },
        previous: { reference: "CAL-26-001", calibratedOn: "2026-05-01" },
        totals: { inspections: 1, readings: 6, failedReadings: 1 },
        inspections: [{ id: "i1", reference: "IPI-26-0001", status: "completed", partNumber: "HCR-100", readings: 6, failedReadings: 1, overrides: 0, firstUsed: "2026-11-05T08:00:00Z", lastUsed: "2026-11-05T08:00:00Z" }],
      },
    });
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter>
          <GaugeUsage calibrationId="c1" />
        </MemoryRouter>
      </QueryClientProvider>
    );
    expect(await screen.findByText(/used MIC-1 since CAL-26-001/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "IPI-26-0001" })).toBeInTheDocument();
  });
});
