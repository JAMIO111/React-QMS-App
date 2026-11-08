import { useState } from "react";
import { Link } from "react-router-dom";
import { HistoryIcon } from "@/components/icons";
import { useAuditVersion, useAuditVersions } from "../../hooks/useAudits";
import { formatDateTime } from "../../lib/processControl";
import { HEADER_FIELD_LABELS, QUESTION_FIELD_LABELS, answerTypeLabel, auditTypeLabel, questionFieldText, questionRule, recordStatusLabel, resultLabel } from "../../lib/audits";
import Dialog from "../ui/Dialog";
import MenuCard from "../ui/MenuCard";
import { ErrorNotice } from "../master-data/shared";

const Pill = ({ children, tone = "bg-brand-primary/15 text-brand-primary" }) => <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}>{children}</span>;

/** A header value for "before → after": long text is only said to have changed. */
const headerText = (field, v) => (v === null || v === undefined || v === "" ? "none" : field === "auditType" ? auditTypeLabel(v) : field === "passMark" ? `${v}%` : String(v));

/** What a version changed from the one before: header fields, questions added, removed, changed and moved, and what the audit became relevant to. */
const Changes = ({ changes, previous }) => {
  const empty =
    !changes.header.length && !changes.questions.added.length && !changes.questions.removed.length && !changes.questions.changed.length && !changes.questions.moved.length &&
    !changes.targets.added.length && !changes.targets.removed.length;
  return (
    <section aria-label={`Changes from version ${previous}`} className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold text-primary-text">{`What changed from version ${previous}`}</h3>
      {empty ? (
        <p className="text-sm text-secondary-text">Nothing that the audit says changed.</p>
      ) : (
        <ul className="flex flex-col gap-1 text-sm text-primary-text">
          {changes.header.map((h) =>
            h.field === "procedure" || h.field === "purpose" ? (
              <li key={h.field}>{HEADER_FIELD_LABELS[h.field]} changed.</li>
            ) : (
              <li key={h.field}>
                {HEADER_FIELD_LABELS[h.field]}: <span className="text-secondary-text line-through">{headerText(h.field, h.before)}</span> → <span className="font-medium">{headerText(h.field, h.after)}</span>
              </li>
            ),
          )}
          {changes.questions.added.map((q) => (
            <li key={`a${q.sequence}`}>
              <Pill tone="bg-success-color/15 text-success-color">Added</Pill> question {q.sequence}: “{q.question}”
            </li>
          ))}
          {changes.questions.removed.map((q) => (
            <li key={`r${q.sequence}`}>
              <Pill tone="bg-error-color/15 text-error-color">Removed</Pill> “{q.question}”
            </li>
          ))}
          {changes.questions.changed.map((c) => (
            <li key={`c${c.after.sequence}`}>
              <Pill tone="bg-warning-color/20 text-primary-text">Changed</Pill> question {c.after.sequence}, “{c.after.question}”:{" "}
              {c.fields.map((f, i) => (
                <span key={f}>
                  {i > 0 && "; "}
                  {QUESTION_FIELD_LABELS[f]} <span className="text-secondary-text line-through">{questionFieldText(f, c.before)}</span> → <span className="font-medium">{questionFieldText(f, c.after)}</span>
                </span>
              ))}
            </li>
          ))}
          {changes.questions.moved.map((m) => (
            <li key={`m${m.to}`}>
              <Pill tone="bg-border-color text-secondary-text">Moved</Pill> “{m.question}” from {m.from} to {m.to}
            </li>
          ))}
          {changes.targets.added.map((t) => (
            <li key={`ta${t.kind}${t.label}`}>
              <Pill tone="bg-success-color/15 text-success-color">Now relevant to</Pill> {t.label}
            </li>
          ))}
          {changes.targets.removed.map((t) => (
            <li key={`tr${t.kind}${t.label}`}>
              <Pill tone="bg-error-color/15 text-error-color">No longer relevant to</Pill> {t.label}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};

/** One version of an audit, whole, with the comparison with the one before and the records done against it. */
export const VersionDialog = ({ audit, version, onClose }) => {
  const query = useAuditVersion(audit.id, version);
  const v = query.data;
  return (
    <Dialog title={`${audit.reference} · version ${version}`} onClose={onClose} width="max-w-3xl">
      {query.isLoading && <p className="text-sm text-secondary-text">Loading…</p>}
      {query.error && <ErrorNotice error={query.error} />}
      {v && (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-primary-text">
            Saved {formatDateTime(v.createdAt)}
            {v.createdBy ? ` by ${v.createdBy.name}` : ""} {v.current && <Pill>Current</Pill>}
          </p>
          <p className="rounded-lg border border-border-color bg-primary-bg p-3 text-sm text-primary-text">
            <span className="block text-xs font-medium text-secondary-text">Why it changed</span>
            {v.reason}
          </p>
          {v.changes && <Changes changes={v.changes} previous={version - 1} />}
          <section aria-label={`The audit in version ${version}`} className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold text-primary-text">The audit in this version</h3>
            <dl className="grid grid-cols-2 gap-3 md:grid-cols-3">
              <div><dt className="text-xs font-medium text-secondary-text">Title</dt><dd className="text-sm text-primary-text">{v.title}</dd></div>
              <div><dt className="text-xs font-medium text-secondary-text">Type</dt><dd className="text-sm text-primary-text">{auditTypeLabel(v.auditType)}</dd></div>
              <div><dt className="text-xs font-medium text-secondary-text">Pass mark</dt><dd className="text-sm text-primary-text">{`${v.passMark}% and every critical question`}</dd></div>
            </dl>
            {v.purpose && <p className="whitespace-pre-wrap text-sm text-primary-text">{v.purpose}</p>}
            {v.procedure && <p className="whitespace-pre-wrap rounded-lg bg-primary-bg p-2 text-sm text-primary-text">{v.procedure}</p>}
            <h4 className="mt-1 text-xs font-medium text-secondary-text">Relevant to</h4>
            {v.targets.length === 0 ? <p className="text-sm text-secondary-text">Not tied to any machine, operation or department.</p> : <p className="text-sm text-primary-text">{v.targets.map((t) => t.label).join(", ")}</p>}
            <h4 className="mt-1 text-xs font-medium text-secondary-text">Checklist</h4>
            {v.questions.length === 0 ? (
              <p className="text-sm text-secondary-text">No questions.</p>
            ) : (
              <ol aria-label={`Checklist of version ${version}`} className="flex flex-col gap-1">
                {v.questions.map((q) => (
                  <li key={q.sequence} className="text-sm text-primary-text">
                    <span className="tabular-nums text-secondary-text">{q.sequence}.</span> {q.question} {q.critical && <Pill tone="bg-error-color/15 text-error-color">Critical</Pill>}
                    <span className="block pl-5 text-xs text-secondary-text">{answerTypeLabel(q.answerType)}; {questionRule(q)}</span>
                  </li>
                ))}
              </ol>
            )}
          </section>
          <section aria-label="Records done against this version" className="flex flex-col gap-1">
            <h3 className="text-sm font-semibold text-primary-text">{`Records done against version ${version}`}</h3>
            {v.recordCount === 0 ? (
              <p className="text-sm text-secondary-text">None.</p>
            ) : (
              <ul className="flex flex-col gap-0.5 text-sm text-primary-text">
                {v.records.map((r) => (
                  <li key={r.id}>
                    <Link to={`/Documentation/Audit-Records/${r.id}`} className="text-link-color hover:underline">{r.reference}</Link> · {r.status === "completed" ? resultLabel(r.result) : recordStatusLabel(r.status)}
                  </li>
                ))}
                {v.recordCount > v.records.length && <li className="text-secondary-text">and {v.recordCount - v.records.length} more</li>}
              </ul>
            )}
          </section>
        </div>
      )}
    </Dialog>
  );
};

/** The history of an audit: each version with its reason, who and when, what changed and how many records were done against it. */
export const VersionHistory = ({ audit }) => {
  const query = useAuditVersions(audit.id);
  const [open, setOpen] = useState(null);
  const versions = query.data ?? [];
  return (
    <MenuCard title="Version history" subtitle="Every change to what the audit says is a new version with a reason. Records keep the version they were done against.">
      {query.isLoading && <p className="text-sm text-secondary-text">Loading…</p>}
      {query.error && <ErrorNotice error={query.error} />}
      {query.data && versions.length === 0 && <p className="text-sm text-secondary-text">No versions yet: one is made the first time the audit is changed or carried out.</p>}
      {versions.length > 0 && (
        <div className="overflow-x-auto">
          <table aria-label="Versions" className="w-full text-sm">
            <thead className="text-left text-secondary-text">
              <tr>
                <th className="py-1 pr-3 font-medium">Version</th>
                <th className="py-1 pr-3 font-medium">Saved</th>
                <th className="py-1 pr-3 font-medium">Reason</th>
                <th className="py-1 pr-3 font-medium">What changed</th>
                <th className="py-1 pr-3 text-right font-medium">Records</th>
                <th className="py-1 font-medium"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody className="text-primary-text">
              {versions.map((v) => (
                <tr key={v.version} className="border-t border-border-color align-top">
                  <td className="py-1.5 pr-3 font-medium">
                    {v.version} {v.current && <Pill>Current</Pill>}
                  </td>
                  <td className="py-1.5 pr-3 whitespace-nowrap">
                    {formatDateTime(v.createdAt)}
                    <span className="block text-xs text-secondary-text">{v.createdBy?.name ?? "Unknown user"}</span>
                  </td>
                  <td className="py-1.5 pr-3">{v.reason}</td>
                  <td className="py-1.5 pr-3 text-secondary-text">{v.summary.length ? v.summary.join("; ") : v.version === 1 ? "" : "—"}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">
                    {v.recordCount ? (
                      <Link to={`/Documentation/Audit-Records?audit=${audit.id}&version=${v.version}`} className="text-link-color hover:underline">{v.recordCount}</Link>
                    ) : (
                      0
                    )}
                  </td>
                  <td className="py-1.5 text-right">
                    <button type="button" aria-label={`View version ${v.version}`} className="inline-flex items-center gap-1 text-link-color hover:underline cursor-pointer" onClick={() => setOpen(v.version)}>
                      <HistoryIcon className="h-3.5 w-3.5" /> View
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {open && <VersionDialog audit={audit} version={open} onClose={() => setOpen(null)} />}
    </MenuCard>
  );
};
