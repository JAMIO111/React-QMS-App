import { Link, useParams } from "react-router-dom";
import { ArrowLeftIcon } from "@/components/icons";
import { useCapa, useCapaAttachments } from "../../hooks/useCapa";
import { ACTION_STATUS, FIVE_W2H, ROOT_CAUSE_KINDS, SOURCES, STEPS, roleLabel, stageOf } from "../../lib/capa";
import { formatDay } from "../../lib/qualityAlerts";
import { formatDateTime } from "../../lib/processControl";
import { buttonClass } from "../master-data/shared";

const Section = ({ code, title, children }) => (
  <section className="break-inside-avoid-page flex flex-col gap-2 border-t border-gray-300 pt-3" aria-label={`${code} ${title}`}>
    <h2 className="text-base font-semibold">{code} · {title}</h2>
    {children}
  </section>
);
const None = ({ children }) => <p className="text-sm italic text-gray-600">{children}</p>;

const Actions = ({ capa, phase, rootCauses }) => {
  const list = capa.actions.filter((a) => a.phase === phase);
  if (list.length === 0) return <None>None recorded.</None>;
  return (
    <table className="w-full text-left text-sm">
      <thead><tr className="border-b border-gray-300"><th className="py-1 pr-2">Action</th>{rootCauses && <th className="pr-2">Root cause</th>}<th className="pr-2">Owner</th><th className="pr-2">Due</th><th>Status</th></tr></thead>
      <tbody>
        {list.map((a) => (
          <tr key={a.id} className="border-b border-gray-200 align-top">
            <td className="py-1 pr-2">{a.description}{a.evidenceNote && <span className="block text-xs text-gray-600">Evidence: {a.evidenceNote}</span>}{a.cancelReason && <span className="block text-xs text-gray-600">Cancelled: {a.cancelReason}</span>}</td>
            {rootCauses && <td className="pr-2">{capa.rootCauses.find((c) => c.id === a.rootCauseId)?.description ?? ""}</td>}
            <td className="pr-2">{a.owner?.name ?? ""}</td>
            <td className="pr-2">{a.dueDate ? formatDay(a.dueDate) : ""}</td>
            <td>{ACTION_STATUS[a.status].label}{a.status === "done" && a.doneAt ? ` ${formatDay(a.doneAt.slice(0, 10))}` : ""}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
};

/**
 * The whole 8D as one printable document (`/CAPA/:id/report`). Print or "Save as PDF" from the browser: only the report is printed.
 */
const CapaReportPage = () => {
  const { id } = useParams();
  const query = useCapa(id);
  const files = useCapaAttachments(id);
  if (query.isLoading) return <p className="p-4 text-sm text-secondary-text">Loading…</p>;
  if (query.isError) return <p role="alert" className="p-4 text-sm text-error-color">Could not load this 8D.</p>;
  const capa = query.data;
  const live = capa.ncrs.filter((n) => !n.endedAt);
  const team = capa.team.filter((t) => !t.endedAt);
  const isNot = capa.analyses.filter((a) => a.kind === "is_is_not");
  const others = capa.analyses.filter((a) => a.kind !== "is_is_not");
  const stored = (files.data ?? []).filter((f) => !f.deletedAt);

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col gap-3 overflow-y-auto p-4">
      <style>{"@media print { body * { visibility: hidden !important; } #capa-report, #capa-report * { visibility: visible !important; } #capa-report { position: absolute; left: 0; top: 0; width: 100%; margin: 0; padding: 0; box-shadow: none; } }"}</style>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link to={`/CAPA/${capa.id}/d8`} className="flex w-fit items-center gap-1 text-sm text-link-color hover:underline"><ArrowLeftIcon className="h-4 w-4" /> Back to the 8D</Link>
        <button type="button" className={buttonClass.primary} onClick={() => window.print()}>Print or save as PDF</button>
      </div>

      <article id="capa-report" className="mx-auto flex w-full max-w-4xl flex-col gap-3 bg-white p-8 text-sm text-gray-900 shadow">
        <header className="flex flex-col gap-1">
          <p className="text-xs uppercase tracking-wide text-gray-600">8D report</p>
          <h1 className="text-2xl font-semibold">{capa.reference} · {capa.title}</h1>
          <p className="text-gray-700">
            {stageOf(capa.stage).label} · {SOURCES.find((s) => s.id === capa.source)?.name ?? capa.source}
            {capa.severity ? ` · ${capa.severity}` : ""}{capa.externalReference ? ` · Ref ${capa.externalReference}` : ""}
            {` · Owner: ${capa.owner?.name ?? "none"}`}{capa.dueDate ? ` · Due ${formatDay(capa.dueDate)}` : ""}
          </p>
          {live.length > 0 && <p className="text-gray-700">Non-conformances: {live.map((n) => n.reference ?? "not visible").join(", ")}</p>}
        </header>

        <Section code="D0" title="Initiate"><p className="whitespace-pre-wrap">{capa.problemStatement ?? "No problem statement."}</p></Section>

        <Section code="D1" title="Team">
          {team.length === 0 ? <None>No team yet.</None> : (
            <ul className="list-disc pl-5">{team.map((t) => <li key={t.id}>{t.name}{t.company ? `, ${t.company}` : ""} ({roleLabel(t.role)})</li>)}</ul>
          )}
        </Section>

        <Section code="D2" title="Describe the problem">
          <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1">
            {FIVE_W2H.map((q) => capa.problem[q.key] ? <div key={q.key} className="contents"><dt className="font-medium">{q.label}</dt><dd className="whitespace-pre-wrap">{capa.problem[q.key]}</dd></div> : null)}
          </dl>
          {isNot.map((a) => (
            <table key={a.id} className="mt-2 w-full text-left text-xs">
              <caption className="pb-1 text-left text-sm font-medium">{a.title}</caption>
              <thead><tr className="border-b border-gray-300"><th className="pr-2">Question</th><th className="pr-2">Is</th><th className="pr-2">Is not</th><th className="pr-2">Distinctive</th><th>Changes</th></tr></thead>
              <tbody>{a.data.rows.filter((r) => r.is || r.isNot || r.distinctive || r.changes).map((r) => <tr key={r.key} className="border-b border-gray-200 align-top"><td className="pr-2">{r.question}</td><td className="pr-2">{r.is}</td><td className="pr-2">{r.isNot}</td><td className="pr-2">{r.distinctive}</td><td>{r.changes}</td></tr>)}</tbody>
            </table>
          ))}
        </Section>

        <Section code="D3" title="Interim containment">
          <Actions capa={capa} phase="interim" />
          {capa.d3NoContainmentReason && <p>No containment needed: {capa.d3NoContainmentReason}</p>}
        </Section>

        <Section code="D4" title="Root cause">
          {capa.rootCauses.length === 0 ? <None>None recorded.</None> : (
            <ul className="flex flex-col gap-1">
              {capa.rootCauses.map((c) => (
                <li key={c.id}><span className="font-medium">{ROOT_CAUSE_KINDS[c.kind].label}:</span> {c.description}
                  <span className="block text-xs text-gray-600">{c.verified ? `Verified: ${c.verificationMethod}${c.verificationNote ? `, ${c.verificationNote}` : ""}` : "Not verified"}</span></li>
              ))}
            </ul>
          )}
          {others.length > 0 && <p className="text-xs text-gray-600">Analyses: {others.map((a) => a.title).join("; ")}</p>}
        </Section>

        <Section code="D5" title="Permanent corrective actions"><Actions capa={capa} phase="corrective" rootCauses /></Section>

        <Section code="D6" title="Implement and validate">
          {capa.verifications.length === 0 ? <None>Not verified yet.</None> : (
            <ul className="flex flex-col gap-1">
              {capa.verifications.map((v) => (
                <li key={v.id}><span className="font-medium">{v.effective ? "Effective" : "Not effective"}</span> · {v.method}{v.notes ? ` · ${v.notes}` : ""}
                  <span className="block text-xs text-gray-600">{v.verifiedBy?.name ?? "Someone"}, {formatDateTime(v.verifiedAt)}</span></li>
              ))}
            </ul>
          )}
        </Section>

        <Section code="D7" title="Prevent recurrence">
          <Actions capa={capa} phase="preventive" rootCauses />
          {capa.d7NoPreventiveReason && <p>No preventive action needed: {capa.d7NoPreventiveReason}</p>}
          {capa.d7LessonsLearned && <p className="whitespace-pre-wrap"><span className="font-medium">Lessons learned: </span>{capa.d7LessonsLearned}</p>}
        </Section>

        <Section code="D8" title="Close and recognise">
          {capa.stage === "closed" ? (
            <>
              <p>Closed by {capa.closedBy?.name ?? "someone"} on {formatDay(capa.closedAt.slice(0, 10))}.</p>
              {capa.d8Recognition && <p className="whitespace-pre-wrap">{capa.d8Recognition}</p>}
            </>
          ) : <None>Not closed yet ({stageOf(capa.stage).label.toLowerCase()}).</None>}
        </Section>

        {stored.length > 0 && (
          <Section code="" title="Evidence files"><ul className="list-disc pl-5">{stored.map((f) => <li key={f.id}>{f.fileName}</li>)}</ul></Section>
        )}

        <p className="border-t border-gray-300 pt-2 text-xs text-gray-600">Steps completed: {capa.steps.filter((s) => s.completed).length} of {STEPS.length}. Printed {formatDateTime(new Date().toISOString())}.</p>
      </article>
    </div>
  );
};

export default CapaReportPage;
