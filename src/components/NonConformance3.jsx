import { useState, useEffect, useRef, lazy, Suspense } from "react";
import { useNavigate } from "react-router-dom";
import { useSearchParams, useParams } from "react-router-dom";
import { BsSliders, BsCurrencyPound } from "react-icons/bs";
import { PiExportLight } from "react-icons/pi";
import { HiArrowsUpDown } from "react-icons/hi2";
import { IoAddOutline } from "react-icons/io5";
import { useNCM } from "../hooks/useNCM";
import { useNCMFilters } from "../hooks/useNCMFilters";
import { useGlobalSearch } from "../contexts/SearchProvider";
import { exportCSV } from "../lib/csvHelper";
import { SkeletonCard2, SkeletonTable } from "./Skeleton";

const NonConformanceTable = lazy(() => import("./BookingsTable"));
const NonConformanceGrid = lazy(() => import("./NonConformanceGrid"));
const SortPane = lazy(() => import("./SortPane"));
const FilterPane = lazy(() => import("./FilterPane"));
const ActionsModal = lazy(() => import("./ActionsModal"));
const Breadcrumb = lazy(() => import("./Breadcrumb"));
const CTAButton = lazy(() => import("./CTAButton"));
const ViewToggle = lazy(() => import("./ViewToggle"));
const IconButton = lazy(() => import("./IconButton"));

const NonConformance = () => {
  const [sortColumn, setSortColumn] = useState("ncm_id");
  const [sortOrder, setSortOrder] = useState("desc");
  const [selectedItem, setSelectedItem] = useState(null); // Required
  const [modalPos, setModalPos] = useState(null); // Required
  const [activeModalType, setActiveModalType] = useState(null); // Required
  const [costData, setCostData] = useState(false); // Required
  const [viewGrid, setViewGrid] = useState(false); // Required
  const [selectedRows, setSelectedRows] = useState([]);
  const modalRef = useRef(null);

  const [searchParams, setSearchParams] = useSearchParams();
  const { type } = useParams();
  const page = parseInt(searchParams.get("page") || "1", 10);
  const pageSize = parseInt(searchParams.get("pageSize") || "25", 10);
  console.log("Type:", type);

  const setPage = (newPage) => {
    setSearchParams((prev) => {
      const params = new URLSearchParams(prev);
      params.set("page", newPage);
      return params;
    });
  };

  const setPageSize = (newPageSize) => {
    setSearchParams((prev) => {
      const params = new URLSearchParams(prev);
      params.set("pageSize", newPageSize);
      return params;
    });
  };

  useEffect(() => {
    // Reset any local state that should clear when type changes
    setSelectedRows([]);
    setSelectedItem(null);
    setCostData(false);
    setViewGrid(false);

    // Optionally refetch data if your hook depends on 'type'
    refetch();

    // Reset pagination
    if (page !== 1) {
      setPage(1);
    }
  }, [type]);

  const { data, isLoading, error, refetch } = useNCM({
    ncType: type,
    sortColumn,
    sortOrder,
    page,
    pageSize,
  });
  const totalCount = data?.count || 0;
  const { debouncedSearchTerm } = useGlobalSearch();
  const { updateFilters } = useNCMFilters();

  const isSelected = (id) => selectedRows.some((row) => row.id === id);

  const handleToggle = (row) => {
    setSelectedRows((prev) =>
      isSelected(row.id) ? prev.filter((r) => r.id !== row.id) : [...prev, row]
    );
  };

  const handleSelectAll = (allRows) => {
    setSelectedRows(allRows);
  };

  const handleClearAll = () => {
    setSelectedRows([]);
  };

  const handleToggleView = () => {
    setViewGrid((prev) => !prev);
    setActiveModalType(null);
    setModalPos(null);
  };

  const totalRows = selectedRows.length;
  const totalQuantity = selectedRows.reduce(
    (acc, r) => acc + r.quantity_defective,
    0
  );
  const totalCost = selectedRows.reduce((acc, r) => acc + r.total_cost, 0);

  useEffect(() => {
    updateFilters((prev) => ({ ...prev, search: debouncedSearchTerm }));
    if (page !== 1) {
      setPage(1);
    }
  }, [debouncedSearchTerm]);

  const navigate = useNavigate();

  const handleNewEntry = () => {
    navigate(`/Non-Conformance/${type}/New-NC`);
  };

  const handleActiveModalType = (type) => {
    setActiveModalType((prev) => (prev === type ? null : type));
  };

  const handleOpenModal = (position) => {
    setModalPos(position);
  };

  const handleCloseModal = () => {
    setModalPos(null);
    setActiveModalType(null);
  };

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (modalRef.current && !modalRef.current.contains(event.target)) {
        setActiveModalType(null);
        setModalPos(null);
      }
    };

    const handleScroll = () => {
      setActiveModalType(null);
      setModalPos(null);
    };

    if (modalPos !== null) {
      document.addEventListener("click", handleClickOutside);
      window.addEventListener("scroll", handleScroll, true); // true for capturing phase, catches scrolls on all ancestors
    }

    return () => {
      document.removeEventListener("click", handleClickOutside);
      window.removeEventListener("scroll", handleScroll, true);
    };
  }, [modalPos]);

  const activeFilters = ["status", "failureMode", "subFailureMode"].filter(
    (key) => searchParams.get(key)
  );
  const filterCount = activeFilters.length;

  return (
    <div className="p-4 flex bg-primary-bg flex-col gap-3 h-screen overflow-hidden">
      <div className="flex flex-row justify-between items-center">
        <div className="flex flex-row justify-start items-center gap-2"></div>
        <div
          ref={modalRef}
          className="pl-1 flex w-full flex-row justify-between items-center">
          <div className="flex flex-col gap-2">
            <Breadcrumb />
            <p className=" text-sm h-4 text-primary-text">
              {totalRows > 0 &&
                `${totalRows} Items selected - Qty: ${totalQuantity.toLocaleString()} (£${totalCost.toLocaleString(
                  undefined,
                  { minimumFractionDigits: 2, maximumFractionDigits: 2 }
                )})`}
            </p>
          </div>
          <div className="flex flex-row justify-end items-center gap-2">
            {selectedRows.length !== 0 && (
              <CTAButton
                callbackFn={() => exportCSV(selectedRows)}
                text="Export CSV"
                type="success"
                title="Export to CSV file"
                icon={PiExportLight}
                iconSize="h-6 w-6"
              />
            )}
            <ViewToggle viewGrid={viewGrid} setViewGrid={handleToggleView} />
            <CTAButton
              callbackFn={() => {
                handleNewEntry(null);
              }}
              text={"New NC"}
              type="main"
              icon={IoAddOutline}
              iconSize="h-6 w-6"
              title="Create a new non-conformance record"
            />
            <IconButton
              title="Cost"
              callback={() => setCostData((prev) => !prev)}
              icon={<BsCurrencyPound className="h-5 w-5" />}
              selected={costData}
              color="green"
            />
            <IconButton
              selected={activeModalType === "Sort"}
              color="blue"
              title="Sort"
              callback={handleActiveModalType}
              icon={<HiArrowsUpDown className="h-5 w-5" />}
            />
            {activeModalType === "Sort" && (
              <Suspense fallback={null}>
                <SortPane
                  sortColumn={sortColumn}
                  sortOrder={sortOrder}
                  setSortColumn={setSortColumn}
                  setSortOrder={setSortOrder}
                  onClose={handleCloseModal}
                />
              </Suspense>
            )}
            <IconButton
              count={filterCount}
              selected={activeModalType === "Filter"}
              color="blue"
              title="Filter"
              callback={handleActiveModalType}
              icon={<BsSliders className="h-4.5 w-4.5" />}
            />
            {activeModalType === "Filter" && (
              <Suspense fallback={null}>
                <FilterPane onClose={handleCloseModal} />
              </Suspense>
            )}
          </div>
        </div>
      </div>
      <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
        <Suspense
          fallback={
            viewGrid ? (
              <div className="grid pr-2 grid-cols-1 sm:grid-cols-1 md:grid-cols-2 lg:grid-cols-2 xl:grid-cols-3 gap-4">
                <SkeletonCard2 />
                <SkeletonCard2 />
                <SkeletonCard2 />
                <SkeletonCard2 />
                <SkeletonCard2 />
                <SkeletonCard2 />
                <SkeletonCard2 />
                <SkeletonCard2 />
                <SkeletonCard2 />
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
              ncmData={data}
              ncType={type}
              costData={costData}
              handleActiveModalType={handleActiveModalType}
              onRefresh={refetch}
              page={page}
              pageSize={pageSize}
              setPage={setPage}
              totalCount={totalCount}
              setPageSize={setPageSize}
            />
          ) : (
            <NonConformanceTable
              onOpenModal={handleOpenModal}
              selectedItem={selectedItem}
              setSelectedItem={setSelectedItem}
              ncmData={data}
              ncType={type}
              costData={costData}
              handleActiveModalType={handleActiveModalType}
              onRefresh={refetch}
              selectedRows={selectedRows}
              isSelected={isSelected}
              onToggle={handleToggle}
              onSelectAll={handleSelectAll}
              onClearAll={handleClearAll}
              page={page}
              pageSize={pageSize}
              setPage={setPage}
              totalCount={totalCount}
              setPageSize={setPageSize}
            />
          )}
        </Suspense>
      </div>

      {activeModalType === "Actions" && (
        <Suspense fallback={null}>
          <ActionsModal
            item={selectedItem}
            position={modalPos}
            onClose={handleCloseModal}
          />
        </Suspense>
      )}
    </div>
  );
};

export default NonConformance;
