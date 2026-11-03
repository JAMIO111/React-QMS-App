import { useMemo, useState } from "react";
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
} from "@tanstack/react-table";
import Table from "./Table";
import DataNavBar2 from "./DataNavBar2";
import { IoEllipsisHorizontal } from "react-icons/io5";
import { useSearchParams } from "react-router-dom";

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
  filteredColumns = [],
  rowSelection,
  setRowSelection,
}) => {
  const [searchParams, setSearchParams] = useSearchParams();
  const [columnSizing, setColumnSizing] = useState({});
  const [resizedColumns, setResizedColumns] = useState(new Set());

  const handleColumnSizingChange = (updater) => {
    setColumnSizing((prev) => {
      const next = typeof updater === "function" ? updater(prev) : updater;

      const clamped = {};
      const resized = new Set(resizedColumns);

      for (const key in next) {
        const col = table.getColumn?.(key);
        const min = col?.columnDef?.minSize ?? 50;
        const max = col?.columnDef?.maxSize ?? 1000;
        const size = Math.max(min, Math.min(next[key], max));
        clamped[key] = size;
        resized.add(key); // mark as resized
      }

      setResizedColumns(resized);
      return clamped;
    });
  };

  console.log("Resized Columns:", resizedColumns);

  const handleEllipsisClick = (item) => (e) => {
    e.stopPropagation(); // Prevent row click event
    if (selectedItem?.id !== item.id) {
      setSelectedItem(item);
    }

    if (e.currentTarget) {
      const rect = e.currentTarget.getBoundingClientRect();
      const modalWidth = 158; // Set this to your modal's approximate width
      const modalHeight = 177; // Set this to your modal's approximate height

      let top = rect.bottom + window.scrollY - 25;
      let left = rect.left + window.scrollX - 160;

      // Adjust to prevent clipping right edge
      if (left + modalWidth > window.innerWidth) {
        left = window.innerWidth - modalWidth - 10; // 10px padding from edge
      }

      // Adjust to prevent clipping bottom edge
      if (top + modalHeight > window.innerHeight + window.scrollY) {
        top = window.innerHeight + window.scrollY - modalHeight - 10;
      }

      // Optional: Adjust to prevent clipping left edge
      if (left < 0) {
        left = 10;
      }

      handleActiveModalType("Actions");
      onOpenModal({ top, left });
    }
  };

  const columns = useMemo(() => {
    return [
      {
        id: "__select",
        header: ({ table }) => (
          <div>
            <input
              id="checkbox-select-all"
              name="checkbox-select-all"
              type="checkbox"
              checked={table.getIsAllPageRowsSelected()}
              onChange={table.getToggleAllPageRowsSelectedHandler()}
              className="cursor-pointer"
            />
          </div>
        ),
        cell: ({ row }) => (
          <div className="flex items-center justify-center">
            <input
              id={`checkbox-select-${row.id}`}
              name={`checkbox-select-${row.id}`}
              type="checkbox"
              checked={row.getIsSelected()}
              disabled={!row.getCanSelect()}
              onChange={row.getToggleSelectedHandler()}
              className="cursor-pointer"
            />
          </div>
        ),
        size: 40,
        minSize: 40,
        maxSize: 40,
        enableResizing: false,
        meta: {
          flexPos: "center",
        },
      },
      ...filteredColumns,
      {
        id: "__actions",
        header: () => null,
        cell: ({ row }) => (
          <button
            onClick={(e) => handleEllipsisClick(row.original)(e)}
            className="p-1 text-secondary-text hover:text-brand-primary hover:cursor-pointer">
            <IoEllipsisHorizontal size={18} />
          </button>
        ),
        size: 50,
        minSize: 50,
        maxSize: 50,
        enableResizing: false,
        meta: {
          flexPos: "center",
        },
      },
    ];
  }, [filteredColumns]);

  const table = useReactTable({
    data,
    columns,
    pageCount: Math.ceil(totalCount / pageSize),
    state: {
      rowSelection,
      columnSizing,
      sorting,
      pagination: {
        pageIndex: page - 1,
        pageSize: pageSize,
      },
    },
    onColumnSizingChange: handleColumnSizingChange,
    columnResizeMode: "onChange",
    manualPagination: true,
    manualSorting: true,
    onRowSelectionChange: (updater) => {
      const newSelection =
        typeof updater === "function" ? updater(rowSelection) : updater;
      setRowSelection(newSelection);

      // Now update selectedRows based on visible rows
      const selected = Object.keys(newSelection)
        .map((rowId) => table.getRow(rowId)?.original)
        .filter(Boolean);

      setSelectedRows(selected);
    },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    enableRowSelection: true,
    onPaginationChange: (updater) => {
      const next =
        typeof updater === "function"
          ? updater({ pageIndex: page - 1, pageSize })
          : updater;

      const nextPage = next.pageIndex + 1; // Convert back to 1-based
      const nextPageSize = next.pageSize;

      setSearchParams((prev) => {
        const params = new URLSearchParams(prev);
        params.set("page", nextPage.toString());
        params.set("pageSize", nextPageSize.toString());
        return params;
      });
    },
  });

  if (error) return <div>Error: {error.message}</div>;

  return (
    <div className="flex flex-col w-[calc(100vw-32px)] md:w-[calc(100vw-97px)] min-w-0 overflow-hidden border border-border-color rounded-2xl h-[calc(100vh-150px)]">
      <div className="flex-1 overflow-x-auto">
        <div className="min-w-max overflow-hidden flex flex-col h-full">
          <Table
            table={table}
            rowSelection={rowSelection}
            onSelectedRowsChange={setSelectedRows}
            isLoading={isLoading}
            data={data}
            resizedColumns={resizedColumns}
          />
        </div>
      </div>
      <DataNavBar2
        table={table}
        totalCount={totalCount}
        onRefresh={onRefresh}
        isLoading={isLoading}
      />
    </div>
  );
};

export default TableWrapper;
