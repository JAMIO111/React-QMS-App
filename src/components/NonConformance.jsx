import React, { useState, useEffect, useRef } from "react";
import NonConformanceTable from "./NonConformanceTable";
import NonConformanceGrid from "./NonConformanceGrid";
import IconButton from "./IconButton";
import { BsSliders, BsCurrencyPound, BsViewList, BsGrid } from "react-icons/bs";
import { HiArrowsUpDown } from "react-icons/hi2";
import { IoAddOutline } from "react-icons/io5";
import FilterPane from "./FilterPane";
import SortPane from "./SortPane";
import CTAButton from "./CTAButton";
import Breadcrumb from "./Breadcrumb";
import ViewToggle from "./ViewToggle";

const NonConformance = () => {
  const [activeModal, setActiveModal] = useState(null);
  const [costData, setCostData] = useState(false);
  const modalRef = useRef(null);

  const [viewGrid, setViewGrid] = useState(false); // Added state for view mode

  const closeModal = () => setActiveModal(null);

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (modalRef.current && !modalRef.current.contains(event.target)) {
        setActiveModal(null);
      }
    };

    if (activeModal !== null) {
      document.addEventListener("mousedown", handleClickOutside);
    }

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [activeModal]);

  return (
    <div className="p-4 flex bg-primary-bg flex-col gap-4 h-screen overflow-hidden">
      <div className="flex flex-row justify-between items-center">
        <div className="flex flex-row justify-start items-center gap-2"></div>
        <div
          ref={modalRef}
          className="flex w-full flex-row justify-between items-center">
          <Breadcrumb />
          <div className="flex flex-row justify-end items-center gap-2">
            <ViewToggle viewGrid={viewGrid} setViewGrid={setViewGrid} />
            <CTAButton text="Add Item" icon={IoAddOutline} />
            <IconButton
              title="Cost"
              callback={() => setCostData((prev) => !prev)}
              icon={<BsCurrencyPound className="h-5 w-5" />}
              selected={costData}
              color="green"
            />
            <IconButton
              selected={activeModal === "sort"}
              color="blue"
              title="Sort"
              callback={() =>
                setActiveModal((prev) => (prev === "sort" ? null : "sort"))
              }
              icon={<HiArrowsUpDown className="h-5 w-5" />}
            />
            {activeModal === "sort" && <SortPane onClose={closeModal} />}
            <IconButton
              selected={activeModal === "filter"}
              color="blue"
              title="Filter"
              callback={() =>
                setActiveModal((prev) => (prev === "filter" ? null : "filter"))
              }
              icon={<BsSliders className="h-4.5 w-4.5" />}
            />
            {activeModal === "filter" && <FilterPane onClose={closeModal} />}
          </div>
        </div>
      </div>
      {viewGrid ? (
        <NonConformanceGrid />
      ) : (
        <NonConformanceTable costData={costData} />
      )}
    </div>
  );
};

export default NonConformance;
