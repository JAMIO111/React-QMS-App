import { useState } from "react";
import { Link } from "react-router-dom";
import { useOccurrenceEvidence } from "../../hooks/useFmea";
import { evidenceCountWords, evidenceFlagLabel, evidenceFlagPill, ratingWords } from "../../lib/fmea";
import { ncrPath } from "../../lib/ncr";
import Callout from "../ui/Callout";
import MenuCard from "../ui/MenuCard";

const Pill = ({ className = "", children }) => <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${className}`}>{children}</span>;

/**
 * What has actually happened (the living FMEA): the failure modes tied to the non-conformance register, beside how many live non-conformances were raised against each in the last
 * year, and the ones nobody foresaw. Read on request, because it counts non-conformances. Information only: nothing is re-rated, and a low rating beside a lot of non-conformances is
 * a prompt for the team to look again.
 */
const EvidenceCard = ({ revision, scale }) => {
  const [open, setOpen] = useState(false);
  const live = revision.status === "draft" || revision.status === "effective";
  const query = useOccurrenceEvidence(revision.id, { enabled: open && live });
  if (!live || revision.net.counts.failureModes === 0) return null;
  const data = query.data;

  return (
    <MenuCard
      title="What has actually happened?"
      subtitle="Failure modes tied to the non-conformance register, beside the non-conformances raised against them."
      action={
        <button type="button" className="text-sm font-medium text-brand-primary hover:underline" aria-expanded={open} aria-label={`${open ? "Hide" : "Show"} evidence`} onClick={() => setOpen((v) => !v)}>
          {open ? "Hide" : "Show"}
        </button>
      }
    >
      {open && (
        <div className="flex flex-col gap-3 p-4">
          {query.isLoading && <p className="text-sm text-secondary-text">Counting non-conformances…</p>}
          {query.error && <Callout tone="error">The evidence could not be worked out. Try again.</Callout>}
          {data && data.available === false && <Callout tone="info">{data.reason}</Callout>}
          {data && data.available && (
            <>
              <p className="text-sm text-secondary-text" aria-label="Evidence figures">
                {data.totals.tied} of {data.totals.failureModes} failure modes tied to the register · {data.totals.withNonConformances} with non-conformances
                {data.totals.toLookAt > 0 && <> · {data.totals.toLookAt} to look at again</>}
                {data.scoped ? " · counted on this FMEA's parts, families and machines" : " · counted across the whole register (this FMEA names no part, family or machine)"}
              </p>
              <ul className="flex flex-col gap-2" aria-label="Failure modes and what happened">
                {data.modes.map((m) => (
                  <li key={m.id} className="rounded-lg border border-border-color bg-secondary-bg px-3 py-2 text-sm">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-primary-text">
                          {m.text} <span className="ml-1 text-xs text-secondary-text">{m.itemName}</span>
                        </p>
                        <p className="text-xs text-secondary-text">
                          {m.tied && <>Register: {m.ncFailureModeName ?? "—"} · </>}
                          {evidenceCountWords(m, data.days)}
                          {m.tied && m.maxOccurrence != null && <> · highest occurrence rated {ratingWords(scale?.occurrence, m.maxOccurrence)}</>}
                        </p>
                      </div>
                      <Pill className={evidenceFlagPill(m.flag)}>{evidenceFlagLabel(m.flag)}</Pill>
                    </div>
                  </li>
                ))}
              </ul>

              <h4 className="mt-1 text-sm font-semibold text-primary-text">Not foreseen</h4>
              {data.notForeseen.available === false && <Callout tone="info">{data.notForeseen.reason}</Callout>}
              {data.notForeseen.available && (
                <>
                  {data.notForeseen.groups.length === 0 ? (
                    <p className="text-sm text-secondary-text">Every failure in the register that happened on this scope in the period is tied to a failure mode here.</p>
                  ) : (
                    <ul className="flex flex-col gap-2" aria-label="Failures nobody foresaw">
                      {data.notForeseen.groups.map((g) => (
                        <li key={g.ncFailureModeId} className="rounded-lg border border-border-color bg-secondary-bg px-3 py-2 text-sm">
                          <p className="text-primary-text">
                            {g.name} <span className="ml-1 text-xs text-secondary-text">{g.count} non-conformance{g.count === 1 ? "" : "s"}</span>
                          </p>
                          <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs">
                            {g.examples.map((n) => (
                              <li key={n.id}>
                                <Link to={ncrPath(n.id)} className="text-brand-primary hover:underline">
                                  {n.reference}
                                </Link>{" "}
                                <span className="text-secondary-text">{n.detectedOn}</span>
                              </li>
                            ))}
                          </ul>
                        </li>
                      ))}
                    </ul>
                  )}
                  {data.notForeseen.unclassified > 0 && (
                    <p className="text-xs text-secondary-text">
                      {data.notForeseen.unclassified} non-conformance{data.notForeseen.unclassified === 1 ? " has" : "s have"} no failure mode in the register, so they cannot be matched to this analysis.
                    </p>
                  )}
                </>
              )}
              <p className="text-xs text-secondary-text">Nothing is re-rated for you: a low occurrence beside many non-conformances is a prompt for the team to look again.</p>
            </>
          )}
        </div>
      )}
    </MenuCard>
  );
};

export default EvidenceCard;
