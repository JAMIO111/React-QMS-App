import { useState, useEffect, useRef, Suspense, useMemo, useCallback } from "react";
import { useNavigate, useSearchParams, useParams, Navigate } from "react-router-dom";
import { PlusIcon, ShareIcon, SlidersHorizontalIcon } from "@/components/icons";
import { useNcrs } from "../hooks/useNcr";
import { useNCMFilters } from "../hooks/useNCMFilters";
import { usePermissions } from "../hooks/useQmsApi";
import { useGlobalSearch } from "../contexts/SearchProvider";
import { exportCSV } from "../lib/csvHelper";
import { NC_TYPES, formatDate, stageOf } from "../lib/ncr";
import { SkeletonCard2, SkeletonTable } from "./Skeleton";
import ColumnVisibilityMenu from "./ui/ColumnVisibilityMenu";
import { useTablePreferences } from "../hooks/useTablePreferences";
import { getColumnsForNcType } from "../lib/ColumnDefs";
import DeleteNcrDialog from "./ncr/DeleteNcrDialog";
import TableWrapper from "./TableWrapper";
import NonConformanceGrid from "./NonConformanceGrid";
import FilterPane from "./FilterPane";
import ActionsModal from "./ActionsModal";
import Breadcrumb from "./Breadcrumb";
import CTAButton from "./CTAButton";
import ViewToggle from "./ViewToggle";
import IconButton from "./IconButton";

/** Flat rows for CSV export. */
const toCsvRow = (n) => ({
  reference: n.reference,
  source: n.source,
  stage: stageOf(n.stage).label,
  severity: n.severity ?? "",
  detected: formatDate(n.detectedAt),
  title: n.title,
  part: n.part?.partNumber ?? "",
  revision: n.part?.revision ?? "",
  quantity: n.quantityAffected ?? "",
  customer: n.customer?.name ?? "",
  customer_reference: n.customerReference ?? "",
  supplier: n.supplier?.name ?? "",
  work_order: n.workOrder ?? "",
  purchase_order: n.purchaseOrder ?? "",
  failure_mode: n.failureMode?.name ?? "",
  sub_failure_mode: n.subFailureMode?.name ?? "",
  causal_process: n.causalProcess?.name ?? "",
  deleted: n.deletedAt ? "yes" : "",
});

/** Register of internal, customer or supplier non-conformances (/Non-Conformance/:type). */
const NonConformance = () => {
  const { type } = useParams();
  const ncType = NC_TYPES[type];
  const navigate = useNavigate();
  const { can } = usePermissions();
  const [sorting, setSortingState] = useState([{ id: "reference", desc: true }]);
  const [selectedItem, setSelectedItem] = useState(null);
  const [modalPos, setModalPos] = useState(null);
  const [rowSelection, setRowSelection] = useState({});
  const [activeModalType, setActiveModalType] = useState(null);
  const [viewGrid, setViewGrid] = useState(false);
  const [selectedRows, setSelectedRows] = useState([]);
  const [deleting, setDeleting] = useState(null);
  const modalRef = useRef(null);

  const [searchParams, setSearchParams] = useSearchParams();
  const page = parseInt(searchParams.get("page") || "1", 10);
  const pageSize = parseInt(searchParams.get("pageSize") || "25", 10);
  const filters = useNCMFilters();
  const { debouncedSearchTerm } = useGlobalSearch();
  const { updateFilters } = filters;

  const allColumns = useMemo(() => getColumnsForNcType(type), [type]);
  const { columnVisibility, setColumnVisibility, columnSizing, setColumnSizing, resetColumns } = useTablePreferences(`nc-register:${type}`);

  const setPage = useCallback(
    (newPage) =>
      setSearchParams((prev) => {
        const params = new URLSearchParams(prev);
        params.set("page", newPage);
        return params;
      }),
    [setSearchParams]
  );

  // A new sort order starts from the first page.
  const setSorting = (updater) => {
    setSortingState(updater);
    if (page !== 1) setPage(1);
  };

  const sortColumn = sorting[0] ? allColumns.find((c) => c.id === sorting[0].id)?.meta?.sortKey : undefined;
  const { data, isLoading, isFetching, error, refetch } = useNcrs({
    source: ncType?.source,
    q: filters.search,
    stage: filters.stage,
    failureModeId: filters.failureMode,
    subFailureModeId: filters.subFailureMode,
    deleted: filters.deleted || undefined,
    sort: sortColumn,
    order: sorting[0]?.desc ? "desc" : "asc",
    page,
    pageSize,
  });
  const rows = data?.data ?? [];
  const totalCount = data?.total ?? 0;

  useEffect(() => {
    setRowSelection({});
    setSelectedRows([]);
  }, [page, pageSize, type]);

  useEffect(() => {
    setSelectedItem(null);
    setActiveModalType(null);
    setModalPos(null);
  }, [type]);

  // The header search box feeds the register search.
  const currentSearch = filters.search;
  useEffect(() => {
    if ((debouncedSearchTerm ?? "") !== currentSearch) updateFilters({ search: debouncedSearchTerm });
    // Only react to the header search box; URL changes elsewhere must not loop back.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearchTerm]);

  const handleToggleView = () => {
    setViewGrid((prev) => !prev);
    setActiveModalType(null);
    setModalPos(null);
  };
  const handleActiveModalType = (t) => setActiveModalType((prev) => (prev === t ? null : t));
  const handleOpenModal = (position) => setModalPos(position);
  const handleCloseModal = () => {
    setModalPos(null);
    setActiveModalType(null);
  };
  const openRecord = (record) => navigate(`/Non-Conformance/${type}/${record.id}`);

  useEffect(() => {
    if (modalPos === null) return undefined;
    const handleClickOutside = (event) => {
      if (modalRef.current && !modalRef.current.contains(event.target) && !document.getElementById("modal-root")?.contains(event.target)) {
        handleCloseModal();
      }
    };
    const handleScroll = () => handleCloseModal();
    document.addEventListener("click", handleClickOutside);
    window.addEventListener("scroll", handleScroll, true);
    return () => {
      document.removeEventListener("click", handleClickOutside);
      window.removeEventListener("scroll", handleScroll, true);
    };
  }, [modalPos]);

  if (!ncType) return <Navigate to="/Non-Conformance/Internal" replace />;

  const totalQuantity = selectedRows.reduce((acc, r) => acc + (Number(r.quantityAffected) || 0), 0);
  const filterCount = ["stage", "failureMode", "subFailureMode", "deleted"].filter((k) => filters[k]).length;

  return (
    <div className="p-4 bg-primary-bg flex flex-col gap-3 w-full min-w-0 flex-1 min-h-0">
      <div className="flex flex-row justify-between items-center">
        <div ref={modalRef} className="pl-1 flex w-full flex-row flex-wrap gap-3 justify-between items-center">
          <div className="flex flex-col gap-2">
            <Suspense fallback={null}>
              <Breadcrumb />
            </Suspense>
            <p className="text-sm h-4 text-primary-text" aria-live="polite">
              {selectedRows.length > 0 && `${selectedRows.length} selected · Qty ${totalQuantity.toLocaleString()}`}
              {selectedRows.length === 0 && !isLoading && `${totalCount.toLocaleString()} ${totalCount === 1 ? "record" : "records"}${filters.deleted === "only" ? " (deleted)" : ""}`}
            </p>
          </div>
          <Suspense fallback={null}>
            <div className="flex flex-row justify-end items-center gap-3">
              {selectedRows.length !== 0 && (
                <CTAButton
                  callbackFn={() => exportCSV(selectedRows.map(toCsvRow), `${type.toLowerCase()}-non-conformances.csv`)}
                  text="Export CSV"
                  type="success"
                  title="Export the selected records to a CSV file"
                  icon={ShareIcon}
                  iconSize="h-6 w-6"
                />
              )}
              {!viewGrid && (
                <ColumnVisibilityMenu columns={allColumns} columnVisibility={columnVisibility} onColumnVisibilityChange={setColumnVisibility} onReset={resetColumns} />
              )}
              <ViewToggle viewGrid={viewGrid} setViewGrid={handleToggleView} />
              {can("ncr.create") && (
                <CTAButton
                  callbackFn={() => navigate(`/Non-Conformance/${type}/new`)}
                  text="New NC"
                  type="main"
                  icon={PlusIcon}
                  iconSize="h-6 w-6"
                  title={`Raise a new ${ncType.one}`}
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
              {activeModalType === "Filter" && <FilterPane onClose={handleCloseModal} />}
            </div>
          </Suspense>
        </div>
      </div>
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
              onOpenModal={handleOpenModal}
              selectedItem={selectedItem}
              setSelectedItem={setSelectedItem}
              items={rows}
              isLoading={isLoading}
              error={error}
              handleActiveModalType={handleActiveModalType}
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
              onOpenModal={handleOpenModal}
              selectedItem={selectedItem}
              setSelectedItem={setSelectedItem}
              handleActiveModalType={handleActiveModalType}
              onRefresh={refetch}
              sorting={sorting}
              setSorting={setSorting}
              columns={allColumns}
              columnVisibility={columnVisibility}
              onColumnVisibilityChange={setColumnVisibility}
              columnSizing={columnSizing}
              onColumnSizingChange={setColumnSizing}
              rowSelection={rowSelection}
              setRowSelection={setRowSelection}
              onRowDoubleClick={openRecord}
            />
          )}
        </Suspense>
      </div>

      {activeModalType === "Actions" && selectedItem && modalPos && (
        <Suspense fallback={null}>
          <ActionsModal
            item={selectedItem}
            position={modalPos}
            onClose={handleCloseModal}
            onDelete={(item) => {
              handleCloseModal();
              setDeleting(item);
            }}
          />
        </Suspense>
      )}
      {deleting && <DeleteNcrDialog ncr={deleting} onClose={() => setDeleting(null)} />}
    </div>
  );
};

export default NonConformance;
