import { RotateCcwIcon } from "@/components/icons";
import { STAGES, nextStages, stageOf } from "../../lib/ncr";
import { gateKey } from "../../lib/ncrWorkflow";

/** Stage track with the moves allowed from the current stage. */
const StageBar = ({ ncr, gates, canUpdate, dirty, onMove, onCancel, onReopen, pending }) => {
  const options = nextStages(ncr.stage);
  const shown = STAGES.filter((s) => s.key !== "cancelled" || ncr.stage === "cancelled");
  const current = STAGES.findIndex((s) => s.key === ncr.stage);
  const blocked = !canUpdate || !!ncr.deletedAt;
  // What is still needed for the next stage (and so for skipping past it): the rules are cumulative.
  const next = options.forward[0];
  const needed = next && next !== "open" ? (gates?.[gateKey(next)] ?? []) : [];
  return (
    <section aria-label="Stage" className="flex flex-col gap-3 rounded-2xl border border-border-color bg-secondary-bg p-4">
      <ol className="flex flex-wrap items-center gap-1 text-xs">
        {shown.map((s, i) => (
          <li key={s.key} aria-current={s.key === ncr.stage ? "step" : undefined}
            className={`rounded-full px-2 py-1 ${s.key === ncr.stage ? s.tone + " font-semibold" : i < current && ncr.stage !== "cancelled" ? "text-primary-text" : "text-secondary-text"}`}>
            {s.label}
          </li>
        ))}
      </ol>
      {ncr.stageReason && (
        <p className="text-sm text-secondary-text">
          Last stage change: <span className="text-primary-text">{ncr.stageReason}</span>
        </p>
      )}
      {needed.length > 0 && (
        <div role="status" aria-label="Needed for the next stage" className="rounded-lg border border-warning-color/40 bg-warning-color/10 p-3 text-sm text-primary-text">
          Before this can move to {stageOf(next).label}:
          <ul className="mt-1 list-disc pl-5">
            {needed.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      )}
      {!blocked && (
        <div className="flex flex-wrap items-center gap-2">
          {options.forward.slice(0, 1).map((to) => (
            <button key={to} type="button" disabled={pending || dirty} onClick={() => onMove(to)}
              className="rounded-lg border border-cta-btn-border bg-cta-btn-bg px-3 py-1.5 text-sm text-primary-text hover:bg-cta-btn-bg-hover disabled:opacity-50 cursor-pointer">
              {to === "open" ? "Open this NC" : `Move to ${stageOf(to).label}`}
            </button>
          ))}
          {options.forward.length > 1 && (
            <select aria-label="Move to a later stage" disabled={pending || dirty} value="" onChange={(e) => e.target.value && onMove(e.target.value)}
              className="rounded-lg border border-border-color bg-text-input-color px-2 py-1.5 text-sm text-primary-text">
              <option value="">Skip to…</option>
              {options.forward.slice(1).map((to) => (
                <option key={to} value={to}>
                  {stageOf(to).label}
                </option>
              ))}
            </select>
          )}
          {options.cancel && (
            <button type="button" disabled={pending || dirty} onClick={onCancel} className="rounded-lg border border-neutral-btn-border bg-neutral-btn-bg px-3 py-1.5 text-sm text-primary-text hover:bg-neutral-btn-bg-hover disabled:opacity-50 cursor-pointer">
              Cancel NC
            </button>
          )}
          {options.reopen && (
            <button type="button" disabled={pending} onClick={onReopen} className="flex items-center gap-1 rounded-lg border border-neutral-btn-border bg-neutral-btn-bg px-3 py-1.5 text-sm text-primary-text hover:bg-neutral-btn-bg-hover disabled:opacity-50 cursor-pointer">
              <RotateCcwIcon className="h-4 w-4" /> Reopen
            </button>
          )}
          {dirty && <span className="text-sm text-secondary-text">Save your changes before changing the stage.</span>}
        </div>
      )}
    </section>
  );
};

export default StageBar;
