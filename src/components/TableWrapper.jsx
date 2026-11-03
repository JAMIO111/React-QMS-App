import { useMemo, useRef } from "react";
import { useReactTable, getCoreRowModel } from "@tanstack/react-table";
import { useSearchParams } from "react-router-dom";
import Table from "./Table";
import DataNavBar2 from "./DataNavBar2";
import { EllipsisIcon } from "@/components/icons";
import { useColumnSizingInfo } from "../hooks/useColumnSizingInfo";

/** Fixed utility columns: never sorted, resized or hidden. */
const utilityColumn = { enableSorting: false, enableResizing: false, enableHiding: false, meta: { align: "center" } };

/**
 * Non-conformance register table: selection, row actions and server-side paging/sorting around the
 * generic <Table>. Column visibility and sizing are owned by the page (see useTablePreferences) so
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
  selectedItem,
  setSelectedItem,
  handleActiveModalType,
  onOpenModal,
  sorting,
  setSorting,
  columns = [],
  columnVisibility,
  onColumnVisibilityChange,
  columnSizing,
  onColumnSizingChange,
  rowSelection,
  setRowSelection,
  onRowDoubleClick,
}) => {
  const [, setSearchParams] = useSearchParams();
  const sizingInfo = useColumnSizingInfo();

  const handleEllipsisClick = (item) => (e) => {
    e.stopPropagation();
    if (selectedItem?.id !== item.id) setSelectedItem(item);

    const rect = e.currentTarget.getBoundingClientRect();
    const modalWidth = 158;
    const modalHeight = 177;
    let top = rect.bottom + window.scrollY - 25;
    let left = rect.left + window.scrollX - 160;
    if (left + modalWidth > window.innerWidth) left = window.innerWidth - modalWidth - 10;
    if (top + modalHeight > window.innerHeight + window.scrollY) top = window.innerHeight + window.scrollY - modalHeight - 10;
    if (left < 0) left = 10;

    handleActiveModalType("Actions");
    onOpenModal({ top, left });
  };
  // The columns are memoised; the actions button calls the latest handler through this ref.
  const ellipsisClick = useRef(handleEllipsisClick);
  ellipsisClick.current = handleEllipsisClick;

  const tableColumns = useMemo(
    () => [
      {
        ...utilityColumn,
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
            aria-label={`Select row ${row.original.ncm_id ?? row.id}`}
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
        id: "__actions",
        headerString: "Actions",
        header: () => <span className="sr-only">Actions</span>,
        cell: ({ row }) => (
          <button
            type="button"
            aria-label="Actions"
            onClick={(e) => ellipsisClick.current(row.original)(e)}
            className="p-1 text-secondary-text hover:text-brand-primary cursor-pointer">
            <EllipsisIcon size={18} />
          </button>
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
          ariaLabel="Non-conformance records"
          onRowDoubleClick={onRowDoubleClick ? (row) => onRowDoubleClick(row.original) : undefined}
        />
      </div>
      <DataNavBar2 table={table} totalCount={totalCount} onRefresh={onRefresh} isLoading={isLoading} />
    </div>
  );
};

export default TableWrapper;
