import { useState } from "react";
import { Link } from "react-router-dom";
import { useAudits, useAuditFindings, useAuditRecords } from "../../hooks/useAudits";
import { usePermissions } from "../../hooks/useQmsApi";
import { FINDING_KIND_PILL, FINDING_STATUS_PILL, RESULT_PILL, findingStatusLabel, recordStatusLabel, resultLabel } from "../../lib/audits";
import { formatDate, ncrPath } from "../../lib/ncr";
import CTAButton from "../CTAButton";
import MenuCard from "../ui/MenuCard";
import StartAuditDialog from "../audits/StartAuditDialog";
import { ErrorNotice } from "../master-data/shared";

const Pill = ({ tone, children }) => <span className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${tone ?? "bg-border-color text-secondary-text"}`}>{children}</span>;

/**
 * The supplier's Audits tab: the audits that list this supplier as something they are relevant to (with when each was last done and when it is next due), the records carried out on
 * this supplier, and the findings from them with the non-conformance each became. Starting an audit from here carries it out on this supplier.
 */
export default function SupplierAudits({ supplier }) {
  const { can } = usePermissions();
  const [starting, setStarting] = useState(false);
  const audits = useAudits({ supplierId: supplier.id, status: "active", sort: "title", pageSize: 50 });
  const records = useAuditRecords({ supplierId: supplier.id, sort: "performedOn", order: "desc", pageSize: 25 });
  const findings = useAuditFindings({ supplierId: supplier.id, pageSize: 50, sort: "createdAt", order: "desc" });
  const auditRows = audits.data?.data ?? [];
  const recordRows = records.data?.data ?? [];
  const findingRows = findings.data?.data ?? [];

  return (
    <div className="flex flex-col gap-4">
      <MenuCard
        title="Audits of this supplier"
        subtitle="Active audits that list this supplier. An audit is added to a supplier under “Relevant to” on the audit."
        action={can("audits.perform") && <CTAButton type="main" size="default" onClick={() => setStarting(true)}>Start an audit</CTAButton>}>
        {audits.error && <ErrorNotice error={audits.error} />}
        {audits.isLoading ? null : auditRows.length === 0 ? <p className="text-sm text-secondary-text">No active audit lists this supplier.</p> : (
          <table className="w-full text-left text-sm" aria-label="Audits of this supplier">
            <thead><tr className="text-secondary-text"><th className="py-1 pr-3 font-medium">Audit</th><th className="py-1 pr-3 font-medium">Last done</th><th className="py-1 font-medium">Next due</th></tr></thead>
            <tbody>
              {auditRows.map((a) => (
                <tr key={a.id} className="border-t border-border-color">
                  <td className="py-1.5 pr-3"><Link to={`/Audits/Templates/${a.id}`} className="text-link-color hover:underline">{a.reference} · {a.title}</Link></td>
                  <td className="py-1.5 pr-3 text-primary-text">{a.lastRecord ? <span className="inline-flex items-center gap-2">{formatDate(a.lastRecord.performedOn)} <Pill tone={RESULT_PILL[a.lastRecord.result]}>{resultLabel(a.lastRecord.result)}</Pill></span> : <span className="text-secondary-text">Never</span>}</td>
                  <td className="py-1.5 text-primary-text">{a.nextDueOn ? formatDate(a.nextDueOn) : <span className="text-secondary-text">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </MenuCard>

      <MenuCard title="Audit records" subtitle="Audits carried out on this supplier, newest first.">
        {records.error && <ErrorNotice error={records.error} />}
        {records.isLoading ? null : recordRows.length === 0 ? <p className="text-sm text-secondary-text">No audit has been carried out on this supplier yet.</p> : (
          <table className="w-full text-left text-sm" aria-label="Audit records of this supplier">
            <thead><tr className="text-secondary-text"><th className="py-1 pr-3 font-medium">Record</th><th className="py-1 pr-3 font-medium">Audit</th><th className="py-1 pr-3 font-medium">Date</th><th className="py-1 pr-3 font-medium">Status</th><th className="py-1 font-medium">Result</th></tr></thead>
            <tbody>
              {recordRows.map((r) => (
                <tr key={r.id} className="border-t border-border-color">
                  <td className="py-1.5 pr-3"><Link to={`/Audits/Records/${r.id}`} className="text-link-color hover:underline">{r.reference}</Link></td>
                  <td className="py-1.5 pr-3 text-primary-text">{r.audit.title}{r.version ? <span className="text-secondary-text"> · v{r.version}</span> : null}</td>
                  <td className="py-1.5 pr-3 text-secondary-text">{formatDate(r.performedOn)}</td>
                  <td className="py-1.5 pr-3 text-secondary-text">{recordStatusLabel(r.status)}</td>
                  <td className="py-1.5">{r.result ? <Pill tone={RESULT_PILL[r.result]}>{resultLabel(r.result)}{r.score !== null ? ` · ${Math.round(r.score)}%` : ""}</Pill> : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </MenuCard>

      <MenuCard title="Findings" subtitle="What these audits found, and the non-conformance each one became.">
        {findings.error && <ErrorNotice error={findings.error} />}
        {findings.isLoading ? null : findingRows.length === 0 ? <p className="text-sm text-secondary-text">No findings from audits of this supplier.</p> : (
          <table className="w-full text-left text-sm" aria-label="Findings from audits of this supplier">
            <thead><tr className="text-secondary-text"><th className="py-1 pr-3 font-medium">Finding</th><th className="py-1 pr-3 font-medium">Classification</th><th className="py-1 pr-3 font-medium">Due</th><th className="py-1 pr-3 font-medium">Status</th><th className="py-1 font-medium">Non-conformance</th></tr></thead>
            <tbody>
              {findingRows.map((f) => (
                <tr key={f.id} className="border-t border-border-color">
                  <td className="py-1.5 pr-3"><Link to={`/Audits/Findings/${f.id}`} className="text-link-color hover:underline">{f.reference}</Link><span className="block text-xs text-secondary-text">{f.title}</span></td>
                  <td className="py-1.5 pr-3"><Pill tone={FINDING_KIND_PILL[f.classification.kind]}>{f.classification.label}</Pill></td>
                  <td className="py-1.5 pr-3 text-secondary-text">{f.dueOn ? formatDate(f.dueOn) : "—"}{f.overdue ? <span className="ml-1 text-error-color">overdue</span> : null}</td>
                  <td className="py-1.5 pr-3"><Pill tone={FINDING_STATUS_PILL[f.status]}>{findingStatusLabel(f.status)}</Pill></td>
                  <td className="py-1.5">{f.ncr ? <Link to={ncrPath(f.ncr.id)} className="text-link-color hover:underline">{f.ncr.reference}</Link> : <span className="text-secondary-text">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </MenuCard>
      {starting && <StartAuditDialog supplier={supplier} onClose={() => setStarting(false)} />}
    </div>
  );
}
