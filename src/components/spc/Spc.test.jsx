import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
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
const renderAt = (url) =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="/Process-Control/SPC" element={<SpcPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
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
      await screen.findByText(
        /no numeric readings for characteristics marked for SPC/,
      ),
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
