import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import DateRangeFilter from "./DateRangeFilter";

// Only the clock is faked: "today" is Tuesday 10 November 2026.
beforeEach(() => vi.useFakeTimers({ toFake: ["Date"], now: new Date(2026, 10, 10, 9, 0) }));
afterEach(() => vi.useRealTimers());

const Harness = ({ initial = {}, ...props }) => {
  const [range, setRange] = useState({ from: null, to: null, ...initial });
  return (
    <>
      <DateRangeFilter label="Detected" from={range.from} to={range.to} onChange={setRange} {...props} />
      <output data-testid="out">{JSON.stringify(range)}</output>
    </>
  );
};
const open = async () => {
  await userEvent.click(screen.getByRole("button", { name: /^Detected/ }));
  return screen.getByRole("dialog", { name: "Choose detected" });
};
const out = () => JSON.parse(screen.getByTestId("out").textContent);

describe("DateRangeFilter", () => {
  it("opens on the look-back presets and a preset sets both ends", async () => {
    render(<Harness />);
    const cal = await open();
    expect(within(cal).getByRole("button", { name: /^Last quarter/ })).toBeInTheDocument();
    expect(within(cal).queryByRole("button", { name: /^Next 30 days/ })).toBeNull();
    await userEvent.click(within(cal).getByRole("button", { name: /^This month/ }));
    expect(out()).toEqual({ from: "2026-11-01", to: "2026-11-10" }); // never past today
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a custom range sets from and to, and Clear empties both", async () => {
    render(<Harness />);
    let cal = await open();
    await userEvent.click(within(cal).getByRole("button", { name: "Custom range" }));
    await userEvent.click(within(cal).getByRole("button", { name: "Monday 2 November 2026" }));
    await userEvent.click(within(cal).getByRole("button", { name: "Friday 6 November 2026" }));
    await userEvent.click(within(cal).getByRole("button", { name: "Done" }));
    expect(out()).toEqual({ from: "2026-11-02", to: "2026-11-06" });
    expect(screen.getByRole("button", { name: /^Detected/ })).toHaveTextContent("2 Nov 2026 – 6 Nov 2026");
    await userEvent.click(screen.getByRole("button", { name: "Clear Detected" }));
    expect(out()).toEqual({ from: null, to: null });
    cal = await open();
    expect(within(cal).getByRole("group", { name: "Preset dates" })).toBeInTheDocument();
  });

  it("past ranges cannot reach after today; a future range (due dates) can and offers look-ahead presets", async () => {
    const { unmount } = render(<Harness />);
    let cal = await open();
    await userEvent.click(within(cal).getByRole("button", { name: "Custom range" }));
    expect(within(cal).getByRole("button", { name: "Wednesday 11 November 2026" })).toBeDisabled();
    unmount();
    render(<Harness direction="future" />);
    cal = await open();
    await userEvent.click(within(cal).getByRole("button", { name: /^Next 30 days/ }));
    expect(out()).toEqual({ from: "2026-11-10", to: "2026-12-09" });
  });

  it("an old link with only one end shows it, and can be replaced", async () => {
    render(<Harness initial={{ from: "2026-10-01" }} />);
    expect(screen.getByRole("button", { name: /^Detected/ })).toHaveTextContent("From 1 Oct 2026");
  });
});
