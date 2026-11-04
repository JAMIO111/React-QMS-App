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

const Harness = ({ initial = {}, onReset, reorder = false }) => {
  const [visibility, setVisibility] = useState(initial);
  const [order, setOrder] = useState([]);
  return (
    <>
      <ColumnVisibilityMenu columns={columns} columnVisibility={visibility} onColumnVisibilityChange={setVisibility} onReset={onReset}
        {...(reorder ? { columnOrder: order, onColumnOrderChange: setOrder } : {})} />
      <output data-testid="state">{JSON.stringify(visibility)}</output>
      <output data-testid="order">{JSON.stringify(order)}</output>
    </>
  );
};
const state = () => JSON.parse(screen.getByTestId("state").textContent);

describe("ColumnVisibilityMenu", () => {
  it("lists hideable columns with their visibility", async () => {
    render(<Harness initial={{ status: false }} />);
    await userEvent.click(screen.getByRole("button", { name: /Columns/ }));
    const items = screen.getAllByRole("checkbox");
    expect(items.map((i) => i.closest("label").textContent)).toEqual(["ID", "Part No.", "Status"]);
    expect(screen.getByRole("checkbox", { name: "Status" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "ID" })).toBeChecked();
    expect(screen.queryByRole("button", { name: /Move/ })).toBeNull();
  });

  it("shows and hides columns", async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: /Columns/ }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Part No." }));
    expect(state()).toEqual({ part_number: false });
    expect(screen.getByLabelText("1 hidden")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("checkbox", { name: "Part No." }));
    expect(state()).toEqual({ part_number: true });
  });

  it("keeps at least one column visible", async () => {
    render(<Harness initial={{ ncm_id: false, part_number: false }} />);
    await userEvent.click(screen.getByRole("button", { name: /Columns/ }));
    const last = screen.getByRole("checkbox", { name: "Status" });
    expect(last).toBeDisabled();
    await userEvent.click(last);
    expect(state().status).toBeUndefined();
  });

  it("closes on Escape and offers a reset", async () => {
    let reset = 0;
    render(<Harness onReset={() => (reset += 1)} />);
    await userEvent.click(screen.getByRole("button", { name: /Columns/ }));
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Columns" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /Columns/ }));
    await userEvent.click(screen.getByRole("button", { name: /Reset columns/ }));
    expect(reset).toBe(1);
    expect(screen.queryByRole("dialog", { name: "Columns" })).toBeNull();
  });

  it("moves columns up and down", async () => {
    render(<Harness reorder />);
    await userEvent.click(screen.getByRole("button", { name: /Columns/ }));
    expect(screen.getByRole("button", { name: "Move ID up" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Move Status down" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Move Status up" }));
    expect(JSON.parse(screen.getByTestId("order").textContent)).toEqual(["__select", "ncm_id", "status", "part_number"]);
    expect(screen.getAllByRole("checkbox").map((i) => i.closest("label").textContent)).toEqual(["ID", "Status", "Part No."]);
    await userEvent.click(screen.getByRole("button", { name: "Move ID down" }));
    expect(screen.getAllByRole("checkbox").map((i) => i.closest("label").textContent)).toEqual(["Status", "ID", "Part No."]);
  });

  it("reorders by dragging a row", async () => {
    const { fireEvent } = await import("@testing-library/react");
    render(<Harness reorder />);
    await userEvent.click(screen.getByRole("button", { name: /Columns/ }));
    const row = (name) => screen.getByRole("checkbox", { name }).closest("li");
    const dataTransfer = { setData: () => {}, effectAllowed: "" };
    fireEvent.dragStart(row("Status"), { dataTransfer });
    // Dropped on the top half of "ID": Status moves before it.
    fireEvent.dragOver(row("ID"), { dataTransfer });
    fireEvent.drop(row("ID"), { dataTransfer });
    expect(screen.getAllByRole("checkbox").map((i) => i.closest("label").textContent)).toEqual(["Status", "ID", "Part No."]);
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
    expect(JSON.parse(localStorage.getItem("qms.table.a"))).toEqual({ columnVisibility: { status: false }, columnSizing: { ncm_id: 120 }, columnOrder: [] });
    act(() => result.current.setColumnOrder(["status", "ncm_id"]));
    expect(JSON.parse(localStorage.getItem("qms.table.a")).columnOrder).toEqual(["status", "ncm_id"]);

    rerender({ k: "b" });
    expect(result.current.columnVisibility).toEqual({});
    expect(result.current.columnOrder).toEqual([]);
    rerender({ k: "a" });
    expect(result.current.columnVisibility).toEqual({ status: false });
    expect(result.current.columnOrder).toEqual(["status", "ncm_id"]);
    expect(result.current.columnSizing).toEqual({ ncm_id: 120 });
  });

  it("resets and ignores corrupt saved data", () => {
    localStorage.setItem("qms.table.c", "{not json");
    const { result } = renderHook(() => useTablePreferences("c"));
    expect(result.current.columnSizing).toEqual({});
    act(() => result.current.setColumnSizing({ a: 100 }));
    act(() => result.current.setColumnOrder(["b", "a"]));
    act(() => result.current.resetColumns());
    expect(result.current.columnSizing).toEqual({});
    expect(result.current.columnOrder).toEqual([]);
    expect(localStorage.getItem("qms.table.c")).toBeNull();
  });
});
