import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { PlayIcon, ShareIcon, XIcon } from "@/components/icons";
import { useGlobalSearch } from "../../contexts/SearchProvider";
import { useAudits, useAuditRecords } from "../../hooks/useAudits";
import { useMachines } from "../../hooks/useProcessControl";
import { usePermissions } from "../../hooks/useQmsApi";
import { useTablePreferences } from "../../hooks/useTablePreferences";
import { AUDIT_RECORD_FILTER_KEYS, useAuditRecordFilters } from "../../hooks/useUrlFilters";
import { RECORD_RESULTS, RECORD_STATUSES, recordStatusLabel, resultLabel } from "../../lib/audits";
import { exportCSV } from "../../lib/csvHelper";
import Breadcrumb from "../Breadcrumb";
import CTAButton from "../CTAButton";
import TableWrapper from "../TableWrapper";
import ColumnVisibilityMenu from "../ui/ColumnVisibilityMenu";
import RHFDatePickerPopout from "../ui/RHFDatePickerPopout";
import { SelectField } from "../master-data/shared";
import { auditRecordColumns, DEFAULT_HIDDEN } from "./auditRecordColumns";
import StartAuditDialog from "./StartAuditDialog";

const rowLabel = (r) => `${r.reference} ${r.audit.title}`;
const toCsvRow = (r) => ({
  record: r.reference,
  audit: r.audit.reference,
  title: r.audit.title,
  carried_out_on: r.carriedOutOn.join("; "),
  auditor: r.auditor?.name ?? "",
  scheduled_for: r.scheduledFor ?? "",
  performed_on: r.performedOn,
  result: r.result ?? "",
  score: r.score ?? "",
  pass_mark: r.passMark,
  failed: r.failedCount ?? "",
  critical_failed: r.criticalFailedCount ?? "",
  status: r.status,
});

/** The Audit records register (Documentation → Audit records): every audit carried out, with its result. Filters live in the URL; sorting and paging are on the server. */
const AuditRecordsPage = () => {
  const { can } = usePermissions();
  const canPerform = can("audits.perform");
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const page = parseInt(searchParams.get("page") || "1", 10);
  const pageSize = parseInt(searchParams.get("pageSize") || "25", 10);
  const filters = useAuditRecordFilters();
  const { updateFilters } = filters;
  const { debouncedSearchTerm, setSearchTerm } = useGlobalSearch();
  const machines = useMachines({ includeInactive: true });
  const audits = useAudits({ sort: "title", pageSize: 200 });
  const [sorting, setSortingState] = useState([{ id: "performedOn", desc: true }]);
  const [rowSelection, setRowSelection] = useState({});
  const [selectedRows, setSelectedRows] = useState([]);
  const [selectedItem, setSelectedItem] = useState(null);
  const [starting, setStarting] = useState(false);
  const headerRef = useRef(null);
  const prefs = useTablePreferences("audit-record-register");
  const columnVisibility = { ...DEFAULT_HIDDEN, ...prefs.columnVisibility };

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
  const sortColumn = sorting[0] ? auditRecordColumns.find((c) => c.id === sorting[0].id)?.meta?.sortKey : undefined;

  const { data, isLoading, isFetching, error, refetch } = useAuditRecords({
    q: filters.search,
    status: filters.status,
    result: filters.result,
    auditId: filters.audit,
    machineId: filters.machine,
    mine: filters.mine === "true" ? "true" : undefined,
    from: filters.from,
    to: filters.to,
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
  // The header search box feeds the register search.
  useEffect(() => {
    if ((debouncedSearchTerm ?? "") !== filters.search) updateFilters({ search: debouncedSearchTerm });
    // Only react to the header search box; URL changes elsewhere must not loop back.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearchTerm]);

  const machineItems = machines.data?.items ?? [];
  const auditItems = audits.data?.data ?? [];
  const activeFilters = [
    ...(filters.search ? [{ key: "search", label: `Search: “${filters.search}”`, clear: { search: "" } }] : []),
    ...(filters.status ? [{ key: "status", label: `Status: ${recordStatusLabel(filters.status)}`, clear: { status: "" } }] : []),
    ...(filters.result ? [{ key: "result", label: `Result: ${resultLabel(filters.result)}`, clear: { result: "" } }] : []),
    ...(filters.audit ? [{ key: "audit", label: `Audit: ${auditItems.find((a) => a.id === filters.audit)?.reference ?? filters.auditLabel ?? "selected"}`, clear: { audit: "", auditLabel: "" } }] : []),
    ...(filters.machine ? [{ key: "machine", label: `Machine: ${machineItems.find((m) => m.id === filters.machine)?.code ?? filters.machineLabel ?? "selected"}`, clear: { machine: "", machineLabel: "" } }] : []),
    ...(filters.mine === "true" ? [{ key: "mine", label: "Mine", clear: { mine: "" } }] : []),
    ...(filters.from ? [{ key: "from", label: `From ${filters.from}`, clear: { from: "" } }] : []),
    ...(filters.to ? [{ key: "to", label: `To ${filters.to}`, clear: { to: "" } }] : []),
  ];
  const clearFilters = (values) => {
    updateFilters(values);
    if ("search" in values) setSearchTerm?.("");
  };

  return (
    <div className="flex w-full min-w-0 flex-1 min-h-0 flex-col gap-3 bg-primary-bg p-4">
      <div ref={headerRef} className="flex flex-row flex-wrap items-center justify-between gap-3 pl-1">
        <div className="flex flex-col gap-2">
          <Breadcrumb />
          <p className="h-4 text-sm text-primary-text" aria-live="polite">
            {selectedRows.length > 0 && `${selectedRows.length} selected`}
            {selectedRows.length === 0 && !isLoading && `${total.toLocaleString()} ${total === 1 ? "audit record" : "audit records"}`}
          </p>
        </div>
        <div className="flex flex-row items-center justify-end gap-3">
          {selectedRows.length > 0 && <CTAButton callbackFn={() => exportCSV(selectedRows.map(toCsvRow), "audit-records.csv")} text="Export CSV" type="success" title="Export the selected audit records to a CSV file" icon={ShareIcon} iconSize="h-6 w-6" />}
          <ColumnVisibilityMenu
            columns={auditRecordColumns}
            columnVisibility={columnVisibility}
            onColumnVisibilityChange={prefs.setColumnVisibility}
            columnOrder={prefs.columnOrder}
            onColumnOrderChange={prefs.setColumnOrder}
            onReset={prefs.resetColumns}
          />
          {canPerform && <CTAButton callbackFn={() => setStarting(true)} text="Start an audit" type="main" icon={PlayIcon} iconSize="h-6 w-6" title="Carry out an audit now, without a scheduled slot" />}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 px-1 sm:grid-cols-2 lg:grid-cols-6">
        <SelectField label="Audit" value={filters.audit} onChange={(v) => updateFilters({ audit: v ?? "", auditLabel: "" })} options={auditItems.map((a) => ({ value: a.id, label: `${a.reference} · ${a.title}` }))} placeholder="Any audit" />
        <SelectField label="Result" value={filters.result} onChange={(v) => updateFilters({ result: v ?? "" })} options={RECORD_RESULTS} placeholder="Any result" />
        <SelectField label="Status" value={filters.status} onChange={(v) => updateFilters({ status: v ?? "" })} options={RECORD_STATUSES} placeholder="Any status" />
        <SelectField label="Machine" value={filters.machine} onChange={(v) => updateFilters({ machine: v ?? "", machineLabel: "" })} options={machineItems.map((m) => ({ value: m.id, label: `${m.code} · ${m.name}` }))} placeholder="Any machine" />
        <RHFDatePickerPopout label="Carried out from" valueFormat="iso" clearable value={filters.from || null} onChange={(d) => updateFilters({ from: d ?? "" })} />
        <RHFDatePickerPopout label="Carried out to" valueFormat="iso" clearable value={filters.to || null} onChange={(d) => updateFilters({ to: d ?? "" })} />
      </div>
      <label className="flex w-fit cursor-pointer items-center gap-2 px-1 text-sm text-primary-text">
        <input type="checkbox" checked={filters.mine === "true"} onChange={(e) => updateFilters({ mine: e.target.checked ? "true" : "" })} />
        Only audits I did
      </label>
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
          <button type="button" onClick={() => clearFilters(Object.fromEntries(AUDIT_RECORD_FILTER_KEYS.map((k) => [k, ""])))} className="text-link-color hover:underline cursor-pointer">
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
          selectedItem={selectedItem}
          setSelectedItem={setSelectedItem}
          onRefresh={refetch}
          sorting={sorting}
          setSorting={setSorting}
          columns={auditRecordColumns}
          columnVisibility={columnVisibility}
          onColumnVisibilityChange={prefs.setColumnVisibility}
          columnSizing={prefs.columnSizing}
          onColumnSizingChange={prefs.setColumnSizing}
          columnOrder={prefs.columnOrder}
          onColumnOrderChange={prefs.setColumnOrder}
          rowSelection={rowSelection}
          setRowSelection={setRowSelection}
          onRowDoubleClick={(r) => navigate(`/Documentation/Audit-Records/${r.id}`)}
          ariaLabel="Audit records"
          rowLabel={rowLabel}
        />
      </div>
      {starting && <StartAuditDialog onClose={() => setStarting(false)} />}
    </div>
  );
};

export default AuditRecordsPage;
