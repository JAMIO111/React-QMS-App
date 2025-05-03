import React from "react";
import { CgClose } from "react-icons/cg";

const FilterPane = ({ onClose }) => {
  return (
    <div className="border absolute bg-white z-1000 top-30 rounded-2xl border-gray-200 shadow-xl shadow-gray-400 w-80 h-fit">
      <div className="flex px-4 py-1 bg-gray-100 border-b border-gray-300 flex-row justify-between items-center rounded-t-2xl ">
        <h3 className="text-xl">Filter</h3>
        <button
          className="cursor-pointer hover:text-red-600 p-1"
          onClick={onClose}>
          <CgClose />
        </button>
      </div>
      <div className="flex flex-col justify-start items-center">
        <div className="filter-item flex px-4 py-3 border-b border-gray-300 w-full flex-col justify-start items-center">
          <div className="w-full flex flex-row justify-between items-center">
            <h4>Failure Mode</h4>
            <button className="text-indigo-600 hover:text-red-600 cursor-pointer pl-2 text-right">
              Reset
            </button>
          </div>
          <div className="w-full">
            <select className="w-full h-10 border border-gray-300 rounded-md p-2 mt-2">
              <option value="">All</option>
              <option value="open">Open</option>
              <option value="closed">Closed</option>
              <option value="in-progress">In Progress</option>
            </select>
          </div>
        </div>
        <div className="filter-item flex px-4 py-3 border-b border-gray-300 w-full flex-col justify-start items-center">
          <div className="w-full flex flex-row justify-between items-center">
            <h4>Status</h4>
            <button className="text-indigo-600 hover:text-red-600 cursor-pointer pl-2 text-right">
              Reset
            </button>
          </div>
          <div className="w-full">
            <select className="w-full h-10 border border-gray-300 rounded-md p-2 mt-2">
              <option value="">All</option>
              <option value="open">Open</option>
              <option value="closed">Closed</option>
              <option value="in-progress">In Progress</option>
            </select>
          </div>
        </div>
        <div className="w-full p-4 flex flex-row justify-between items-center">
          <button className="border border-gray-300 rounded-lg py-1 px-2 cursor-pointer hover:border-red-500 hover:text-red-600">
            Reset All
          </button>
          <button className="border border-gray-500 rounded-lg py-1 px-2 text-white bg-indigo-600 cursor-pointer">
            Apply Now
          </button>
        </div>
      </div>
    </div>
  );
};

export default FilterPane;
