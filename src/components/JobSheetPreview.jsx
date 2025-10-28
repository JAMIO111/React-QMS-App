import JobSheet from "@components/JobSheet";
import CTAButton from "./CTAButton";
import { IoPrintOutline } from "react-icons/io5";
import { useReactToPrint } from "react-to-print";

const JobSheetPreview = ({ jobs = [] }) => {
  const handlePrint = useReactToPrint({
    content: () => document.getElementById("job-print-container"),
    documentTitle: "Job Sheets",
    removeAfterPrint: true,
    pageStyle: `
      @page {
        size: A4;
        margin: 15mm;
      }
      @media print {
        body {
          -webkit-print-color-adjust: exact;
        }
        .page-break {
          page-break-after: always;
        }
        .no-print {
          display: none !important;
        }
      }
    `,
  });

  return (
    <div className="flex flex-col max-h-[90vh]">
      {/* Print button */}
      <div className="p-3 bg-primary-bg border-b border-border-color flex justify-end items-center no-print">
        <CTAButton
          text="Print All"
          type="main"
          icon={IoPrintOutline}
          callbackFn={handlePrint}
        />
      </div>

      {/* Printable section */}
      <div
        id="job-print-container"
        className="p-4 bg-tertiary-bg overflow-y-auto print:overflow-visible">
        {jobs.length > 0 ? (
          jobs.map((job, index) => (
            <div key={job.id || index} className="page-break">
              <JobSheet job={job} />
            </div>
          ))
        ) : (
          <p>No jobs to print.</p>
        )}
      </div>
    </div>
  );
};

export default JobSheetPreview;
