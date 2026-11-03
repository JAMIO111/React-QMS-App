import { describe, expect, it, beforeEach } from "vitest";
import { useState } from "react";
import { act, render, renderHook, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ColumnVisibilityMenu from "./ColumnVisibilityMenu";
import { useTablePreferences } from "../../hooks/useTablePreferences";

const columns = [
  { id: "__select", headerString: "Select", enableHiding: false },
  { id: "ncm_id", headerString: "ID" },
  { id: "part_number", headerString: "Part No." },
  { id: "status", headerString: "Status" },
];

const Harness = ({ initial = {}, onReset }) => {
  const [visibility, setVisibility] = useState(initial);
  return (
    <>
      <ColumnVisibilityMenu columns={columns} columnVisibility={visibility} onColumnVisibilityChange={setVisibility} onReset={onReset} />
      <output data-testid="state">{JSON.stringify(visibility)}</output>
    </>
  );
};
const state = () => JSON.parse(screen.getByTestId("state").textContent);

describe("ColumnVisibilityMenu", () => {
  it("lists hideable columns with their visibility", async () => {
    render(<Harness initial={{ status: false }} />);
    await userEvent.click(screen.getByRole("button", { name: /Columns/ }));
    const items = screen.getAllByRole("menuitemcheckbox");
    expect(items.map((i) => i.textContent)).toEqual(["ID", "Part No.", "Status"]);
    expect(screen.getByRole("menuitemcheckbox", { name: "Status" })).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("menuitemcheckbox", { name: "ID" })).toHaveAttribute("aria-checked", "true");
  });

  it("shows and hides columns", async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: /Columns/ }));
    await userEvent.click(screen.getByRole("menuitemcheckbox", { name: "Part No." }));
    expect(state()).toEqual({ part_number: false });
    expect(screen.getByLabelText("1 hidden")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("menuitemcheckbox", { name: "Part No." }));
    expect(state()).toEqual({ part_number: true });
  });

  it("keeps at least one column visible", async () => {
    render(<Harness initial={{ ncm_id: false, part_number: false }} />);
    await userEvent.click(screen.getByRole("button", { name: /Columns/ }));
    const last = screen.getByRole("menuitemcheckbox", { name: "Status" });
    expect(last).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(last);
    expect(state().status).toBeUndefined();
  });

  it("closes on Escape and offers a reset", async () => {
    let reset = 0;
    render(<Harness onReset={() => (reset += 1)} />);
    await userEvent.click(screen.getByRole("button", { name: /Columns/ }));
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /Columns/ }));
    await userEvent.click(screen.getByRole("menuitem", { name: /Reset columns/ }));
    expect(reset).toBe(1);
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

describe("useTablePreferences", () => {
  beforeEach(() => localStorage.clear());

  it("remembers visibility and widths per table", () => {
    const { result, rerender } = renderHook(({ k }) => useTablePreferences(k), { initialProps: { k: "a" } });
    act(() => {
      result.current.setColumnVisibility((v) => ({ ...v, status: false }));
      result.current.setColumnSizing({ ncm_id: 120 });
    });
    expect(JSON.parse(localStorage.getItem("qms.table.a"))).toEqual({ columnVisibility: { status: false }, columnSizing: { ncm_id: 120 } });

    rerender({ k: "b" });
    expect(result.current.columnVisibility).toEqual({});
    rerender({ k: "a" });
    expect(result.current.columnVisibility).toEqual({ status: false });
    expect(result.current.columnSizing).toEqual({ ncm_id: 120 });
  });

  it("resets and ignores corrupt saved data", () => {
    localStorage.setItem("qms.table.c", "{not json");
    const { result } = renderHook(() => useTablePreferences("c"));
    expect(result.current.columnSizing).toEqual({});
    act(() => result.current.setColumnSizing({ a: 100 }));
    act(() => result.current.resetColumns());
    expect(result.current.columnSizing).toEqual({});
    expect(localStorage.getItem("qms.table.c")).toBeNull();
  });
});
