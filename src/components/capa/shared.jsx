import { STEPS, stageOf } from "../../lib/capa";

/** The stage as a word, never colour alone. */
export const StagePill = ({ stage }) => {
  const s = stageOf(stage);
  return <span className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${s.tone}`}>{s.label}</span>;
};

/** How many of the nine steps are complete, as a bar and words. */
export const StepProgress = ({ done, current }) => (
  <div className="flex items-center gap-2" title={`${done} of ${STEPS.length} steps complete`}>
    <div className="h-1.5 w-20 overflow-hidden rounded-full bg-border-color" aria-hidden="true">
      <div className="h-full rounded-full bg-brand-primary" style={{ width: `${(done / STEPS.length) * 100}%` }} />
    </div>
    <span className="whitespace-nowrap text-xs text-secondary-text">{current ? `${current.toUpperCase()} · ` : ""}{done}/{STEPS.length}</span>
  </div>
);
