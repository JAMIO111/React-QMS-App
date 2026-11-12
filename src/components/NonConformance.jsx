import { useState, useEffect, Suspense, useMemo, useCallback } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { PlusIcon, ShareIcon, SlidersHorizontalIcon } from "@/components/icons";
import { useNcrs } from "../hooks/useNcr";
import { FILTER_KEYS, useNCMFilters } from "../hooks/useNCMFilters";
import { usePermissions } from "../hooks/useQmsApi";
import { useGlobalSearch } from "../contexts/SearchProvider";
import { exportCSV } from "../lib/csvHelper";
import { formatMoney } from "../lib/costs";
import { formatDate, ncrPath, sourceLabel, stageOf } from "../lib/ncr";
import { useClassifications } from "../hooks/useNcr";
import { XIcon } from "@/components/icons";
import { SkeletonCard2, SkeletonTable } from "./Skeleton";
import ColumnVisibilityMenu from "./ui/ColumnVisibilityMenu";
import { useTablePreferences } from "../hooks/useTablePreferences";
import { NC_DEFAULT_HIDDEN, getNcColumns } from "../lib/ColumnDefs";
import DeleteNcrDialog from "./ncr/DeleteNcrDialog";
import NewNcDialog from "./ncr/NewNcDialog";
import TableWrapper from "./TableWrapper";
import NonConformanceGrid from "./NonConformanceGrid";
import FilterPane from "./FilterPane";
import useNcrRowActions from "./ncr/useNcrRowActions";
import Breadcrumb from "./Breadcrumb";
import CTAButton from "./CTAButton";
import ViewToggle from "./ViewToggle";
import IconButton from "./IconButton";
import SavedFilterBar from "./ncr/SavedFilterBar";
import { NC_SCOPE } from "../lib/savedFilters";
import { customCsvValues, useCustomColumns, useCustomFilterChips } from "./custom-fields/customColumns";

/** Flat rows for CSV export. */
const toCsvRow = (n) => ({
  reference: n.reference,
  source: sourceLabel(n.source),
  category: n.category?.name ?? "Uncategorised",
  stage: stageOf(n.stage).label,
  severity: n.severity ?? "",
  eight_d: n.capaCount === 1 && n.capa ? n.capa.reference : n.capaCount ? `${n.capaCount} 8Ds` : "",
  detected: formatDate(n.detectedAt),
  title: n.title,
  part: n.part?.partNumber ?? "",
  revision: n.part?.revision ?? "",
  quantity: n.quantityAffected ?? "",
  total_cost: n.totalCost ?? 0,
  cost_currency: n.costCurrency ?? "",
  customer: n.customer?.name ?? "",
  customer_reference: n.customerReference ?? "",
  supplier: n.supplier?.name ?? "",
  work_order: n.workOrder ?? "",
  purchase_order: n.purchaseOrder ?? "",
  failure_mode: n.failureMode?.name ?? "",
  sub_failure_mode: n.subFailureMode?.name ?? "",
  causal_process: n.causalProcess?.name ?? "",
  raised: n.createdAt ? formatDate(n.createdAt) : "",
  raised_by: n.raisedBy?.name ?? "",
  detected_by: n.detectedByEmployee?.name ?? "",
  responsible_department: n.responsibleDepartment?.name ?? "",
  deleted: n.deletedAt ? "yes" : "",
});

/** The non-conformance register (/Non-Conformance/Register): every source and category, with quick tabs All / Customer / Supplier. */
const NonConformance = () => {
  const navigate = useNavigate();
  const { can } = usePermissions();
  const [sorting, setSortingState] = useState([
    { id: "reference", desc: true },
  ]);
  const [selectedItem, setSelectedItem] = useState(null);
  const [rowSelection, setRowSelection] = useState({});
  const [activeModalType, setActiveModalType] = useState(null);
  const [viewGrid, setViewGrid] = useState(false);
  const [selectedRows, setSelectedRows] = useState([]);
  const [deleting, setDeleting] = useState(null);
  const [choosingSource, setChoosingSource] = useState(false);

  const [searchParams, setSearchParams] = useSearchParams();
  const page = parseInt(searchParams.get("page") || "1", 10);
  const pageSize = parseInt(searchParams.get("pageSize") || "25", 10);
  const filters = useNCMFilters();
  const { debouncedSearchTerm, setSearchTerm } = useGlobalSearch();
  const { data: lists } = useClassifications();
  const { updateFilters } = filters;

  const custom = useCustomColumns("nonconformance");
  const customFilters = useCustomFilterChips("nonconformance");
  const allColumns = useMemo(() => [...getNcColumns(), ...custom.columns], [custom.columns]);
  const prefs = useTablePreferences("nc-register");
  const {
    columnSizing,
    setColumnSizing,
    columnOrder,
    setColumnOrder,
    resetColumns,
  } = prefs;
  // Some columns only apply to some sources and start hidden; a saved choice wins.
  const columnVisibility = useMemo(
    () => ({ ...NC_DEFAULT_HIDDEN, ...custom.defaultHidden, ...prefs.columnVisibility }),
    [prefs.columnVisibility, custom.defaultHidden],
  );
  const setColumnVisibility = useCallback(
    (updater) =>
      prefs.setColumnVisibility((saved) =>
        typeof updater === "function"
          ? updater({ ...NC_DEFAULT_HIDDEN, ...custom.defaultHidden, ...saved })
          : updater,
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [prefs.setColumnVisibility, custom.defaultHidden],
  );

  const setPage = useCallback(
    (newPage) =>
      setSearchParams((prev) => {
        const params = new URLSearchParams(prev);
        params.set("page", newPage);
        return params;
      }),
    [setSearchParams],
  );

  // A new sort order starts from the first page.
  const setSorting = (updater) => {
    setSortingState(updater);
    if (page !== 1) setPage(1);
  };

  const sortColumn = sorting[0]
    ? allColumns.find((c) => c.id === sorting[0].id)?.meta?.sortKey
    : undefined;
  const { data, isLoading, isFetching, error, refetch } = useNcrs({
    source: filters.source,
    categoryId: filters.category,
    uncategorised: filters.uncategorised || undefined,
    q: filters.search,
    stage: filters.stage,
    failureModeId: filters.failureMode,
    subFailureModeId: filters.subFailureMode,
    deleted: filters.deleted || undefined,
    severity: filters.severity,
    from: filters.from,
    to: filters.to,
    raisedFrom: filters.raisedFrom,
    raisedTo: filters.raisedTo,
    responsibleDepartmentId: filters.department,
    detectedByEmployeeId: filters.detectedBy,
    partId: filters.part,
    productionOrderId: filters.order,
    lotId: filters.lot,
    customerId: filters.customer,
    supplierId: filters.supplier,
    costMin: filters.costMin,
    costMax: filters.costMax,
    qtyMin: filters.qtyMin,
    qtyMax: filters.qtyMax,
    sort: sortColumn,
    order: sorting[0]?.desc ? "desc" : "asc",
    page,
    pageSize,
    ...customFilters.params,
  });
  const rows = data?.data ?? [];
  const totalCount = data?.total ?? 0;

  useEffect(() => {
    setRowSelection({});
    setSelectedRows([]);
  }, [page, pageSize]);

  // The header search box feeds the register search.
  const currentSearch = filters.search;
  useEffect(() => {
    if ((debouncedSearchTerm ?? "") !== currentSearch)
      updateFilters({ search: debouncedSearchTerm });
    // Only react to the header search box; URL changes elsewhere must not loop back.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearchTerm]);

  const handleSetView = (grid) => {
    setViewGrid(grid);
    setActiveModalType(null);
  };
  const handleActiveModalType = (t) =>
    setActiveModalType((prev) => (prev === t ? null : t));
  const rowActions = useNcrRowActions({ onDelete: setDeleting });
  const openRecord = (record) => navigate(ncrPath(record.id));

  const totalQuantity = selectedRows.reduce((acc, r) => acc + (Number(r.quantityAffected) || 0), 0);
  // Costs are kept in the organisation's base currency, so the rows add up.
  const totalCost = selectedRows.reduce((acc, r) => acc + (Number(r.totalCost) || 0), 0);
  const filterCount = [
    "source", "category", "uncategorised", "stage", "severity", "failureMode", "subFailureMode", "deleted", "part", "customer", "supplier", "department", "detectedBy",
  ].filter((k) => filters[k]).length + customFilters.count + (filters.from || filters.to ? 1 : 0) + (filters.raisedFrom || filters.raisedTo ? 1 : 0) + (filters.costMin || filters.costMax ? 1 : 0) + (filters.qtyMin || filters.qtyMax ? 1 : 0);
  const between = (lo, hi, fmt = (v) => v) => (lo && hi ? `${fmt(lo)} – ${fmt(hi)}` : lo ? `from ${fmt(lo)}` : `up to ${fmt(hi)}`);
  const nameOf = (id) => (lists?.all ?? []).find((c) => c.id === id)?.name ?? "…";
  // What the register is currently filtered by, each removable on its own.
  const activeFilters = [
    ...(filters.search ? [{ key: "search", label: `Search: “${filters.search}”`, clear: { search: "" } }] : []),
    ...(filters.from || filters.to ? [{ key: "date", label: `Detected ${between(filters.from, filters.to, formatDate)}`, clear: { from: "", to: "" } }] : []),
    ...(filters.raisedFrom || filters.raisedTo ? [{ key: "raised", label: `Raised ${between(filters.raisedFrom, filters.raisedTo, formatDate)}`, clear: { raisedFrom: "", raisedTo: "" } }] : []),
    ...(filters.detectedBy ? [{ key: "detectedBy", label: `Detected by: ${filters.detectedByLabel || "selected"}`, clear: { detectedBy: "", detectedByLabel: "" } }] : []),
    ...(filters.department ? [{ key: "department", label: `Responsible department: ${filters.departmentLabel || "selected"}`, clear: { department: "", departmentLabel: "" } }] : []),
    ...(filters.stage ? [{ key: "stage", label: `Stage: ${filters.stage.split(",").map((k) => stageOf(k).label).join(", ")}`, clear: { stage: "" } }] : []),
    ...(filters.severity ? [{ key: "severity", label: `Severity: ${filters.severity.split(",").map((k) => k[0].toUpperCase() + k.slice(1)).join(", ")}`, clear: { severity: "" } }] : []),
    ...(filters.order ? [{ key: "order", label: `Order: ${filters.orderLabel || "selected order"}`, clear: { order: "", orderLabel: "" } }] : []),
    ...(filters.lot ? [{ key: "lot", label: `Lot: ${filters.lotLabel || "selected lot"}`, clear: { lot: "", lotLabel: "" } }] : []),
    ...(filters.part ? [{ key: "part", label: `Part: ${filters.partLabel || "selected part"}`, clear: { part: "", partLabel: "" } }] : []),
    ...(filters.customer ? [{ key: "customer", label: `Customer: ${filters.customerLabel || "selected"}`, clear: { customer: "", customerLabel: "" } }] : []),
    ...(filters.supplier ? [{ key: "supplier", label: `Supplier: ${filters.supplierLabel || "selected"}`, clear: { supplier: "", supplierLabel: "" } }] : []),
    ...(filters.source ? [{ key: "source", label: `Source: ${filters.source.split(",").map(sourceLabel).join(", ")}`, clear: { source: "" } }] : []),
    ...(filters.category ? [{ key: "category", label: `Category: ${filters.categoryLabel || nameOf(filters.category)}`, clear: { category: "", categoryLabel: "" } }] : []),
    ...(filters.uncategorised ? [{ key: "uncategorised", label: "Uncategorised", clear: { uncategorised: "" } }] : []),
    ...(filters.costMin || filters.costMax ? [{ key: "cost", label: `Total cost ${between(filters.costMin, filters.costMax, (v) => formatMoney(Number(v), rows[0]?.costCurrency ?? "GBP").replace(/\.00$/, ""))}`, clear: { costMin: "", costMax: "" } }] : []),
    ...(filters.qtyMin || filters.qtyMax ? [{ key: "qty", label: `Quantity ${between(filters.qtyMin, filters.qtyMax)}`, clear: { qtyMin: "", qtyMax: "" } }] : []),
    ...(filters.failureMode ? [{ key: "failureMode", label: `Failure mode: ${nameOf(filters.failureMode)}`, clear: { failureMode: "", subFailureMode: "" } }] : []),
    ...(filters.subFailureMode ? [{ key: "subFailureMode", label: `Sub-failure mode: ${nameOf(filters.subFailureMode)}`, clear: { subFailureMode: "" } }] : []),
    ...(filters.deleted ? [{ key: "deleted", label: filters.deleted === "only" ? "Deleted only" : "Including deleted", clear: { deleted: "" } }] : []),
    ...customFilters.chips,
  ];
  const clearFilters = (values) => {
    updateFilters(values);
    if ("search" in values) setSearchTerm?.("");
  };

  return (
    <div className="p-4 bg-primary-bg flex flex-col gap-3 w-full min-w-0 flex-1 min-h-0">
      <div className="flex flex-row justify-between items-center">
        <div className="pl-1 flex w-full flex-row flex-wrap gap-3 justify-between items-center">
          <div className="flex flex-col gap-2">
            <Suspense fallback={null}>
              <Breadcrumb />
            </Suspense>
            <p className="text-sm h-4 text-primary-text" aria-live="polite">
              {selectedRows.length > 0 && `${selectedRows.length} selected · Qty ${totalQuantity.toLocaleString()} · Cost ${formatMoney(totalCost, selectedRows[0]?.costCurrency || "GBP")}`}
              {selectedRows.length === 0 && !isLoading && `${totalCount.toLocaleString()} ${totalCount === 1 ? "record" : "records"}${filters.deleted === "only" ? " (deleted)" : ""}`}
            </p>
          </div>
          <Suspense fallback={null}>
            <div className="flex flex-row justify-end items-center gap-3">
              {selectedRows.length !== 0 && (
                <CTAButton
                  callbackFn={() =>
                    exportCSV(
                      selectedRows.map((r) => ({ ...toCsvRow(r), ...customCsvValues(custom.fields, r) })),
                      "non-conformances.csv",
                    )
                  }
                  text="Export CSV"
                  type="success"
                  title="Export the selected records to a CSV file"
                  icon={ShareIcon}
                  iconSize="h-5 w-5"
                />
              )}
              {!viewGrid && (
                <ColumnVisibilityMenu
                  columns={allColumns}
                  columnVisibility={columnVisibility}
                  onColumnVisibilityChange={setColumnVisibility}
                  columnOrder={columnOrder}
                  onColumnOrderChange={setColumnOrder}
                  onReset={resetColumns}
                />
              )}
              <ViewToggle viewGrid={viewGrid} setViewGrid={handleSetView} />
              {can("ncr.create") && (
                <CTAButton
                  callbackFn={() => setChoosingSource(true)}
                  text="New NC"
                  type="main"
                  icon={PlusIcon}
                  iconSize="h-5 w-5"
                  title="Raise a new non-conformance"
                />
              )}
              <IconButton
                count={filterCount}
                selected={activeModalType === "Filter"}
                color="blue"
                title="Filter"
                callback={handleActiveModalType}
                icon={<SlidersHorizontalIcon className="h-4.5 w-4.5" />}
              />
              {/* The drawer calls onClose after sliding out; by then another menu may be open, so only clear the filter. */}
              {activeModalType === "Filter" && (
                <FilterPane
                  onClose={() =>
                    setActiveModalType((t) => (t === "Filter" ? null : t))
                  }
                />
              )}
            </div>
          </Suspense>
        </div>
      </div>
      <SavedFilterBar
        scope={NC_SCOPE}
        keys={FILTER_KEYS}
        values={filters}
        summary={activeFilters.map((f) => f.label)}
        onApply={(values) => {
          updateFilters(values);
          setSearchTerm?.(values.search ?? "");
        }}
        onClearAll={() => clearFilters(Object.fromEntries(FILTER_KEYS.map((k) => [k, ""])))}
      />
      {activeFilters.length > 0 && (
        <div
          aria-label="Active filters"
          className="flex flex-wrap items-center gap-2 px-1 text-sm">
          {activeFilters.map((f) => (
            <span
              key={f.key}
              className="flex items-center gap-1 rounded-full border border-brand-primary/50 bg-brand-primary/10 py-0.5 pl-3 pr-1 text-primary-text">
              {f.label}
              <button
                type="button"
                aria-label={`Remove filter ${f.label}`}
                onClick={() => (f.clearCustom ? f.clearCustom() : clearFilters(f.clear))}
                className="rounded-full p-0.5 hover:bg-brand-primary/20 cursor-pointer">
                <XIcon className="h-3.5 w-3.5" />
              </button>
            </span>
          ))}
          <button
            type="button"
            onClick={() => {
              customFilters.clearAll();
              clearFilters(Object.fromEntries(FILTER_KEYS.map((k) => [k, ""])));
            }}
            className="text-link-color hover:underline cursor-pointer">
            Clear all
          </button>
        </div>
      )}
      <div className="flex flex-col flex-1 min-h-0 min-w-0 overflow-auto">
        <Suspense
          fallback={
            viewGrid ? (
              <div className="grid pr-2 grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                {Array.from({ length: 6 }, (_, i) => (
                  <SkeletonCard2 key={i} />
                ))}
              </div>
            ) : (
              <SkeletonTable />
            )
          }>
          {viewGrid ? (
            <NonConformanceGrid
              selectedItem={selectedItem}
              setSelectedItem={setSelectedItem}
              items={rows}
              isLoading={isLoading}
              error={error}
              rowActions={rowActions}
              onOpen={openRecord}
            />
          ) : (
            <TableWrapper
              data={rows}
              isLoading={isLoading || isFetching}
              error={error}
              totalCount={totalCount}
              page={page}
              pageSize={pageSize}
              setSelectedRows={setSelectedRows}
              rowActions={rowActions}
              onRefresh={refetch}
              sorting={sorting}
              setSorting={setSorting}
              columns={allColumns}
              columnVisibility={columnVisibility}
              onColumnVisibilityChange={setColumnVisibility}
              columnSizing={columnSizing}
              onColumnSizingChange={setColumnSizing}
              columnOrder={columnOrder}
              onColumnOrderChange={setColumnOrder}
              rowSelection={rowSelection}
              setRowSelection={setRowSelection}
              onRowDoubleClick={openRecord}
            />
          )}
        </Suspense>
      </div>

      {choosingSource && (
        <NewNcDialog
          initial={filters.source && !filters.source.includes(",") ? filters.source : "internal"}
          onClose={() => setChoosingSource(false)}
          onChoose={(source) => navigate(ncrPath("new", source))}
        />
      )}
      {deleting && (
        <DeleteNcrDialog ncr={deleting} onClose={() => setDeleting(null)} />
      )}
    </div>
  );
};

export default NonConformance;
