import { useEffect, useState } from "react";
import { getCoreRowModel, useReactTable } from "@tanstack/react-table";
import Table from "../Table";
import { SearchIcon } from "@/components/icons";
import { useTablePreferences } from "../../hooks/useTablePreferences";
import { useColumnSizingInfo } from "../../hooks/useColumnSizingInfo";
import { describeApiError } from "../../lib/api-client";

export const buttonClass = {
  primary:
    "rounded-lg border border-cta-btn-border bg-cta-btn-bg px-4 py-2 text-sm text-primary-text hover:bg-cta-btn-bg-hover disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer",
  neutral:
    "rounded-lg border border-neutral-btn-border bg-neutral-btn-bg px-3 py-1.5 text-sm text-primary-text hover:bg-neutral-btn-bg-hover disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer",
  danger:
    "rounded-lg border border-error-btn-border bg-error-btn-bg px-3 py-1.5 text-sm text-primary-text hover:bg-error-btn-bg-hover disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer",
};

/** Search box whose value is passed on after typing pauses. */
export const SearchBox = ({ label, onSearch, delay = 300 }) => {
  const [value, setValue] = useState("");
  useEffect(() => {
    const t = setTimeout(() => onSearch(value.trim()), delay);
    return () => clearTimeout(t);
  }, [value, delay, onSearch]);
  return (
    <div className="relative w-72 max-w-full">
      <SearchIcon className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-icon-color" />
      <input
        type="search"
        aria-label={label}
        placeholder={label}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className="w-full rounded-lg border border-border-color bg-text-input-color py-2 pl-9 pr-3 text-sm text-primary-text focus:outline-none focus:border-brand-primary"
      />
    </div>
  );
};

export const ErrorNotice = ({ error }) => (
  <p role="alert" className="rounded-lg border border-error-color/40 bg-error-color/10 p-3 text-sm text-primary-text">
    {describeApiError(error)}
  </p>
);

/**
 * A master-data list: the shared Table with resizable, hideable, reorderable columns remembered under
 * `storageKey`, rows from a paged query, and "Load more".
 */
export const DataList = ({ storageKey, columns, query, onOpen, emptyMessage, ariaLabel }) => {
  const prefs = useTablePreferences(storageKey);
  const sizingInfo = useColumnSizingInfo();
  const table = useReactTable({
    data: query.data?.items ?? [],
    columns,
    getRowId: (row) => row.id,
    state: {
      columnVisibility: prefs.columnVisibility,
      columnSizing: prefs.columnSizing,
      columnOrder: prefs.columnOrder,
      columnSizingInfo: sizingInfo.columnSizingInfo,
    },
    onColumnVisibilityChange: prefs.setColumnVisibility,
    onColumnSizingChange: prefs.setColumnSizing,
    onColumnOrderChange: prefs.setColumnOrder,
    enableColumnReordering: true,
    onColumnSizingInfoChange: sizingInfo.onColumnSizingInfoChange,
    columnResizeMode: "onChange",
    enableSorting: false, // lists come ordered by code / number from the server
    getCoreRowModel: getCoreRowModel(),
  });
  if (query.error) return <ErrorNotice error={query.error} />;
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-border-color">
      <div className="min-h-0 flex-1">
        <Table
          table={table}
          isLoading={query.isLoading}
          emptyMessage={emptyMessage}
          ariaLabel={ariaLabel}
          onRowClick={onOpen ? (row) => onOpen(row.original) : undefined}
        />
      </div>
      {query.hasNextPage && (
        <div className="border-t border-border-color p-2">
          <button type="button" className={buttonClass.neutral} disabled={query.isFetchingNextPage} onClick={() => query.fetchNextPage()}>
            {query.isFetchingNextPage ? "Loading…" : "Load more"}
          </button>
        </div>
      )}
    </div>
  );
};

export const ActiveBadge = ({ active }) =>
  active ? (
    <span className="rounded-full bg-success-color/15 px-2 py-0.5 text-xs text-success-color">Active</span>
  ) : (
    <span className="rounded-full bg-border-color px-2 py-0.5 text-xs text-secondary-text">Inactive</span>
  );
