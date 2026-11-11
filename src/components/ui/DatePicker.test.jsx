import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { format, subDays } from "date-fns";
import RHFDatePickerPopout from "./RHFDatePickerPopout";
import { clampRange, resolvePresets } from "@/lib/datePresets";

// Only the clock is faked, so user events still run: "today" is Sunday 15 March 2026.
beforeEach(() => vi.useFakeTimers({ toFake: ["Date"], now: new Date(2026, 2, 15, 10, 30) }));
afterEach(() => vi.useRealTimers());

const Harness = ({ initial = null, ...props }) => {
  const [value, setValue] = useState(initial);
  return (
    <>
      <RHFDatePickerPopout label="Period" value={value} onChange={setValue} valueFormat="iso" {...props} />
      <output data-testid="out">{JSON.stringify(value)}</output>
    </>
  );
};
const open = async () => {
  await userEvent.click(screen.getByRole("button", { name: /^Period/ }));
  return screen.getByRole("dialog", { name: "Choose period" });
};
const day = (cal, name) => within(cal).getByRole("button", { name });
const out = () => JSON.parse(screen.getByTestId("out").textContent);

describe("date range", () => {
  it("picks two days, shows the span and saves on Done", async () => {
    render(<Harness mode="range" />);
    const cal = await open();
    await userEvent.click(day(cal, "Saturday 7 March 2026"));
    await userEvent.click(day(cal, "Wednesday 11 March 2026"));
    expect(within(cal).getByText("5 days")).toBeInTheDocument();
    expect(out()).toBeNull(); // nothing is saved until Done
    await userEvent.click(within(cal).getByRole("button", { name: "Done" }));
    expect(out()).toEqual({ from: "2026-03-07", to: "2026-03-11" });
    expect(screen.getByRole("button", { name: /^Period/ })).toHaveTextContent("7 Mar 2026 – 11 Mar 2026");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("puts the earlier day first whichever is clicked first, and Cancel keeps the old value", async () => {
    render(<Harness mode="range" initial={{ from: "2026-03-02", to: "2026-03-03" }} />);
    let cal = await open();
    await userEvent.click(day(cal, "Friday 13 March 2026"));
    await userEvent.click(day(cal, "Monday 9 March 2026"));
    await userEvent.click(within(cal).getByRole("button", { name: "Cancel" }));
    expect(out()).toEqual({ from: "2026-03-02", to: "2026-03-03" });
    cal = await open();
    await userEvent.click(day(cal, "Friday 13 March 2026"));
    await userEvent.click(day(cal, "Monday 9 March 2026"));
    await userEvent.click(within(cal).getByRole("button", { name: "Done" }));
    expect(out()).toEqual({ from: "2026-03-09", to: "2026-03-13" });
  });

  it("clears a range", async () => {
    render(<Harness mode="range" clearable initial={{ from: "2026-03-02", to: "2026-03-03" }} />);
    await userEvent.click(screen.getByRole("button", { name: "Clear Period" }));
    expect(out()).toBeNull();
  });
});

describe("blocking days", () => {
  it("allowFuture={false} blocks tomorrow and allowPast={false} blocks yesterday", async () => {
    const { unmount } = render(<Harness allowFuture={false} />);
    let cal = await open();
    expect(day(cal, "Monday 16 March 2026")).toBeDisabled();
    expect(day(cal, "Sunday 15 March 2026")).toBeEnabled();
    unmount();
    render(<Harness allowPast={false} />);
    cal = await open();
    expect(day(cal, "Saturday 14 March 2026")).toBeDisabled();
    expect(day(cal, "Sunday 15 March 2026")).toBeEnabled();
  });

  it("combines with minDate / maxDate", async () => {
    render(<Harness allowFuture={false} minDate="2026-03-05" />);
    const cal = await open();
    expect(day(cal, "Wednesday 4 March 2026")).toBeDisabled();
    expect(day(cal, "Thursday 5 March 2026")).toBeEnabled();
    expect(day(cal, "Monday 16 March 2026")).toBeDisabled();
  });
});

describe("time", () => {
  it("asks for a time with a single day and keeps it in the value", async () => {
    render(<Harness withTime />);
    const cal = await open();
    await userEvent.click(day(cal, "Tuesday 10 March 2026"));
    expect(out()).toBeNull(); // a time needs Done
    fireEvent.change(within(cal).getByLabelText("Time"), { target: { value: "14:45" } });
    await userEvent.click(within(cal).getByRole("button", { name: "Done" }));
    expect(out()).toBe("2026-03-10T14:45");
    expect(screen.getByRole("button", { name: /^Period/ })).toHaveTextContent("Tue 10 March 2026, 14:45");
  });

  it("a range has a start and an end time, and the end cannot be before the start on one day", async () => {
    render(<Harness mode="range" withTime />);
    const cal = await open();
    await userEvent.click(day(cal, "Tuesday 10 March 2026"));
    await userEvent.click(day(cal, "Tuesday 10 March 2026"));
    fireEvent.change(within(cal).getByLabelText("Start time"), { target: { value: "09:00" } });
    fireEvent.change(within(cal).getByLabelText("End time"), { target: { value: "08:00" } });
    expect(within(cal).getByRole("alert")).toHaveTextContent("The end time must be after the start time");
    expect(within(cal).getByRole("button", { name: "Done" })).toBeDisabled();
    fireEvent.change(within(cal).getByLabelText("End time"), { target: { value: "17:30" } });
    await userEvent.click(within(cal).getByRole("button", { name: "Done" }));
    expect(out()).toEqual({ from: "2026-03-10T09:00", to: "2026-03-10T17:30" });
  });
});

describe("presets", () => {
  it("a range preset from the list fills the range at once", async () => {
    render(<Harness mode="range" presets={["thisMonth", "lastMonth", "thisQuarter", "lastYear"]} />);
    const cal = await open();
    await userEvent.click(within(cal).getByRole("button", { name: "More" }));
    await userEvent.click(within(cal).getByRole("button", { name: /Last year/ }));
    expect(out()).toEqual({ from: "2025-01-01", to: "2025-12-31" });
  });

  it("the first presets sit above the calendar", async () => {
    render(<Harness mode="range" presets={["lastMonth", "thisQuarter", "lastQuarter"]} />);
    const cal = await open();
    await userEvent.click(within(cal).getByRole("button", { name: "Last month" }));
    expect(out()).toEqual({ from: "2026-02-01", to: "2026-02-28" });
  });

  it("each field has its own presets, including ones you write", async () => {
    const custom = { label: "Last 45 days", range: (t) => [subDays(t, 44), t] };
    render(<Harness mode="range" presets={[custom, "thisYear"]} quickPresets={1} />);
    const cal = await open();
    await userEvent.click(within(cal).getByRole("button", { name: "Last 45 days" }));
    expect(out()).toEqual({ from: format(subDays(new Date(), 44), "yyyy-MM-dd"), to: "2026-03-15" });
  });

  it("is clamped to the days allowed, and switched off when none are", async () => {
    render(<Harness mode="range" allowFuture={false} presets={["thisYear", "last7"]} quickPresets={0} presetsOpen />);
    const cal = await open();
    await userEvent.click(within(cal).getByRole("button", { name: /This year/ }));
    expect(out()).toEqual({ from: "2026-01-01", to: "2026-03-15" });
    expect(clampRange([new Date(2026, 5, 1), new Date(2026, 5, 30)], null, new Date(2026, 2, 15))).toBeNull();
  });

  it("single-date presets: Today and Tomorrow", async () => {
    render(<Harness presets={["today", "tomorrow", "nextWeek"]} />);
    const cal = await open();
    await userEvent.click(within(cal).getByRole("button", { name: "Tomorrow" }));
    expect(out()).toBe("2026-03-16");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a single-date preset that is blocked is disabled", async () => {
    render(<Harness presets={["today", "tomorrow"]} allowFuture={false} />);
    const cal = await open();
    expect(within(cal).getByRole("button", { name: "Tomorrow" })).toBeDisabled();
  });

  it("resolvePresets skips unknown keys and incomplete objects", () => {
    expect(resolvePresets(["thisMonth", "nope", { label: "x" }, { label: "ok", range: () => [] }], "range").map((p) => p.label)).toEqual(["This month", "ok"]);
    expect(resolvePresets(false, "range")).toEqual([]);
    expect(resolvePresets(true, "single").length).toBeGreaterThan(0);
  });
});

describe("month and year chooser", () => {
  it("jumps to another month and year", async () => {
    render(<Harness />);
    const cal = await open();
    await userEvent.click(within(cal).getByRole("button", { name: "Choose month and year" }));
    await userEvent.click(within(cal).getByRole("button", { name: "Next year" }));
    await userEvent.click(within(cal).getByRole("button", { name: "Aug" }));
    expect(within(cal).getByRole("button", { name: "Choose month and year" })).toHaveTextContent("August 2027");
  });
});
