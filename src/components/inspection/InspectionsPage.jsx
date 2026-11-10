import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { customCsvValues, useCustomColumns, useCustomFilterChips } from "../custom-fields/customColumns";
import { useNavigate, useSearchParams } from "react-router-dom";
import { FolderOpenIcon, PlusIcon, ShareIcon, SlidersHorizontalIcon, XIcon } from "@/components/icons";
import { useGlobalSearch } from "../../contexts/SearchProvider";
import { usePermissions } from "../../hooks/useQmsApi";
import { useInspections } from "../../hooks/useInspection";
import { useProductionSettings } from "../../hooks/useProduction";
import { useTablePreferences } from "../../hooks/useTablePreferences";
import { INSPECTION_FILTER_KEYS, useInspectionFilters } from "../../hooks/useUrlFilters";
import { exportCSV } from "../../lib/csvHelper";
import { STATUS, TRIGGER_LABEL } from "../../lib/inspection";
import { formatDate } from "../../lib/ncr";
import { formatDateTime } from "../../lib/processControl";
import Breadcrumb from "../Breadcrumb";
import CTAButton from "../CTAButton";
import IconButton from "../IconButton";
import TableWrapper from "../TableWrapper";
import ColumnVisibilityMenu from "../ui/ColumnVisibilityMenu";
import InspectionFilterPane from "./InspectionFilterPane";
import { DEFAULT_HIDDEN, inspectionColumns } from "./inspectionColumns";

const rowLabel = (r) => r.reference;

const toCsvRow = (r) => ({
  inspection: r.reference,
  part: r.part.partNumber,
  part_revision: r.partRevision,
  operation: r.operationCode ?? "All",
  control_plan: `${r.plan.planCode} rev ${r.plan.revisionCode}`,
  production_order: r.links?.productionOrder?.orderNumber ?? r.workOrder ?? "",
  work_order: r.workOrder ?? "",
  lot: r.lot ?? "",
  serial: r.serial ?? "",
  trigger: TRIGGER_LABEL[r.triggerType] ?? r.triggerType,
  status: STATUS[r.status]?.label ?? r.status,
  result: r.result ?? "",
  failed_readings: r.failures,
  started: formatDateTime(r.startedAt),
  operator: r.startedBy?.name ?? "",
  site: r.site?.name ?? "",
  machine: r.machine ? `${r.machine.code} · ${r.machine.name}` : "",
});

/** Register of in-process inspections (/Inspections): the same server-side table, column set and filter drawer as the NC and gauge registers. */
const InspectionsPage = () => {
  const navigate = useNavigate();
  const { can } = usePermissions();
  const [searchParams, setSearchParams] = useSearchParams();
  const page = parseInt(searchParams.get("page") || "1", 10);
  const pageSize = parseInt(searchParams.get("pageSize") || "25", 10);
  const filters = useInspectionFilters();
  const { updateFilters } = filters;
  const { debouncedSearchTerm, setSearchTerm } = useGlobalSearch();
  const [sorting, setSortingState] = useState([{ id: "startedAt", desc: true }]);
  const [rowSelection, setRowSelection] = useState({});
  const [selectedRows, setSelectedRows] = useState([]);
  const [activeModalType, setActiveModalType] = useState(null);
  const headerRef = useRef(null);
  const prefs = useTablePreferences("inspection-register");
  const { useLotsAndSerials } = useProductionSettings();
  // With lots and serial numbers switched off the lot column has nothing to show.
  const custom = useCustomColumns("inspection");
  const customFilters = useCustomFilterChips("inspection");
  const columnVisibility = { ...DEFAULT_HIDDEN, ...custom.defaultHidden, ...prefs.columnVisibility, ...(useLotsAndSerials ? {} : { context: false }) };
  const columns = useMemo(() => [...(useLotsAndSerials ? inspectionColumns : inspectionColumns.filter((c) => c.id !== "context")), ...custom.columns], [useLotsAndSerials, custom.columns]);

  const setPage = useCallback(
    (p) =>
      setSearchParams((prev) => {
        const params = new URLSearchParams(prev);
        params.set("page", p);
        return params;
      }),
    [setSearchParams]
  );
  // A new sort order starts from the first page.
  const setSorting = (updater) => {
    setSortingState(updater);
    if (page !== 1) setPage(1);
  };
  const sortColumn = sorting[0] ? columns.find((c) => c.id === sorting[0].id)?.meta?.sortKey : undefined;

  const { data, isLoading, isFetching, error, refetch } = useInspections({
    q: filters.search,
    status: filters.status,
    result: filters.result,
    trigger: filters.trigger,
    partId: filters.part,
    siteId: filters.site,
    machineId: filters.machine,
    productionOrderId: filters.order,
    from: filters.from,
    to: filters.to,
    sort: sortColumn,
    order: sorting[0]?.desc ? "desc" : "asc",
    page,
    pageSize,
    ...customFilters.params,
  });
  const rows = data?.data ?? [];
  const total = data?.total ?? 0;

  useEffect(() => {
    setRowSelection({});
    setSelectedRows([]);
  }, [page, pageSize]);

  // The header search box feeds the register search.
  useEffect(() => {
    if ((debouncedSearchTerm ?? "") !== filters.search) updateFilters({ search: debouncedSearchTerm });
    // Only react to the header search box; URL changes elsewhere must not loop back.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearchTerm]);

  const toggleModal = (t) => setActiveModalType((prev) => (prev === t ? null : t));

  const rowActions = (item) => [{ label: "Open", icon: FolderOpenIcon, onSelect: () => navigate(`/Inspections/${item.id}`) }];

  const list = (v) => (v ? v.split(",") : []);
  const between = (lo, hi) => (lo && hi ? `${formatDate(lo)} – ${formatDate(hi)}` : lo ? `from ${formatDate(lo)}` : `up to ${formatDate(hi)}`);
  const activeFilters = [
    ...(filters.search ? [{ key: "search", label: `Search: “${filters.search}”`, clear: { search: "" } }] : []),
    ...(filters.status ? [{ key: "status", label: `Status: ${list(filters.status).map((k) => STATUS[k]?.label ?? k).join(", ")}`, clear: { status: "" } }] : []),
    ...(filters.result ? [{ key: "result", label: `Result: ${list(filters.result).map((k) => (k === "pass" ? "Pass" : "Fail")).join(", ")}`, clear: { result: "" } }] : []),
    ...(filters.trigger ? [{ key: "trigger", label: `Trigger: ${list(filters.trigger).map((k) => TRIGGER_LABEL[k] ?? k).join(", ")}`, clear: { trigger: "" } }] : []),
    ...(filters.from || filters.to ? [{ key: "date", label: `Started ${between(filters.from, filters.to)}`, clear: { from: "", to: "" } }] : []),
    ...(filters.part ? [{ key: "part", label: `Part: ${filters.partLabel || "selected part"}`, clear: { part: "", partLabel: "" } }] : []),
    ...(filters.site ? [{ key: "site", label: "Site", clear: { site: "" } }] : []),
    ...(filters.order ? [{ key: "order", label: `Order: ${filters.orderLabel || "selected"}`, clear: { order: "", orderLabel: "" } }] : []),
    ...(filters.machine ? [{ key: "machine", label: `Machine: ${filters.machineLabel || "selected"}`, clear: { machine: "", machineLabel: "" } }] : []),
    ...customFilters.chips,
  ];
  const filterCount = activeFilters.filter((f) => f.key !== "search").length;
  const clearFilters = (values) => {
    updateFilters(values);
    if ("search" in values) setSearchTerm?.("");
  };
  const open = (r) => navigate(`/Inspections/${r.id}`);

  return (
    <div className="flex w-full min-w-0 flex-1 min-h-0 flex-col gap-3 bg-primary-bg p-4">
      <div ref={headerRef} className="flex flex-row flex-wrap items-center justify-between gap-3 pl-1">
        <div className="flex flex-col gap-2">
          <Breadcrumb />
          <p className="h-4 text-sm text-primary-text" aria-live="polite">
            {selectedRows.length > 0 && `${selectedRows.length} selected`}
            {selectedRows.length === 0 && !isLoading && `${total.toLocaleString()} ${total === 1 ? "inspection" : "inspections"}`}
          </p>
        </div>
        <div className="flex flex-row items-center justify-end gap-3">
          {selectedRows.length > 0 && (
            <CTAButton callbackFn={() => exportCSV(selectedRows.map((r) => ({ ...toCsvRow(r), ...customCsvValues(custom.fields, r) })), "inspections.csv")} text="Export CSV" type="success" title="Export the selected inspections to a CSV file" icon={ShareIcon} iconSize="h-6 w-6" />
          )}
          <ColumnVisibilityMenu
            columns={columns}
            columnVisibility={columnVisibility}
            onColumnVisibilityChange={prefs.setColumnVisibility}
            columnOrder={prefs.columnOrder}
            onColumnOrderChange={prefs.setColumnOrder}
            onReset={prefs.resetColumns}
          />
          {can("inspection.record") && (
            <CTAButton callbackFn={() => navigate("/Inspections/new")} text="Start inspection" type="main" icon={PlusIcon} iconSize="h-6 w-6" title="Start an in-process inspection" />
          )}
          <IconButton count={filterCount} selected={activeModalType === "Filter"} color="blue" title="Filter" callback={toggleModal} icon={<SlidersHorizontalIcon className="h-4.5 w-4.5" />} />
          {/* The drawer calls onClose after sliding out; by then another menu may be open, so only clear the filter. */}
          {activeModalType === "Filter" && <InspectionFilterPane onClose={() => setActiveModalType((t) => (t === "Filter" ? null : t))} />}
        </div>
      </div>
      {activeFilters.length > 0 && (
        <div aria-label="Active filters" className="flex flex-wrap items-center gap-2 px-1 text-sm">
          {activeFilters.map((f) => (
            <span key={f.key} className="flex items-center gap-1 rounded-full border border-brand-primary/50 bg-brand-primary/10 py-0.5 pl-3 pr-1 text-primary-text">
              {f.label}
              <button type="button" aria-label={`Remove filter ${f.label}`} onClick={() => (f.clearCustom ? f.clearCustom() : clearFilters(f.clear))} className="rounded-full p-0.5 hover:bg-brand-primary/20 cursor-pointer">
                <XIcon className="h-3.5 w-3.5" />
              </button>
            </span>
          ))}
          <button type="button" onClick={() => {
            customFilters.clearAll();
            (() => clearFilters(Object.fromEntries(INSPECTION_FILTER_KEYS.map((k) => [k, ""]))))();
          }} className="text-link-color hover:underline cursor-pointer">
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
          ariaLabel="Inspections"
          rowLabel={rowLabel}
        />
      </div>

    </div>
  );
};

export default InspectionsPage;
