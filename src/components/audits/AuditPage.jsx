import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeftIcon, PencilIcon, PlayIcon } from "@/components/icons";
import { useToast } from "../../contexts/ToastProvider";
import { useAudit, useAuditMutation } from "../../hooks/useAudits";
import { usePermissions } from "../../hooks/useQmsApi";
import { formatDate } from "../../lib/ncr";
import { answerTypeLabel, auditTypeLabel, auditorLabel, frequencyLabel, questionRule, resultLabel } from "../../lib/audits";
import { ErrorNotice } from "../master-data/shared";
import MenuCard from "../ui/MenuCard";
import { VersionHistory } from "./AuditVersions";
import ReasonDialog from "../ncr/ReasonDialog";
import CTAButton from "@/components/CTAButton";

const Fact = ({ label, children }) => (
  <div className="flex min-w-0 flex-col gap-0.5">
    <dt className="text-xs font-medium text-secondary-text">{label}</dt>
    <dd className="text-sm text-primary-text">{children || "—"}</dd>
  </div>
);

/** One audit (/Audits/Templates/:id): its procedure, checklist, what it is relevant to, frequency and who is expected to do it. */
const AuditPage = () => {
  const { id } = useParams();
  const { can } = usePermissions();
  const canManage = can("audits.manage");
  const canPerform = can("audits.perform");
  const navigate = useNavigate();
  const query = useAudit(id);
  const mutation = useAuditMutation();
  const { showToast } = useToast();
  const [retiring, setRetiring] = useState(false);
  if (query.isLoading) return <p className="p-6 text-secondary-text">Loading…</p>;
  if (query.error || !query.data) return <div className="p-6"><ErrorNotice error={query.error ?? new Error("Not found")} /></div>;
  const a = query.data;
  const grouped = (kind) => a.targets.filter((t) => t.kind === kind);

  return (
    <div className="flex w-full min-w-0 flex-1 min-h-0 flex-col gap-4 overflow-auto bg-primary-bg p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-2">
          <Link to="/Audits/Templates" className="flex w-fit items-center gap-1 text-sm text-link-color hover:underline">
            <ArrowLeftIcon /> Audits
          </Link>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-xl font-semibold text-primary-text">
              {a.reference} · {a.title}
            </h1>
            {a.version && <span className="rounded-full bg-brand-primary/15 px-2 py-0.5 text-xs font-medium text-brand-primary">{`Version ${a.version}`}</span>}
            <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${a.status === "active" ? "bg-success-color/15 text-success-color" : "bg-border-color text-secondary-text"}`}>{a.status === "active" ? "Active" : "Retired"}</span>
          </div>
          {a.retired && (
            <p className="text-sm text-secondary-text">
              Retired {formatDate(a.retired.at)}{a.retired.by ? ` by ${a.retired.by.name}` : ""}: {a.retired.reason}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <CTAButton to={`/Audits/Records?audit=${a.id}`} type="neutral" size="md">
            Audit records
          </CTAButton>
          <CTAButton to={`/Audits/Schedule?audit=${a.id}`} type="neutral" size="md">
            Schedule
          </CTAButton>
          {canPerform && a.status === "active" && (
            <CTAButton
              buttonType="button"
              type="secondary" size="md"
              disabled={mutation.isPending} loading={mutation.isPending}
              onClick={() =>
                mutation.mutate(
                  { path: "/audit-records", body: { auditId: a.id } },
                  { onSuccess: (record) => { showToast({ type: "success", title: "Audit started", message: `${record.reference} is open.` }); navigate(`/Audits/Records/${record.id}`); } }
                )
              }>
              <PlayIcon className="mr-1 inline" aria-hidden="true" /> Start audit
            </CTAButton>
          )}
        </div>
        {canManage && (
          <div className="flex flex-wrap items-center gap-2">
            <CTAButton to={`/Audits/Templates/${a.id}/edit`} type="secondary" size="md">
              <PencilIcon className="mr-1 inline" aria-hidden="true" /> Edit
            </CTAButton>
            {a.status === "active" ? (
              <CTAButton buttonType="button" type="neutral" size="md" onClick={() => setRetiring(true)}>
                Retire
              </CTAButton>
            ) : (
              <CTAButton
                buttonType="button"
                type="neutral" size="md"
                disabled={mutation.isPending} loading={mutation.isPending}
                onClick={() =>
                  mutation.mutate({ path: `/audits/${a.id}/reactivate` }, { onSuccess: () => showToast({ type: "success", title: "Reactivated", message: `${a.reference} is active again.` }) })
                }>
                Reactivate
              </CTAButton>
            )}
          </div>
        )}
      </div>

      <MenuCard title="About this audit" subtitle="What it is for, how often, and who is expected to do it">
        <dl className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <Fact label="Type">{auditTypeLabel(a.auditType)}</Fact>
          <Fact label="Frequency">{frequencyLabel(a.frequency)}</Fact>
          <Fact label="First due">{a.frequency.firstDueOn ? formatDate(a.frequency.firstDueOn) : null}</Fact>
          <Fact label="Grace period">{a.frequency.kind === "on_demand" ? null : `${a.graceDays} ${a.graceDays === 1 ? "day" : "days"}${a.weekdaysOnly ? ", weekdays only" : ""}`}</Fact>
          <Fact label="Expected auditor">{auditorLabel(a.auditor)}</Fact>
          <Fact label="Pass mark">{`${a.passMark}% and every critical question`}</Fact>
          <Fact label="Questions">{`${a.questionCount} (${a.criticalCount} critical)`}</Fact>
          <Fact label="Last done">
            {a.lastRecord ? (
              <Link to={`/Audits/Records/${a.lastRecord.id}`} className="text-link-color hover:underline">
                {formatDate(a.lastRecord.performedOn)}: {resultLabel(a.lastRecord.result)}
              </Link>
            ) : (
              "Never"
            )}
          </Fact>
          <Fact label="Next due">{a.nextDueOn ? formatDate(a.nextDueOn) : null}</Fact>
          <Fact label="Defined by">{a.createdBy?.name}</Fact>
        </dl>
        {a.purpose && <p className="mt-4 whitespace-pre-wrap text-sm text-primary-text">{a.purpose}</p>}
      </MenuCard>

      <MenuCard title="Relevant to" subtitle="Whoever does the audit says which of these it was carried out on">
        {a.targets.length === 0 ? (
          <p className="text-sm text-secondary-text">Not tied to any machine, operation, department or supplier.</p>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
            {[["machine", "Machines"], ["operation", "Operations"], ["department", "Departments"], ["supplier", "Suppliers"]].map(([kind, title]) => (
              <div key={kind}>
                <h3 className="mb-1 text-sm font-medium text-primary-text">{title}</h3>
                {grouped(kind).length === 0 ? <p className="text-sm text-secondary-text">None</p> : <ul aria-label={title} className="flex flex-col gap-0.5 text-sm text-primary-text">{grouped(kind).map((t) => <li key={`${t.kind}-${t.id}`}>{t.label}</li>)}</ul>}
              </div>
            ))}
          </div>
        )}
      </MenuCard>

      <MenuCard title="Procedure" subtitle="The steps the auditor follows">
        {a.procedure ? <p className="whitespace-pre-wrap text-sm text-primary-text">{a.procedure}</p> : <p className="text-sm text-secondary-text">No procedure written.</p>}
      </MenuCard>

      <MenuCard title="Checklist" subtitle="Asked in this order. Each audit record keeps a copy of the questions as they were when it was done.">
        {a.questions.length === 0 ? (
          <p className="text-sm text-secondary-text">No questions yet.</p>
        ) : (
          <ol aria-label="Checklist" className="flex flex-col gap-3">
            {a.questions.map((q) => (
              <li key={q.id} className="flex flex-col gap-0.5 rounded-xl border border-border-color bg-primary-bg p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs tabular-nums text-secondary-text">{q.sequence}.</span>
                  <span className="text-sm font-medium text-primary-text">{q.question}</span>
                  {q.critical && <span className="rounded-full bg-error-color/15 px-2 py-0.5 text-xs font-medium text-error-color">Critical</span>}
                </div>
                <p className="text-xs text-secondary-text">
                  {answerTypeLabel(q.answerType)}; {questionRule(q)}
                </p>
                {q.guidance && <p className="text-sm text-primary-text">{q.guidance}</p>}
              </li>
            ))}
          </ol>
        )}
      </MenuCard>

      <VersionHistory audit={a} />

      {retiring && (
        <ReasonDialog
          title={`Retire ${a.reference}?`}
          label="Why is it being retired?"
          confirmText="Retire audit"
          pending={mutation.isPending}
          error={mutation.error}
          onClose={() => setRetiring(false)}
          onConfirm={(reason) => mutation.mutate({ path: `/audits/${a.id}/retire`, body: { reason } }, { onSuccess: () => { setRetiring(false); showToast({ type: "success", title: "Retired", message: `${a.reference} will no longer be scheduled.` }); } })}
        />
      )}
    </div>
  );
};

export default AuditPage;
