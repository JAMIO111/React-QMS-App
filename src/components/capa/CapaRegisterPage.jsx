import { useCallback, useEffect, useMemo, useState } from "react";
import { customCsvValues, useCustomColumns, useCustomFilterChips } from "../custom-fields/customColumns";
import { useNavigate, useSearchParams } from "react-router-dom";
import { FolderOpenIcon, PlusIcon, ShareIcon, SlidersHorizontalIcon, XIcon } from "@/components/icons";
import { useGlobalSearch } from "../../contexts/SearchProvider";
import { useCapas } from "../../hooks/useCapa";
import { usePermissions } from "../../hooks/useQmsApi";
import { useTablePreferences } from "../../hooks/useTablePreferences";
import { CAPA_FILTER_KEYS, useCapaFilters } from "../../hooks/useUrlFilters";
import { SEVERITIES, SOURCES, STAGES, capaHref, stageOf } from "../../lib/capa";
import { exportCSV } from "../../lib/csvHelper";
import { formatDay } from "../../lib/qualityAlerts";
import Breadcrumb from "../Breadcrumb";
import CTAButton from "../CTAButton";
import IconButton from "../IconButton";
import TableWrapper from "../TableWrapper";
import ColumnVisibilityMenu from "../ui/ColumnVisibilityMenu";
import CapaFilterPane from "./CapaFilterPane";
import StartCapaDialog from "./StartCapaDialog";
import { DEFAULT_HIDDEN, capaColumns } from "./capaColumns";

const rowLabel = (r) => r.reference;
const nameOf = (list, id) => list.find((x) => x.id === id)?.name ?? id;

const toCsvRow = (c) => ({
  reference: c.reference,
  title: c.title,
  outside_reference: c.externalReference ?? "",
  stage: stageOf(c.stage).label,
  current_step: c.stage === "closed" || c.stage === "cancelled" ? "" : c.currentStep.toUpperCase(),
  steps_done: c.stepsDone,
  owner: c.owner?.name ?? "",
  due: c.dueDate ?? "",
  overdue: c.overdue ? "Yes" : "",
  non_conformances: c.ncrCount,
  severity: c.severity ?? "",
  source: c.source,
  started: c.createdAt?.slice(0, 10) ?? "",
  closed: c.closedAt?.slice(0, 10) ?? "",
});

/**
 * Corrective actions (8D): the register — the same server-side table, column set, header search and filter drawer as the NC register.
 * Running 8Ds by default (no stage filter); filters live in the URL. Starting an 8D here is for one that is not tied to a non-conformance;
 * from an NC use the Investigation card on the NC page.
 */
const CapaRegisterPage = () => {
  const navigate = useNavigate();
  const { can } = usePermissions();
  const manage = can("capa.manage");
  const [searchParams, setSearchParams] = useSearchParams();
  const page = parseInt(searchParams.get("page") || "1", 10);
  const pageSize = parseInt(searchParams.get("pageSize") || "25", 10);
  const filters = useCapaFilters();
  const { updateFilters } = filters;
  const { debouncedSearchTerm, setSearchTerm } = useGlobalSearch();
  const [sorting, setSortingState] = useState([{ id: "createdAt", desc: true }]);
  const [rowSelection, setRowSelection] = useState({});
  const [selectedRows, setSelectedRows] = useState([]);
  const [activeModalType, setActiveModalType] = useState(null);
  const [starting, setStarting] = useState(false);
  const prefs = useTablePreferences("capa-register");
  const custom = useCustomColumns("capa");
  const customFilters = useCustomFilterChips("capa");
  const columnVisibility = { ...DEFAULT_HIDDEN, ...custom.defaultHidden, ...prefs.columnVisibility };
  const columns = useMemo(() => [...capaColumns, ...custom.columns], [custom.columns]);

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

  const { data, isLoading, isFetching, error, refetch } = useCapas({
    stage: filters.stage || "running",
    source: filters.source,
    severity: filters.severity,
    owner: filters.owner,
    overdue: filters.overdue,
    from: filters.from,
    to: filters.to,
    q: filters.search,
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

  // The header search box feeds the register search (reference, title, problem, outside reference, owner, linked NCs).
  useEffect(() => {
    if ((debouncedSearchTerm ?? "") !== filters.search) updateFilters({ search: debouncedSearchTerm });
    // Only react to the header search box; URL changes elsewhere must not loop back.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearchTerm]);

  const toggleModal = (t) => setActiveModalType((prev) => (prev === t ? null : t));
  const open = (c) => navigate(capaHref(c));
  const rowActions = (item) => [{ label: "Open", icon: FolderOpenIcon, onSelect: () => open(item) }];

  const list = (v) => (v ? v.split(",") : []);
  const between = (lo, hi) => (lo && hi ? `${formatDay(lo)} – ${formatDay(hi)}` : lo ? `from ${formatDay(lo)}` : `up to ${formatDay(hi)}`);
  const activeFilters = [
    ...(filters.search ? [{ key: "search", label: `Search: “${filters.search}”`, clear: { search: "" } }] : []),
    ...(filters.stage ? [{ key: "stage", label: `Stage: ${list(filters.stage).map((k) => STAGES.find((s) => s.key === k)?.label ?? k).join(", ")}`, clear: { stage: "" } }] : []),
    ...(filters.source ? [{ key: "source", label: `Source: ${list(filters.source).map((k) => nameOf(SOURCES, k)).join(", ")}`, clear: { source: "" } }] : []),
    ...(filters.severity ? [{ key: "severity", label: `Severity: ${list(filters.severity).map((k) => nameOf(SEVERITIES, k)).join(", ")}`, clear: { severity: "" } }] : []),
    ...(filters.owner === "me" ? [{ key: "owner", label: "Owned by me", clear: { owner: "" } }] : []),
    ...(filters.overdue ? [{ key: "overdue", label: "Overdue", clear: { overdue: "" } }] : []),
    ...(filters.from || filters.to ? [{ key: "date", label: `Started ${between(filters.from, filters.to)}`, clear: { from: "", to: "" } }] : []),
    ...customFilters.chips,
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
            {selectedRows.length === 0 && !isLoading && `${total.toLocaleString()} ${total === 1 ? "8D" : "8Ds"}${filters.stage ? "" : " running"}`}
          </p>
        </div>
        <div className="flex flex-row items-center justify-end gap-3">
          {selectedRows.length > 0 && (
            <CTAButton callbackFn={() => exportCSV(selectedRows.map((r) => ({ ...toCsvRow(r), ...customCsvValues(custom.fields, r) })), "8ds.csv")} text="Export CSV" type="success" title="Export the selected 8Ds to a CSV file" icon={ShareIcon} iconSize="h-6 w-6" />
          )}
          <ColumnVisibilityMenu
            columns={columns}
            columnVisibility={columnVisibility}
            onColumnVisibilityChange={prefs.setColumnVisibility}
            columnOrder={prefs.columnOrder}
            onColumnOrderChange={prefs.setColumnOrder}
            onReset={prefs.resetColumns}
          />
          {manage && <CTAButton callbackFn={() => setStarting(true)} text="Start an 8D" type="main" icon={PlusIcon} iconSize="h-6 w-6" title="Start an 8D that is not tied to a non-conformance" />}
          <IconButton count={filterCount} selected={activeModalType === "Filter"} color="blue" title="Filter" callback={toggleModal} icon={<SlidersHorizontalIcon className="h-4.5 w-4.5" />} />
          {/* The drawer calls onClose after sliding out; by then another menu may be open, so only clear the filter. */}
          {activeModalType === "Filter" && <CapaFilterPane onClose={() => setActiveModalType((t) => (t === "Filter" ? null : t))} />}
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
            (() => clearFilters(Object.fromEntries(CAPA_FILTER_KEYS.map((k) => [k, ""]))))();
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
          ariaLabel="8Ds"
          rowLabel={rowLabel}
        />
      </div>
      {starting && <StartCapaDialog onClose={() => setStarting(false)} />}
    </div>
  );
};

export default CapaRegisterPage;
