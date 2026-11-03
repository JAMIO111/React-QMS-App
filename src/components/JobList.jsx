import React from "react";
import CTAButton from "./CTAButton";
import { HiOutlineDocumentText } from "react-icons/hi2";

const JobList = ({ jobs = [], isLoading, error, openModal }) => {
  return (
    <div className="flex flex-col bg-secondary-bg p-2 h-full rounded-3xl shadow-m">
      {/* Header */}

      <div className="flex flex-row justify-between items-center px-3 pt-3 pb-4">
        <h2 className="text-xl text-primary-text font-semibold">
          Upcoming Jobs
        </h2>
        <CTAButton
          callbackFn={openModal}
          type="main"
          text="Job Sheets"
          icon={HiOutlineDocumentText}
          disabled={jobs.length === 0 || isLoading || error}
          title={
            jobs.length === 0
              ? "No jobs available to preview"
              : isLoading
              ? "Loading jobs..."
              : error
              ? "Error loading jobs"
              : ""
          }
        />
      </div>

      <div className="flex flex-1 bg-tertiary-bg flex-col border border-border-color h-full rounded-2xl overflow-hidden">
        <div className="grid grid-cols-[2.5fr_2fr_2fr] border-b border-border-color text-sm bg-primary-bg text-secondary-text">
          <div className="p-2 border-r border-border-color">Property</div>
          <div className="p-2 border-r border-border-color">Job Date</div>
          <div className="p-2">Move In</div>
        </div>

        {/* Body */}
        <div className="flex-1 [&::-webkit-scrollbar]:hidden overflow-y-scroll">
          {jobs.length > 0 ? (
            jobs.map((job, index) => (
              <div
                key={job.jobId || index}
                className={`${
                  index % 2 === 0 ? "bg-tertiary-bg" : "bg-secondary-bg"
                } ${
                  index !== jobs.length ? "border-b" : ""
                } border-border-color grid grid-cols-[2.5fr_2fr_2fr] text-sm text-primary-text hover:bg-brand-primary/30 cursor-pointer`}>
                <div className="flex font-medium items-center px-2 py-1">
                  {job.propertyDetails.name}
                </div>
                <div className="flex items-center px-3 py-1">
                  {job.jobDate
                    ? new Date(job.jobDate).toLocaleDateString("en-GB", {
                        weekday: "short",
                        day: "numeric",
                        month: "short",
                      })
                    : "N/A"}
                </div>
                <div className="flex items-center px-3 py-1">
                  {job.nextArrival
                    ? new Date(job.nextArrival).toLocaleDateString("en-GB", {
                        weekday: "short",
                        day: "numeric",
                        month: "short",
                      })
                    : "No Booking"}
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
