import { useCallback, useEffect, useMemo, useState } from "react";
import { customCsvValues, useCustomColumns, useCustomFilterChips } from "../custom-fields/customColumns";
import { useNavigate, useSearchParams } from "react-router-dom";
import { FolderOpenIcon, PlusIcon, ShareIcon, SlidersHorizontalIcon, XIcon } from "@/components/icons";
import { useGlobalSearch } from "../../contexts/SearchProvider";
import { usePermissions } from "../../hooks/useQmsApi";
import { useSupplierClassifications, useSupplierRegister } from "../../hooks/useSupplierQuality";
import { useTablePreferences } from "../../hooks/useTablePreferences";
import { SUPPLIER_FILTER_KEYS, useSupplierFilters } from "../../hooks/useUrlFilters";
import { exportCSV } from "../../lib/csvHelper";
import { RISK_RATINGS, SUPPLIER_FILTER_TITLES, SUPPLIER_SCOPE, SUPPLIER_STATUSES, SUPPLIER_TYPES, statusOf, typeLabel } from "../../lib/supplierQuality";
import Breadcrumb from "../Breadcrumb";
import CTAButton from "../CTAButton";
import IconButton from "../IconButton";
import TableWrapper from "../TableWrapper";
import SavedFilterBar from "../ncr/SavedFilterBar";
import ColumnVisibilityMenu from "../ui/ColumnVisibilityMenu";
import SupplierDialog from "./SupplierDialog";
import SupplierFilterPane from "./SupplierFilterPane";
import { DEFAULT_HIDDEN, supplierColumns } from "./supplierColumns";

const rowLabel = (r) => r.code;
const nameOf = (list, id) => list.find((x) => (x.id ?? x.key) === id)?.name ?? list.find((x) => x.key === id)?.label ?? id;

const toCsvRow = (s) => ({
  code: s.code,
  name: s.name,
  trading_name: s.displayName ?? "",
  approval_status: statusOf(s.approvalStatus).label,
  activity: s.active ? "Active" : "Inactive",
  type: typeLabel(s.supplierType),
  classifications: s.classifications.map((c) => c.label).join("; "),
  risk: s.riskRating ?? "",
  country: s.country ?? "",
  city: s.city ?? "",
  primary_contact: s.primaryContact?.name ?? "",
  primary_contact_email: s.primaryContact?.email ?? "",
  open_non_conformances: s.openNcCount,
});

/** What a saved supplier filter contains, as readable rows. */
const describeSupplierFilter = (classifications) => (filters = {}) =>
  Object.keys(SUPPLIER_FILTER_TITLES)
    .filter((k) => filters[k])
    .map((k) => {
      const parts = String(filters[k]).split(",");
      const label = (v) =>
        k === "status" ? statusOf(v).label : k === "type" ? typeLabel(v) : k === "risk" ? nameOf(RISK_RATINGS, v) : k === "classification" ? (classifications.find((c) => c.id === v)?.label ?? v) : k === "active" ? (v === "inactive" ? "Inactive" : "All") : v;
      return { key: k, title: SUPPLIER_FILTER_TITLES[k], value: parts.map(label).join(", ") };
    });

/**
 * Suppliers (/Suppliers): the register — the same server-side table, column set, header search and filter drawer as the other registers, plus a bar of the
 * person's own saved filters. Approval status and activity are separate. Active suppliers by default.
 */
const SuppliersRegisterPage = () => {
  const navigate = useNavigate();
  const { can } = usePermissions();
  const manage = can("supplier_quality.manage");
  const [searchParams, setSearchParams] = useSearchParams();
  const page = parseInt(searchParams.get("page") || "1", 10);
  const pageSize = parseInt(searchParams.get("pageSize") || "25", 10);
  const filters = useSupplierFilters();
  const { updateFilters } = filters;
  const { debouncedSearchTerm, setSearchTerm } = useGlobalSearch();
  const [sorting, setSortingState] = useState([{ id: "code", desc: false }]);
  const [rowSelection, setRowSelection] = useState({});
  const [selectedRows, setSelectedRows] = useState([]);
  const [activeModalType, setActiveModalType] = useState(null);
  const [adding, setAdding] = useState(false);
  const prefs = useTablePreferences("supplier-register");
  const custom = useCustomColumns("supplier");
  const customFilters = useCustomFilterChips("supplier");
  const columnVisibility = { ...DEFAULT_HIDDEN, ...custom.defaultHidden, ...prefs.columnVisibility };
  const columns = useMemo(() => [...supplierColumns, ...custom.columns], [custom.columns]);
  const classificationList = useSupplierClassifications({ all: true }).data?.data ?? [];

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

  const { data, isLoading, isFetching, error, refetch } = useSupplierRegister({
    q: filters.search,
    status: filters.status,
    type: filters.type,
    classificationId: filters.classification,
    risk: filters.risk,
    active: filters.active || "active",
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

  // The header search box feeds the register search (code, names, contacts, classifications, places, references).
  useEffect(() => {
    if ((debouncedSearchTerm ?? "") !== filters.search) updateFilters({ search: debouncedSearchTerm });
    // Only react to the header search box; URL changes elsewhere must not loop back.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearchTerm]);

  const toggleModal = (t) => setActiveModalType((prev) => (prev === t ? null : t));
  const open = (s) => navigate(`/Suppliers/${s.id}`);
  const rowActions = (item) => [{ label: "Open profile", icon: FolderOpenIcon, onSelect: () => open(item) }];

  const list = (v) => (v ? v.split(",") : []);
  const activeFilters = [
    ...(filters.search ? [{ key: "search", label: `Search: “${filters.search}”`, clear: { search: "" } }] : []),
    ...(filters.status ? [{ key: "status", label: `Approval: ${list(filters.status).map((k) => SUPPLIER_STATUSES.find((s) => s.key === k)?.label ?? k).join(", ")}`, clear: { status: "" } }] : []),
    ...(filters.type ? [{ key: "type", label: `Type: ${list(filters.type).map((k) => nameOf(SUPPLIER_TYPES, k)).join(", ")}`, clear: { type: "" } }] : []),
    ...(filters.classification ? [{ key: "classification", label: `Classification: ${list(filters.classification).map((id) => classificationList.find((c) => c.id === id)?.label ?? "…").join(", ")}`, clear: { classification: "" } }] : []),
    ...(filters.risk ? [{ key: "risk", label: `Risk: ${list(filters.risk).map((k) => nameOf(RISK_RATINGS, k)).join(", ")}`, clear: { risk: "" } }] : []),
    ...(filters.active ? [{ key: "active", label: filters.active === "inactive" ? "Inactive suppliers" : "Active and inactive", clear: { active: "" } }] : []),
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
            {selectedRows.length === 0 && !isLoading && `${total.toLocaleString()} ${total === 1 ? "supplier" : "suppliers"}`}
          </p>
        </div>
        <div className="flex flex-row items-center justify-end gap-3">
          {selectedRows.length > 0 && (
            <CTAButton callbackFn={() => exportCSV(selectedRows.map((r) => ({ ...toCsvRow(r), ...customCsvValues(custom.fields, r) })), "suppliers.csv")} text="Export CSV" type="success" title="Export the selected suppliers to a CSV file" icon={ShareIcon} iconSize="h-6 w-6" />
          )}
          <ColumnVisibilityMenu
            columns={columns}
            columnVisibility={columnVisibility}
            onColumnVisibilityChange={prefs.setColumnVisibility}
            columnOrder={prefs.columnOrder}
            onColumnOrderChange={prefs.setColumnOrder}
            onReset={prefs.resetColumns}
          />
          {manage && <CTAButton callbackFn={() => setAdding(true)} text="Add supplier" type="main" icon={PlusIcon} iconSize="h-6 w-6" title="Add a supplier (it starts Pending Approval)" />}
          <IconButton count={filterCount} selected={activeModalType === "Filter"} color="blue" title="Filter" callback={toggleModal} icon={<SlidersHorizontalIcon className="h-4.5 w-4.5" />} />
          {activeModalType === "Filter" && <SupplierFilterPane onClose={() => setActiveModalType((t) => (t === "Filter" ? null : t))} />}
        </div>
      </div>
      <SavedFilterBar
        scope={SUPPLIER_SCOPE}
        keys={SUPPLIER_FILTER_KEYS}
        values={filters}
        summary={activeFilters.map((f) => f.label)}
        describe={describeSupplierFilter(classificationList)}
        onApply={(values) => {
          updateFilters(values);
          setSearchTerm?.(values.search ?? "");
        }}
        onClearAll={() => clearFilters(Object.fromEntries(SUPPLIER_FILTER_KEYS.map((k) => [k, ""])))}
      />
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
            (() => clearFilters(Object.fromEntries(SUPPLIER_FILTER_KEYS.map((k) => [k, ""]))))();
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
          ariaLabel="Suppliers"
          rowLabel={rowLabel}
        />
      </div>
      {adding && <SupplierDialog onClose={() => setAdding(false)} onSaved={(s) => navigate(`/Suppliers/${s.id}`)} />}
    </div>
  );
};

export default SuppliersRegisterPage;
