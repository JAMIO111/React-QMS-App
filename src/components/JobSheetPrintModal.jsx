import React, { useRef } from "react";
import { useReactToPrint } from "react-to-print";
import CTAButton from "./CTAButton";
import { IoPrintOutline } from "react-icons/io5";
import JobSheetPrintView from "./JobSheetPrintView";

export default function JobSheetPrintModal({ jobs, startDate, endDate }) {
  const printRef = useRef();
  console.log(startDate, endDate);

  const handlePrint = useReactToPrint({
    contentRef: printRef,
    documentTitle: "Job Sheets",
  });

  return (
    <div
      onClick={(e) => e.stopPropagation()}
      className="flex flex-col h-full max-h-[90vh] p-3">
      {/* Fixed Button */}
      <div className="flex justify-between items-center flex-shrink-0 pb-2 border-b border-border-color mb-3">
        <div className="flex flex-col gap-1">
          <p className="font-semibold text-primary-text">{`${jobs.length} Job${
            jobs.length !== 1 ? "s" : ""
          } Selected`}</p>
          <p className="text-sm text-primary-text">
            {startDate && endDate
              ? `${new Date(startDate).toLocaleDateString("en-GB", {
                  weekday: "short",
                  year: "numeric",
                  month: "short",
                  day: "numeric",
                })} - ${new Date(endDate).toLocaleDateString("en-GB", {
                  weekday: "short",
                  year: "numeric",
                  month: "short",
                  day: "numeric",
                })}`
              : "No date range"}
          </p>
        </div>

        <CTAButton
          type="main"
          icon={IoPrintOutline}
          callbackFn={handlePrint}
          text={`Print All (${jobs.length})`}
        />
      </div>

      {/* Scrollable Job Sheets */}
      <div ref={printRef} className="flex-1 overflow-y-auto">
        <JobSheetPrintView jobs={jobs} />
      </div>
    </div>
  );
}
