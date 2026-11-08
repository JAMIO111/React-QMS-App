import { useMemo, useRef } from "react";
import { useReactTable, getCoreRowModel } from "@tanstack/react-table";
import { useSearchParams } from "react-router-dom";
import Table from "./Table";
import DataNavBar2 from "./DataNavBar2";
import RowActionsMenu from "./ui/RowActionsMenu";
import { useColumnSizingInfo } from "../hooks/useColumnSizingInfo";

const defaultRowLabel = (row) => row.reference ?? row.id;

/** Fixed utility columns: never sorted, resized or hidden. */
const utilityColumn = { enableSorting: false, enableResizing: false, enableHiding: false, meta: { align: "center" } };

/**
 * Register table (non-conformances, gauges): selection, row actions and server-side paging/sorting around the
 * generic <Table>. `rowActions(item)` returns the DropdownMenu items of a row's "…" menu (nothing → no button). Column visibility and sizing are owned by the page (see useTablePreferences) so
 * the column menu can live in the page header.
 */
const TableWrapper = ({
  data,
  isLoading,
  error,
  onRefresh,
  page,
  pageSize,
  totalCount,
  setSelectedRows,
  rowActions,
  sorting,
  setSorting,
  columns = [],
  columnVisibility,
  onColumnVisibilityChange,
  columnSizing,
  onColumnSizingChange,
  columnOrder,
  onColumnOrderChange,
  rowSelection,
  setRowSelection,
  onRowDoubleClick,
  ariaLabel = "Non-conformance records",
  rowLabel = defaultRowLabel,
}) => {
  const [, setSearchParams] = useSearchParams();
  const sizingInfo = useColumnSizingInfo();

  // The columns are memoised; the row menu reads the latest items through this ref.
  const actionsOf = useRef(rowActions);
  actionsOf.current = rowActions;
  const labelOf = useRef(rowLabel);
  labelOf.current = rowLabel;

  const tableColumns = useMemo(
    () => [
      {
        ...utilityColumn,
        meta: { ...utilityColumn.meta, pin: "left" },
        id: "__select",
        headerString: "Select",
        header: ({ table }) => (
          <input
            type="checkbox"
            aria-label="Select all rows on this page"
            checked={table.getIsAllPageRowsSelected()}
            ref={(el) => {
              if (el) el.indeterminate = table.getIsSomePageRowsSelected() && !table.getIsAllPageRowsSelected();
            }}
            onChange={table.getToggleAllPageRowsSelectedHandler()}
            className="cursor-pointer"
          />
        ),
        cell: ({ row }) => (
          <input
            type="checkbox"
            aria-label={`Select ${labelOf.current(row.original)}`}
            checked={row.getIsSelected()}
            disabled={!row.getCanSelect()}
            onChange={row.getToggleSelectedHandler()}
            className="cursor-pointer"
          />
        ),
        size: 40,
        minSize: 40,
        maxSize: 40,
      },
      ...columns,
      {
        ...utilityColumn,
        meta: { ...utilityColumn.meta, pin: "right" },
        id: "__actions",
        headerString: "Actions",
        header: () => <span className="sr-only">Actions</span>,
        cell: ({ row }) => (
          <RowActionsMenu items={actionsOf.current?.(row.original)} label={`Actions for ${labelOf.current(row.original)}`} />
        ),
        size: 50,
        minSize: 50,
        maxSize: 50,
      },
    ],
    [columns]
  );

  const table = useReactTable({
    data,
    columns: tableColumns,
    getRowId: (row, index) => String(row.id ?? index),
    defaultColumn: { minSize: 60, maxSize: 800 },
    state: {
      rowSelection,
      sorting,
      columnVisibility,
      columnSizing,
      ...(columnOrder ? { columnOrder } : {}),
      columnSizingInfo: sizingInfo.columnSizingInfo,
      pagination: { pageIndex: page - 1, pageSize },
    },
    pageCount: Math.max(1, Math.ceil(totalCount / pageSize)),
    manualPagination: true,
    manualSorting: true,
    enableSortingRemoval: false,
    sortDescFirst: false, // first click sorts ascending, for every column type
    columnResizeMode: "onChange",
    enableRowSelection: true,
    getCoreRowModel: getCoreRowModel(),
    onSortingChange: setSorting,
    onColumnVisibilityChange,
    onColumnSizingChange,
    ...(onColumnOrderChange ? { onColumnOrderChange, enableColumnReordering: true } : {}),
    onColumnSizingInfoChange: sizingInfo.onColumnSizingInfoChange,
    onRowSelectionChange: (updater) => {
      const next = typeof updater === "function" ? updater(rowSelection) : updater;
      setRowSelection(next);
      setSelectedRows(data.filter((row, index) => next[String(row.id ?? index)]));
    },
    onPaginationChange: (updater) => {
      const next = typeof updater === "function" ? updater({ pageIndex: page - 1, pageSize }) : updater;
      setSearchParams((prev) => {
        const params = new URLSearchParams(prev);
        params.set("page", String(next.pageIndex + 1));
        params.set("pageSize", String(next.pageSize));
        return params;
      });
    },
  });

  if (error) return <div role="alert" className="text-error-color p-4">Error: {error.message}</div>;

  return (
    <div className="flex flex-col flex-1 w-full h-full min-w-0 min-h-0 overflow-hidden border border-border-color rounded-2xl">
      <div className="flex-1 min-h-0">
        <Table
          table={table}
          isLoading={isLoading}
          ariaLabel={ariaLabel}
          onRowDoubleClick={onRowDoubleClick ? (row) => onRowDoubleClick(row.original) : undefined}
        />
      </div>
      <DataNavBar2 table={table} totalCount={totalCount} onRefresh={onRefresh} isLoading={isLoading} />
    </div>
  );
};

export default TableWrapper;
