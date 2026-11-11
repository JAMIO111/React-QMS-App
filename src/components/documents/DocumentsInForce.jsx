import { Link } from "react-router-dom";
import { usePermissions } from "../../hooks/useQmsApi";
import { useDocumentsInForce } from "../../hooks/useDocuments";
import { formatDay, revisionPath } from "../../lib/documents";

/** The documents a list item names, read from the API row. */
const DocumentItem = ({ d }) => (
  <li className="flex flex-col gap-0.5 rounded-lg border border-border-color bg-primary-bg p-3">
    <div className="flex flex-wrap items-center gap-2">
      <Link to={revisionPath(d.id, d.revision.id)} className="font-medium text-link-color hover:underline">
        {d.number} rev {d.revision.letter} · {d.title}
      </Link>
      {d.toAcknowledge && <span className="rounded-full border border-warning-color px-2 py-0.5 text-xs text-warning-color">To read</span>}
    </div>
    <p className="text-xs text-secondary-text">
      {d.type} · for this {d.matched.join(", ")} · in force since {formatDay(d.revision.effectiveFrom)}
    </p>
  </li>
);

/** Just the list (for the job hub's side pane). */
export const DocumentsInForceList = ({ documents }) =>
  documents.length === 0 ? (
    <p className="text-sm text-secondary-text">No documents in force are linked to this part, family, machine or operation.</p>
  ) : (
    <ul aria-label="Documents in force" className="flex flex-col gap-2">
      {documents.map((d) => (
        <DocumentItem key={d.id} d={d} />
      ))}
    </ul>
  );

/**
 * The documents in force linked to what is being worked on (a part and its family, a part family, a machine, an operation), shown where the work happens.
 * Information only; shows nothing when there are none or the person may not read documents.
 */
const DocumentsInForce = ({ partId, partFamilyId, machineId, operationCode, className = "" }) => {
  const { can } = usePermissions();
  const docs = useDocumentsInForce({ partId, partFamilyId, machineId, operationCode }, { enabled: can("documentation.read") });
  const list = docs.data ?? [];
  if (list.length === 0) return null;
  const toRead = list.filter((d) => d.toAcknowledge).length;
  return (
    <section aria-label="Documents in force" className={`flex flex-col gap-2 rounded-2xl border border-border-color bg-secondary-bg p-4 ${className}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold text-primary-text">{list.length === 1 ? "1 document applies to this work" : `${list.length} documents apply to this work`}</h2>
        {toRead > 0 && <span className="text-sm text-warning-color">{toRead === 1 ? "1 is waiting for you to read" : `${toRead} are waiting for you to read`}</span>}
      </div>
      <DocumentsInForceList documents={list} />
    </section>
  );
};

export default DocumentsInForce;
