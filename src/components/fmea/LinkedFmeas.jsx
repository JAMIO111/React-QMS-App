import { Link } from "react-router-dom";
import { usePermissions } from "../../hooks/useQmsApi";
import { useLinkedFmeas } from "../../hooks/useFmea";
import { FMEA_THING, fmeaPath, viaWords } from "../../lib/fmea";
import { formatDay } from "../../lib/documents";

/**
 * The FMEAs in force that cover this part, part family, machine or control plan, shown where the work happens (plan FM16). Information only: it never blocks anything. A part or a
 * plan that no FMEA covers says so quietly (`showWhenNone`), a review that is overdue is flagged, and nothing shows to someone who may not read FMEAs.
 */
const LinkedFmeas = ({ kind, id, showWhenNone = false, className = "" }) => {
  const { can } = usePermissions();
  const query = useLinkedFmeas(kind, id, { enabled: can("fmea.read") });
  if (!can("fmea.read") || !Array.isArray(query.data?.data)) return null;
  const { data, canRaise } = query.data;
  const thing = FMEA_THING[kind];

  if (data.length === 0) {
    if (!showWhenNone) return null;
    return (
      <section aria-label="FMEA" className={`flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-border-color bg-secondary-bg px-4 py-3 text-sm ${className}`}>
        <p className="text-secondary-text">No FMEA in force covers this {thing}.</p>
        {canRaise && (
          <Link to="/FMEA" className="font-medium text-link-color hover:underline">
            Go to FMEAs
          </Link>
        )}
      </section>
    );
  }

  const overdue = data.filter((f) => f.reviewOverdue).length;
  return (
    <section aria-label="FMEA" className={`flex flex-col gap-2 rounded-2xl border border-border-color bg-secondary-bg p-4 ${className}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold text-primary-text">{data.length === 1 ? "1 FMEA covers this" : `${data.length} FMEAs cover this`} {thing}</h2>
        {overdue > 0 && <span className="text-sm text-warning-color">{overdue === 1 ? "Its review is overdue" : `${overdue} reviews are overdue`}</span>}
      </div>
      <ul aria-label="FMEAs in force" className="flex flex-col gap-2">
        {data.map((f) => (
          <li key={f.id} className="flex flex-col gap-0.5 rounded-lg border border-border-color bg-primary-bg p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Link to={fmeaPath(f.id)} className="font-medium text-link-color hover:underline">
                {f.number} rev {f.letter ?? "—"} · {f.title}
              </Link>
              {f.reviewOverdue && <span className="rounded-full border border-warning-color px-2 py-0.5 text-xs text-warning-color">Review overdue</span>}
            </div>
            <p className="text-xs text-secondary-text">
              {f.kind === "design" ? "Design" : "Process"} FMEA · covers {viaWords(f.via)}
              {f.nextReviewOn ? ` · next review ${formatDay(f.nextReviewOn)}` : ""}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
};

export default LinkedFmeas;
