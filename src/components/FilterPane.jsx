import React from "react";
import { CgClose } from "react-icons/cg";

const FilterPane = ({ onClose }) => {
  return (
    <div className="border absolute bg-primary-bg text-primary-text z-1000 top-30 rounded-2xl border-border-color shadow-lg shadow-border-color w-80 h-fit">
      <div className="flex px-4 py-1 bg-secondary-bg border-b border-border-color flex-row justify-between items-center rounded-t-2xl ">
        <h3 className="text-xl">Filter</h3>
        <button
          className="cursor-pointer hover:text-error-color p-1"
          onClick={onClose}>
          <CgClose />
        </button>
      </div>
      <div className="flex flex-col justify-start items-center">
        <div className="filter-item flex px-4 py-3 border-b border-border-color w-full flex-col justify-start items-center">
          <div className="w-full flex flex-row justify-between items-center">
            <h4>Failure Mode</h4>
            <button className="text-brand-primary hover:text-error-color cursor-pointer pl-2 text-right">
              Reset
            </button>
          </div>
          <div className="w-full">
            <select className="w-full h-8 bg-text-input-color border border-border-color rounded-md px-2 mt-2">
              <option value="">All</option>
              <option value="open">Open</option>
              <option value="closed">Closed</option>
              <option value="in-progress">In Progress</option>
            </select>
          </div>
        </div>
        <div className="filter-item flex px-4 py-3 border-b border-border-color w-full flex-col justify-start items-center">
          <div className="w-full flex flex-row justify-between items-center">
            <h4>Status</h4>
            <button className="text-brand-primary hover:text-error-color cursor-pointer pl-2 text-right">
              Reset
            </button>
          </div>
          <div className="w-full">
            <select className="w-full h-8 border bg-text-input-color border-border-color rounded-md px-2 mt-2">
              <option value="">All</option>
              <option value="open">Open</option>
              <option value="closed">Closed</option>
              <option value="in-progress">In Progress</option>
            </select>
          </div>
        </div>
        <div className="w-full p-4 flex flex-row justify-between items-center">
          <button className="border border-border-color bg-primary-bg rounded-lg py-1 px-2 cursor-pointer hover:border-error-color hover:text-error-color">
            Reset All
          </button>
          <button className="rounded-lg py-1 px-2 text-white bg-cta-color cursor-pointer">
            Apply Now
          </button>
        </div>
      </div>
    </div>
  );
};

export default FilterPane;
