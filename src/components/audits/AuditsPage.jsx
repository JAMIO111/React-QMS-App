import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { PlusIcon, ShareIcon, XIcon } from "@/components/icons";
import { useGlobalSearch } from "../../contexts/SearchProvider";
import { useAudits } from "../../hooks/useAudits";
import { useMachines } from "../../hooks/useProcessControl";
import { usePermissions } from "../../hooks/useQmsApi";
import { useTablePreferences } from "../../hooks/useTablePreferences";
import { AUDIT_FILTER_KEYS, useAuditFilters } from "../../hooks/useUrlFilters";
import { AUDIT_TYPES, auditTypeLabel, frequencyLabel } from "../../lib/audits";
import { exportCSV } from "../../lib/csvHelper";
import Breadcrumb from "../Breadcrumb";
import CTAButton from "../CTAButton";
import TableWrapper from "../TableWrapper";
import ColumnVisibilityMenu from "../ui/ColumnVisibilityMenu";
import { SelectField } from "../master-data/shared";
import { auditColumns, DEFAULT_HIDDEN } from "./auditColumns";

const rowLabel = (r) => `${r.reference} ${r.title}`;
const toCsvRow = (r) => ({
  audit: r.reference,
  title: r.title,
  type: auditTypeLabel(r.auditType),
  machines: r.targets.machines,
  operations: r.targets.operations,
  departments: r.targets.departments,
  frequency: frequencyLabel(r.frequency),
  first_due: r.frequency.firstDueOn ?? "",
  expected_auditor: r.auditor.name ?? "",
  pass_mark: `${r.passMark}%`,
  last_done: r.lastRecord?.performedOn ?? "",
  last_result: r.lastRecord?.result ?? "",
  next_due: r.nextDueOn ?? "",
  questions: r.questionCount,
  critical_questions: r.criticalCount,
  status: r.status,
});

/** The Audits register (Documentation → Audits): the audit definitions, with filters kept in the URL and the same server-side table as the other registers. */
const AuditsPage = () => {
  const { can } = usePermissions();
  const canManage = can("audits.manage");
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const page = parseInt(searchParams.get("page") || "1", 10);
  const pageSize = parseInt(searchParams.get("pageSize") || "25", 10);
  const filters = useAuditFilters();
  const { updateFilters } = filters;
  const { debouncedSearchTerm, setSearchTerm } = useGlobalSearch();
  const machines = useMachines({ includeInactive: true });
  const [sorting, setSortingState] = useState([{ id: "reference", desc: false }]);
  const [rowSelection, setRowSelection] = useState({});
  const [selectedRows, setSelectedRows] = useState([]);
  const [selectedItem, setSelectedItem] = useState(null);
  const headerRef = useRef(null);
  const prefs = useTablePreferences("audit-register");
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
  const sortColumn = sorting[0] ? auditColumns.find((c) => c.id === sorting[0].id)?.meta?.sortKey : undefined;

  const { data, isLoading, isFetching, error, refetch } = useAudits({
    q: filters.search,
    status: filters.status,
    type: filters.type,
    machineId: filters.machine,
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
  const activeFilters = [
    ...(filters.search ? [{ key: "search", label: `Search: “${filters.search}”`, clear: { search: "" } }] : []),
    ...(filters.status ? [{ key: "status", label: `Status: ${filters.status === "retired" ? "Retired" : "Active"}`, clear: { status: "" } }] : []),
    ...(filters.type ? [{ key: "type", label: `Type: ${auditTypeLabel(filters.type)}`, clear: { type: "" } }] : []),
    ...(filters.machine ? [{ key: "machine", label: `Machine: ${machineItems.find((m) => m.id === filters.machine)?.code ?? filters.machineLabel ?? "selected"}`, clear: { machine: "", machineLabel: "" } }] : []),
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
            {selectedRows.length === 0 && !isLoading && `${total.toLocaleString()} ${total === 1 ? "audit" : "audits"}`}
          </p>
        </div>
        <div className="flex flex-row items-center justify-end gap-3">
          {selectedRows.length > 0 && <CTAButton callbackFn={() => exportCSV(selectedRows.map(toCsvRow), "audits.csv")} text="Export CSV" type="success" title="Export the selected audits to a CSV file" icon={ShareIcon} iconSize="h-6 w-6" />}
          <ColumnVisibilityMenu
            columns={auditColumns}
            columnVisibility={columnVisibility}
            onColumnVisibilityChange={prefs.setColumnVisibility}
            columnOrder={prefs.columnOrder}
            onColumnOrderChange={prefs.setColumnOrder}
            onReset={prefs.resetColumns}
          />
          {canManage && <CTAButton callbackFn={() => navigate("/Documentation/Audits/new")} text="New audit" type="main" icon={PlusIcon} iconSize="h-6 w-6" title="Define a new audit" />}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 px-1 sm:grid-cols-3 lg:max-w-3xl">
        <SelectField label="Type" value={filters.type} onChange={(v) => updateFilters({ type: v ?? "" })} options={AUDIT_TYPES} placeholder="Any type" />
        <SelectField label="Status" value={filters.status} onChange={(v) => updateFilters({ status: v ?? "" })} options={[{ value: "active", label: "Active" }, { value: "retired", label: "Retired" }]} placeholder="Any status" />
        <SelectField label="Machine" value={filters.machine} onChange={(v) => updateFilters({ machine: v ?? "", machineLabel: "" })} options={machineItems.map((m) => ({ value: m.id, label: `${m.code} · ${m.name}` }))} placeholder="Any machine" />
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
          <button type="button" onClick={() => clearFilters(Object.fromEntries(AUDIT_FILTER_KEYS.map((k) => [k, ""])))} className="text-link-color hover:underline cursor-pointer">
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
          columns={auditColumns}
          columnVisibility={columnVisibility}
          onColumnVisibilityChange={prefs.setColumnVisibility}
          columnSizing={prefs.columnSizing}
          onColumnSizingChange={prefs.setColumnSizing}
          columnOrder={prefs.columnOrder}
          onColumnOrderChange={prefs.setColumnOrder}
          rowSelection={rowSelection}
          setRowSelection={setRowSelection}
          onRowDoubleClick={(r) => navigate(`/Documentation/Audits/${r.id}`)}
          ariaLabel="Audits"
          rowLabel={rowLabel}
        />
      </div>
    </div>
  );
};

export default AuditsPage;
