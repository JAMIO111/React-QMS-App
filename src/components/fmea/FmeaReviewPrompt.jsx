import { Link } from "react-router-dom";
import { usePermissions } from "../../hooks/useQmsApi";
import { useLinkedFmeas } from "../../hooks/useFmea";
import { fmeaPath, formatDay, kindLabel } from "../../lib/fmea";
import { ErrorNotice } from "../master-data/shared";
import MenuCard from "../ui/MenuCard";

const SCOPE_WORDS = { part: "a part it concerns", part_family: "the family of a part it concerns", machine: "a machine it concerns" };
const scopeWords = (via = []) => via.map((v) => SCOPE_WORDS[v] ?? v).join(" and ");

/**
 * "Was the FMEA reviewed?" on the prevention step of an 8D (plan FM13): the FMEAs in force that cover the parts and machines of the non-conformances the 8D is about, so the team
 * can check whether the analysis foresaw this failure and rated it right, and start a new revision when it did not. A prompt only: it never blocks the step. Shown to people
 * who may read FMEAs.
 */
const FmeaReviewPrompt = ({ capaId }) => {
  const { can } = usePermissions();
  const readable = can("fmea.read");
  const query = useLinkedFmeas("capa_scope", capaId, { enabled: readable });
  if (!readable || !capaId) return null;
  const list = Array.isArray(query.data?.data) ? query.data.data : [];
  return (
    <MenuCard title="Was the FMEA reviewed?" subtitle="Did the analysis foresee this failure, and was it rated high enough? If not, the FMEA should change.">
      {query.isLoading ? (
        <p className="text-sm text-secondary-text">Loading…</p>
      ) : query.error ? (
        <ErrorNotice error={query.error} />
      ) : list.length === 0 ? (
        <p className="text-sm text-secondary-text">No FMEA in force covers the parts or machines of this 8D&apos;s non-conformances.</p>
      ) : (
        <ul aria-label="FMEAs that cover this 8D" className="-my-2 divide-y divide-border-color">
          {list.map((f) => (
            <li key={f.id} className="flex flex-col gap-0.5 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <Link to={fmeaPath(f.id)} className="text-sm font-medium text-link-color hover:underline">
                  {f.number} rev {f.letter ?? "—"} · {f.title}
                </Link>
                {f.reviewOverdue && <span className="rounded-full border border-warning-color px-2 py-0.5 text-xs text-warning-color">Review overdue</span>}
              </div>
              <p className="text-xs text-secondary-text">
                {kindLabel(f.kind)} FMEA · covers {scopeWords(f.via)}
                {f.nextReviewOn ? ` · next review ${formatDay(f.nextReviewOn)}` : ""}
              </p>
            </li>
          ))}
        </ul>
      )}
    </MenuCard>
  );
};

export default FmeaReviewPrompt;
