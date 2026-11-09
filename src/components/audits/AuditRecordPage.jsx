import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeftIcon, CircleCheckIcon, TriangleAlertIcon } from "@/components/icons";
import { useToast } from "../../contexts/ToastProvider";
import { useAnswerAudit, useAuditAttachments, useAuditMutation, useAuditRecord, useRecordFindings, useSetAuditTargets } from "../../hooks/useAudits";
import { usePermissions } from "../../hooks/useQmsApi";
import { formatDate, ncrPath } from "../../lib/ncr";
import { answerTypeLabel, auditTypeLabel, FINDING_KIND_PILL, FINDING_STATUS_PILL, findingStatusLabel, formatScore, questionRule, RESULT_PILL, recordStatusLabel, resultLabel, STATUS_PILL, targetKey } from "../../lib/audits";
import ReasonDialog from "../ncr/ReasonDialog";
import ComboField from "../ui/ComboField";
import { AttachmentDrop } from "../ui/FileDrop";
import Dialog from "../ui/Dialog";
import MenuCard from "../ui/MenuCard";
import RHFDatePickerPopout from "../ui/RHFDatePickerPopout";
import { ErrorNotice, FormError, TextAreaField } from "../master-data/shared";
import FindingDialog from "./FindingDialog";
import CTAButton from "@/components/CTAButton";
import Callout from "../ui/Callout";

const today = () => new Date().toISOString().slice(0, 10);

const Fact = ({ label, children }) => (
  <div className="flex min-w-0 flex-col gap-0.5">
    <dt className="text-xs font-medium text-secondary-text">{label}</dt>
    <dd className="text-sm text-primary-text">{children || "—"}</dd>
  </div>
);

const TONE = {
  pass: "border-success-color bg-success-color/15 text-success-color",
  fail: "border-error-color bg-error-color/15 text-error-color",
  yes: "border-success-color bg-success-color/15 text-success-color",
  no: "border-error-color bg-error-color/15 text-error-color",
  compliant: "border-success-color bg-success-color/15 text-success-color",
  non_compliant: "border-error-color bg-error-color/15 text-error-color",
  na: "border-border-dark-color bg-border-color text-primary-text",
};
const SELECTED = "border-brand-primary bg-brand-primary/15 text-primary-text";

/** A small set of exclusive buttons (a radio group): pass / fail, yes / no, compliant / non-compliant, or the numbers of a rating scale. */
const Choice = ({ label, options, value, onChange, disabled }) => (
  <div role="radiogroup" aria-label={label} className="inline-flex flex-wrap gap-1">
    {options.map((o) => {
      const on = value === o.value;
      return (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={on}
          disabled={disabled}
          onClick={() => onChange(on ? null : o.value)}
          className={`rounded-lg border px-3 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-60 ${on ? (TONE[o.value] ?? SELECTED) : "border-border-color bg-text-input-color text-primary-text hover:border-border-dark-color"} ${disabled ? "" : "cursor-pointer"}`}>
          {o.label}
        </button>
      );
    })}
  </div>
);

/** The buttons each type of question shows (the answer's value and its words). */
const BUTTONS = {
  yes_no: [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }],
  yes_no_na: [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }, { value: "na", label: "N/A" }],
  compliant: [{ value: "compliant", label: "Compliant" }, { value: "non_compliant", label: "Non-compliant" }],
  pass_fail: [{ value: "pass", label: "Pass" }, { value: "fail", label: "Fail" }],
};

const inputClass =
  "h-9.5 w-40 rounded-lg border border-border-color bg-text-input-color px-3 py-2 text-sm text-primary-text hover:border-border-dark-color focus:border-brand-primary focus:outline-none disabled:opacity-60";

/** The photographs and documents that answer an evidence question. */
const Evidence = ({ recordId, q, editable }) => {
  const attachments = useAuditAttachments(recordId, q.id);
  const mutation = useAuditMutation();
  return (
    <AttachmentDrop
      recordId={recordId}
      bucket="audit-files"
      folder="audit"
      attachments={attachments}
      mutation={mutation}
      attachUrl={`/audit-records/${recordId}/attachments`}
      extraBody={{ questionId: q.id }}
      itemBase="/audit-attachments"
      title="Photographs and documents"
      subtitle={editable ? "At least one is needed to complete the audit." : undefined}
      canEdit={editable}
    />
  );
};

/** One question, with the control its type asks for, what was found, the files, and the non-conformances raised from it. */
const Question = ({ q, recordId, editable, save, canFinding, onFinding }) => {
  const r = q.response;
  const [value, setValue] = useState(r?.value ?? "");
  const [note, setNote] = useState(r?.note ?? "");
  const [seen, setSeen] = useState({ id: r?.id, value: r?.value, note: r?.note });
  // The answer on screen follows the server's (a refetch, or another person's change).
  if (seen.id !== r?.id || seen.value !== r?.value || seen.note !== r?.note) {
    setSeen({ id: r?.id, value: r?.value, note: r?.note });
    setValue(r?.value ?? "");
    setNote(r?.note ?? "");
  }
  const send = (patch) => save({ questionId: q.id, answer: r?.answer ?? null, value: r?.value ?? null, choice: r?.choice ?? null, note: r?.note ?? null, ...patch });
  const t = q.answerType;
  const failed = r?.result === "fail";
  const aria = `Answer to question ${q.sequence}`;
  const buttons = BUTTONS[t];
  const scaleOptions = t === "rating" ? Array.from({ length: q.ratingMax }, (_, i) => ({ value: String(i + 1), label: String(i + 1) })) : [];

  return (
    <li className={`flex flex-col gap-3 rounded-xl border bg-primary-bg p-3 ${failed ? "border-error-color/60" : "border-border-color"}`} aria-label={`Question ${q.sequence}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs tabular-nums text-secondary-text">{q.sequence}.</span>
        <span className="text-sm font-medium text-primary-text">{q.question}</span>
        {q.critical && <span className="rounded-full bg-error-color/15 px-2 py-0.5 text-xs font-medium text-error-color">Critical</span>}
        {r?.result && r.result !== "na" && <span className={`ml-auto rounded-full px-2 py-0.5 text-xs font-medium ${RESULT_PILL[r.result]}`}>{resultLabel(r.result)}</span>}
        {r?.result === "na" && <span className="ml-auto rounded-full bg-border-color px-2 py-0.5 text-xs font-medium text-secondary-text">Not applicable</span>}
      </div>
      {q.guidance && <p className="text-sm text-secondary-text">{q.guidance}</p>}
      <p className="text-xs text-secondary-text">
        {answerTypeLabel(t)}; {questionRule(q)}
      </p>

      {buttons && <Choice label={aria} options={buttons} value={r?.answer ?? null} disabled={!editable} onChange={(answer) => send({ answer, note: answer ? (r?.note ?? null) : null })} />}
      {(t === "numeric" || t === "measurement") && (
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="number"
            step="any"
            aria-label={aria}
            className={inputClass}
            value={value}
            disabled={!editable}
            onChange={(e) => setValue(e.target.value)}
            onBlur={() => {
              const n = value === "" ? null : Number(value);
              if (n !== (r?.value ?? null)) send({ answer: null, value: n, note: n == null ? null : (r?.note ?? null) });
            }}
          />
          {q.unit && <span className="text-sm text-secondary-text">{q.unit}</span>}
        </div>
      )}
      {t === "multiple_choice" && (
        <ComboField
          label={aria}
          value={r?.choice ?? null}
          disabled={!editable}
          options={(q.options ?? []).map((o) => ({ value: o.label, label: o.label }))}
          placeholder="Choose one"
          onChange={(choice) => send({ answer: null, value: null, choice, note: choice ? (r?.note ?? null) : null })}
          className="max-w-sm"
        />
      )}
      {t === "rating" && (
        <Choice label={aria} options={scaleOptions} value={r?.value == null ? null : String(r.value)} disabled={!editable} onChange={(v) => send({ answer: null, value: v == null ? null : Number(v), note: v == null ? null : (r?.note ?? null) })} />
      )}
      {t === "text" && (
        <TextAreaField
          label={`Note for question ${q.sequence}`}
          rows={2}
          value={note}
          disabled={!editable}
          maxLength={2000}
          onChange={(e) => setNote(e.target.value)}
          onBlur={() => {
            if (note.trim() !== (r?.note ?? "")) send({ answer: null, value: null, choice: null, note: note.trim() || null });
          }}
        />
      )}
      {t === "evidence" && (
        <>
          <Evidence recordId={recordId} q={q} editable={editable} />
          {(editable || r?.note) && (
            <TextAreaField
              label={`Note on question ${q.sequence} (optional)`}
              rows={2}
              value={note}
              readOnly={!editable}
              maxLength={2000}
              onChange={(e) => setNote(e.target.value)}
              onBlur={() => {
                if (editable && note.trim() !== (r?.note ?? "")) send({ answer: null, value: null, choice: null, note: note.trim() || null });
              }}
            />
          )}
        </>
      )}
      {t !== "text" && t !== "evidence" && r && r.result !== "na" && (
        <TextAreaField
          label={failed ? `What was found, question ${q.sequence}` : `Note on question ${q.sequence}`}
          required={failed}
          rows={2}
          value={note}
          disabled={!editable && !note}
          readOnly={!editable}
          maxLength={2000}
          hint={failed && editable && !note.trim() ? "Say what was found; it is needed to complete the audit." : undefined}
          onChange={(e) => setNote(e.target.value)}
          onBlur={() => {
            if (editable && note.trim() !== (r?.note ?? "")) send({ note: note.trim() || null });
          }}
        />
      )}
      {r?.ncrs?.length > 0 && (
        <p className="flex flex-wrap items-center gap-2 text-sm text-secondary-text">
          Raised as
          {r.ncrs.map((n) => (
            <Link key={n.id} to={ncrPath(n.id)} className="font-medium text-link-color hover:underline">
              {n.reference}
            </Link>
          ))}
        </p>
      )}
      {r?.finding ? (
        <p className="flex flex-wrap items-center gap-2 text-sm text-secondary-text">
          Finding
          <Link to={`/Documentation/Audit-Findings/${r.finding.id}`} className="font-medium text-link-color hover:underline">
            {r.finding.reference}
          </Link>
          <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${FINDING_KIND_PILL[r.finding.kind]}`}>{r.finding.classification}</span>
        </p>
      ) : failed && canFinding ? (
        <div className="flex flex-wrap items-center gap-3">
          <CTAButton buttonType="button" type="secondary" size="md" onClick={() => onFinding(q)}>
            Create finding
          </CTAButton>
          {q.critical && <span className="text-sm text-secondary-text">A failed critical question needs a finding before the audit can be completed.</span>}
        </div>
      ) : null}
    </li>
  );
};

/** What the audit was carried out on: tick any of the machines, operations and departments the audit lists. */
const Targets = ({ record, editable }) => {
  const mutation = useSetAuditTargets(record.id);
  const chosen = new Set(record.targets.map(targetKey));
  const toggle = (t) => {
    const next = chosen.has(targetKey(t)) ? record.availableTargets.filter((x) => chosen.has(targetKey(x)) && targetKey(x) !== targetKey(t)) : record.availableTargets.filter((x) => chosen.has(targetKey(x)) || targetKey(x) === targetKey(t));
    mutation.mutate(next);
  };
  if (!editable) {
    return record.targets.length ? (
      <ul aria-label="Carried out on" className="flex flex-col gap-0.5 text-sm text-primary-text">
        {record.targets.map((t) => (
          <li key={targetKey(t)}>{t.label}</li>
        ))}
      </ul>
    ) : (
      <p className="text-sm text-secondary-text">{record.targetsRequired || record.status !== "in_progress" ? "None recorded." : "This audit is not tied to a machine, operation or department."}</p>
    );
  }
  if (!record.availableTargets.length) return <p className="text-sm text-secondary-text">This audit is not tied to a machine, operation or department.</p>;
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
      {[["machine", "Machines"], ["operation", "Operations"], ["department", "Departments"]].map(([kind, title]) => {
        const items = record.availableTargets.filter((t) => t.kind === kind);
        if (!items.length) return null;
        return (
          <fieldset key={kind} className="flex flex-col gap-1">
            <legend className="mb-1 text-sm font-medium text-primary-text">{title}</legend>
            {items.map((t) => (
              <label key={targetKey(t)} className="flex cursor-pointer items-center gap-2 text-sm text-primary-text">
                <input type="checkbox" checked={chosen.has(targetKey(t))} onChange={() => toggle(t)} />
                {t.label}
              </label>
            ))}
          </fieldset>
        );
      })}
    </div>
  );
};

/** The findings raised from this audit (withdrawn ones stay in the list so it says what happened). */
const Findings = ({ findings }) =>
  findings.length === 0 ? (
    <p className="text-sm text-secondary-text">No findings have been raised from this audit.</p>
  ) : (
    <ul aria-label="Findings" className="flex flex-col divide-y divide-border-color">
      {findings.map((f) => (
        <li key={f.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
          <Link to={`/Documentation/Audit-Findings/${f.id}`} className="font-medium text-link-color hover:underline">
            {f.reference}
          </Link>
          <span className={f.status === "withdrawn" ? "text-secondary-text line-through" : "text-primary-text"}>{f.title}</span>
          <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${FINDING_KIND_PILL[f.classification.kind]}`}>{f.classification.label}</span>
          <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${FINDING_STATUS_PILL[f.status]}`}>{findingStatusLabel(f.status)}</span>
          {f.owner && <span className="text-secondary-text">{f.owner.name}</span>}
          {f.answer && <span className="text-secondary-text">Question {f.answer.sequence}</span>}
          {f.ncr && (
            <Link to={ncrPath(f.ncr.id)} className="text-link-color hover:underline">
              {f.ncr.reference}
            </Link>
          )}
        </li>
      ))}
    </ul>
  );

/** One audit carried out (/Documentation/Audit-Records/:id): answer the checklist, say what it was carried out on, complete it. */
const AuditRecordPage = () => {
  const { id } = useParams();
  const { can } = usePermissions();
  const query = useAuditRecord(id);
  const mutation = useAuditMutation();
  const answer = useAnswerAudit(id);
  const { showToast } = useToast();
  const [abandoning, setAbandoning] = useState(false);
  const [finding, setFinding] = useState(null);
  const findingsQuery = useRecordFindings(id);
  const [notes, setNotes] = useState(null);

  if (query.isLoading) return <p className="p-6 text-secondary-text">Loading…</p>;
  if (query.error || !query.data) return <div className="p-6"><ErrorNotice error={query.error ?? new Error("Not found")} /></div>;
  const r = query.data;
  const editable = can("audits.perform") && r.status === "in_progress";
  const canFinding = can("audits.perform") && r.status !== "abandoned";
  const findings = findingsQuery.data ?? [];
  const noteText = notes ?? r.notes ?? "";

  return (
    <div className="flex w-full min-w-0 flex-1 min-h-0 flex-col gap-4 overflow-auto bg-primary-bg p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-2">
          <Link to="/Documentation/Audit-Records" className="flex w-fit items-center gap-1 text-sm text-link-color hover:underline">
            <ArrowLeftIcon /> Audit records
          </Link>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-xl font-semibold text-primary-text">
              {r.reference} · {r.audit.title}
            </h1>
            <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_PILL[r.status]}`}>{recordStatusLabel(r.status)}</span>
            {r.result && <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${RESULT_PILL[r.result]}`}>{resultLabel(r.result)}</span>}
          </div>
          <Link to={`/Documentation/Audits/${r.audit.id}`} className="w-fit text-sm text-link-color hover:underline">
            {r.audit.reference} · {auditTypeLabel(r.audit.auditType)}
          </Link>
          <p className="text-sm text-secondary-text" data-testid="record-version">
            {r.version ? `Done against version ${r.version} of the audit` : "Made before versions of audits were kept"}
            {r.version && r.currentVersion && r.currentVersion !== r.version ? ` (the audit is now at version ${r.currentVersion})` : ""}
            {r.version || r.currentVersion ? (
              <>
                {" · "}
                <Link to={`/Documentation/Audits/${r.audit.id}`} className="text-link-color hover:underline">Version history</Link>
              </>
            ) : null}
          </p>
        </div>
      </div>

      {r.status === "completed" && (
        <div role="status" className={`flex flex-wrap items-center gap-3 rounded-2xl border p-4 ${r.result === "pass" ? "border-success-color/50 bg-success-color/10" : "border-error-color/50 bg-error-color/10"}`}>
          {r.result === "pass" ? <CircleCheckIcon className="h-6 w-6 text-success-color" /> : <TriangleAlertIcon className="h-6 w-6 text-error-color" />}
          <div className="text-sm text-primary-text">
            <p className="font-medium">
              {r.result === "pass" ? "Passed" : "Failed"} with {formatScore(r.score)} (pass mark {r.passMark}%)
            </p>
            <p className="text-secondary-text">
              {r.passedCount} passed, {r.failedCount} failed, {r.naCount} not applicable
              {r.criticalFailedCount ? `; ${r.criticalFailedCount} critical ${r.criticalFailedCount === 1 ? "question" : "questions"} failed` : ""}.
            </p>
          </div>
        </div>
      )}
      {r.status === "abandoned" && (
        <Callout tone="info" role="status" title="Abandoned">
          {r.abandonReason}
        </Callout>
      )}

      <MenuCard title="About this audit" subtitle="Who did it, when, and for which scheduled slot">
        <dl className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <Fact label="Auditor">{r.auditor?.name}</Fact>
          <Fact label="Carried out on">{formatDate(r.performedOn)}</Fact>
          <Fact label="Scheduled for">{r.scheduledFor ? formatDate(r.scheduledFor) : "Not scheduled"}</Fact>
          <Fact label="Pass mark">{`${r.passMark}% and every critical question`}</Fact>
        </dl>
        {editable && (
          <div className="mt-4 max-w-xs">
            <RHFDatePickerPopout label="Date carried out" valueFormat="iso" value={r.performedOn} maxDate={new Date()} onChange={(d) => d && d !== r.performedOn && d <= today() && mutation.mutate({ path: `/audit-records/${r.id}`, method: "PATCH", body: { performedOn: d } })} />
          </div>
        )}
      </MenuCard>

      {(r.targetsRequired || r.targets.length > 0) && (
        <MenuCard title="Carried out on" subtitle={editable ? "Tick the machines, operations and departments this audit covered; one or several" : "The machines, operations and departments this audit covered"}>
          <Targets record={r} editable={editable} />
        </MenuCard>
      )}

      {r.procedure && (
        <MenuCard title="Procedure" subtitle="The steps the auditor follows">
          <p className="whitespace-pre-wrap text-sm text-primary-text">{r.procedure}</p>
        </MenuCard>
      )}

      <MenuCard title="Checklist" subtitle={editable ? "Answers are saved as you go" : "The questions as they were when this audit was started"}>
        <ol aria-label="Checklist" className="flex flex-col gap-3">
          {r.questions.map((q) => (
            <Question key={q.id} q={q} recordId={r.id} editable={editable} save={(body) => answer.mutate(body)} canFinding={canFinding} onFinding={(question) => setFinding({ question })} />
          ))}
        </ol>
        {answer.error && <div className="mt-3"><FormError error={answer.error} /></div>}
      </MenuCard>

      {(findings.length > 0 || canFinding) && (
        <MenuCard
          title="Findings"
          subtitle="What this audit found: classified, owned and followed up. A finding classified as a non-conformity can be raised as a non-conformance from its page."
          action={
            canFinding && (
              <CTAButton buttonType="button" type="secondary" size="md" onClick={() => setFinding({ question: null })}>
                Add finding
              </CTAButton>
            )
          }>
          <Findings findings={findings} />
        </MenuCard>
      )}

      <MenuCard title="Notes" subtitle="Anything else about this audit">
        <TextAreaField label="Audit notes" rows={3} value={noteText} readOnly={!editable} maxLength={5000} onChange={(e) => setNotes(e.target.value)} onBlur={() => notes !== null && notes.trim() !== (r.notes ?? "") && mutation.mutate({ path: `/audit-records/${r.id}`, method: "PATCH", body: { notes: notes.trim() || null } })} />
      </MenuCard>

      {r.status === "in_progress" && (
        <MenuCard title="Complete" subtitle="The score and the result are worked out when you complete the audit; it cannot be changed afterwards">
          {r.problems.length > 0 ? (
            <div>
              <p className="text-sm font-medium text-primary-text">Still needed</p>
              <ul aria-label="Still needed" className="mt-1 list-disc pl-5 text-sm text-secondary-text">
                {r.problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="text-sm text-secondary-text">Everything is answered. Complete the audit when you are ready.</p>
          )}
          {can("audits.perform") && (
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <CTAButton
                buttonType="button"
                type="main" size="lg"
                disabled={r.problems.length > 0 || mutation.isPending}
                onClick={() => mutation.mutate({ path: `/audit-records/${r.id}/complete` }, { onSuccess: (done) => showToast({ type: done.result === "pass" ? "success" : "warning", title: `Audit ${done.result === "pass" ? "passed" : "failed"}`, message: `${done.reference}: ${formatScore(done.score)}` }) })}>
                {mutation.isPending ? "Completing…" : "Complete audit"}
              </CTAButton>
              <CTAButton buttonType="button" type="neutral" size="md" onClick={() => setAbandoning(true)}>
                Abandon
              </CTAButton>
            </div>
          )}
          <FormError error={mutation.error} />
        </MenuCard>
      )}

      {abandoning && (
        <ReasonDialog
          title={`Abandon ${r.reference}?`}
          label="Why is it being abandoned?"
          confirmText="Abandon audit"
          pending={mutation.isPending}
          error={mutation.error}
          onClose={() => setAbandoning(false)}
          onConfirm={(reason) => mutation.mutate({ path: `/audit-records/${r.id}/abandon`, body: { reason } }, { onSuccess: () => setAbandoning(false) })}
        />
      )}
      {finding && <FindingDialog record={r} question={finding.question} onClose={() => setFinding(null)} />}
    </div>
  );
};

export default AuditRecordPage;
