import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { FolderOpenIcon, PlusIcon, ShareIcon, SlidersHorizontalIcon, XIcon } from "@/components/icons";
import { useGlobalSearch } from "../../contexts/SearchProvider";
import { usePermissions } from "../../hooks/useQmsApi";
import { useFmeas } from "../../hooks/useFmea";
import { usePartFamilies } from "../../hooks/useProcessControl";
import { useTablePreferences } from "../../hooks/useTablePreferences";
import { FMEA_FILTER_KEYS, useFmeaFilters } from "../../hooks/useUrlFilters";
import { exportCSV } from "../../lib/csvHelper";
import { FMEA_SCOPE, REVISION_STATUS, describeFmeaFilter, fmeaPath, kindLabel, statusLabel } from "../../lib/fmea";
import Breadcrumb from "../Breadcrumb";
import CTAButton from "../CTAButton";
import IconButton from "../IconButton";
import SavedFilterBar from "../ncr/SavedFilterBar";
import TableWrapper from "../TableWrapper";
import ColumnVisibilityMenu from "../ui/ColumnVisibilityMenu";
import { FmeaDialog } from "./FmeaDialogs";
import FmeaFilterPane from "./FmeaFilterPane";
import { DEFAULT_HIDDEN, fmeaColumns, fmeaHref } from "./fmeaColumns";

const rowLabel = (r) => r.number;

const toCsvRow = (m) => ({
  fmea: m.number,
  title: m.title,
  kind: kindLabel(m.kind),
  covers: m.covers ?? "",
  customer: m.customer?.name ?? "",
  owner: m.owner?.name ?? "",
  status: statusLabel(m.status),
  in_force: m.currentLetter ? `Rev ${m.currentLetter} from ${m.currentEffectiveFrom ?? ""}` : "",
  revision_in_progress: m.openRevisionId ? `${m.openLetter ? `Rev ${m.openLetter}` : "Draft"} (${REVISION_STATUS[m.openStatus]?.label ?? m.openStatus})` : "",
  next_review: m.nextReviewOn ?? "",
  review_overdue: m.reviewOverdue ? "Yes" : "",
  scope: m.scopeText ?? "",
  updated: m.updatedAt?.slice(0, 10) ?? "",
  created: m.createdAt?.slice(0, 10) ?? "",
});

/**
 * The FMEA register (`/FMEA/Register`): every design and process FMEA — the same server-side table, column menu, header search, filter drawer, saved filters and
 * CSV export as the other registers. Drafts and those in force by default; filters live in the URL.
 */
const FmeaRegisterPage = () => {
  const { can } = usePermissions();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const page = parseInt(searchParams.get("page") || "1", 10);
  const pageSize = parseInt(searchParams.get("pageSize") || "25", 10);
  const filters = useFmeaFilters();
  const { updateFilters } = filters;
  const { debouncedSearchTerm, setSearchTerm } = useGlobalSearch();
  const [sorting, setSortingState] = useState([{ id: "number", desc: true }]);
  const [rowSelection, setRowSelection] = useState({});
  const [selectedRows, setSelectedRows] = useState([]);
  const [activeModalType, setActiveModalType] = useState(null);
  const [creating, setCreating] = useState(false);
  const prefs = useTablePreferences("fmea-register");
  const columnVisibility = { ...DEFAULT_HIDDEN, ...prefs.columnVisibility };
  const families = usePartFamilies({ includeInactive: true });
  const familyList = useMemo(() => families.data?.items ?? [], [families.data]);

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
  const sortColumn = sorting[0] ? fmeaColumns.find((c) => c.id === sorting[0].id)?.meta?.sortKey : undefined;

  const { data, isLoading, isFetching, error, refetch } = useFmeas({
    q: filters.search,
    kind: filters.kind,
    status: filters.status,
    owner: filters.owner,
    waiting: filters.waiting,
    reviewOverdue: filters.overdue ? "true" : undefined,
    partId: filters.part,
    partFamilyId: filters.family,
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

  // The header search box feeds the register search (number, title, scope, what it covers, owner, customer).
  useEffect(() => {
    if ((debouncedSearchTerm ?? "") !== filters.search) updateFilters({ search: debouncedSearchTerm });
    // Only react to the header search box; URL changes elsewhere must not loop back.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearchTerm]);

  const toggleModal = (t) => setActiveModalType((prev) => (prev === t ? null : t));
  const open = (m) => navigate(fmeaHref(m));
  const rowActions = (item) => [{ label: "Open", icon: FolderOpenIcon, onSelect: () => open(item) }];

  const list = (v) => (v ? v.split(",") : []);
  const activeFilters = [
    ...(filters.search ? [{ key: "search", label: `Search: “${filters.search}”`, clear: { search: "" } }] : []),
    ...(filters.kind ? [{ key: "kind", label: `Kind: ${list(filters.kind).map(kindLabel).join(", ")}`, clear: { kind: "" } }] : []),
    ...(filters.status ? [{ key: "status", label: `Status: ${list(filters.status).map((s) => (s === "all" ? "All" : statusLabel(s))).join(", ")}`, clear: { status: "" } }] : []),
    ...(filters.family ? [{ key: "family", label: `Family: ${list(filters.family).map((id) => familyList.find((f) => f.id === id)?.code ?? "…").join(", ")}`, clear: { family: "" } }] : []),
    ...(filters.part ? [{ key: "part", label: `Part: ${filters.partLabel || "chosen"}`, clear: { part: "", partLabel: "" } }] : []),
    ...(filters.owner === "me" ? [{ key: "owner", label: "Owned by me", clear: { owner: "" } }] : []),
    ...(filters.waiting === "me" ? [{ key: "waiting", label: "Waiting for my approval", clear: { waiting: "" } }] : []),
    ...(filters.overdue ? [{ key: "overdue", label: "Review overdue", clear: { overdue: "" } }] : []),
  ];
  const filterCount = activeFilters.filter((f) => f.key !== "search").length;
  const clearFilters = (values) => {
    updateFilters(values);
    if ("search" in values) setSearchTerm?.("");
  };
  const clearAll = () => clearFilters(Object.fromEntries(FMEA_FILTER_KEYS.map((k) => [k, ""])));

  return (
    <div className="flex w-full min-w-0 flex-1 min-h-0 flex-col gap-3 bg-primary-bg p-4">
      <div className="flex flex-row flex-wrap items-center justify-between gap-3 pl-1">
        <div className="flex flex-col gap-2">
          <Breadcrumb />
          <p className="h-4 text-sm text-primary-text" aria-live="polite">
            {selectedRows.length > 0 && `${selectedRows.length} selected`}
            {selectedRows.length === 0 && !isLoading && `${total.toLocaleString()} ${total === 1 ? "FMEA" : "FMEAs"}${filters.status ? "" : " (drafts and in force)"}`}
          </p>
        </div>
        <div className="flex flex-row items-center justify-end gap-3">
          {selectedRows.length > 0 && (
            <CTAButton callbackFn={() => exportCSV(selectedRows.map(toCsvRow), "fmeas.csv")} text="Export CSV" type="success" title="Export the selected FMEAs to a CSV file" icon={ShareIcon} iconSize="h-6 w-6" />
          )}
          <ColumnVisibilityMenu
            columns={fmeaColumns}
            columnVisibility={columnVisibility}
            onColumnVisibilityChange={prefs.setColumnVisibility}
            columnOrder={prefs.columnOrder}
            onColumnOrderChange={prefs.setColumnOrder}
            onReset={prefs.resetColumns}
          />
          {can("fmea.manage") && <CTAButton callbackFn={() => setCreating(true)} text="Start an FMEA" type="main" icon={PlusIcon} iconSize="h-6 w-6" />}
          <IconButton count={filterCount} selected={activeModalType === "Filter"} color="blue" title="Filter" callback={toggleModal} icon={<SlidersHorizontalIcon className="h-4.5 w-4.5" />} />
          {/* The drawer calls onClose after sliding out; by then another menu may be open, so only clear the filter. */}
          {activeModalType === "Filter" && <FmeaFilterPane families={familyList} onClose={() => setActiveModalType((t) => (t === "Filter" ? null : t))} />}
        </div>
      </div>
      <SavedFilterBar
        scope={FMEA_SCOPE}
        keys={FMEA_FILTER_KEYS}
        values={filters}
        summary={activeFilters.map((f) => f.label)}
        describe={describeFmeaFilter(familyList)}
        onApply={(values) => {
          updateFilters(values);
          setSearchTerm?.(values.search ?? "");
        }}
        onClearAll={clearAll}
      />
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
          columns={fmeaColumns}
          columnVisibility={columnVisibility}
          onColumnVisibilityChange={prefs.setColumnVisibility}
          columnSizing={prefs.columnSizing}
          onColumnSizingChange={prefs.setColumnSizing}
          columnOrder={prefs.columnOrder}
          onColumnOrderChange={prefs.setColumnOrder}
          rowSelection={rowSelection}
          setRowSelection={setRowSelection}
          onRowDoubleClick={open}
          ariaLabel="FMEAs"
          rowLabel={rowLabel}
        />
      </div>
      {creating && <FmeaDialog onClose={() => setCreating(false)} onSaved={(m) => m?.id && navigate(fmeaPath(m.id))} />}
    </div>
  );
};

export default FmeaRegisterPage;
