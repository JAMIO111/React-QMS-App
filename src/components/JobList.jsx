import React from "react";
import CTAButton from "./CTAButton";
import { IoPrintOutline } from "react-icons/io5";

const JobList = ({ jobs = [] }) => {
  return (
    <div className="flex flex-col bg-secondary-bg p-2 h-full rounded-3xl shadow-m">
      {/* Header */}

      <div className="flex flex-row justify-between items-center px-3 pt-3 pb-4">
        <h2 className="text-xl text-primary-text font-semibold">
          Upcoming Jobs
        </h2>
        <CTAButton
          callbackFn={() => {
            navigate("/jobs/new-job");
          }}
          type="main"
          text="Print"
          icon={IoPrintOutline}
        />
      </div>

      <div className="flex flex-1 bg-tertiary-bg flex-col border border-border-color h-full rounded-2xl overflow-hidden">
        <div className="grid grid-cols-[0.8fr_2.5fr_2fr_2fr] border-b border-border-color text-sm bg-primary-bg text-secondary-text">
          <div className="p-2 border-r border-border-color overflow-clip text-ellipsis text-nowrap">
            No.
          </div>
          <div className="p-2 border-r border-border-color">Property</div>
          <div className="p-2 border-r border-border-color">Job Date</div>
          <div className="p-2">Move In</div>
        </div>

        {/* Body */}
        <div className="flex-1">
          {jobs.length > 0 ? (
            jobs.map((job, index) => (
              <div
                key={job.id || index}
                className="grid grid-cols-[0.8fr_2.5fr_2fr_2fr] text-sm text-primary-text hover:bg-brand-primary/30 transition-colors cursor-pointer">
                <div className="flex items-center border-b px-2 py-1 border-border-color">
                  {job.jobNo}
                </div>
                <div className="flex font-medium items-center border-b px-2 py-1 border-border-color">
                  {job.property}
                </div>
                <div className="flex items-center border-b px-2 py-1 border-border-color">
                  {job.jobDate}
                </div>
                <div className="flex items-center border-b px-2 py-1 border-border-color">
                  {job.moveIn}
                </div>
              </div>
            ))
          ) : (
            <div className="p-6 text-center text-secondary-text text-sm">
              No jobs found
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default JobList;
