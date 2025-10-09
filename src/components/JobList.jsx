import React from "react";

const JobList = ({ jobs = [] }) => {
  return (
    <div className="bg-secondary-bg shadow-sm h-full rounded-2xl border border-border-color overflow-hidden">
      {/* Header */}
      <div className="grid grid-cols-[1.2fr_2.5fr_2fr_2fr] py-2 px-3 bg-secondary-bg border-b border-border-color text-sm text-secondary-text">
        <div>Job No.</div>
        <div>Property</div>
        <div>Job Date</div>
        <div>Move In</div>
      </div>

      {/* Body */}
      <div className="h-full bg-text-input-color">
        {jobs.length > 0 ? (
          jobs.map((job, index) => (
            <div
              key={job.id || index}
              className="grid grid-cols-[1.2fr_2.5fr_2fr_2fr] py-2 px-4 text-sm text-primary-text hover:bg-brand-primary/30 transition-colors cursor-pointer">
              <div>{job.jobNo}</div>
              <div>{job.property}</div>
              <div>{job.jobDate}</div>
              <div>{job.moveIn}</div>
            </div>
          ))
        ) : (
          <div className="p-6 text-center text-secondary-text text-sm">
            No jobs found
          </div>
        )}
      </div>
    </div>
  );
};

export default JobList;
