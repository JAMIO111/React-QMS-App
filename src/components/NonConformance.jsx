import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import NonConformanceTable from "./NonConformanceTable";
import NonConformanceGrid from "./NonConformanceGrid";
import IconButton from "./IconButton";
import { BsSliders, BsCurrencyPound } from "react-icons/bs";
import { HiArrowsUpDown } from "react-icons/hi2";
import { IoAddOutline } from "react-icons/io5";
import FilterPane from "./FilterPane";
import SortPane from "./SortPane";
import CTAButton from "./CTAButton";
import Breadcrumb from "./Breadcrumb";
import ViewToggle from "./ViewToggle";
import { useNCM } from "../hooks/useNCM";
import ActionsModal from "./ActionsModal";
import { useNCMFilters } from "../hooks/useNCMFilters";
import { useGlobalSearch } from "../contexts/SearchProvider";

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
  const {
    data: ncmData,
    isLoading,
    error,
    refetch,
  } = useNCM({ sortColumn, sortOrder });
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
  const totalQuantity = selectedRows.reduce((acc, r) => acc + r.quantity, 0);
  const totalCost = selectedRows.reduce((acc, r) => acc + r.total_cost, 0);

  useEffect(() => {
    updateFilters((prev) => ({ ...prev, search: debouncedSearchTerm }));
  }, [debouncedSearchTerm]);

  const navigate = useNavigate();

  const handleNewEntry = () => {
    navigate("/Non-Conformance/Internal/NC-Form", {
      state: {
        itemID: null, // Could be null for a new NC
      },
    });
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

    if (modalPos !== null) {
      document.addEventListener("click", handleClickOutside);
    }

    return () => {
      document.removeEventListener("click", handleClickOutside);
    };
  }, [activeModalType]);

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
            <ViewToggle viewGrid={viewGrid} setViewGrid={handleToggleView} />
            <CTAButton
              callbackFn={() => {
                handleNewEntry(null);
              }}
              text="Add Item"
              type="main"
              icon={IoAddOutline}
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
              <SortPane
                sortColumn={sortColumn}
                sortOrder={sortOrder}
                setSortColumn={setSortColumn}
                setSortOrder={setSortOrder}
                onClose={handleCloseModal}
              />
            )}
            <IconButton
              selected={activeModalType === "Filter"}
              color="blue"
              title="Filter"
              callback={handleActiveModalType}
              icon={<BsSliders className="h-4.5 w-4.5" />}
            />
            {activeModalType === "Filter" && (
              <FilterPane onClose={handleCloseModal} />
            )}
          </div>
        </div>
      </div>
      {viewGrid ? (
        <NonConformanceGrid
          onOpenModal={handleOpenModal}
          selectedItem={selectedItem}
          setSelectedItem={setSelectedItem}
          ncmData={ncmData}
          costData={costData}
          handleActiveModalType={handleActiveModalType}
          onRefresh={refetch}
        />
      ) : (
        <NonConformanceTable
          onOpenModal={handleOpenModal}
          selectedItem={selectedItem}
          setSelectedItem={setSelectedItem}
          ncmData={ncmData}
          costData={costData}
          handleActiveModalType={handleActiveModalType}
          onRefresh={refetch}
          selectedRows={selectedRows}
          isSelected={isSelected}
          onToggle={handleToggle}
          onSelectAll={handleSelectAll}
          onClearAll={handleClearAll}
        />
      )}
      {activeModalType === "Actions" && (
        <ActionsModal
          item={selectedItem}
          position={modalPos}
          onClose={handleCloseModal}
        />
      )}
    </div>
  );
};

export default NonConformance;
