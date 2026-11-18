import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Outlet, Route, Routes } from "react-router-dom";

let state;
vi.mock("../../hooks/usePortal", () => ({ usePortalPerformance: () => state }));

import { PerformancePanel } from "./PortalPerformancePage";

const access = { organisationId: "o1", organisationName: "Alpha Precision", partyName: "Acme Castings", partyKind: "supplier", mfaRequired: false };
const full = {
  period: { from: "2026-08-20", to: "2026-11-17", days: 90 },
  tiles: {},
  score: { value: 82.4, band: "good" },
  delivery: {
    onTime: { value: 0.94, lines: 50, onTime: 47, late: 3, early: 0 },
    inFull: { value: 0.98, lines: 50, inFull: 49, short: 1, over: 0 },
    otif: { value: 0.92 },
  },
  quality: {
    ppm: { value: 410, rejectedUnits: 4, receivedUnits: 9756 },
    ppmNc: { value: null, affectedUnits: 0, receivedUnits: 9756 },
    lotRejection: { rate: 0.02, rejectedLines: 1, lines: 50 },
  },
  ncs: { total: 3, critical: 0, major: 1, minor: 2, repeat: 0 },
  scars: { issued: 2, answeredOnTime: 1, answeredLate: 0, overdueNow: 0, awaitingYou: 1 },
  certs: { current: 2, expired: 0, expiringSoon: 1 },
  trend: [{ from: "2026-10-01", to: "2026-10-31", score: 80, band: "good" }],
  ranking: { band: "upper_half", enough: true },
};

const renderIt = () =>
  render(
    <MemoryRouter initialEntries={["/portal/performance"]}>
      <Routes>
        <Route path="/portal" element={<Outlet context={{ access }} />}>
          <Route path="performance" element={<PerformancePanel access={access} />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );

beforeEach(() => {
  state = { data: full, isLoading: false, error: null };
});

describe("your performance in the portal", () => {
  it("shows every figure in words, with the score and where the supplier stands", () => {
    renderIt();
    expect(screen.getByRole("heading", { name: "Your performance" })).toBeInTheDocument();
    expect(screen.getAllByText("Good").length).toBeGreaterThan(0);
    expect(screen.getByText("47 of 50 delivered lines on time (3 late, 0 early)")).toBeInTheDocument();
    expect(screen.getByText("49 of 50 order lines in full (1 short, 0 over)")).toBeInTheDocument();
    expect(screen.getByText("4 of 9756 units rejected")).toBeInTheDocument();
    expect(screen.getByText("In the upper half of our suppliers")).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Monthly scores" })).toHaveTextContent("80");
  });

  it("leaves out a tile the server did not send", () => {
    const { delivery, trend, ranking, ...rest } = full;
    void delivery; void trend; void ranking;
    state = { data: rest, isLoading: false, error: null };
    renderIt();
    expect(screen.queryByText("Delivery")).toBeNull();
    expect(screen.queryByText("Monthly trend")).toBeNull();
    expect(screen.queryByText(/our suppliers/)).toBeNull();
    expect(screen.getByText("Quality of what you delivered")).toBeInTheDocument();
  });

  it("explains an empty score and a position that is not ready", () => {
    state = { data: { ...full, score: { value: null, band: "insufficient" }, ranking: { band: null, enough: false }, trend: [] }, isLoading: false, error: null };
    renderIt();
    expect(screen.getByText("No score yet")).toBeInTheDocument();
    expect(screen.getByText(/once enough suppliers have a score/)).toBeInTheDocument();
    expect(screen.getByText(/Monthly scores will appear here/)).toBeInTheDocument();
  });
});
