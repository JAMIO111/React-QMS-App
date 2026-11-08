import { useState } from "react";
import { Link } from "react-router-dom";
import { PlayIcon } from "@/components/icons";
import { usePermissions } from "../../hooks/useQmsApi";
import { useMyJobs } from "../../hooks/useJobs";
import { elapsed } from "../../lib/jobs";
import StartJobDialog from "./StartJobDialog";
import CTAButton from "@/components/CTAButton";

const Card = () => {
  const [open, setOpen] = useState(false);
  const jobs = useMyJobs();
  const running = jobs.data?.data ?? [];
  return (
    <section aria-label="Jobs" className="flex flex-col gap-3 rounded-2xl border border-border-color bg-secondary-bg p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-primary-text">Start new job</h2>
          <p className="text-sm text-secondary-text">Choose your machine and the part. Everything else is filled in for you.</p>
        </div>
        <CTAButton buttonType="button" type="main" size="lg" onClick={() => setOpen(true)}>
          <PlayIcon className="mr-1.5 inline h-4 w-4" aria-hidden="true" />
          Start new job
        </CTAButton>
      </div>
      {running.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-secondary-text">Your jobs in progress</h3>
          <ul aria-label="Jobs in progress" className="flex flex-col gap-1.5">
            {running.map((j) => (
              <li key={j.id}>
                <Link to={`/Jobs/${j.id}`} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border-color bg-primary-bg px-3 py-2 text-sm hover:border-border-dark-color">
                  <span className="font-medium text-primary-text">
                    {j.part?.partNumber}
                    {j.machine ? ` · ${j.machine.code}` : ""}
                    {j.workOrder ? ` · ${j.workOrder}` : ""}
                  </span>
                  <span className="text-secondary-text">
                    {j.reference} · {elapsed(j.startedAt)} · <span className="text-link-color">Resume</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
      {open && <StartJobDialog onClose={() => setOpen(false)} />}
    </section>
  );
};

/** Dashboard card for anyone who can record inspections: start a job, or resume one. */
const StartJobCard = () => {
  const { can } = usePermissions();
  return can("inspection.record") ? <Card /> : null;
};

export default StartJobCard;
