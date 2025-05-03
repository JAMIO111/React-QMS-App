import React, { useState } from "react";
import NonConformanceTable from "./NonConformanceTable";
import IconButton from "./IconButton";
import { BsSliders, BsCurrencyPound } from "react-icons/bs";
import { HiArrowsUpDown } from "react-icons/hi2";
import FilterPane from "./FilterPane";
import SortPane from "./SortPane";

const NonConformance = () => {
  const [activeModal, setActiveModal] = useState(null);
  const [costData, setCostData] = useState(false);

  const closeModal = () => setActiveModal(null);

  return (
    <div className="p-4 flex flex-col gap-4 h-screen overflow-hidden">
      <div className="flex flex-row justify-between items-center">
        <div className="flex flex-row justify-start items-center gap-2"></div>
        <div className="flex flex-row justify-end items-center gap-2">
          <IconButton
            title="Cost Data"
            callback={() => setCostData((prev) => !prev)}
            icon={<BsCurrencyPound className="h-5 w-5" />}
            selected={costData}
          />
          <IconButton
            selected={activeModal === "sort"}
            title="Sort"
            callback={() =>
              setActiveModal((prev) => (prev === "sort" ? null : "sort"))
            }
            icon={<HiArrowsUpDown className="h-5 w-5" />}
          />
          {activeModal === "sort" && <SortPane onClose={closeModal} />}
          <IconButton
            selected={activeModal === "filter"}
            title="Filter"
            callback={() =>
              setActiveModal((prev) => (prev === "filter" ? null : "filter"))
            }
            icon={<BsSliders className="h-4.5 w-4.5" />}
          />
          {activeModal === "filter" && <FilterPane onClose={closeModal} />}
        </div>
      </div>
      <NonConformanceTable costData={costData} />
    </div>
  );
};

export default NonConformance;
