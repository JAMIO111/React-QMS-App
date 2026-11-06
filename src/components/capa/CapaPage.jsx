import { useState } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import { ArrowLeftIcon } from "@/components/icons";
import ReasonDialog from "../ncr/ReasonDialog";
import { usePermissions } from "../../hooks/useQmsApi";
import { useCapa, useCapaMutation } from "../../hooks/useCapa";
import { SOURCES, STEPS, isRunning, ncrHref, stepOf } from "../../lib/capa";
import { formatDay } from "../../lib/qualityAlerts";
import { ErrorNotice, buttonClass } from "../master-data/shared";
import { StagePill } from "./shared";
import Stepper from "./Stepper";
import StepFooter from "./StepFooter";
import D0Initiate from "./steps/D0Initiate";
import D1Team from "./steps/D1Team";
import D2Problem from "./steps/D2Problem";
import D3Containment from "./steps/D3Containment";
import D4RootCause from "./steps/D4RootCause";
import D5Corrective from "./steps/D5Corrective";
import D6Implement from "./steps/D6Implement";
import D7Prevent from "./steps/D7Prevent";
import D8Close from "./steps/D8Close";

const STEP_PAGES = { d0: D0Initiate, d1: D1Team, d2: D2Problem, d3: D3Containment, d4: D4RootCause, d5: D5Corrective, d6: D6Implement, d7: D7Prevent, d8: D8Close };

/**
 * One 8D, step by step. `/CAPA/:id` opens the step the 8D is at; `/CAPA/:id/:step` shows D0…D8 with the stepper beside it. Each step page has its
 * content (analysis tools open as modals), a list of what is still needed, and Complete step and continue.
 */
const CapaPage = () => {
  const { id, step } = useParams();
  const { can } = usePermissions();
  const query = useCapa(id);
  const mutation = useCapaMutation();
  const [dialog, setDialog] = useState(null);

  if (query.isLoading) return <p className="p-4 text-secondary-text">Loading 8D…</p>;
  if (query.error) return <div className="p-4"><ErrorNotice error={query.error} /></div>;
  const capa = query.data;
  if (!capa) return null;
  if (!step || !STEPS.some((s) => s.key === step)) return <Navigate to={`/CAPA/${capa.id}/${capa.currentStep}`} replace />;

  const running = isRunning(capa.stage);
  const editable = can("capa.manage") && running;
  const def = stepOf(step);
  const Page = STEP_PAGES[step];
  const source = SOURCES.find((s) => s.id === capa.source)?.name ?? capa.source;
  const live = capa.ncrs.filter((n) => !n.endedAt);

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col gap-4 overflow-y-auto p-4">
      <Link to="/CAPA" className="flex w-fit items-center gap-1 text-sm text-link-color hover:underline">
        <ArrowLeftIcon className="h-4 w-4" /> Corrective actions
      </Link>

      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="flex flex-wrap items-center gap-3 text-2xl font-semibold text-primary-text">
            <span>{capa.reference}</span>
            <span className="font-normal text-secondary-text">·</span>
            <span className="min-w-0 break-words">{capa.title}</span>
          </h1>
          <p className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-secondary-text">
            <StagePill stage={capa.stage} />
            <span>{source}</span>
            {capa.severity && <span className="capitalize">{capa.severity}</span>}
            {capa.externalReference && <span>Ref {capa.externalReference}</span>}
            <span>Owner: {capa.owner?.name ?? "none"}</span>
            {capa.dueDate && <span className={capa.overdue ? "font-medium text-error-color" : ""}>Due {formatDay(capa.dueDate)}{capa.overdue ? " · overdue" : ""}</span>}
          </p>
          {live.length > 0 && (
            <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-secondary-text">
              Addresses
              {live.map((n) => (n.reference ? <Link key={n.id} to={ncrHref(n)} className="rounded-full border border-border-color px-2 py-0.5 text-link-color hover:underline">{n.reference}</Link> : <span key={n.id}>a non-conformance you cannot see</span>))}
            </p>
          )}
          {capa.stageReason && <p className="mt-1 text-sm text-secondary-text">{capa.stage === "cancelled" ? "Cancelled" : "Reopened"}: {capa.stageReason}</p>}
        </div>
        <div className="flex gap-2">
          <Link to={`/CAPA/${capa.id}/report`} className={buttonClass.neutral}>Report</Link>
          {can("capa.manage") && running && <button type="button" className={buttonClass.danger} onClick={() => { mutation.reset(); setDialog("cancel"); }}>Cancel 8D</button>}
          {can("capa.manage") && !running && <button type="button" className={buttonClass.neutral} onClick={() => { mutation.reset(); setDialog("reopen"); }}>Reopen 8D</button>}
        </div>
      </header>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[15rem_minmax(0,1fr)]">
        <Stepper capa={capa} active={step} />
        <section aria-label={`${def.code} ${def.title}`} className="flex min-w-0 flex-col gap-4 rounded-2xl border border-border-color bg-secondary-bg p-5">
          <div>
            <h2 className="text-xl font-semibold text-primary-text">{def.code} · {def.title}</h2>
            <p className="mt-1 max-w-3xl text-sm text-secondary-text">{def.help}</p>
          </div>
          {!running && <p role="status" className="rounded-lg border border-border-color bg-primary-bg p-3 text-sm text-primary-text">This 8D is {capa.stage}. Reopen it to make changes.</p>}
          {Page && <Page capa={capa} editable={editable} />}
          <StepFooter capa={capa} step={step} editable={editable} />
        </section>
      </div>

      {dialog === "cancel" && (
        <ReasonDialog title={`Cancel ${capa.reference}?`} label="Why is this 8D being cancelled?" confirmText="Cancel 8D" pending={mutation.isPending} error={mutation.error}
          onClose={() => setDialog(null)} onConfirm={(reason) => mutation.mutate({ action: "cancel", id: capa.id, body: { reason } }, { onSuccess: () => setDialog(null) })} />
      )}
      {dialog === "reopen" && (
        <ReasonDialog title={`Reopen ${capa.reference}?`} label="Why is this 8D being reopened?" confirmText="Reopen 8D" pending={mutation.isPending} error={mutation.error}
          onClose={() => setDialog(null)} onConfirm={(reason) => mutation.mutate({ action: "reopen", id: capa.id, body: { reason } }, { onSuccess: () => setDialog(null) })} />
      )}
    </div>
  );
};

export default CapaPage;
