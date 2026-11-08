import { useCallback, useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ShareIcon, XIcon } from "@/components/icons";
import { useGlobalSearch } from "../../contexts/SearchProvider";
import { useAudits, useAuditFindings, useFindingClassifications } from "../../hooks/useAudits";
import { useEmployees } from "../../hooks/useNcr";
import { useTablePreferences } from "../../hooks/useTablePreferences";
import { AUDIT_FINDING_FILTER_KEYS, useAuditFindingFilters } from "../../hooks/useUrlFilters";
import { FINDING_KINDS, FINDING_STATUSES, findingKindLabel, findingStatusLabel } from "../../lib/audits";
import { exportCSV } from "../../lib/csvHelper";
import Breadcrumb from "../Breadcrumb";
import CTAButton from "../CTAButton";
import TableWrapper from "../TableWrapper";
import ColumnVisibilityMenu from "../ui/ColumnVisibilityMenu";
import ComboField from "../ui/ComboField";
import { DEFAULT_HIDDEN, findingColumns } from "./findingColumns";

const rowLabel = (f) => `${f.reference} ${f.title}`;
const toCsvRow = (f) => ({
  finding: f.reference,
  title: f.title,
  classification: f.classification.label,
  kind: f.classification.kind,
  status: f.status,
  audit_record: f.record.reference,
  audit: f.record.audit.title,
  owner: f.owner?.name ?? "",
  due: f.dueOn ?? "",
  overdue: f.overdue ? "yes" : "",
  non_conformance: f.ncr?.reference ?? "",
  what_was_found: f.description,
});

/** The Audit findings register (Documentation → Audit findings): every finding of every audit. Filters live in the URL; sorting and paging are on the server. */
const AuditFindingsPage = () => {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const page = parseInt(searchParams.get("page") || "1", 10);
  const pageSize = parseInt(searchParams.get("pageSize") || "25", 10);
  const filters = useAuditFindingFilters();
  const { updateFilters } = filters;
  const { debouncedSearchTerm, setSearchTerm } = useGlobalSearch();
  const classes = useFindingClassifications({ all: true });
  const employees = useEmployees();
  const audits = useAudits({ sort: "title", pageSize: 200 });
  const [sorting, setSortingState] = useState([{ id: "reference", desc: true }]);
  const [rowSelection, setRowSelection] = useState({});
  const [selectedRows, setSelectedRows] = useState([]);
  const [selectedItem, setSelectedItem] = useState(null);
  const prefs = useTablePreferences("audit-finding-register");
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
  const sortColumn = sorting[0] ? findingColumns.find((c) => c.id === sorting[0].id)?.meta?.sortKey : undefined;

  const { data, isLoading, isFetching, error, refetch } = useAuditFindings({
    q: filters.search,
    status: filters.status,
    classificationId: filters.classification,
    kind: filters.kind,
    ownerId: filters.owner,
    auditId: filters.audit,
    overdue: filters.overdue === "true" ? "true" : undefined,
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

  const classItems = classes.data ?? [];
  const employeeItems = employees.data ?? [];
  const auditItems = audits.data?.data ?? [];
  const activeFilters = [
    ...(filters.search ? [{ key: "search", label: `Search: “${filters.search}”`, clear: { search: "" } }] : []),
    ...(filters.status ? [{ key: "status", label: `Status: ${findingStatusLabel(filters.status)}`, clear: { status: "" } }] : []),
    ...(filters.classification ? [{ key: "classification", label: `Classification: ${classItems.find((c) => c.id === filters.classification)?.label ?? "selected"}`, clear: { classification: "" } }] : []),
    ...(filters.kind ? [{ key: "kind", label: `Kind: ${findingKindLabel(filters.kind)}`, clear: { kind: "" } }] : []),
    ...(filters.owner ? [{ key: "owner", label: `Owner: ${employeeItems.find((x) => x.id === filters.owner)?.name ?? filters.ownerLabel ?? "selected"}`, clear: { owner: "", ownerLabel: "" } }] : []),
    ...(filters.audit ? [{ key: "audit", label: `Audit: ${auditItems.find((a) => a.id === filters.audit)?.reference ?? filters.auditLabel ?? "selected"}`, clear: { audit: "", auditLabel: "" } }] : []),
    ...(filters.overdue === "true" ? [{ key: "overdue", label: "Overdue", clear: { overdue: "" } }] : []),
  ];
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
            {selectedRows.length === 0 && !isLoading && `${total.toLocaleString()} ${total === 1 ? "finding" : "findings"}`}
          </p>
        </div>
        <div className="flex flex-row items-center justify-end gap-3">
          {selectedRows.length > 0 && <CTAButton callbackFn={() => exportCSV(selectedRows.map(toCsvRow), "audit-findings.csv")} text="Export CSV" type="success" title="Export the selected findings to a CSV file" icon={ShareIcon} iconSize="h-6 w-6" />}
          <ColumnVisibilityMenu
            columns={findingColumns}
            columnVisibility={columnVisibility}
            onColumnVisibilityChange={prefs.setColumnVisibility}
            columnOrder={prefs.columnOrder}
            onColumnOrderChange={prefs.setColumnOrder}
            onReset={prefs.resetColumns}
          />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 px-1 sm:grid-cols-2 lg:grid-cols-5">
        <ComboField label="Status" value={filters.status || null} onChange={(v) => updateFilters({ status: v ?? "" })} options={FINDING_STATUSES} placeholder="Any status" />
        <ComboField label="Classification" value={filters.classification || null} onChange={(v) => updateFilters({ classification: v ?? "" })} options={classItems.map((c) => ({ value: c.id, label: c.label, hint: c.active ? undefined : "Switched off" }))} placeholder="Any classification" />
        <ComboField label="Kind" value={filters.kind || null} onChange={(v) => updateFilters({ kind: v ?? "" })} options={FINDING_KINDS} placeholder="Any kind" />
        <ComboField label="Owner" value={filters.owner || null} onChange={(v) => updateFilters({ owner: v ?? "", ownerLabel: "" })} options={employeeItems.map((x) => ({ value: x.id, label: x.name }))} placeholder="Anyone" />
        <ComboField label="Audit" value={filters.audit || null} onChange={(v) => updateFilters({ audit: v ?? "", auditLabel: "" })} options={auditItems.map((a) => ({ value: a.id, label: `${a.reference} · ${a.title}` }))} placeholder="Any audit" />
      </div>
      <label className="flex w-fit cursor-pointer items-center gap-2 px-1 text-sm text-primary-text">
        <input type="checkbox" checked={filters.overdue === "true"} onChange={(e) => updateFilters({ overdue: e.target.checked ? "true" : "" })} />
        Only overdue findings
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
          <button type="button" onClick={() => clearFilters(Object.fromEntries(AUDIT_FINDING_FILTER_KEYS.map((k) => [k, ""])))} className="text-link-color hover:underline cursor-pointer">
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
          columns={findingColumns}
          columnVisibility={columnVisibility}
          onColumnVisibilityChange={prefs.setColumnVisibility}
          columnSizing={prefs.columnSizing}
          onColumnSizingChange={prefs.setColumnSizing}
          columnOrder={prefs.columnOrder}
          onColumnOrderChange={prefs.setColumnOrder}
          rowSelection={rowSelection}
          setRowSelection={setRowSelection}
          onRowDoubleClick={(f) => navigate(`/Documentation/Audit-Findings/${f.id}`)}
          ariaLabel="Audit findings"
          rowLabel={rowLabel}
        />
      </div>
    </div>
  );
};

export default AuditFindingsPage;
