import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { FolderOpenIcon, PlusIcon, ShareIcon, SlidersHorizontalIcon, XIcon } from "@/components/icons";
import { useGlobalSearch } from "../../contexts/SearchProvider";
import { useQualityAlerts } from "../../hooks/useDocumentation";
import { usePermissions } from "../../hooks/useQmsApi";
import { useTablePreferences } from "../../hooks/useTablePreferences";
import { QUALITY_ALERT_FILTER_KEYS, useQualityAlertFilters } from "../../hooks/useUrlFilters";
import { exportCSV } from "../../lib/csvHelper";
import { CATEGORIES, SEVERITIES, STATUSES, categoryLabel, formatDay, referenceText, severityOf, statusOf } from "../../lib/qualityAlerts";
import Breadcrumb from "../Breadcrumb";
import CTAButton from "../CTAButton";
import IconButton from "../IconButton";
import TableWrapper from "../TableWrapper";
import ColumnVisibilityMenu from "../ui/ColumnVisibilityMenu";
import AlertFilterPane from "./AlertFilterPane";
import { DEFAULT_HIDDEN, alertColumns, alertHref } from "./alertColumns";

const rowLabel = (r) => r.reference;

const toCsvRow = (a) => ({
  alert: referenceText(a),
  title: a.title,
  category: categoryLabel(a.category),
  severity: severityOf(a.severity).label,
  status: statusOf(a.status).label,
  effective: a.effectiveDate ?? "",
  expires: a.expiryDate ?? "",
  acknowledge_by: a.acknowledgeBy ?? "",
  acknowledged: a.progress ? `${a.progress.acknowledged} of ${a.progress.total}` : "",
  overdue_acknowledgements: a.progress?.overdue ?? "",
  issued: a.issuedAt?.slice(0, 10) ?? "",
  issued_by: a.issuedBy?.name ?? "",
  drafted_by: a.createdBy?.name ?? "",
  updated: a.updatedAt?.slice(0, 10) ?? "",
});

/**
 * Quality alerts: communications that something needs immediate attention. The register is the same server-side table, column set, header search
 * and filter drawer as the other registers; it lists the newest revision of each alert unless statuses are chosen. Filters live in the URL.
 */
const QualityAlertsPage = () => {
  const navigate = useNavigate();
  const { can } = usePermissions();
  const manage = can("documentation.manage");
  const [searchParams, setSearchParams] = useSearchParams();
  const page = parseInt(searchParams.get("page") || "1", 10);
  const pageSize = parseInt(searchParams.get("pageSize") || "25", 10);
  const filters = useQualityAlertFilters();
  const { updateFilters } = filters;
  const { debouncedSearchTerm, setSearchTerm } = useGlobalSearch();
  const [sorting, setSortingState] = useState([{ id: "reference", desc: true }]);
  const [rowSelection, setRowSelection] = useState({});
  const [selectedRows, setSelectedRows] = useState([]);
  const [activeModalType, setActiveModalType] = useState(null);
  const prefs = useTablePreferences("quality-alert-register");
  const columnVisibility = { ...DEFAULT_HIDDEN, ...prefs.columnVisibility };
  const columns = useMemo(() => alertColumns({ manage }), [manage]);

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

  const { data, isLoading, isFetching, error, refetch } = useQualityAlerts({
    status: filters.status,
    category: filters.category,
    severity: filters.severity,
    ...(manage && filters.overdue === "true" ? { overdue: "true" } : {}),
    from: filters.from,
    to: filters.to,
    expiresFrom: filters.expiresFrom,
    expiresTo: filters.expiresTo,
    q: filters.search,
    sort: sortColumn,
    order: sorting[0]?.desc ? "desc" : "asc",
    page,
    pageSize,
  });
  const rows = data?.data ?? [];
  const total = data?.total ?? 0;

  useEffect(() => {
    setRowSelection({});
    setSelectedRows([]);
  }, [page, pageSize]);

  // The header search box feeds the register search (reference and title).
  useEffect(() => {
    if ((debouncedSearchTerm ?? "") !== filters.search) updateFilters({ search: debouncedSearchTerm });
    // Only react to the header search box; URL changes elsewhere must not loop back.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearchTerm]);

  const toggleModal = (t) => setActiveModalType((prev) => (prev === t ? null : t));
  const open = (a) => navigate(alertHref(a));
  const rowActions = (item) => [{ label: "Open", icon: FolderOpenIcon, onSelect: () => open(item) }];

  const list = (v) => (v ? v.split(",") : []);
  const words = (v, options) => list(v).map((k) => options.find((o) => o.value === k)?.label ?? k).join(", ");
  const between = (lo, hi) => (lo && hi ? `${formatDay(lo)} – ${formatDay(hi)}` : lo ? `from ${formatDay(lo)}` : `up to ${formatDay(hi)}`);
  const activeFilters = [
    ...(filters.search ? [{ key: "search", label: `Search: “${filters.search}”`, clear: { search: "" } }] : []),
    ...(filters.status ? [{ key: "status", label: `Status: ${words(filters.status, STATUSES)}`, clear: { status: "" } }] : []),
    ...(filters.category ? [{ key: "category", label: `Category: ${words(filters.category, CATEGORIES)}`, clear: { category: "" } }] : []),
    ...(filters.severity ? [{ key: "severity", label: `Severity: ${words(filters.severity, SEVERITIES)}`, clear: { severity: "" } }] : []),
    ...(manage && filters.overdue === "true" ? [{ key: "overdue", label: "Overdue acknowledgements", clear: { overdue: "" } }] : []),
    ...(filters.from || filters.to ? [{ key: "effective", label: `Effective ${between(filters.from, filters.to)}`, clear: { from: "", to: "" } }] : []),
    ...(filters.expiresFrom || filters.expiresTo ? [{ key: "expires", label: `Expires ${between(filters.expiresFrom, filters.expiresTo)}`, clear: { expiresFrom: "", expiresTo: "" } }] : []),
  ];
  const filterCount = activeFilters.filter((f) => f.key !== "search").length;
  const clearFilters = (values) => {
    updateFilters(values);
    if ("search" in values) setSearchTerm?.("");
  };

  return (
    <div className="flex w-full min-w-0 flex-1 min-h-0 flex-col gap-3 bg-primary-bg p-4">
      <div className="flex flex-row flex-wrap items-center justify-between gap-3 pl-1">
        <div className="flex flex-col gap-2">
          <Breadcrumb />
          <p className="h-4 text-sm text-primary-text" aria-live="polite">
            {selectedRows.length > 0 && `${selectedRows.length} selected`}
            {selectedRows.length === 0 && !isLoading && `${total.toLocaleString()} ${total === 1 ? "quality alert" : "quality alerts"}${filters.status ? "" : " (newest revisions)"}`}
          </p>
        </div>
        <div className="flex flex-row items-center justify-end gap-3">
          {selectedRows.length > 0 && (
            <CTAButton callbackFn={() => exportCSV(selectedRows.map(toCsvRow), "quality-alerts.csv")} text="Export CSV" type="success" title="Export the selected quality alerts to a CSV file" icon={ShareIcon} iconSize="h-6 w-6" />
          )}
          <ColumnVisibilityMenu
            columns={columns}
            columnVisibility={columnVisibility}
            onColumnVisibilityChange={prefs.setColumnVisibility}
            columnOrder={prefs.columnOrder}
            onColumnOrderChange={prefs.setColumnOrder}
            onReset={prefs.resetColumns}
          />
          {manage && <CTAButton callbackFn={() => navigate("/Documentation/Quality-Alerts/new")} text="New quality alert" type="main" icon={PlusIcon} iconSize="h-6 w-6" />}
          <IconButton count={filterCount} selected={activeModalType === "Filter"} color="blue" title="Filter" callback={toggleModal} icon={<SlidersHorizontalIcon className="h-4.5 w-4.5" />} />
          {/* The drawer calls onClose after sliding out; by then another menu may be open, so only clear the filter. */}
          {activeModalType === "Filter" && <AlertFilterPane manage={manage} onClose={() => setActiveModalType((t) => (t === "Filter" ? null : t))} />}
        </div>
      </div>
      {activeFilters.length > 0 && (
        <div aria-label="Active filters" className="flex flex-wrap items-center gap-2 px-1 text-sm">
          {activeFilters.map((f) => (
            <span key={f.key} className="flex items-center gap-1 rounded-full border border-brand-primary/50 bg-brand-primary/10 py-0.5 pl-3 pr-1 text-primary-text">
              {f.label}
              <button type="button" aria-label={`Remove filter ${f.label}`} onClick={() => clearFilters(f.clear)} className="rounded-full p-0.5 hover:bg-brand-primary/20 cursor-pointer">
                <XIcon className="h-3.5 w-3.5" />
              </button>
            </span>
          ))}
          <button type="button" onClick={() => clearFilters(Object.fromEntries(QUALITY_ALERT_FILTER_KEYS.map((k) => [k, ""])))} className="text-link-color hover:underline cursor-pointer">
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
          ariaLabel="Quality alerts"
          rowLabel={rowLabel}
        />
      </div>
    </div>
  );
};

export default QualityAlertsPage;
