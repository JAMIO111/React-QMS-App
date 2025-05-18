import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchAll } from "../api/supabaseApi";
import { CgClose } from "react-icons/cg";
import { useNCMFilters } from "../hooks/useNCMFilters";
import { useSearchParams } from "react-router-dom";

const FilterPane = ({ onClose }) => {
  const [searchParams] = useSearchParams();
  const statusUrl = searchParams.get("status") || "";
  const failureModeUrl = searchParams.get("failure_mode") || "";
  const { search, status, failureMode, updateFilters } = useNCMFilters();
  const [localStatus, setLocalStatus] = useState(statusUrl);
  const [localFailureMode, setLocalFailureMode] = useState(failureModeUrl);

  useEffect(() => {
    setLocalStatus(status);
  }, [status]);

  useEffect(() => {
    setLocalFailureMode(failureMode);
  }, [failureMode]);

  const onStatusChange = (e) => setLocalStatus(e.target.value);
  const onFailureModeChange = (e) => setLocalFailureMode(e.target.value);

  const resetAll = () => {
    setLocalStatus("");
    setLocalFailureMode("");
  };

  const applyFilters = () => {
    updateFilters({
      search: search,
      status: localStatus,
      failureMode: localFailureMode,
    });
    if (onClose) onClose();
  };

  const {
    data: statusOptions,
    error: statusError,
    isLoading: isStatusLoading,
  } = useQuery({
    queryKey: ["Status"],
    queryFn: () => fetchAll("Status"),
    staleTime: 1000 * 60 * 30, // 30 minutes
  });
  const {
    data: failureModeOptions,
    error: failureModeError,
    isLoading: isFailureModeLoading,
  } = useQuery({
    queryKey: ["Failure Mode"],
    queryFn: () => fetchAll("Failure Mode"),
    staleTime: 1000 * 60 * 30, // 30 minutes
  });

  return (
    <div className="border absolute bg-primary-bg text-primary-text z-1000 top-32 rounded-2xl border-border-color shadow-lg shadow-shadow-color w-80 h-fit">
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
            <h4>Status</h4>
            <button className="text-brand-primary hover:text-error-color cursor-pointer pl-2 text-right">
              Reset
            </button>
          </div>
          <div className="w-full">
            <select
              value={localStatus}
              onChange={onStatusChange}
              className="w-full h-8 bg-text-input-color border border-border-color rounded-md px-2 mt-2">
              <option defaultValue value="">
                All
              </option>
              {statusOptions?.map((option) => (
                <option key={option.id} value={option.name}>
                  {option.name}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="filter-item flex px-4 py-3 border-b border-border-color w-full flex-col justify-start items-center">
          <div className="w-full flex flex-row justify-between items-center">
            <h4>Failure Mode</h4>
            <button className="text-brand-primary hover:text-error-color cursor-pointer pl-2 text-right">
              Reset
            </button>
          </div>
          <div className="w-full">
            <select
              value={localFailureMode}
              onChange={onFailureModeChange}
              className="w-full h-8 border bg-text-input-color border-border-color rounded-md px-2 mt-2">
              <option defaultValue value="">
                All
              </option>
              {failureModeOptions?.map((option) => (
                <option key={option.id} value={option.name}>
                  {option.code} - {option.name}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="w-full p-4 flex flex-row justify-between items-center">
          <button
            onClick={resetAll}
            className="border border-border-color bg-primary-bg rounded-lg py-1 px-2 cursor-pointer hover:border-error-color hover:text-error-color">
            Reset All
          </button>
          <button
            onClick={applyFilters}
            className="rounded-lg py-1 px-2 text-white bg-cta-color cursor-pointer">
            Apply Now
          </button>
        </div>
      </div>
    </div>
  );
};

export default FilterPane;
