import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { customCsvValues, useCustomColumns, useCustomFilterChips } from "../custom-fields/customColumns";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ClipboardCheckIcon, FolderOpenIcon, PlusIcon, RotateCcwIcon, ShareIcon, SlidersHorizontalIcon, Trash2Icon, XIcon } from "@/components/icons";
import { useGlobalSearch } from "../../contexts/SearchProvider";
import { useToast } from "../../contexts/ToastProvider";
import { useCalibrationMutation, useGauges, useGaugeTypes } from "../../hooks/useCalibration";
import { usePermissions, useSites } from "../../hooks/useQmsApi";
import { useTablePreferences } from "../../hooks/useTablePreferences";
import { GAUGE_FILTER_KEYS, useGaugeFilters } from "../../hooks/useUrlFilters";
import { describeApiError } from "../../lib/api-client";
import { DUE_FILTERS, OUTCOMES, describeDue, formatInterval, outcomeOf, statusOf } from "../../lib/calibration";
import { exportCSV } from "../../lib/csvHelper";
import { formatDate } from "../../lib/ncr";
import Breadcrumb from "../Breadcrumb";
import CTAButton from "../CTAButton";
import IconButton from "../IconButton";
import TableWrapper from "../TableWrapper";
import ReasonDialog from "../ncr/ReasonDialog";
import ColumnVisibilityMenu from "../ui/ColumnVisibilityMenu";
import GaugeFilterPane from "./GaugeFilterPane";
import { DEFAULT_HIDDEN, gaugeColumns } from "./gaugeColumns";

const rowLabel = (g) => g.assetNumber;

const toCsvRow = (g) => ({
  asset_number: g.assetNumber,
  description: g.description,
  type: g.type?.name ?? "",
  status: statusOf(g.status).label,
  status_reason: g.statusReason ?? "",
  next_due: g.nextDueOn ?? "",
  due: describeDue(g.daysUntilDue),
  last_calibrated: g.lastCalibratedOn ?? "",
  last_result: outcomeOf(g.lastOutcome)?.label ?? "",
  interval: formatInterval(g.intervalValue, g.intervalUnit),
  site: g.site?.name ?? "",
  location: g.location ?? "",
  custodian: g.custodian?.name ?? "",
  manufacturer: g.manufacturer ?? "",
  model: g.model ?? "",
  serial_number: g.serialNumber ?? "",
  range_from: g.rangeMin ?? "",
  range_to: g.rangeMax ?? "",
  unit: g.unitCode ?? "",
  calibrated: g.calibrationSource === "external" ? "External" : "In-house",
  calibration_supplier: g.supplier?.name ?? "",
  deleted: g.deletedAt ? "yes" : "",
});

/** Register of gauges and measuring equipment (/Calibration/Gauges). */
const GaugeRegister = () => {
  const navigate = useNavigate();
  const { can } = usePermissions();
  const { showToast } = useToast();
  const restoreMutation = useCalibrationMutation();
  const [searchParams, setSearchParams] = useSearchParams();
  const page = parseInt(searchParams.get("page") || "1", 10);
  const pageSize = parseInt(searchParams.get("pageSize") || "25", 10);
  const filters = useGaugeFilters();
  const { updateFilters } = filters;
  const { debouncedSearchTerm, setSearchTerm } = useGlobalSearch();
  const { data: types } = useGaugeTypes({ includeInactive: true });
  const { data: sites } = useSites({ includeInactive: true });
  const [sorting, setSortingState] = useState([{ id: "nextDueOn", desc: false }]);
  const [rowSelection, setRowSelection] = useState({});
  const [selectedRows, setSelectedRows] = useState([]);
  const [activeModalType, setActiveModalType] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const deleteMutation = useCalibrationMutation();
  const headerRef = useRef(null);
  const prefs = useTablePreferences("gauge-register");
  const custom = useCustomColumns("gauge");
  const customFilters = useCustomFilterChips("gauge");
  const columnVisibility = { ...DEFAULT_HIDDEN, ...custom.defaultHidden, ...prefs.columnVisibility };
  const columns = useMemo(() => [...gaugeColumns, ...custom.columns], [custom.columns]);

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
  const sortColumn = sorting[0] ? columns.find((c) => c.id === sorting[0].id)?.meta?.sortKey : undefined;

  const { data, isLoading, isFetching, error, refetch } = useGauges({
    q: filters.search,
    status: filters.status,
    due: filters.due,
    outcome: filters.outcome,
    typeId: filters.type,
    siteId: filters.site,
    supplierId: filters.supplier,
    source: filters.source,
    from: filters.from,
    to: filters.to,
    deleted: filters.deleted || undefined,
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

  const restore = (item) =>
    restoreMutation.mutate(
      { path: `/gauges/${item.id}/restore` },
      {
        onSuccess: () => showToast({ type: "success", title: "Restored", message: `${item.assetNumber} is back in the register.` }),
        onError: (error) => showToast({ type: "error", title: "Not restored", message: describeApiError(error) }),
      }
    );
  const rowActions = (item) => [
    { label: "Open", icon: FolderOpenIcon, onSelect: () => navigate(`/Calibration/Gauges/${item.id}`) },
    can("calibration.record") && !item.deletedAt && { label: "Record calibration", icon: ClipboardCheckIcon, onSelect: () => navigate(`/Calibration/Gauges/${item.id}/calibrations/new`) },
    can("calibration.manage") && !item.deletedAt && { label: "Delete", icon: Trash2Icon, tone: "danger", onSelect: () => { deleteMutation.reset(); setDeleting(item); } },
    can("calibration.manage") && item.deletedAt && { label: "Restore", icon: RotateCcwIcon, onSelect: () => restore(item) },
  ];

  const list = (v) => (v ? v.split(",") : []);
  const labelOf = (options, keys) => list(keys).map((k) => options.find((o) => o.key === k)?.label ?? k).join(", ");
  const between = (lo, hi) => (lo && hi ? `${formatDate(lo)} – ${formatDate(hi)}` : lo ? `from ${formatDate(lo)}` : `up to ${formatDate(hi)}`);
  const activeFilters = [
    ...(filters.search ? [{ key: "search", label: `Search: “${filters.search}”`, clear: { search: "" } }] : []),
    ...(filters.due ? [{ key: "due", label: `Due: ${labelOf(DUE_FILTERS, filters.due)}`, clear: { due: "" } }] : []),
    ...(filters.status ? [{ key: "status", label: `Status: ${list(filters.status).map((k) => statusOf(k).label).join(", ")}`, clear: { status: "" } }] : []),
    ...(filters.outcome ? [{ key: "outcome", label: `Last result: ${labelOf(OUTCOMES, filters.outcome)}`, clear: { outcome: "" } }] : []),
    ...(filters.from || filters.to ? [{ key: "date", label: `Next due ${between(filters.from, filters.to)}`, clear: { from: "", to: "" } }] : []),
    ...(filters.type ? [{ key: "type", label: `Type: ${(types ?? []).find((t) => t.id === filters.type)?.name ?? "…"}`, clear: { type: "" } }] : []),
    ...(filters.site ? [{ key: "site", label: `Site: ${(sites?.data ?? []).find((s) => s.id === filters.site)?.name ?? "…"}`, clear: { site: "" } }] : []),
    ...(filters.source ? [{ key: "source", label: filters.source === "external" ? "Calibrated externally" : "Calibrated in-house", clear: { source: "" } }] : []),
    ...(filters.supplier ? [{ key: "supplier", label: `Supplier: ${filters.supplierLabel || "selected"}`, clear: { supplier: "", supplierLabel: "" } }] : []),
    ...(filters.deleted ? [{ key: "deleted", label: filters.deleted === "only" ? "Deleted only" : "Including deleted", clear: { deleted: "" } }] : []),
    ...customFilters.chips,
  ];
  const filterCount = activeFilters.filter((f) => f.key !== "search").length;
  const clearFilters = (values) => {
    updateFilters(values);
    if ("search" in values) setSearchTerm?.("");
  };
  const openGauge = (g) => navigate(`/Calibration/Gauges/${g.id}`);

  return (
    <div className="flex w-full min-w-0 flex-1 min-h-0 flex-col gap-3 bg-primary-bg p-4">
      <div ref={headerRef} className="flex flex-row flex-wrap items-center justify-between gap-3 pl-1">
        <div className="flex flex-col gap-2">
          <Breadcrumb />
          <p className="h-4 text-sm text-primary-text" aria-live="polite">
            {selectedRows.length > 0 && `${selectedRows.length} selected`}
            {selectedRows.length === 0 && !isLoading && `${total.toLocaleString()} ${total === 1 ? "gauge" : "gauges"}${filters.deleted === "only" ? " (deleted)" : ""}`}
          </p>
        </div>
        <div className="flex flex-row items-center justify-end gap-3">
          {selectedRows.length > 0 && (
            <CTAButton callbackFn={() => exportCSV(selectedRows.map((r) => ({ ...toCsvRow(r), ...customCsvValues(custom.fields, r) })), "gauges.csv")} text="Export CSV" type="success" title="Export the selected gauges to a CSV file" icon={ShareIcon} iconSize="h-6 w-6" />
          )}
          <ColumnVisibilityMenu
            columns={columns}
            columnVisibility={columnVisibility}
            onColumnVisibilityChange={prefs.setColumnVisibility}
            columnOrder={prefs.columnOrder}
            onColumnOrderChange={prefs.setColumnOrder}
            onReset={prefs.resetColumns}
          />
          {can("calibration.manage") && (
            <CTAButton callbackFn={() => navigate("/Calibration/Gauges/new")} text="New gauge" type="main" icon={PlusIcon} iconSize="h-6 w-6" title="Add a gauge or piece of measuring equipment" />
          )}
          <IconButton count={filterCount} selected={activeModalType === "Filter"} color="blue" title="Filter" callback={toggleModal} icon={<SlidersHorizontalIcon className="h-4.5 w-4.5" />} />
          {/* The drawer calls onClose after sliding out; by then another menu may be open, so only clear the filter. */}
          {activeModalType === "Filter" && <GaugeFilterPane onClose={() => setActiveModalType((t) => (t === "Filter" ? null : t))} />}
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
            (() => clearFilters(Object.fromEntries(GAUGE_FILTER_KEYS.map((k) => [k, ""]))))();
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
          onRowDoubleClick={openGauge}
          ariaLabel="Gauges"
          rowLabel={rowLabel}
        />
      </div>

      {deleting && (
        <ReasonDialog
          title={`Delete ${deleting.assetNumber}?`}
          label="Reason for deleting (the gauge and its records are kept and can be restored)"
          confirmText="Delete"
          pending={deleteMutation.isPending}
          error={deleteMutation.error}
          onClose={() => setDeleting(null)}
          onConfirm={(reason) =>
            deleteMutation.mutate(
              { path: `/gauges/${deleting.id}/delete`, body: { reason } },
              {
                onSuccess: () => {
                  showToast({ type: "success", title: "Deleted", message: `${deleting.assetNumber} was deleted. It can be restored from the deleted records filter.` });
                  setDeleting(null);
                },
              }
            )
          }
        />
      )}
    </div>
  );
};

export default GaugeRegister;
