import { useState } from "react";
import { flexRender } from "@tanstack/react-table";
import { ArrowDownIcon, ArrowUpIcon, ChevronsUpDownIcon } from "@/components/icons";

/**
 * Reusable data table for a TanStack Table instance.
 *
 * Header and rows are one <table> in one scroll container, and every column's width comes from a
 * single <colgroup> driven by column.getSize(). Header and rows therefore always line up, while
 * resizing and while scrolling in either direction. A trailing filler column takes any spare width,
 * so resized columns keep exactly the width they were dragged to.
 *
 * Features come from the table instance:
 * - sorting: click a header (keyboard: Enter/Space). Columns opt out with enableSorting: false.
 * - resizing: drag the right edge of a header; double-click it to reset. Columns opt out with
 *   enableResizing: false; minSize/maxSize are respected.
 * - show/hide: columnVisibility state (see ColumnVisibilityMenu).
 *
 * Column meta: { align: "left" | "center" | "right" } (also accepts the older flexPos), and
 * pin: "left" | "right" to keep a column fixed at that edge while the others scroll sideways
 * (e.g. row selection and row actions). Pinned columns come first / last, with the filler column
 * between the scrolling columns and the right-pinned ones.
 */
const alignClass = (column) => {
  const align = column.columnDef.meta?.align ?? column.columnDef.meta?.flexPos;
  return align === "center" ? "justify-center text-center" : align === "right" ? "justify-end text-right" : "justify-start text-left";
};

const columnLabel = (column) => column.columnDef.headerString ?? (typeof column.columnDef.header === "string" ? column.columnDef.header : column.id);

const isInteractive = (target) => target instanceof Element && !!target.closest("button, a, input, select, textarea, label");

const SortIndicator = ({ direction }) => {
  if (direction === "asc") return <ArrowUpIcon className="h-4 w-4 shrink-0 text-cta-color" aria-hidden="true" />;
  if (direction === "desc") return <ArrowDownIcon className="h-4 w-4 shrink-0 text-cta-color" aria-hidden="true" />;
  return <ChevronsUpDownIcon className="h-4 w-4 shrink-0 opacity-0 group-hover:opacity-60 group-focus-visible:opacity-60" aria-hidden="true" />;
};

const Table = ({
  table,
  isLoading = false,
  emptyMessage = "No records found.",
  onRowClick,
  onRowDoubleClick,
  ariaLabel = "Table",
}) => {
  const [activeRowId, setActiveRowId] = useState(null);
  const visible = table.getVisibleLeafColumns();
  const pinOf = (column) => column.columnDef.meta?.pin;
  const leftCols = visible.filter((c) => pinOf(c) === "left");
  const rightCols = visible.filter((c) => pinOf(c) === "right");
  const columns = [...leftCols, ...visible.filter((c) => !pinOf(c))];
  // Sticky offsets: each pinned column sits after the pinned columns before it on its side.
  const offset = {};
  leftCols.reduce((x, c) => ((offset[c.id] = { left: x }), x + c.getSize()), 0);
  [...rightCols].reverse().reduce((x, c) => ((offset[c.id] = { right: x }), x + c.getSize()), 0);
  const lastLeft = leftCols.at(-1)?.id;
  const firstRight = rightCols[0]?.id;
  const pinClass = (column) =>
    !pinOf(column)
      ? ""
      : `sticky z-[2] bg-primary-bg ${column.id === lastLeft ? "shadow-[4px_0_6px_-4px_rgba(0,0,0,0.3)]" : ""} ${
          column.id === firstRight ? "border-l shadow-[-4px_0_6px_-4px_rgba(0,0,0,0.3)]" : ""
        }`;
  const headerById = (headerGroup) => Object.fromEntries(headerGroup.headers.map((h) => [h.column.id, h]));
  const rows = table.getRowModel().rows;
  const colSpan = visible.length + 1;
  // Keep the resize cursor and stop text selection while dragging, even off the handle.
  const resizing = !!table.getState().columnSizingInfo?.isResizingColumn;

  return (
    <div
      className={`relative h-full w-full overflow-auto ${resizing ? "cursor-col-resize select-none" : ""}`}
      role="region"
      aria-label={ariaLabel}
      tabIndex={0}>
      <table
        className="table-fixed border-separate border-spacing-0 text-primary-text"
        style={{ width: "100%", minWidth: table.getTotalSize() }}
        aria-busy={isLoading || undefined}>
        <colgroup>
          {columns.map((column) => (
            <col key={column.id} data-column-id={column.id} style={{ width: column.getSize() }} />
          ))}
          <col data-column-id="__filler" />
          {rightCols.map((column) => (
            <col key={column.id} data-column-id={column.id} style={{ width: column.getSize() }} />
          ))}
        </colgroup>

        <thead className="sticky top-0 z-10 bg-primary-bg">
          {table.getHeaderGroups().map((headerGroup) => {
            const byId = headerById(headerGroup);
            const renderHeader = (header) => {
                const column = header.column;
                const sorted = column.getIsSorted();
                const canSort = column.getCanSort();
                const content = header.isPlaceholder ? null : flexRender(column.columnDef.header, header.getContext());
                return (
                  <th
                    key={header.id}
                    scope="col"
                    data-column-id={column.id}
                    aria-sort={sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : canSort ? "none" : undefined}
                    style={offset[column.id]}
                    className={`relative border-b border-r border-border-color p-0 font-normal text-secondary-text ${pinClass(column)}`}>
                    {canSort ? (
                      <button
                        type="button"
                        onClick={column.getToggleSortingHandler()}
                        title={`Sort by ${columnLabel(column)}`}
                        className={`group flex h-full w-full min-w-0 items-center gap-1 px-2 py-1 cursor-pointer select-none hover:bg-hover-menu-color focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-cta-color ${alignClass(column)}`}>
                        <span className="min-w-0 truncate">{content}</span>
                        <SortIndicator direction={sorted} />
                      </button>
                    ) : (
                      <div className={`flex h-full w-full min-w-0 items-center px-2 py-1 ${alignClass(column)}`}>
                        <span className="min-w-0 truncate">{content}</span>
                      </div>
                    )}
                    {column.getCanResize() && (
                      <div
                        role="separator"
                        aria-orientation="vertical"
                        aria-label={`Resize ${columnLabel(column)}`}
                        title="Drag to resize, double-click to reset"
                        onMouseDown={header.getResizeHandler()}
                        onTouchStart={header.getResizeHandler()}
                        onDoubleClick={() => column.resetSize()}
                        onClick={(e) => e.stopPropagation()}
                        className={`table-resizer ${column.getIsResizing() ? "is-resizing" : ""}`}
                      />
                    )}
                  </th>
                );
            };
            return (
              <tr key={headerGroup.id}>
                {columns.map((c) => byId[c.id] && renderHeader(byId[c.id]))}
                <th aria-hidden="true" className="border-b border-border-color p-0" />
                {rightCols.map((c) => byId[c.id] && renderHeader(byId[c.id]))}
              </tr>
            );
          })}
        </thead>

        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={colSpan} className="p-6 text-center text-secondary-text italic select-none">
                {isLoading ? "Loading…" : emptyMessage}
              </td>
            </tr>
          )}
          {rows.map((row) => {
            const highlighted = row.getIsSelected() || activeRowId === row.id;
            return (
              <tr
                key={row.id}
                data-row-id={row.id}
                aria-selected={row.getCanSelect() ? row.getIsSelected() : undefined}
                onClick={(e) => {
                  if (isInteractive(e.target)) return;
                  setActiveRowId((prev) => (prev === row.id ? null : row.id));
                  onRowClick?.(row, e);
                }}
                onDoubleClick={(e) => {
                  if (isInteractive(e.target)) return;
                  onRowDoubleClick?.(row, e);
                }}
                className={`group/row ${highlighted ? "bg-brand-primary/10 hover:bg-brand-primary/15" : "hover:bg-hover-menu-color"} ${
                  onRowClick || onRowDoubleClick ? "cursor-pointer" : ""
                }`}>
                {(() => {
                  const cells = Object.fromEntries(row.getVisibleCells().map((cell) => [cell.column.id, cell]));
                  const renderCell = (cell) => {
                    const pinned = !!pinOf(cell.column);
                    return (
                      <td
                        key={cell.id}
                        data-column-id={cell.column.id}
                        style={offset[cell.column.id]}
                        className={`border-b border-r p-0 align-middle ${cell.column.getIsResizing() ? "border-r-cta-color" : "border-border-color"} ${pinClass(cell.column)}`}>
                        <div
                          className={`flex min-w-0 items-center overflow-hidden whitespace-nowrap px-2 py-1 ${alignClass(cell.column)} ${
                            // A pinned cell is opaque, so it repeats the row's highlight itself.
                            pinned ? (highlighted ? "bg-brand-primary/10 group-hover/row:bg-brand-primary/15" : "group-hover/row:bg-hover-menu-color") : ""
                          }`}>
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </div>
                      </td>
                    );
                  };
                  return (
                    <>
                      {columns.map((c) => cells[c.id] && renderCell(cells[c.id]))}
                      <td aria-hidden="true" className="border-b border-border-color p-0" />
                      {rightCols.map((c) => cells[c.id] && renderCell(cells[c.id]))}
                    </>
                  );
                })()}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};

export default Table;
