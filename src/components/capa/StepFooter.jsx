import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ChevronLeftIcon, ChevronRightIcon, CircleAlertIcon, CircleCheckIcon } from "@/components/icons";
import ReasonDialog from "../ncr/ReasonDialog";
import { useCapaMutation } from "../../hooks/useCapa";
import { STEPS, stepIndex } from "../../lib/capa";
import { formatDateTime } from "../../lib/processControl";
import { FormError, buttonClass } from "../master-data/shared";

/**
 * Under every step: what is still needed (worked out by the database), Back, and Complete step and continue. A complete step shows who
 * completed it and offers to reopen it. Steps are markers, not gates: any step can be completed in any order and nothing locks.
 */
const StepFooter = ({ capa, step, editable }) => {
  const navigate = useNavigate();
  const mutation = useCapaMutation();
  const [reopening, setReopening] = useState(false);
  const i = stepIndex(step);
  const prev = STEPS[i - 1];
  const next = STEPS[i + 1];
  const s = capa.steps.find((x) => x.step === step);
  const code = STEPS[i].code;
  const ready = s.problems.length === 0;

  return (
    <div className="flex flex-col gap-3 border-t border-border-color pt-4">
      {s.completed ? (
        <p className="flex flex-wrap items-center gap-2 text-sm text-primary-text">
          <CircleCheckIcon className="h-4 w-4 text-success-color" />
          {code} was completed by {s.completedBy?.name ?? "someone"} on {formatDateTime(s.completedAt)}.
          {s.note && <span className="text-secondary-text">“{s.note}”</span>}
        </p>
      ) : (
        <div role="status" aria-label="Still needed" className="rounded-lg border border-border-color bg-secondary-bg p-3 text-sm">
          {ready ? (
            <p className="flex items-center gap-2 text-primary-text"><CircleCheckIcon className="h-4 w-4 text-success-color" /> Everything {code} needs is in place.</p>
          ) : (
            <>
              <p className="mb-1 flex items-center gap-2 font-medium text-primary-text"><CircleAlertIcon className="h-4 w-4 text-warning-color" /> Still needed to complete {code}</p>
              <ul className="list-disc pl-6 text-primary-text">
                {s.problems.map((p) => <li key={p}>{p}</li>)}
              </ul>
            </>
          )}
        </div>
      )}
      <FormError error={mutation.error} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        {prev ? (
          <Link to={`/CAPA/${capa.id}/${prev.key}`} className={`${buttonClass.neutral} inline-flex items-center gap-1`}>
            <ChevronLeftIcon className="h-4 w-4" /> {prev.code} {prev.label}
          </Link>
        ) : <span />}
        <div className="flex flex-wrap items-center gap-2">
          {editable && s.completed && step !== "d8" && (
            <button type="button" className={buttonClass.neutral} onClick={() => { mutation.reset(); setReopening(true); }}>Reopen {code}</button>
          )}
          {editable && !s.completed && step !== "d8" && (
            <button
              type="button"
              className={buttonClass.primary}
              disabled={!ready || mutation.isPending}
              onClick={() => mutation.mutate({ action: "completeStep", id: capa.id, body: { step } }, { onSuccess: () => next && navigate(`/CAPA/${capa.id}/${next.key}`) })}>
              {mutation.isPending ? "Saving…" : next ? `Complete ${code} and continue` : `Complete ${code}`}
            </button>
          )}
          {next && (s.completed || !editable) && (
            <Link to={`/CAPA/${capa.id}/${next.key}`} className={`${buttonClass.neutral} inline-flex items-center gap-1`}>
              {next.code} {next.label} <ChevronRightIcon className="h-4 w-4" />
            </Link>
          )}
        </div>
      </div>
      {reopening && (
        <ReasonDialog
          title={`Reopen ${code}?`}
          label={`Why is ${code} being reopened?`}
          confirmText={`Reopen ${code}`}
          pending={mutation.isPending}
          error={mutation.error}
          onClose={() => setReopening(false)}
          onConfirm={(reason) => mutation.mutate({ action: "reopenStep", id: capa.id, body: { step, reason } }, { onSuccess: () => setReopening(false) })}
        />
      )}
    </div>
  );
};

export default StepFooter;
