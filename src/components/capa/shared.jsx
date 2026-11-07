import { STEPS, stageOf } from "../../lib/capa";

/** The stage as a word, never colour alone. */
export const StagePill = ({ stage }) => {
  const s = stageOf(stage);
  return <span className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${s.tone}`}>{s.label}</span>;
};

const SQUARE_TONES = ["bg-red-400", "bg-amber-400", "bg-green-500"];

/** How many of the nine steps are complete: nine squares, three red, three amber, three green; steps not yet complete are grey. */
export const StepProgress = ({ done, current }) => (
  <div className="flex items-center gap-2" title={`${done} of ${STEPS.length} steps complete`}>
    <div className="flex gap-0.5" aria-hidden="true">
      {STEPS.map((s, i) => (
        <span key={s.code ?? i} data-filled={i < done ? "true" : "false"} className={`h-2.5 w-2.5 rounded-[2px] ${i < done ? SQUARE_TONES[Math.floor(i / 3)] : "bg-border-color"}`} />
      ))}
    </div>
    <span className="whitespace-nowrap text-xs text-secondary-text">{current ? `${current.toUpperCase()} · ` : ""}{done}/{STEPS.length}</span>
  </div>
);
