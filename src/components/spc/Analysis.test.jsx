import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const apiFetch = vi.fn();
vi.mock("../../lib/api-client", async (importOriginal) => ({ ...(await importOriginal()), apiFetch: (...a) => apiFetch(...a) }));
vi.mock("../../contexts/OrganisationProvider", () => ({ useOrganisation: () => ({ organisationId: "org-1" }) }));
vi.mock("../../hooks/useQmsApi", () => ({ usePermissions: () => ({ can: () => true }), useSites: () => ({ data: { data: [] } }) }));
vi.mock("recharts", async (importOriginal) => ({ ...(await importOriginal()), ResponsiveContainer: ({ children }) => <div data-testid="chart-area">{children}</div> }));

import AnalysisPage from "./AnalysisPage";

const stat = (over) => ({
  n: 12, mean: null, sd: null, min: null, max: null, spec: null, outOfSpec: null, offsetPct: null, spreadPct: null, pp: null, ppk: null, expectedPpm: null,
  failed: null, rate: null, defects: null, perUnit: null, z: null, verdict: null, machineId: null, partId: null, ...over,
});
const analysis = (over = {}) => ({
  groupBy: "machine",
  scope: { kind: "part", id: "p1", label: "HCR-100 · Rod" },
  characteristic: { key: "OD", name: "Outer diameter", operationCode: "OP-020", kind: "variable", unitCode: "mm" },
  groups: [
    stat({ key: "m1", label: "L1 · Lathe 1", mean: 25, offsetPct: -2, spreadPct: 40, pp: 2.5, ppk: 2.4, outOfSpec: 0, spec: { nominal: 25, lower: 24.95, upper: 25.05 }, verdict: "lower", z: -5 }),
    stat({ key: "m2", label: "L2 · Lathe 2", mean: 25.03, offsetPct: 58, spreadPct: 40, pp: 2.5, ppk: 0.9, outOfSpec: 1, spec: { nominal: 25, lower: 24.95, upper: 25.05 }, verdict: "higher", z: 5 }),
  ],
  overall: { n: 24, mean: 25.015, sd: 0.02, offsetPct: 28, spreadPct: 60, pp: 1.6, ppk: 1.2, rate: null, perUnit: null },
  toleranceScale: false,
  excluded: [{ reason: "retest", text: "Retests (they re-measure a failed reading)", count: 2 }],
  warnings: ["2 groups have fewer than 30 readings: treat differences with care."],
  ...over,
});
const routeApi = (routes) =>
  apiFetch.mockImplementation(async (path, opts = {}) => {
    const k = `${opts.method ?? "GET"} ${path.split("?")[0]}`;
    if (!(k in routes)) throw new Error(`unexpected ${k}`);
    return typeof routes[k] === "function" ? routes[k](path, opts) : routes[k];
  });
const characteristic = { key: "OD", name: "Outer diameter", operationCode: "OP-020", chartType: null, subgroupSize: null, unitCode: "mm", readings: 24, lastMeasuredAt: "2026-11-05T08:00:00Z", hasBaseline: false };
const base = (extra = {}) => ({
  "GET /parts/p1": { id: "p1", partNumber: "HCR-100", name: "Rod", revisions: [] },
  "GET /parts": { data: [], nextCursor: null },
  "GET /part-families": { items: [{ id: "f1", code: "HCR", name: "Rods" }], data: [{ id: "f1", code: "HCR", name: "Rods" }], nextCursor: null },
  "GET /spc/characteristics": [characteristic],
  "GET /spc/analysis": analysis(),
  ...extra,
});
const renderAt = (url) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="/Process-Control/Analysis" element={<AnalysisPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );

beforeEach(() => {
  apiFetch.mockReset();
});

describe("Machine & family analysis", () => {
  it("compares machines for a part: position, Ppk and which one is different", async () => {
    routeApi(base());
    renderAt("/Process-Control/Analysis?part=p1&c=OD%7COP-020");
    const table = await screen.findByRole("table", { name: "Group comparison" });
    const l2 = within(table).getByRole("row", { name: /L2 · Lathe 2/ });
    expect(within(l2).getByText("58 %")).toBeInTheDocument();
    expect(within(l2).getByText("0.90")).toBeInTheDocument();
    expect(within(l2).getByText("Higher than the others")).toBeInTheDocument();
    expect(within(within(table).getByRole("row", { name: /L1 · Lathe 1/ })).getByText("Lower than the others")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Position and spread of 2 groups against the tolerance" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("fewer than 30 readings");
    expect(screen.getByRole("list", { name: "Excluded readings" })).toHaveTextContent("2 · Retests");
    const call = apiFetch.mock.calls.find((c) => c[0].startsWith("/spc/analysis"));
    expect(call[0]).toContain("groupBy=machine");
    expect(call[0]).toContain("partId=p1");
  });

  it("a family can be compared by machine or by part, and lists every characteristic with readings", async () => {
    const seen = [];
    routeApi(base({ "GET /spc/analysis": (path) => (seen.push(path), analysis({ groupBy: "part", scope: { kind: "family", id: "f1", label: "HCR · Rods" } })) }));
    renderAt("/Process-Control/Analysis?scope=family&family=f1&by=part&c=OD%7COP-020");
    await screen.findByRole("table", { name: "Group comparison" });
    expect(seen.at(-1)).toContain("partFamilyId=f1");
    expect(seen.at(-1)).toContain("groupBy=part");
    expect(apiFetch.mock.calls.some((c) => c[0].includes("/spc/characteristics?") && c[0].includes("partFamilyId=f1") && c[0].includes("all=true"))).toBe(true);
    expect(screen.getByLabelText("Compare by")).toHaveValue("part");
    await userEvent.selectOptions(screen.getByLabelText("Scope"), "part");
    expect(screen.queryByLabelText("Compare by")).toBeNull();
  });

  it("pass/fail shows failure rates and count shows defects per unit", async () => {
    routeApi(
      base({
        "GET /spc/analysis": analysis({
          characteristic: { key: "VISUAL", name: "No chatter", operationCode: "OP-020", kind: "attribute", unitCode: null },
          groups: [stat({ key: "m1", label: "L1", failed: 1, rate: 0.083 }), stat({ key: "m2", label: "L2", failed: 6, rate: 0.5, verdict: "higher" })],
          overall: { n: 24, mean: null, sd: null, offsetPct: null, spreadPct: null, pp: null, ppk: null, rate: 0.29, perUnit: null },
          excluded: [],
        }),
      }),
    );
    renderAt("/Process-Control/Analysis?part=p1&c=OD%7COP-020");
    const table = await screen.findByRole("table", { name: "Group comparison" });
    expect(within(table).getByRole("columnheader", { name: "Failure rate" })).toBeInTheDocument();
    expect(within(table).getByText("50.0%")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Failure rate of 2 groups" })).toBeInTheDocument();
  });

  it("explains when position and spread cannot be drawn (no two-sided tolerance)", async () => {
    routeApi(base({ "GET /spc/analysis": analysis({ groups: [stat({ key: "m1", label: "L1", mean: 1, ppk: 1.4 })] }) }));
    renderAt("/Process-Control/Analysis?part=p1&c=OD%7COP-020");
    expect(await screen.findByText(/Both specification limits are needed/)).toBeInTheDocument();
  });
});
