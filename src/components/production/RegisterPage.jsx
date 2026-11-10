import CustomFieldFilters from "../custom-fields/CustomFieldFilters";
import { customCsvValues, useCustomColumns, useCustomFilterChips } from "../custom-fields/customColumns";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { PencilIcon, PlusIcon, ShareIcon, XIcon } from "@/components/icons";
import { useGlobalSearch } from "../../contexts/SearchProvider";
import { useTablePreferences } from "../../hooks/useTablePreferences";
import { useUrlFilters } from "../../hooks/useUrlFilters";
import { exportCSV } from "../../lib/csvHelper";
import Breadcrumb from "../Breadcrumb";
import CTAButton from "../CTAButton";
import TableWrapper from "../TableWrapper";
import ColumnVisibilityMenu from "../ui/ColumnVisibilityMenu";

/**
 * A server-side register (search, status chips, optional selects, sort, pages) shared by production orders, lots and serial numbers. Filters live in the URL.
 * `useRegister(params)` is the data hook; `toParams(filters, sort, page, pageSize)` maps URL filters to its query; `onOpen(row)` opens a record; `children(editing, close)`
 * renders the add/edit dialog.
 */
const RegisterPage = ({
  noun,
  nounPlural,
  columns: baseColumns,
  defaultHidden: baseHidden = {},
  entityType,
  prefsKey,
  defaultSort,
  useRegister,
  statusOptions,
  selects = [],
  scopes = [],
  canManage,
  newLabel,
  onOpen,
  rowLabel,
  toCsvRow,
  csvName,
  dialog,
}) => {
  const [searchParams, setSearchParams] = useSearchParams();
  const page = parseInt(searchParams.get("page") || "1", 10);
  const pageSize = parseInt(searchParams.get("pageSize") || "25", 10);
  const filterKeys = ["search", "status", ...selects.map((s) => s.key), ...scopes.map((s) => s.key)];
  const filters = useUrlFilters(filterKeys);
  const { updateFilters } = filters;
  const { debouncedSearchTerm, setSearchTerm } = useGlobalSearch();
  const [sorting, setSortingState] = useState([defaultSort]);
  const [rowSelection, setRowSelection] = useState({});
  const [selectedRows, setSelectedRows] = useState([]);
  const [editing, setEditing] = useState(undefined); // undefined: closed, null: new, record: edit
  const prefs = useTablePreferences(prefsKey);
  // The kind of record's custom fields: extra columns (hidden until shown), filters in the address (cf_<key>) and CSV values.
  const custom = useCustomColumns(entityType);
  const customFilters = useCustomFilterChips(entityType);
  const columns = useMemo(() => [...baseColumns, ...custom.columns], [baseColumns, custom.columns]);
  const columnVisibility = { ...baseHidden, ...custom.defaultHidden, ...prefs.columnVisibility };

  const setPage = useCallback(
    (p) =>
      setSearchParams((prev) => {
        const params = new URLSearchParams(prev);
        params.set("page", p);
        return params;
      }),
    [setSearchParams]
  );
  const setSorting = (updater) => {
    setSortingState(updater);
    if (page !== 1) setPage(1);
  };
  const sortKey = sorting[0] ? columns.find((c) => c.id === sorting[0].id)?.meta?.sortKey : undefined;

  const { data, isLoading, isFetching, error, refetch } = useRegister({
    q: filters.search,
    status: filters.status,
    ...Object.fromEntries([...selects, ...scopes].map((s) => [s.key, filters[s.key]])),
    sort: sortKey,
    order: sorting[0]?.desc ? "desc" : "asc",
    page,
    pageSize,
    ...(entityType ? customFilters.params : {}),
  });
  const rows = data?.data ?? [];
  const total = data?.total ?? 0;

  useEffect(() => {
    setRowSelection({});
    setSelectedRows([]);
  }, [page, pageSize]);
  useEffect(() => {
    if ((debouncedSearchTerm ?? "") !== filters.search) updateFilters({ search: debouncedSearchTerm });
    // Only react to the header search box; URL changes elsewhere must not loop back.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearchTerm]);

  const rowActions = (item) => [{ label: canManage ? "Open" : "View", icon: PencilIcon, onSelect: () => open(item) }];

  const chosen = filters.status ? filters.status.split(",") : [];
  const toggleStatus = (value) => updateFilters({ status: (chosen.includes(value) ? chosen.filter((v) => v !== value) : [...chosen, value]).join(",") });
  const activeFilters = [
    ...(filters.search ? [{ key: "search", label: `Search: “${filters.search}”`, clear: { search: "" } }] : []),
    ...scopes.filter((s) => filters[s.key]).map((s) => ({ key: s.key, label: s.label, clear: { [s.key]: "" } })),
    ...(entityType ? customFilters.chips : []),
  ];
  const clearAll = () => {
    if (entityType) customFilters.clearAll();
    updateFilters(Object.fromEntries(filterKeys.map((k) => [k, ""])));
    setSearchTerm?.("");
  };
  const open = (r) => {
    onOpen(r, setEditing);
  };

  return (
    <div className="flex w-full min-w-0 flex-1 min-h-0 flex-col gap-3 bg-primary-bg p-4">
      <div className="flex flex-row flex-wrap items-center justify-between gap-3 pl-1">
        <div className="flex flex-col gap-2">
          <Breadcrumb />
          <p className="h-4 text-sm text-primary-text" aria-live="polite">
            {selectedRows.length > 0 && `${selectedRows.length} selected`}
            {selectedRows.length === 0 && !isLoading && `${total.toLocaleString()} ${total === 1 ? noun : nounPlural}`}
          </p>
        </div>
        <div className="flex flex-row items-center justify-end gap-3">
          {selectedRows.length > 0 && <CTAButton callbackFn={() => exportCSV(selectedRows.map((r) => ({ ...toCsvRow(r), ...customCsvValues(custom.fields, r) })), csvName)} text="Export CSV" type="success" title={`Export the selected ${nounPlural} to a CSV file`} icon={ShareIcon} iconSize="h-6 w-6" />}
          <ColumnVisibilityMenu columns={columns} columnVisibility={columnVisibility} onColumnVisibilityChange={prefs.setColumnVisibility} columnOrder={prefs.columnOrder} onColumnOrderChange={prefs.setColumnOrder} onReset={prefs.resetColumns} />
          {canManage && <CTAButton callbackFn={() => setEditing(null)} text={newLabel} type="main" icon={PlusIcon} iconSize="h-6 w-6" title={newLabel} />}
        </div>
      </div>

      <div role="group" aria-label="Filters" className="flex flex-wrap items-end gap-x-4 gap-y-2 px-1">
        <div role="group" aria-label="Status" className="flex flex-wrap items-center gap-1.5">
          {statusOptions.map((o) => {
            const on = chosen.includes(o.value);
            return (
              <button
                key={o.value}
                type="button"
                aria-pressed={on}
                onClick={() => toggleStatus(o.value)}
                className={`rounded-full border px-3 py-1 text-sm cursor-pointer ${on ? "border-brand-primary bg-brand-primary/15 text-primary-text" : "border-border-color text-secondary-text hover:border-border-dark-color"}`}>
                {o.label}
              </button>
            );
          })}
        </div>
        {selects.map((s) => (
          <label key={s.key} className="flex items-center gap-2 text-sm text-secondary-text">
            {s.label}
            <select value={filters[s.key]} onChange={(e) => updateFilters({ [s.key]: e.target.value })} className="h-8 rounded-lg border border-border-color bg-text-input-color px-2 text-sm text-primary-text">
              <option value="">All</option>
              {s.options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        ))}
        {entityType && custom.fields.length > 0 && (
          <details className="relative text-sm">
            <summary className="cursor-pointer select-none rounded-full border border-border-color px-3 py-1 text-secondary-text hover:border-border-dark-color">More filters</summary>
            <div className="absolute z-30 mt-2 w-80 rounded-xl border border-border-color bg-secondary-bg p-4 shadow-lg">
              <CustomFieldFilters entityType={entityType} />
            </div>
          </details>
        )}
      </div>
      {activeFilters.length > 0 && (
        <div aria-label="Active filters" className="flex flex-wrap items-center gap-2 px-1 text-sm">
          {activeFilters.map((f) => (
            <span key={f.key} className="flex items-center gap-1 rounded-full border border-brand-primary/50 bg-brand-primary/10 py-0.5 pl-3 pr-1 text-primary-text">
              {f.label}
              <button type="button" aria-label={`Remove filter ${f.label}`} onClick={() => (f.clearCustom ? f.clearCustom() : updateFilters(f.clear))} className="rounded-full p-0.5 hover:bg-brand-primary/20 cursor-pointer">
                <XIcon className="h-3.5 w-3.5" />
              </button>
            </span>
          ))}
          <button type="button" onClick={clearAll} className="text-link-color hover:underline cursor-pointer">
            Clear all
          </button>
        </div>
      )}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-auto">
        <TableWrapper
          data={rows}
          isLoading={isLoading || isFetching}
          error={error}
          totalCount={total}
          page={page}
          pageSize={pageSize}
          setSelectedRows={setSelectedRows}
          rowActions={rowActions}
          onRefresh={refetch}
          sorting={sorting}
          setSorting={setSorting}
          columns={columns}
          columnVisibility={columnVisibility}
          onColumnVisibilityChange={prefs.setColumnVisibility}
          columnSizing={prefs.columnSizing}
          onColumnSizingChange={prefs.setColumnSizing}
          columnOrder={prefs.columnOrder}
          onColumnOrderChange={prefs.setColumnOrder}
          rowSelection={rowSelection}
          setRowSelection={setRowSelection}
          onRowDoubleClick={open}
          ariaLabel={nounPlural[0].toUpperCase() + nounPlural.slice(1)}
          rowLabel={rowLabel}
        />
      </div>
      {editing !== undefined && dialog(editing ? (rows.find((r) => r.id === editing.id) ?? editing) : editing, () => setEditing(undefined))}
    </div>
  );
};

export default RegisterPage;
