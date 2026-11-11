import { Link } from "react-router-dom";
import { FINDING_KIND_PILL, findingStatusLabel } from "../../lib/audits";
import { formatDate } from "../../lib/ncr";
import DownloadLink from "../ui/DownloadLink";

/**
 * The audit(s) a non-conformance was raised from: the audit record, the finding (with its classification and status), the answers behind it and the finding's evidence files.
 * A non-conformance raised straight from answers before findings existed shows the answers only.
 */
const NcrAuditSource = ({ source }) => (
  <div className="flex flex-col gap-4">
    {source.items.map((item) => (
      <div key={item.finding?.id ?? item.record.id} className="flex flex-col gap-2">
        <p className="text-sm text-primary-text">
          <Link to={`/Audits/Records/${item.record.id}`} className="font-medium text-link-color hover:underline">
            {item.record.reference}
          </Link>{" "}
          · {item.record.audit.reference} · {item.record.audit.title} · carried out {formatDate(item.record.performedOn)}
        </p>
        {item.finding && (
          <p className="flex flex-wrap items-center gap-2 text-sm text-primary-text">
            Finding
            <Link to={`/Audits/Findings/${item.finding.id}`} className="font-medium text-link-color hover:underline">
              {item.finding.reference}
            </Link>
            · {item.finding.title}
            <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${FINDING_KIND_PILL[item.finding.classification.kind]}`}>{item.finding.classification.label}</span>
            <span className="rounded-full bg-border-color px-2 py-0.5 text-xs text-secondary-text">{findingStatusLabel(item.finding.status)}</span>
          </p>
        )}
        {item.answers.length > 0 && (
          <ul aria-label={`Answers behind this NC from ${item.record.reference}`} className="flex flex-col gap-1 text-sm text-primary-text">
            {item.answers.map((a) => (
              <li key={a.sequence}>
                <span className="text-secondary-text">Question {a.sequence}:</span> {a.question}
                {a.note ? <span className="block text-secondary-text">{a.note}</span> : null}
              </li>
            ))}
          </ul>
        )}
        {item.files.length > 0 && (
          <ul aria-label="Evidence from the finding" className="flex flex-wrap gap-3 text-sm">
            {item.files.map((f) => (
              <li key={f.id}>
                <DownloadLink bucket="audit-files" file={{ id: f.id, path: f.storagePath, name: f.fileName }} />
              </li>
            ))}
          </ul>
        )}
      </div>
    ))}
  </div>
);

export default NcrAuditSource;
