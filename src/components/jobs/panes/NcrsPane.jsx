import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ncrPath } from "../../../lib/ncr";
import { formatDate } from "../../../lib/processControl";
import { SeverityPill, StagePill } from "../../ncr/Pills";
import { Pager } from "./SidePanes";

const WHY = { part: "Same part", family: "Same part family", machine: "Same machine", operation: "Same operation" };

/** Recent non-conformances for the job's part, family, machine and operation: open ones first, one at a time with previous/next. */
const NcrsPane = ({ ncrs }) => {
  const [index, setIndex] = useState(0);
  const list = ncrs?.data ?? [];
  useEffect(() => {
    if (index >= list.length) setIndex(Math.max(0, list.length - 1));
  }, [list.length, index]);
  const n = list[index];
  if (!n) return <p className="text-sm text-secondary-text">No non-conformances for this part, family, machine or operation in the last {ncrs?.days ?? 90} days.</p>;

  return (
    <>
      <Pager index={index} count={list.length} onChange={setIndex} label="non-conformance" />
      <article aria-label={n.reference} className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <StagePill stage={n.stage} />
          <SeverityPill severity={n.severity} />
          {n.open && <span className="text-xs text-secondary-text">Still open</span>}
        </div>
        <h3 className="text-base font-semibold text-primary-text">
          {n.reference} · {n.title}
        </h3>
        <dl className="grid grid-cols-2 gap-2 text-sm">
          <div>
            <dt className="text-secondary-text">Detected</dt>
            <dd className="text-primary-text">{formatDate(n.detectedAt)}</dd>
          </div>
          <div>
            <dt className="text-secondary-text">Quantity affected</dt>
            <dd className="text-primary-text">{n.quantityAffected ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-secondary-text">Part</dt>
            <dd className="text-primary-text">{n.part?.partNumber ?? "—"}</dd>
          </div>
          {n.characteristics.length > 0 && (
            <div>
              <dt className="text-secondary-text">Failed check</dt>
              <dd className="text-primary-text">{n.characteristics.join(", ")}</dd>
            </div>
          )}
        </dl>
        <p className="text-xs text-secondary-text">Shown because: {n.matched.map((m) => WHY[m]).join(", ").toLowerCase()}.</p>
        <Link to={ncrPath(n.id)} target="_blank" rel="noopener noreferrer" className="text-sm text-link-color hover:underline">
          Open the non-conformance
        </Link>
      </article>
    </>
  );
};

export default NcrsPane;
