import { describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getCoreRowModel, getSortedRowModel, useReactTable } from "@tanstack/react-table";
import Table from "./Table";
import { useColumnSizingInfo } from "../hooks/useColumnSizingInfo";

const data = [
  { id: 1, name: "Bracket", qty: 5 },
  { id: 2, name: "Axle", qty: 12 },
  { id: 3, name: "Clamp", qty: 1 },
];
const columns = [
  { id: "name", accessorKey: "name", header: "Name", size: 200, minSize: 80, maxSize: 400 },
  { id: "qty", accessorKey: "qty", header: "Qty", size: 100, meta: { align: "right" } },
  { id: "note", header: "Note", cell: () => <button type="button">Open</button>, enableSorting: false, enableResizing: false, size: 90 },
];

/** A real TanStack table, as a page would build it. */
const Harness = ({ initialVisibility = {}, onRowDoubleClick, rows = data, isLoading }) => {
  const [sorting, setSorting] = useState([]);
  const [columnSizing, setColumnSizing] = useState({});
  const [columnVisibility, setColumnVisibility] = useState(initialVisibility);
  const sizingInfo = useColumnSizingInfo();
  const table = useReactTable({
    data: rows,
    columns,
    state: { sorting, columnSizing, columnVisibility, columnSizingInfo: sizingInfo.columnSizingInfo },
    onColumnSizingInfoChange: sizingInfo.onColumnSizingInfoChange,
    onSortingChange: setSorting,
    onColumnSizingChange: setColumnSizing,
    onColumnVisibilityChange: setColumnVisibility,
    columnResizeMode: "onChange",
    enableSortingRemoval: false,
    sortDescFirst: false,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });
  return <Table table={table} onRowDoubleClick={onRowDoubleClick} isLoading={isLoading} ariaLabel="Parts" />;
};

const colWidth = (id) => document.querySelector(`col[data-column-id="${id}"]`).style.width;
const firstColumnValues = () => screen.getAllByRole("row").slice(1).map((r) => within(r).getAllByRole("cell")[0].textContent);

describe("Table", () => {
  it("renders header and rows in one table sized by a single colgroup", () => {
    render(<Harness />);
    expect(screen.getAllByRole("table")).toHaveLength(1);
    // The trailing spare-width column is hidden from assistive technology.
    expect(screen.getAllByRole("columnheader").map((th) => th.textContent)).toEqual(["Name", "Qty", "Note"]);
    expect(colWidth("name")).toBe("200px");
    expect(colWidth("qty")).toBe("100px");
    expect(screen.getByRole("table").style.minWidth).toBe("390px"); // sum of column sizes
  });

  it("sorts when a header is clicked, toggling direction, and reports it with aria-sort", async () => {
    render(<Harness />);
    const nameHeader = screen.getByRole("columnheader", { name: /Name/ });
    expect(nameHeader).toHaveAttribute("aria-sort", "none");

    await userEvent.click(within(nameHeader).getByRole("button"));
    expect(nameHeader).toHaveAttribute("aria-sort", "ascending");
    expect(firstColumnValues()).toEqual(["Axle", "Bracket", "Clamp"]);

    await userEvent.click(within(nameHeader).getByRole("button"));
    expect(nameHeader).toHaveAttribute("aria-sort", "descending");
    expect(firstColumnValues()).toEqual(["Clamp", "Bracket", "Axle"]);
  });

  it("does not offer sorting on columns that opt out", () => {
    render(<Harness />);
    const note = screen.getByRole("columnheader", { name: "Note" });
    expect(within(note).queryByRole("button")).toBeNull();
    expect(note).not.toHaveAttribute("aria-sort");
  });

  it("resizes a column by dragging, within its min and max, and resets on double-click", () => {
    render(<Harness />);
    const handle = screen.getByRole("separator", { name: "Resize Name" });

    fireEvent.mouseDown(handle, { clientX: 200 });
    fireEvent.mouseMove(document, { clientX: 260 });
    expect(colWidth("name")).toBe("260px"); // header and rows share this width
    fireEvent.mouseUp(document, { clientX: 260 });
    expect(screen.getByRole("table").style.minWidth).toBe("450px");

    fireEvent.mouseDown(handle, { clientX: 260 });
    fireEvent.mouseMove(document, { clientX: 900 });
    fireEvent.mouseUp(document, { clientX: 900 });
    expect(colWidth("name")).toBe("400px"); // maxSize

    fireEvent.mouseDown(handle, { clientX: 400 });
    fireEvent.mouseMove(document, { clientX: 0 });
    fireEvent.mouseUp(document, { clientX: 0 });
    expect(colWidth("name")).toBe("80px"); // minSize

    fireEvent.doubleClick(handle);
    expect(colWidth("name")).toBe("200px");
  });

  it("does not sort when the resize handle is used", () => {
    render(<Harness />);
    const nameHeader = screen.getByRole("columnheader", { name: /Name/ });
    const handle = screen.getByRole("separator", { name: "Resize Name" });
    fireEvent.mouseDown(handle, { clientX: 200 });
    fireEvent.mouseUp(document, { clientX: 220 });
    fireEvent.click(handle);
    expect(nameHeader).toHaveAttribute("aria-sort", "none");
  });

  it("has no resize handle on fixed columns", () => {
    render(<Harness />);
    expect(screen.queryByRole("separator", { name: "Resize Note" })).toBeNull();
  });

  it("hides columns from the header and every row", () => {
    render(<Harness initialVisibility={{ qty: false }} />);
    expect(screen.queryByRole("columnheader", { name: /Qty/ })).toBeNull();
    expect(document.querySelector('col[data-column-id="qty"]')).toBeNull();
    for (const row of screen.getAllByRole("row").slice(1)) {
      expect(row.querySelector('[data-column-id="qty"]')).toBeNull();
    }
  });

  it("aligns cells from column meta", () => {
    render(<Harness />);
    const qtyCell = document.querySelector('td[data-column-id="qty"] > div');
    expect(qtyCell.className).toContain("justify-end");
  });

  it("opens a row on double-click, but not when a control inside it is used", async () => {
    const open = vi.fn();
    render(<Harness onRowDoubleClick={open} />);
    const firstRow = screen.getAllByRole("row")[1];
    await userEvent.dblClick(within(firstRow).getAllByRole("cell")[0]);
    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0][0].original.name).toBe("Bracket");

    await userEvent.dblClick(within(firstRow).getByRole("button", { name: "Open" }));
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("shows loading and empty states across the full width", () => {
    const { rerender } = render(<Harness rows={[]} isLoading />);
    expect(screen.getByRole("cell", { name: "Loading, please wait…" })).toHaveAttribute("colspan", "4");
    rerender(<Harness rows={[]} />);
    expect(screen.getByRole("cell", { name: "No records found." })).toBeInTheDocument();
  });
});

describe("Table pinned columns", () => {
  const pinned = [
    { id: "sel", header: "Sel", cell: () => <input type="checkbox" aria-label="pick" />, size: 40, meta: { pin: "left" }, enableSorting: false, enableResizing: false },
    { id: "name", accessorKey: "name", header: "Name", size: 200 },
    { id: "qty", accessorKey: "qty", header: "Qty", size: 100 },
    { id: "act", header: "Act", cell: () => <button type="button">More</button>, size: 50, meta: { pin: "right" }, enableSorting: false, enableResizing: false },
  ];
  const Pinned = () => {
    const table = useReactTable({ data, columns: pinned, getCoreRowModel: getCoreRowModel() });
    return <Table table={table} ariaLabel="Pinned" />;
  };

  it("keeps the left and right pinned columns at their edges, with the filler column in between", () => {
    render(<Pinned />);
    const ids = [...document.querySelectorAll("col")].map((c) => c.dataset.columnId);
    expect(ids).toEqual(["sel", "name", "qty", "__filler", "act"]);
    const [headerRow] = screen.getAllByRole("row");
    const ths = headerRow.querySelectorAll("th");
    expect(ths[0]).toHaveClass("sticky");
    expect(ths[0].style.left).toBe("0px");
    expect(ths[ths.length - 1]).toHaveClass("sticky");
    expect(ths[ths.length - 1].style.right).toBe("0px");
    expect(ths[1]).not.toHaveClass("sticky");
    const cells = screen.getAllByRole("row")[1].querySelectorAll("td");
    expect(cells[0]).toHaveClass("sticky");
    expect(cells[cells.length - 1]).toHaveClass("sticky");
    expect(within(cells[cells.length - 1]).getByRole("button", { name: "More" })).toBeInTheDocument();
  });
});

describe("Table column reordering", () => {
  const cols = [
    { id: "sel", header: "Sel", cell: () => null, size: 40, meta: { pin: "left" } },
    { id: "name", accessorKey: "name", header: "Name", size: 200 },
    { id: "qty", accessorKey: "qty", header: "Qty", size: 100 },
    { id: "note", header: "Note", cell: () => "n", size: 90 },
  ];
  const Reorderable = ({ reorder = true }) => {
    const [columnOrder, setColumnOrder] = useState([]);
    const table = useReactTable({
      data,
      columns: cols,
      state: { columnOrder },
      onColumnOrderChange: setColumnOrder,
      enableColumnReordering: reorder,
      getCoreRowModel: getCoreRowModel(),
    });
    return <Table table={table} ariaLabel="Parts" />;
  };
  const headerIds = () => [...document.querySelectorAll("thead th[data-column-id]")].map((th) => th.dataset.columnId);
  const th = (id) => document.querySelector(`thead th[data-column-id="${id}"]`);
  const dataTransfer = { setData: () => {}, effectAllowed: "" };

  it("moves a column by dragging its header onto another", () => {
    render(<Reorderable />);
    expect(headerIds()).toEqual(["sel", "name", "qty", "note"]);
    expect(th("name")).toHaveAttribute("draggable", "true");
    expect(th("sel")).not.toHaveAttribute("draggable");
    fireEvent.dragStart(th("note"), { dataTransfer });
    // jsdom headers have no width, so clientX 0 is the left half: drop before "name".
    fireEvent.dragOver(th("name"), { dataTransfer, clientX: 0 });
    fireEvent.drop(th("name"), { dataTransfer });
    expect(headerIds()).toEqual(["sel", "note", "name", "qty"]);
    // Row cells follow the header order.
    expect([...screen.getAllByRole("row")[1].querySelectorAll("td[data-column-id]")].map((td) => td.dataset.columnId)).toEqual(["sel", "note", "name", "qty"]);
  });

  it("does not start a move from the resize handle, and pinned columns stay put", () => {
    render(<Reorderable />);
    fireEvent.dragStart(th("name"), { dataTransfer });
    fireEvent.dragOver(th("sel"), { dataTransfer, clientX: 0 });
    fireEvent.drop(th("sel"), { dataTransfer });
    expect(headerIds()).toEqual(["sel", "name", "qty", "note"]);
  });

  it("is off unless the table opts in", () => {
    render(<Reorderable reorder={false} />);
    expect(th("name")).not.toHaveAttribute("draggable");
  });
});
