import { useState } from "react";
import { Link } from "react-router-dom";
import { useCapaMutation, useMyCapaActions } from "../../hooks/useCapa";
import { formatDay } from "../../lib/qualityAlerts";
import { ACTION_STATUS } from "../../lib/capa";
import { ErrorNotice, FormError } from "../master-data/shared";
import { FindingsDialog } from "./ActionList";
import CTAButton from "@/components/CTAButton";

const PHASES = { interim: "Containment", corrective: "Corrective action", preventive: "Preventive action" };
const STEP_OF = { interim: "d3", corrective: "d6", preventive: "d7" };
const FILTERS = [
  { id: "open", label: "To do" },
  { id: "done", label: "Closed" },
  { id: "all", label: "All" },
];

/** Every 8D action assigned to the signed-in person: update the findings and close it without opening the 8D. */
const MyActionsPage = () => {
  const [status, setStatus] = useState("open");
  const query = useMyCapaActions(status);
  const mutation = useCapaMutation();
  const [dialog, setDialog] = useState(null); // { action, closing }
  const rows = query.data?.data ?? [];

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col gap-4 overflow-y-auto p-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-primary-text">My 8D actions</h1>
          <p className="text-sm text-secondary-text">Actions in running 8Ds that are assigned to you. Write what you did and found, then close the action.</p>
        </div>
        <div role="group" aria-label="Show" className="flex gap-1">
          {FILTERS.map((f) => (
            <CTAButton key={f.id} type="neutral" size="md" aria-pressed={status === f.id} className={status === f.id ? "ring-2 ring-brand-primary" : undefined} onClick={() => setStatus(f.id)}>{f.label}</CTAButton>
          ))}
        </div>
      </header>
      {query.error && <ErrorNotice error={query.error} />}
      <FormError error={dialog ? null : mutation.error} />
      {query.isLoading ? (
        <p className="text-sm text-secondary-text">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border-dark-color p-4 text-sm text-secondary-text">{status === "open" ? "Nothing to do. Actions assigned to you will appear here." : "No actions."}</p>
      ) : (
        <ul aria-label="My actions" className="flex flex-col gap-3">
          {rows.map((a) => (
            <li key={a.id} className="flex flex-col gap-2 rounded-2xl border border-border-color bg-secondary-bg p-4 text-sm">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <p className="max-w-3xl text-primary-text">{a.description}</p>
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${ACTION_STATUS[a.status].tone}`}>{ACTION_STATUS[a.status].label}</span>
              </div>
              <p className="text-xs text-secondary-text">
                <Link to={`/CAPA/${a.capaId}/${STEP_OF[a.phase]}`} className="text-link-color hover:underline">{a.capaReference} · {a.capaTitle}</Link>
                {" · "}{PHASES[a.phase]}
                {a.dueDate && <> · Due {formatDay(a.dueDate)}{a.overdue && <span className="font-medium text-error-color"> · overdue</span>}</>}
                {a.status === "done" && a.doneAt && <> · Closed {formatDay(a.doneAt.slice(0, 10))}</>}
              </p>
              {a.evidenceNote && <p className="whitespace-pre-wrap text-xs text-primary-text"><span className="text-secondary-text">Findings: </span>{a.evidenceNote}</p>}
              {a.locked ? (
                <p className="text-xs text-secondary-text">The step this is worked in is complete, so it is read-only. Ask the 8D team to reopen it.</p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {a.status === "open" && <CTAButton buttonType="button" type="neutral" size="md" aria-label={`Update findings: ${a.description}`} onClick={() => { mutation.reset(); setDialog({ action: a, closing: false }); }}>Update findings</CTAButton>}
                  {a.status === "open" && <CTAButton buttonType="button" type="main" size="lg" aria-label={`Close action: ${a.description}`} onClick={() => { mutation.reset(); setDialog({ action: a, closing: true }); }}>Close action</CTAButton>}
                  {a.status === "done" && <CTAButton buttonType="button" type="neutral" size="md" aria-label={`Reopen: ${a.description}`} disabled={mutation.isPending} onClick={() => mutation.mutate({ action: "reopenAction", id: a.id })}>Reopen</CTAButton>}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {dialog && <FindingsDialog action={dialog.action} closing={dialog.closing} onClose={() => setDialog(null)} />}
    </div>
  );
};

export default MyActionsPage;
