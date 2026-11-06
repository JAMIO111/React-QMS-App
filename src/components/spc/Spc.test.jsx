import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { chartRows, decimalsOf, yDomain } from "../../lib/spc";

let permissions;
const apiFetch = vi.fn();
vi.mock("../../lib/api-client", async (importOriginal) => ({
  ...(await importOriginal()),
  apiFetch: (...a) => apiFetch(...a),
}));
vi.mock("../../contexts/OrganisationProvider", () => ({
  useOrganisation: () => ({ organisationId: "org-1" }),
}));
vi.mock("../../hooks/useQmsApi", () => ({
  usePermissions: () => ({ can: (p) => permissions.includes(p) }),
  useSites: () => ({ data: { data: [] } }),
}));
// Recharts measures its container, which jsdom cannot do; the chart's content is tested through its data and labels.
vi.mock("recharts", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    ResponsiveContainer: ({ children }) => (
      <div data-testid="chart-area">{children}</div>
    ),
  };
});

import SpcPage from "./SpcPage";

const limits = {
  centre: 25.003,
  ucl: 25.043,
  lcl: 24.963,
  dispersionCentre: 0.015,
  dispersionUcl: 0.049,
  dispersionLcl: 0,
  sigma: 0.013,
};
const point = (i, value, extra = {}) => ({
  index: i,
  at: `2026-11-05T08:${String(10 + i).padStart(2, "0")}:00Z`,
  value,
  dispersion: i === 0 ? null : 0.01,
  readings: [{ id: `m${i}`, value: value.toFixed(3), sampleNumber: i + 1 }],
  inspections: [{ id: "i1", reference: "IPI-26-0001" }],
  lot: "LOT-1",
  machineId: null,
  gaugeOverride: false,
  ...extra,
});
const chart = (over = {}) => ({
  part: { id: "p1", partNumber: "HCR-100", name: "Rod 100" },
  characteristic: {
    key: "OD",
    name: "Outer diameter",
    operationCode: "OP-020",
    chartType: "imr",
    subgroupSize: 1,
    unitCode: "mm",
  },
  spec: { nominal: 25, lower: 24.95, upper: 25.05 },
  points: [point(0, 25), point(1, 25.01), point(2, 24.99), point(3, 25.049)],
  limitsSource: "trial",
  limits,
  provisional: true,
  rules: ["we1", "we2", "we3", "we4"],
  signals: [
    {
      rule: "we1",
      text: "One point beyond 3σ (outside the control limits)",
      index: 3,
      involved: [3],
      side: "above",
    },
  ],
  dispersionSignals: [],
  noVariation: false,
  warnings: [
    "Trial limits: calculated from the points shown, not a saved baseline. Save a baseline to fix them.",
  ],
  excluded: [
    {
      reason: "retest",
      text: "Retests (they re-measure a failed reading)",
      count: 2,
    },
  ],
  baseline: null,
  baselineIssue: null,
  reactions: [
    {
      action: "notify",
      instruction: "Tell the quality engineer; do not adjust the machine yet",
    },
  ],
  ...over,
});

const routeApi = (routes) =>
  apiFetch.mockImplementation(async (path, opts = {}) => {
    const k = `${opts.method ?? "GET"} ${path.split("?")[0]}`;
    if (!(k in routes)) throw new Error(`unexpected ${k}`);
    return typeof routes[k] === "function" ? routes[k](path, opts) : routes[k];
  });
const base = (extra = {}) => ({
  "GET /parts/p1": {
    id: "p1",
    partNumber: "HCR-100",
    name: "Rod 100",
    revisions: [],
  },
  "GET /parts": { data: [], nextCursor: null },
  "GET /machines": { data: [], nextCursor: null },
  "GET /spc/characteristics": [
    {
      key: "OD",
      name: "Outer diameter",
      operationCode: "OP-020",
      chartType: "imr",
      subgroupSize: 1,
      unitCode: "mm",
      readings: 4,
      lastMeasuredAt: "2026-11-05T08:13:00Z",
      hasBaseline: false,
    },
  ],
  "GET /spc/chart": chart(),
  "GET /spc/baselines": [],
  ...extra,
});
const renderAt = (url) => {
  let search = "";
  const Where = () => ((search = useLocation().search), null);
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route
            path="/Process-Control/SPC"
            element={
              <>
                <SpcPage />
                <Where />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return () => search;
};
const URL = "/Process-Control/SPC?part=p1";

beforeEach(() => {
  apiFetch.mockReset();
  permissions = ["spc.read", "spc.manage", "inspection.read"];
});

describe("helpers", () => {
  it("shows one more decimal than was recorded, at most five", () => {
    expect(decimalsOf([point(0, 25.049)])).toBe(4);
    expect(decimalsOf([{ readings: [{ value: "25" }] }])).toBe(1);
    expect(decimalsOf([{ readings: [{ value: "1.123456789" }] }])).toBe(5);
  });
  it("flags points with the rules they break and keeps the data, limits and spec in the axis range", () => {
    const rows = chartRows(chart());
    expect(rows.map((r) => r.rules)).toEqual([[], [], [], ["we1"]]);
    const [lo, hi] = yDomain([25, 25.049], [25.043, 24.963, 24.95, 25.05]);
    expect(lo).toBeLessThan(24.95);
    expect(hi).toBeGreaterThan(25.05);
  });
});

describe("SPC page", () => {
  it("shows the chart with trial limits, the signal and its rule, the plan’s reaction and what was left out", async () => {
    routeApi(base());
    renderAt(`${URL}&c=OD%7COP-020`);
    expect(
      await screen.findByText(/Trial limits \(provisional\)/),
    ).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Trial limits: calculated from the points shown",
    );
    const signals = screen.getByRole("table", { name: "Signals" });
    expect(
      within(signals).getByText(/Rule 1: One point beyond 3σ/),
    ).toBeInTheDocument();
    expect(
      within(signals).getByRole("link", { name: "IPI-26-0001" }),
    ).toHaveAttribute("href", "/Inspections/i1");
    expect(
      screen.getByText(
        "Tell the quality engineer; do not adjust the machine yet",
      ),
    ).toBeInTheDocument();
    // A signal is a process signal, not a product failure.
    expect(
      screen.getByText(/does not mean product is nonconforming/),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole("list", { name: "Excluded readings" })).getByText(
        /2 · Retests/,
      ),
    ).toBeInTheDocument();
    // Control limits and specification are described separately.
    const key = screen.getByRole("list", { name: "Chart key" });
    expect(
      within(key).getByText(/Control limits \(UCL\/LCL, from the process\)/),
    ).toBeInTheDocument();
    expect(
      within(key).getByText(/Specification \(USL\/LSL, from the drawing\)/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("img", {
        name: "Individual value chart, 4 points, 1 signal",
      }),
    ).toBeInTheDocument();
  });

  it("offers the data as a table with a signal column", async () => {
    routeApi(base());
    renderAt(`${URL}&c=OD%7COP-020`);
    const table = await screen.findByRole("table", {
      name: "Chart data",
      hidden: true,
    });
    const rows = within(table).getAllByRole("row", { hidden: true });
    expect(rows).toHaveLength(5);
    expect(within(rows[4]).getByText("Rule 1")).toBeInTheDocument();
  });

  it("asks for a part first and explains an empty characteristic list", async () => {
    routeApi(base({ "GET /spc/characteristics": [] }));
    renderAt(URL);
    expect(
      await screen.findByText(/no readings for characteristics marked for SPC/),
    ).toBeInTheDocument();
    expect(apiFetch.mock.calls.some(([p]) => p.startsWith("/spc/chart"))).toBe(
      false,
    );
  });

  it("sends the chosen rules; switching one off keeps the others", async () => {
    routeApi(base());
    renderAt(`${URL}&c=OD%7COP-020`);
    await screen.findByText(/Trial limits \(provisional\)/);
    await userEvent.click(screen.getByRole("checkbox", { name: /Rule 2:/ }));
    await screen.findByRole("checkbox", { name: /Rule 2:/ });
    const last = apiFetch.mock.calls
      .filter(([p]) => p.startsWith("/spc/chart"))
      .pop()[0];
    expect(decodeURIComponent(last)).toContain("rules=we1,we3,we4");
  });

  it("explains a baseline that cannot be used", async () => {
    routeApi(
      base({
        "GET /spc/chart": chart({
          baselineIssue:
            "The saved baseline was made with a different subgroup size or unit, so it is not used. Save a new baseline.",
        }),
      }),
    );
    renderAt(`${URL}&c=OD%7COP-020`);
    expect(
      await screen.findByText(/different subgroup size or unit/),
    ).toBeInTheDocument();
  });

  it("says plainly when there are too few points for limits", async () => {
    routeApi(
      base({
        "GET /spc/chart": chart({
          limitsSource: "none",
          limits: null,
          signals: [],
          points: [point(0, 25), point(1, 25.01)],
          warnings: [
            "At least 5 readings are needed before limits can be shown; there are 2.",
          ],
        }),
      }),
    );
    renderAt(`${URL}&c=OD%7COP-020`);
    expect(await screen.findByRole("status")).toHaveTextContent(
      "At least 5 readings are needed before limits can be shown",
    );
    expect(screen.getByText(/No limits yet/)).toBeInTheDocument();
  });
});

describe("Baseline panel", () => {
  const saved = {
    id: "b1",
    partId: "p1",
    characteristicKey: "OD",
    operationCode: "OP-020",
    chartType: "imr",
    subgroupSize: 1,
    unitCode: "mm",
    windowFrom: "2026-11-05T08:10:00Z",
    windowTo: "2026-11-05T09:10:00Z",
    points: 12,
    provisional: true,
    spec: { nominal: 25, lower: 24.95, upper: 25.05 },
    limits,
    rules: ["we1", "we2", "we3", "we4"],
    notes: "Stable run",
    createdAt: "2026-11-05T09:11:00Z",
    createdBy: { id: "u1", name: "Ada" },
    supersededAt: null,
    supersededBy: null,
  };

  it("saves a baseline from the first N points with the ticked rules", async () => {
    let body;
    routeApi(
      base({ "POST /spc/baselines": (_p, o) => ((body = o.body), saved) }),
    );
    renderAt(`${URL}&c=OD%7COP-020`);
    const form = await screen.findByRole("form", { name: "Save a baseline" });
    await userEvent.click(
      within(form).getByRole("radio", { name: "The first N" }),
    );
    const n = within(form).getByLabelText(/Number of readings/);
    await userEvent.clear(n);
    await userEvent.type(n, "12");
    await userEvent.type(within(form).getByLabelText(/Note/), "Stable run");
    await userEvent.click(
      within(form).getByRole("button", { name: "Calculate and save baseline" }),
    );
    expect(body).toEqual({
      partId: "p1",
      characteristicKey: "OD",
      operationCode: "OP-020",
      rules: ["we1", "we2", "we3", "we4"],
      notes: "Stable run",
      firstN: 12,
    });
    expect(await within(form).findByRole("status")).toHaveTextContent(
      "Baseline saved from 12 readings",
    );
  });

  it("shows the baseline in use and the history, including replaced limits", async () => {
    routeApi(
      base({
        "GET /spc/chart": chart({
          limitsSource: "baseline",
          baseline: saved,
          provisional: true,
        }),
        "GET /spc/baselines": [
          saved,
          {
            ...saved,
            id: "b0",
            points: 8,
            supersededAt: "2026-11-05T09:11:00Z",
            supersededBy: "b1",
          },
        ],
      }),
    );
    renderAt(`${URL}&c=OD%7COP-020`);
    expect(await screen.findByText(/In use: 12 readings/)).toHaveTextContent(
      "saved",
    );
    expect(screen.getByText(/Provisional: too few points/)).toBeInTheDocument();
    const history = await screen.findByRole("table", {
      name: "Baseline history",
    });
    expect(within(history).getByText("Current")).toBeInTheDocument();
    expect(within(history).getByText(/Replaced/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Calculate and replace baseline" }),
    ).toBeInTheDocument();
  });

  it("is read-only without spc.manage", async () => {
    permissions = ["spc.read", "inspection.read"];
    routeApi(base());
    renderAt(`${URL}&c=OD%7COP-020`);
    await screen.findByText(/No baseline saved/);
    expect(screen.queryByRole("form", { name: "Save a baseline" })).toBeNull();
  });
});

describe("P chart", () => {
  const pPoint = (i, n, failed, ucl, extra = {}) => ({
    index: i,
    at: `2026-11-05T08:${String(10 + i).padStart(2, "0")}:00Z`,
    value: failed / n,
    dispersion: null,
    readings: [],
    inspections: [{ id: `i${i}`, reference: `IPI-26-000${i + 1}` }],
    lot: null,
    machineId: null,
    gaugeOverride: false,
    n,
    failed,
    ucl,
    lcl: 0,
    z: 0,
    ...extra,
  });
  const pChart = (over = {}) => ({
    part: { id: "p1", partNumber: "HCR-100", name: "Rod 100" },
    characteristic: {
      key: "VISUAL",
      name: "No chatter marks",
      operationCode: "OP-020",
      chartType: "p",
      subgroupSize: null,
      unitCode: null,
    },
    spec: { nominal: null, lower: null, upper: null },
    points: [
      pPoint(0, 20, 1, 0.19),
      pPoint(1, 20, 2, 0.19),
      pPoint(2, 40, 9, 0.17, { z: 5.1 }),
    ],
    limitsSource: "trial",
    limits: {
      centre: 0.125,
      ucl: 0.2,
      lcl: 0,
      sigma: 0.07,
      dispersionCentre: null,
      dispersionUcl: null,
      dispersionLcl: null,
    },
    provisional: true,
    rules: ["we1", "we2", "we3", "we4"],
    signals: [
      {
        rule: "we1",
        text: "One point beyond 3σ (outside the control limits)",
        index: 2,
        involved: [2],
        side: "above",
      },
    ],
    dispersionSignals: [],
    noVariation: false,
    warnings: [
      "Trial limits: calculated from the subgroups shown, not a saved baseline. Save a baseline to fix them.",
    ],
    excluded: [
      {
        reason: "no_lot",
        text: "Checks of an inspection without a lot number (subgroups by lot)",
        count: 20,
      },
    ],
    baseline: null,
    baselineIssue: null,
    subgroup: {
      basis: "inspection",
      meanSize: 26.7,
      expectedFailures: 3.3,
      reliable: false,
    },
    reactions: [],
    ...over,
  });
  const pBase = (extra = {}) =>
    base({
      "GET /spc/characteristics": [
        {
          key: "VISUAL",
          name: "No chatter marks",
          operationCode: "OP-020",
          chartType: "p",
          subgroupSize: null,
          unitCode: null,
          readings: 80,
          lastMeasuredAt: "2026-11-05T08:13:00Z",
          hasBaseline: false,
        },
      ],
      "GET /spc/chart": pChart(),
      ...extra,
    });

  it("shows proportions with a subgroup choice, per-subgroup limits and no spec or range chart", async () => {
    routeApi(pBase());
    renderAt(`${URL}&c=VISUAL%7COP-020`);
    expect(
      await screen.findByText(/P chart \(proportion failed\)/),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/Subgroup \(one point is/)).toHaveValue(
      "inspection",
    );
    expect(
      screen.queryByRole("checkbox", { name: /Show specification limits/ }),
    ).toBeNull();
    expect(screen.queryByText("Moving range")).toBeNull();
    expect(
      screen.getByRole("img", {
        name: "Proportion failed chart, 3 points, 1 signal",
      }),
    ).toBeInTheDocument();
    const key = screen.getByRole("list", { name: "Chart key" });
    expect(
      within(key).getByText(/recalculated for each subgroup's size/),
    ).toBeInTheDocument();
    expect(within(key).queryByText(/Specification/)).toBeNull();
    expect(
      within(screen.getByRole("table", { name: "Signals" })).getByText(
        /Rule 1: One point beyond 3σ/,
      ),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole("list", { name: "Excluded readings" })).getByText(
        /20 · Checks of an inspection without a lot number/,
      ),
    ).toBeInTheDocument();
  });

  it("lists checks, failures, proportion and each subgroup's limits in the data table", async () => {
    routeApi(pBase());
    renderAt(`${URL}&c=VISUAL%7COP-020`);
    const table = await screen.findByRole("table", {
      name: "Chart data",
      hidden: true,
    });
    const rows = within(table).getAllByRole("row", { hidden: true });
    const last = within(rows[3])
      .getAllByRole("cell", { hidden: true })
      .map((c) => c.textContent);
    expect(last.slice(2)).toEqual([
      "40",
      "9",
      "22.50%",
      "0.00% to 17.00%",
      "Rule 1",
    ]);
  });

  it("asks the API for the chosen subgroup and keeps it in the URL", async () => {
    routeApi(pBase());
    const where = renderAt(`${URL}&c=VISUAL%7COP-020`);
    await screen.findByLabelText(/Subgroup \(one point is/);
    await userEvent.selectOptions(
      screen.getByLabelText(/Subgroup \(one point is/),
      "day",
    );
    await screen.findByRole("img", { name: /Proportion failed chart/ });
    const last = apiFetch.mock.calls
      .filter(([p]) => p.startsWith("/spc/chart"))
      .pop()[0];
    expect(decodeURIComponent(last)).toContain("subgroup=day");
    expect(where()).toContain("basis=day");
  });

  it("saves a P baseline with the subgroup in use and shows it in proportions", async () => {
    let body;
    const saved = {
      id: "b1",
      partId: "p1",
      characteristicKey: "VISUAL",
      operationCode: "OP-020",
      chartType: "p",
      subgroupSize: null,
      subgroupBasis: "day",
      meanSubgroupSize: 80,
      unitCode: null,
      windowFrom: "2026-11-01T08:00:00Z",
      windowTo: "2026-11-05T08:00:00Z",
      points: 5,
      provisional: true,
      spec: { nominal: null, lower: null, upper: null },
      limits: {
        centre: 0.06,
        ucl: 0.14,
        lcl: 0,
        sigma: 0.03,
        dispersionCentre: null,
        dispersionUcl: null,
        dispersionLcl: null,
      },
      rules: ["we1"],
      notes: null,
      createdAt: "2026-11-05T09:11:00Z",
      createdBy: { id: "u1", name: "Ada" },
      supersededAt: null,
      supersededBy: null,
    };
    routeApi(
      pBase({ "POST /spc/baselines": (_p, o) => ((body = o.body), saved) }),
    );
    renderAt(`${URL}&c=VISUAL%7COP-020&basis=day`);
    const form = await screen.findByRole("form", { name: "Save a baseline" });
    expect(
      within(form).getByRole("radio", {
        name: /All subgroups \(one day each\)/,
      }),
    ).toBeInTheDocument();
    await userEvent.click(
      within(form).getByRole("button", { name: "Calculate and save baseline" }),
    );
    expect(body).toMatchObject({
      partId: "p1",
      characteristicKey: "VISUAL",
      operationCode: "OP-020",
      subgroup: "day",
    });
  });

  it("shows the baseline in use as a proportion with its subgroup, and says when it was made for another subgroup", async () => {
    const baseline = {
      id: "b1",
      partId: "p1",
      characteristicKey: "VISUAL",
      operationCode: "OP-020",
      chartType: "p",
      subgroupSize: null,
      subgroupBasis: "inspection",
      meanSubgroupSize: 20,
      unitCode: null,
      windowFrom: "2026-11-01T08:00:00Z",
      windowTo: "2026-11-05T08:00:00Z",
      points: 12,
      provisional: true,
      spec: { nominal: null, lower: null, upper: null },
      limits: {
        centre: 0.06,
        ucl: 0.2,
        lcl: 0,
        sigma: 0.05,
        dispersionCentre: null,
        dispersionUcl: null,
        dispersionLcl: null,
      },
      rules: ["we1"],
      notes: null,
      createdAt: "2026-11-05T09:11:00Z",
      createdBy: { id: "u1", name: "Ada" },
      supersededAt: null,
      supersededBy: null,
    };
    routeApi(
      pBase({
        "GET /spc/chart": pChart({ limitsSource: "baseline", baseline }),
        "GET /spc/baselines": [baseline],
      }),
    );
    renderAt(`${URL}&c=VISUAL%7COP-020`);
    expect(await screen.findByText(/In use: 12 subgroups/)).toBeInTheDocument();
    expect(
      screen.getByText("Centre line p̄ (proportion failed)").nextSibling,
    ).toHaveTextContent("6.00%");
    expect(screen.getByText("Subgroup").nextSibling).toHaveTextContent(
      "one inspection",
    );
    const history = await screen.findByRole("table", {
      name: "Baseline history",
    });
    expect(within(history).getByText("6.00%")).toBeInTheDocument();
  });
});

describe("NP, C and U charts", () => {
  const cPoint = (i, n, failed, ucl, extra = {}) => ({
    index: i,
    at: `2026-11-05T08:${String(10 + i).padStart(2, "0")}:00Z`,
    value: failed,
    dispersion: null,
    readings: [],
    inspections: [{ id: `i${i}`, reference: `IPI-26-000${i + 1}` }],
    lot: null,
    machineId: null,
    gaugeOverride: false,
    n,
    failed,
    ucl,
    lcl: 0,
    z: 0,
    ...extra,
  });
  const countChart = (variant, over = {}) => ({
    part: { id: "p1", partNumber: "HCR-100", name: "Rod 100" },
    characteristic: {
      key: variant === "np" ? "VISUAL" : "SCRATCH",
      name: variant === "np" ? "No chatter marks" : "Scratches",
      operationCode: "OP-020",
      chartType: variant === "np" ? "p" : "defects",
      subgroupSize: null,
      unitCode: null,
    },
    variant,
    spec: { nominal: null, lower: null, upper: null },
    points: [cPoint(0, 10, 8, 11.3), cPoint(1, 10, 12, 11.3), cPoint(2, 10, 30, 11.3, { z: 5.1 })],
    limitsSource: "trial",
    limits: { centre: 5, ucl: 11.7, lcl: 0, sigma: 2.2, dispersionCentre: null, dispersionUcl: null, dispersionLcl: null },
    provisional: true,
    rules: ["we1", "we2", "we3", "we4"],
    signals: [{ rule: "we1", text: "One point beyond 3σ (outside the control limits)", index: 2, involved: [2], side: "above" }],
    dispersionSignals: [],
    noVariation: false,
    warnings: [],
    excluded: [{ reason: "size", text: "Subgroups of a different size than the NP chart uses (10)", count: 1 }],
    baseline: null,
    baselineIssue: null,
    subgroup: { basis: "inspection", meanSize: 10, expectedFailures: 5, reliable: true, size: 10 },
    reactions: [],
    ...over,
  });
  const option = (key, name, chartType) => ({
    key,
    name,
    operationCode: "OP-020",
    chartType,
    subgroupSize: null,
    unitCode: null,
    readings: 30,
    lastMeasuredAt: "2026-11-05T08:13:00Z",
    hasBaseline: false,
  });

  it("a defects characteristic shows a C chart with defect counts, per-subgroup limits and no spec or range chart", async () => {
    routeApi(base({ "GET /spc/characteristics": [option("SCRATCH", "Scratches", "defects")], "GET /spc/chart": countChart("c") }));
    renderAt(`${URL}&c=SCRATCH%7COP-020`);
    expect(await screen.findByText(/C chart \(defects per subgroup\)/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Subgroup \(one point is/)).toHaveValue("inspection");
    expect(screen.queryByLabelText("Show as")).toBeNull();
    expect(screen.queryByRole("checkbox", { name: /Show specification limits/ })).toBeNull();
    expect(screen.queryByText("Moving range")).toBeNull();
    expect(screen.getByRole("img", { name: "Defects chart, 3 points, 1 signal" })).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "Chart key" })).getByText(/Centre line c̄/)).toBeInTheDocument();
    expect(within(screen.getByRole("table", { name: "Signals" })).getByText(/Rule 1: One point beyond 3σ/)).toBeInTheDocument();
    await userEvent.click(screen.getByText("Show the data behind the chart"));
    const data = screen.getByRole("table", { name: "Chart data" });
    expect(within(data).getByRole("columnheader", { name: "Units" })).toBeInTheDocument();
    expect(within(data).getByRole("columnheader", { name: "Defects" })).toBeInTheDocument();
  });

  it("a U chart plots defects per unit", async () => {
    routeApi(
      base({
        "GET /spc/characteristics": [option("SCRATCH", "Scratches", "defects")],
        "GET /spc/chart": countChart("u", { points: [cPoint(0, 10, 8, 1.4, { value: 0.8 }), cPoint(1, 5, 6, 2.1, { value: 1.2 })], signals: [] }),
      }),
    );
    renderAt(`${URL}&c=SCRATCH%7COP-020`);
    expect(await screen.findByText(/U chart \(defects per unit\)/)).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Defects per unit chart, 2 points, 0 signals" })).toBeInTheDocument();
    await userEvent.click(screen.getByText("Show the data behind the chart"));
    const data = screen.getByRole("table", { name: "Chart data" });
    expect(within(data).getByRole("columnheader", { name: "Defects per unit" })).toBeInTheDocument();
    expect(within(data).getByText("1.2")).toBeInTheDocument();
  });

  it("a pass/fail characteristic can be shown as an NP chart; the size is calculated unless one is typed", async () => {
    const seen = [];
    routeApi(
      base({
        "GET /spc/characteristics": [option("VISUAL", "No chatter marks", "p")],
        "GET /spc/chart": (path) => {
          seen.push(path);
          return path.includes("display=np") ? countChart("np") : countChart("p", { characteristic: { key: "VISUAL", name: "No chatter marks", operationCode: "OP-020", chartType: "p", subgroupSize: null, unitCode: null }, points: [cPoint(0, 10, 2, 0.4, { value: 0.2 })], signals: [], excluded: [] });
        },
      }),
    );
    const search = renderAt(`${URL}&c=VISUAL%7COP-020&display=np`);
    expect(await screen.findByText(/NP chart \(number failed, subgroups of one size\)/)).toBeInTheDocument();
    expect(screen.getByLabelText("Show as")).toHaveValue("np");
    expect(seen.at(-1)).toMatch(/display=np/);
    expect(seen.at(-1)).toMatch(/size=auto/);
    expect(screen.getByText(/Calculated: the most common size, 10 checks per subgroup/)).toBeInTheDocument();
    expect(screen.getByText(/Subgroups of a different size/)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/NP subgroup size/), "8");
    expect(search()).toContain("size=8");
  });
});

describe("count helpers", () => {
  it("formats counts and finds an axis from zero that holds the points and limits", async () => {
    const { countDomain, formatCount } = await import("../../lib/spc");
    expect(formatCount(1.2345)).toBe("1.23");
    expect(formatCount(null)).toBe("—");
    const [lo, hi] = countDomain([{ value: 3, ucl: 11 }, { value: 30, ucl: null }]);
    expect(lo).toBe(0);
    expect(hi).toBeGreaterThan(30);
  });
});
