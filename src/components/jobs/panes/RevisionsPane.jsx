import { useEffect, useState } from "react";
import { formatDate } from "../../../lib/processControl";
import { revisionLabel } from "../../../lib/partRevisions";
import { Pager } from "./SidePanes";

const KIND = { part_revision: "Part revision", plan_revision: "Control plan revision" };

/** Recently released part revisions and recently effective control plan revisions for the job's part, New ones flagged, one at a time. */
const RevisionsPane = ({ revisions }) => {
  const [index, setIndex] = useState(0);
  const list = revisions?.data ?? [];
  useEffect(() => {
    if (index >= list.length) setIndex(Math.max(0, list.length - 1));
  }, [list.length, index]);
  const r = list[index];
  if (!r) return <p className="text-sm text-secondary-text">No revisions of this part or its control plan in the last {revisions?.days ?? 30} days.</p>;

  return (
    <>
      <Pager index={index} count={list.length} onChange={setIndex} label="revision" />
      <article aria-label={`${r.subject} rev ${revisionLabel(r)}`} className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {r.isNew && <span className="rounded-full bg-error-color px-2 py-0.5 text-xs font-semibold text-white">New</span>}
          <span className="text-xs text-secondary-text">{KIND[r.kind]}</span>
          <span className={`rounded-full px-2 py-0.5 text-xs ${r.current ? "bg-success-color/15 text-success-color" : "bg-primary-text/10 text-secondary-text"}`}>{r.current ? "In force" : "Replaced"}</span>
        </div>
        <h3 className="text-base font-semibold text-primary-text">
          {r.subject} · rev {revisionLabel(r)}
        </h3>
        <p className="text-sm text-primary-text">{r.changeSummary ?? "No change summary was given."}</p>
        <p className="text-xs text-secondary-text">
          {r.kind === "part_revision" ? "Released" : "In force from"} {formatDate(r.at)}
          {r.by ? ` by ${r.by}` : ""}
        </p>
        {r.runningOnIt ? <p className="text-sm text-primary-text">This job is running on this revision.</p> : r.current ? <p className="rounded-lg border border-warning-color bg-warning-color/15 p-2 text-sm text-primary-text">This job started on an earlier revision.</p> : null}
      </article>
    </>
  );
};

export default RevisionsPane;
