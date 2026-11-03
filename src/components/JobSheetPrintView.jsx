// JobSheetPrintView.jsx
import React, { forwardRef } from "react";
import JobSheet from "./JobSheet";

const JobSheetPrintView = forwardRef(({ jobs }, ref) => (
  <div className="overflow-y-auto" ref={ref}>
    {jobs.map((job) => (
      <JobSheet key={job.id} job={job} />
    ))}
  </div>
));

export default JobSheetPrintView;
