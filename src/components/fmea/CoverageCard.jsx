import { useState } from "react";
import { useControlCoverage } from "../../hooks/useFmea";
import { controlKindLabel, coverageLabel, coveragePill, linkStateLabel, linkStatePill, planTargetWords, priorityLabel, priorityPill } from "../../lib/fmea";
import Callout from "../ui/Callout";
import MenuCard from "../ui/MenuCard";

const Pill = ({ className = "", children }) => <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${className}`}>{children}</span>;

/**
 * Which causes that need attention the control plan in force covers (FM11): read on request, because it looks at the control plans. Information only: nothing is blocked,
 * and a cause that is not covered is a prompt to carry a control to a plan characteristic (from the cause, above) or to say why not.
 */
const CoverageCard = ({ revision }) => {
  const [open, setOpen] = useState(false);
  const live = revision.status === "draft" || revision.status === "effective";
  const needing = revision.net.counts.needAttention;
  const query = useControlCoverage(revision.id, { enabled: open && live && needing > 0 });
  if (!live || needing === 0) return null;
  const data = query.data;

  return (
    <MenuCard
      title="Covered by the control plan?"
      subtitle="The causes that need attention, and whether a characteristic of the control plan in force checks each of them."
      action={
        <button type="button" className="text-sm font-medium text-brand-primary hover:underline" aria-expanded={open} aria-label={`${open ? "Hide" : "Show"} coverage`} onClick={() => setOpen((v) => !v)}>
          {open ? "Hide" : "Show"}
        </button>
      }
    >
      {open && (
        <div className="flex flex-col gap-3 p-4">
          {query.isLoading && <p className="text-sm text-secondary-text">Looking at the control plans…</p>}
          {query.error && <Callout tone="error">The coverage could not be worked out. Try again.</Callout>}
          {data && (
            <>
              {!data.canReadPlans && <Callout tone="info">You cannot read control plans, so the links below cannot be checked against them.</Callout>}
              <p className="text-sm text-secondary-text" aria-label="Coverage figures">
                {data.totals.coveredPercent == null ? "Nothing needs attention." : `${data.totals.covered} of ${data.totals.needingAttention} covered (${data.totals.coveredPercent}%)`}
                {data.totals.notCovered > 0 && <> · {data.totals.notCovered} not covered</>}
                {data.totals.linkProblems > 0 && <> · {data.totals.linkProblems} with a link to look at</>}
                {data.totals.unverified > 0 && <> · {data.totals.unverified} not checked</>}
              </p>
              <ul className="flex flex-col gap-2" aria-label="Causes that need attention">
                {data.rows.map((r) => (
                  <li key={r.id} className="rounded-lg border border-border-color bg-secondary-bg px-3 py-2 text-sm">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-primary-text">
                          {r.text}
                          <span className="ml-2 text-xs text-secondary-text">
                            {r.itemName} · {r.failureMode}
                          </span>
                        </p>
                        <p className="text-xs text-secondary-text">{r.why}</p>
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5">
                        {r.priority && <Pill className={priorityPill(r.priority)}>{priorityLabel(r.priority)}</Pill>}
                        <Pill className={coveragePill(r.status)}>{coverageLabel(r.status)}</Pill>
                      </div>
                    </div>
                    {r.links.length > 0 && (
                      <ul className="mt-1 flex flex-col gap-1">
                        {r.links.map((l) => (
                          <li key={l.id} className="flex flex-wrap items-center gap-2 text-xs text-secondary-text">
                            <span>
                              {controlKindLabel(l.kind)}: {planTargetWords({ plan: l.planCode ? { code: l.planCode } : null, operationCode: l.operationCode, characteristicKey: l.characteristicKey })}
                            </span>
                            <Pill className={linkStatePill(l.state)}>{linkStateLabel(l.state)}</Pill>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
              {data.canCarry && data.totals.notCovered > 0 && <p className="text-xs text-secondary-text">To cover a cause, use “Carry to the control plan” under it in the analysis above.</p>}
            </>
          )}
        </div>
      )}
    </MenuCard>
  );
};

export default CoverageCard;
