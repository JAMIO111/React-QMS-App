import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { DashboardPeriodPicker } from "./DashboardPeriod";
import { useDashboardPeriod } from "../../hooks/useDashboardPeriod";
import { DASHBOARD_PERIODS, periodParams, readPeriod } from "@/lib/dashboardPeriod";

// Only the clock is faked: "today" is Tuesday 10 November 2026.
beforeEach(() => vi.useFakeTimers({ toFake: ["Date"], now: new Date(2026, 10, 10, 9, 0) }));
afterEach(() => vi.useRealTimers());

const Probe = ({ defaultId = "90d" }) => {
  const period = useDashboardPeriod(defaultId);
  const { search } = useLocation();
  return (
    <>
      <DashboardPeriodPicker period={period} />
      <output data-testid="range">{`${period.fromIso}..${period.toIso}`}</output>
      <output data-testid="search">{search}</output>
    </>
  );
};
const renderAt = (url = "/") => render(<MemoryRouter initialEntries={[url]}><Probe /></MemoryRouter>);
const open = async () => {
  await userEvent.click(screen.getByRole("button", { name: /^Period/ }));
  return screen.getByRole("dialog", { name: "Choose period" });
};

describe("dashboard period picker", () => {
  it("shows the default preset by name and opens on the list of presets", async () => {
    renderAt();
    expect(screen.getByRole("button", { name: /^Period/ })).toHaveTextContent("Last 90 days");
    const cal = await open();
    expect(within(cal).getByRole("group", { name: "Preset dates" })).toBeInTheDocument();
    expect(within(cal).queryByRole("button", { name: "Previous month" })).toBeNull();
    expect(screen.getByTestId("range")).toHaveTextContent("2026-08-13..2026-11-10");
  });

  it("choosing a preset puts its id in the address, and the default leaves the address clean", async () => {
    renderAt();
    let cal = await open();
    await userEvent.click(within(cal).getByRole("button", { name: /^Last quarter/ }));
    expect(screen.getByTestId("search")).toHaveTextContent("?period=lastQuarter");
    expect(screen.getByTestId("range")).toHaveTextContent("2026-07-01..2026-09-30");
    cal = await open();
    await userEvent.click(within(cal).getByRole("button", { name: /^Last 90 days/ }));
    expect(screen.getByTestId("search").textContent).toBe("");
  });

  it("Custom range opens the calendar for any two days, kept as from and to", async () => {
    renderAt();
    const cal = await open();
    await userEvent.click(within(cal).getByRole("button", { name: "Custom range" }));
    await userEvent.click(within(cal).getByRole("button", { name: "Previous month" }));
    await userEvent.click(within(cal).getByRole("button", { name: "Thursday 8 October 2026" }));
    await userEvent.click(within(cal).getByRole("button", { name: "Wednesday 14 October 2026" }));
    await userEvent.click(within(cal).getByRole("button", { name: "Done" }));
    expect(screen.getByTestId("search")).toHaveTextContent("?from=2026-10-08&to=2026-10-14");
    expect(screen.getByRole("button", { name: /^Period/ })).toHaveTextContent("8 Oct 2026 – 14 Oct 2026");
  });

  it("cannot pick days after today", async () => {
    renderAt();
    const cal = await open();
    await userEvent.click(within(cal).getByRole("button", { name: "Custom range" }));
    expect(within(cal).getByRole("button", { name: "Wednesday 11 November 2026" })).toBeDisabled();
    expect(within(cal).getByRole("button", { name: "Tuesday 10 November 2026" })).toBeEnabled();
  });

  it("starts from a custom range in the address, and ignores one that is not valid", () => {
    renderAt("/?from=2026-01-05&to=2026-02-06");
    expect(screen.getByTestId("range")).toHaveTextContent("2026-01-05..2026-02-06");
  });
});

describe("period helpers", () => {
  const today = new Date(2026, 10, 10);
  const at = (q, d = "90d") => readPeriod(new URLSearchParams(q), d, today);

  it("reads presets, the older ids and falls back to the default", () => {
    expect(at("period=12m")).toMatchObject({ id: "12m", fromIso: "2025-11-11", toIso: "2026-11-10" });
    expect(at("period=ytd")).toMatchObject({ fromIso: "2026-01-01", toIso: "2026-11-10" });
    expect(at("period=lastMonth")).toMatchObject({ fromIso: "2026-10-01", toIso: "2026-10-31" });
    expect(at("period=lastYear")).toMatchObject({ fromIso: "2025-01-01", toIso: "2025-12-31" });
    expect(at("period=thisQuarter")).toMatchObject({ fromIso: "2026-10-01", toIso: "2026-11-10" });
    expect(at("period=nonsense")).toMatchObject({ id: "90d", fromIso: "2026-08-13" });
    expect(at("")).toMatchObject({ id: "90d" });
  });

  it("rejects a custom range that is back to front, in the future or longer than three years", () => {
    expect(at("from=2026-03-01&to=2026-02-01").id).toBe("90d");
    expect(at("from=2026-10-01&to=2026-12-01").id).toBe("90d");
    expect(at("from=2020-01-01&to=2026-11-10").id).toBe("90d");
    expect(at("from=2026-02-30&to=2026-03-01").id).toBe("90d");
    expect(at("from=2026-02-01&to=2026-03-01").id).toBe("custom");
  });

  it("every preset ends today or earlier and starts before it ends", () => {
    for (const p of DASHBOARD_PERIODS) {
      const [a, b] = p.range(today);
      expect(a <= b).toBe(true);
      expect(b <= today).toBe(true);
    }
  });

  it("writes the address: a preset id, nothing for the default, or from and to", () => {
    const range = (id) => { const [from, to] = DASHBOARD_PERIODS.find((p) => p.id === id).range(today); return { from, to }; };
    expect(periodParams(range("lastQuarter"), "90d", today)).toEqual({ period: "lastQuarter" });
    expect(periodParams(range("90d"), "90d", today)).toEqual({});
    expect(periodParams({ from: new Date(2026, 9, 8), to: new Date(2026, 9, 14) }, "90d", today)).toEqual({ from: "2026-10-08", to: "2026-10-14" });
  });
});
