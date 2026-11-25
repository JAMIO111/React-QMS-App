import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { FolderOpenIcon, PlusIcon, ShareIcon, SlidersHorizontalIcon, XIcon } from "@/components/icons";
import { useGlobalSearch } from "../../contexts/SearchProvider";
import { useMsaStudies } from "../../hooks/useMsa";
import { usePermissions } from "../../hooks/useQmsApi";
import { useTablePreferences } from "../../hooks/useTablePreferences";
import { MSA_FILTER_KEYS, useMsaFilters } from "../../hooks/useUrlFilters";
import { exportCSV } from "../../lib/csvHelper";
import { STATUS_FILTERS, TYPE_FILTERS, VALIDITY_FILTERS, VERDICT_FILTERS, conclusionLabel, msaPath, statusOf, typeOf, verdictOf } from "../../lib/msa";
import Breadcrumb from "../Breadcrumb";
import CTAButton from "../CTAButton";
import IconButton from "../IconButton";
import TableWrapper from "../TableWrapper";
import ColumnVisibilityMenu from "../ui/ColumnVisibilityMenu";
import MsaFilterPane from "./MsaFilterPane";
import StudyDialog from "./StudyDialog";
import { DEFAULT_HIDDEN, headlineWords, msaColumns } from "./msaColumns";

const rowLabel = (r) => r.reference;

const toCsvRow = (s) => ({
  study: s.reference,
  kind: typeOf(s.studyType).label,
  gauge: s.gauge?.assetNumber ?? "",
  part: s.part?.partNumber ?? "",
  measuring: s.characteristicName,
  state: statusOf(s.status).label,
  readings: s.progress ? `${s.progress.filled}/${s.progress.total}` : "",
  result: s.verdict ? verdictOf(s.verdict).label : "",
  headline: headlineWords(s),
  conclusion: s.conclusion ? conclusionLabel(s.conclusion) : "",
  valid_until: s.validUntil ?? "",
  started: s.startedAt?.slice(0, 10) ?? "",
  completed: s.completedAt?.slice(0, 10) ?? "",
});

/**
 * Gauge R&R: the register of measurement system studies — the same server-side table, column set, header search and filter drawer as the other registers.
 * Every study but cancelled ones by default; filters live in the URL.
 */
const MsaStudiesPage = ({ toggle }) => {
  const navigate = useNavigate();
  const { can } = usePermissions();
  const manage = can("calibration.manage");
  const [searchParams, setSearchParams] = useSearchParams();
  const page = parseInt(searchParams.get("page") || "1", 10);
  const pageSize = parseInt(searchParams.get("pageSize") || "25", 10);
  const filters = useMsaFilters();
  const { updateFilters } = filters;
  const { debouncedSearchTerm, setSearchTerm } = useGlobalSearch();
  const [sorting, setSortingState] = useState([{ id: "createdAt", desc: true }]);
  const [rowSelection, setRowSelection] = useState({});
  const [selectedRows, setSelectedRows] = useState([]);
  const [activeModalType, setActiveModalType] = useState(null);
  const [planning, setPlanning] = useState(false);
  const prefs = useTablePreferences("msa-register");
  const columnVisibility = { ...DEFAULT_HIDDEN, ...prefs.columnVisibility };
  const columns = useMemo(() => msaColumns, []);

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

  const { data, isLoading, isFetching, error, refetch } = useMsaStudies({
    status: filters.status || "all",
    type: filters.type,
    verdict: filters.verdict,
    valid: filters.valid,
    gaugeId: filters.gauge,
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

  // The header search box feeds the register search (reference, what is measured, gauge, part).
  useEffect(() => {
    if ((debouncedSearchTerm ?? "") !== filters.search) updateFilters({ search: debouncedSearchTerm });
    // Only react to the header search box; URL changes elsewhere must not loop back.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearchTerm]);

  const open = (s) => navigate(msaPath(s.id));
  const rowActions = (item) => [{ label: "Open", icon: FolderOpenIcon, onSelect: () => open(item) }];

  const list = (v) => (v ? v.split(",") : []);
  const words = (opts, v) => list(v).map((k) => opts.find((o) => o.key === k)?.label ?? k).join(", ");
  const activeFilters = [
    ...(filters.search ? [{ key: "search", label: `Search: “${filters.search}”`, clear: { search: "" } }] : []),
    ...(filters.status ? [{ key: "status", label: `State: ${words(STATUS_FILTERS, filters.status)}`, clear: { status: "" } }] : []),
    ...(filters.type ? [{ key: "type", label: `Kind: ${words(TYPE_FILTERS, filters.type)}`, clear: { type: "" } }] : []),
    ...(filters.verdict ? [{ key: "verdict", label: `Result: ${words(VERDICT_FILTERS, filters.verdict)}`, clear: { verdict: "" } }] : []),
    ...(filters.valid ? [{ key: "valid", label: `Validity: ${words(VALIDITY_FILTERS, filters.valid)}`, clear: { valid: "" } }] : []),
    ...(filters.gauge ? [{ key: "gauge", label: rows[0]?.gauge ? `Gauge: ${rows[0].gauge.assetNumber}` : "One gauge", clear: { gauge: "" } }] : []),
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
            {selectedRows.length === 0 && !isLoading && `${total.toLocaleString()} ${total === 1 ? "study" : "studies"}`}
          </p>
        </div>
        <div className="flex flex-row flex-wrap items-center justify-end gap-3">
          {toggle}
          {selectedRows.length > 0 && <CTAButton callbackFn={() => exportCSV(selectedRows.map(toCsvRow), "measurement-system-studies.csv")} text="Export CSV" type="success" title="Export the selected studies to a CSV file" icon={ShareIcon} iconSize="h-6 w-6" />}
          <ColumnVisibilityMenu columns={columns} columnVisibility={columnVisibility} onColumnVisibilityChange={prefs.setColumnVisibility} columnOrder={prefs.columnOrder} onColumnOrderChange={prefs.setColumnOrder} onReset={prefs.resetColumns} />
          {manage && <CTAButton callbackFn={() => setPlanning(true)} text="Plan a study" type="main" icon={PlusIcon} iconSize="h-6 w-6" title="Plan a Gauge R&R, Type 1 or attribute agreement study" />}
          <IconButton count={filterCount} selected={activeModalType === "Filter"} color="blue" title="Filter" callback={(t) => setActiveModalType((p) => (p === t ? null : t))} icon={<SlidersHorizontalIcon className="h-4.5 w-4.5" />} />
          {activeModalType === "Filter" && <MsaFilterPane onClose={() => setActiveModalType((t) => (t === "Filter" ? null : t))} />}
        </div>
      </div>
      {activeFilters.length > 0 && (
        <div aria-label="Active filters" className="flex flex-wrap items-center gap-2 px-1 text-sm">
          {activeFilters.map((f) => (
            <span key={f.key} className="flex items-center gap-1 rounded-full border border-brand-primary/50 bg-brand-primary/10 py-0.5 pl-3 pr-1 text-primary-text">
              {f.label}
              <button type="button" aria-label={`Remove filter ${f.label}`} onClick={() => clearFilters(f.clear)} className="cursor-pointer rounded-full p-0.5 hover:bg-brand-primary/20">
                <XIcon className="h-3.5 w-3.5" />
              </button>
            </span>
          ))}
          <button type="button" onClick={() => clearFilters(Object.fromEntries(MSA_FILTER_KEYS.map((k) => [k, ""])))} className="cursor-pointer text-link-color hover:underline">
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
          ariaLabel="Measurement system studies"
          rowLabel={rowLabel}
        />
      </div>
      {planning && <StudyDialog onClose={() => setPlanning(false)} />}
    </div>
  );
};

export default MsaStudiesPage;
