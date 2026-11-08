import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeftIcon, CircleCheckIcon, TriangleAlertIcon } from "@/components/icons";
import { useToast } from "../../contexts/ToastProvider";
import { useAnswerAudit, useAuditMutation, useAuditRecord, useSetAuditTargets } from "../../hooks/useAudits";
import { usePermissions } from "../../hooks/useQmsApi";
import { formatDate } from "../../lib/ncr";
import { answerTypeLabel, auditTypeLabel, formatScore, limitsLabel, RESULT_PILL, recordStatusLabel, resultLabel, STATUS_PILL, targetKey } from "../../lib/audits";
import ReasonDialog from "../ncr/ReasonDialog";
import Dialog from "../ui/Dialog";
import MenuCard from "../ui/MenuCard";
import RHFDatePickerPopout from "../ui/RHFDatePickerPopout";
import { ErrorNotice, FormError, SelectField, TextAreaField, buttonClass } from "../master-data/shared";

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
  na: "border-border-dark-color bg-border-color text-primary-text",
};

/** A small set of exclusive buttons (a radio group) for pass / fail / not applicable and yes / no / not applicable. */
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
          className={`rounded-lg border px-3 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-60 ${on ? TONE[o.value] : "border-border-color bg-text-input-color text-primary-text hover:border-border-dark-color"} ${disabled ? "" : "cursor-pointer"}`}>
          {o.label}
        </button>
      );
    })}
  </div>
);

const PASS_FAIL = [{ value: "pass", label: "Pass" }, { value: "fail", label: "Fail" }, { value: "na", label: "N/A" }];
const YES_NO = [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }, { value: "na", label: "N/A" }];

const inputClass =
  "h-9.5 w-40 rounded-lg border border-border-color bg-text-input-color px-3 py-2 text-sm text-primary-text hover:border-border-dark-color focus:border-brand-primary focus:outline-none disabled:opacity-60";

/** One question: how to answer it, what was found, the non-conformances raised from it. */
const Question = ({ q, editable, save }) => {
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
  const send = (patch) => save({ questionId: q.id, answer: r?.answer ?? null, value: r?.value ?? null, note: r?.note ?? null, ...patch });
  const failed = r?.result === "fail";
  const limits = limitsLabel(q);

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
        {answerTypeLabel(q.answerType)}
        {q.answerType === "yes_no" ? `; "${q.passAnswer}" passes` : ""}
        {limits ? `; passes ${limits}` : ""}
      </p>

      {q.answerType === "pass_fail" && <Choice label={`Answer to question ${q.sequence}`} options={PASS_FAIL} value={r?.answer ?? null} disabled={!editable} onChange={(answer) => send({ answer, note: answer ? (r?.note ?? null) : null })} />}
      {q.answerType === "yes_no" && <Choice label={`Answer to question ${q.sequence}`} options={YES_NO} value={r?.answer ?? null} disabled={!editable} onChange={(answer) => send({ answer, note: answer ? (r?.note ?? null) : null })} />}
      {q.answerType === "number" && (
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="number"
            step="any"
            aria-label={`Answer to question ${q.sequence}`}
            className={inputClass}
            value={r?.answer === "na" ? "" : value}
            disabled={!editable || r?.answer === "na"}
            onChange={(e) => setValue(e.target.value)}
            onBlur={() => {
              const n = value === "" ? null : Number(value);
              if (n !== (r?.value ?? null)) send({ answer: null, value: n, note: n == null ? null : (r?.note ?? null) });
            }}
          />
          {q.unit && <span className="text-sm text-secondary-text">{q.unit}</span>}
          <Choice label={`Not applicable, question ${q.sequence}`} options={[{ value: "na", label: "N/A" }]} value={r?.answer ?? null} disabled={!editable} onChange={(answer) => send({ answer, value: null, note: answer ? (r?.note ?? null) : null })} />
        </div>
      )}
      {q.answerType === "text" && (
        <TextAreaField
          label={`Note for question ${q.sequence}`}
          rows={2}
          value={note}
          disabled={!editable}
          maxLength={2000}
          onChange={(e) => setNote(e.target.value)}
          onBlur={() => {
            if (note.trim() !== (r?.note ?? "")) send({ answer: null, value: null, note: note.trim() || null });
          }}
        />
      )}
      {q.answerType !== "text" && r && r.result !== "na" && (
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
            <Link key={n.id} to={`/Non-Conformance/Internal/${n.id}`} className="font-medium text-link-color hover:underline">
              {n.reference}
            </Link>
          ))}
        </p>
      )}
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

/** Turn failed answers into a draft internal non-conformance, prefilled, on request. */
const RaiseNcrDialog = ({ record, candidates, onClose }) => {
  const navigate = useNavigate();
  const { showToast } = useToast();
  const mutation = useAuditMutation();
  const [picked, setPicked] = useState(() => new Set(candidates.map((q) => q.response.id)));
  const first = candidates[0];
  const [title, setTitle] = useState(() => `${record.audit.reference}: ${first.question}`.slice(0, 200));
  const [severity, setSeverity] = useState(null);
  const [description, setDescription] = useState(
    () =>
      `Found in audit ${record.reference} (${record.audit.title})${record.carriedOutOn.length ? `, carried out on ${record.carriedOutOn.join(", ")}` : ""}.\n\n` +
      candidates.map((q) => `${q.sequence}. ${q.question}${q.response.note ? ` — ${q.response.note}` : ""}`).join("\n")
  );
  const toggle = (id) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return (
    <Dialog title="Raise a non-conformance" onClose={onClose} width="max-w-2xl">
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          mutation.mutate(
            { path: `/audit-records/${record.id}/raise-ncr`, body: { responseIds: [...picked], title: title.trim(), description: description.trim() || undefined, severity: severity ?? undefined } },
            {
              onSuccess: (res) => {
                showToast({ type: "success", title: "Draft non-conformance raised", message: "Review it and open it when it is ready." });
                navigate(`/Non-Conformance/Internal/${res.nonconformanceId}`);
              },
            }
          );
        }}
        className="flex flex-col gap-3">
        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1 text-sm font-medium text-secondary-text" data-required>
            Failed answers to include
          </legend>
          {candidates.map((q) => (
            <label key={q.id} className="flex cursor-pointer items-start gap-2 text-sm text-primary-text">
              <input type="checkbox" className="mt-1" checked={picked.has(q.response.id)} onChange={() => toggle(q.response.id)} />
              <span>
                {q.sequence}. {q.question}
                {q.response.note ? <span className="block text-secondary-text">{q.response.note}</span> : null}
              </span>
            </label>
          ))}
        </fieldset>
        <label className="flex flex-col gap-1 text-sm font-medium text-secondary-text" data-required>
          Title
          <input className={`${inputClass} w-full font-normal`} value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} required aria-required="true" />
        </label>
        <SelectField label="Severity" value={severity} onChange={setSeverity} options={[{ value: "minor", label: "Minor" }, { value: "major", label: "Major" }, { value: "critical", label: "Critical" }]} placeholder="Decide later" />
        <TextAreaField label="Description" rows={6} value={description} maxLength={5000} onChange={(e) => setDescription(e.target.value)} />
        <p className="text-sm text-secondary-text">It is created as a draft internal non-conformance. Nothing else happens until someone opens it.</p>
        <FormError error={mutation.error} />
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={buttonClass.neutral}>
            Cancel
          </button>
          <button type="submit" disabled={picked.size === 0 || !title.trim() || mutation.isPending} className={buttonClass.primary}>
            {mutation.isPending ? "Raising…" : "Raise non-conformance"}
          </button>
        </div>
      </form>
    </Dialog>
  );
};

/** One audit carried out (/Documentation/Audit-Records/:id): answer the checklist, say what it was carried out on, complete it. */
const AuditRecordPage = () => {
  const { id } = useParams();
  const { can } = usePermissions();
  const query = useAuditRecord(id);
  const mutation = useAuditMutation();
  const answer = useAnswerAudit(id);
  const { showToast } = useToast();
  const [abandoning, setAbandoning] = useState(false);
  const [raising, setRaising] = useState(false);
  const [notes, setNotes] = useState(null);

  if (query.isLoading) return <p className="p-6 text-secondary-text">Loading…</p>;
  if (query.error || !query.data) return <div className="p-6"><ErrorNotice error={query.error ?? new Error("Not found")} /></div>;
  const r = query.data;
  const editable = can("audits.perform") && r.status === "in_progress";
  const candidates = r.questions.filter((q) => q.response?.result === "fail" && !q.response.ncrs.length);
  const canRaise = can("ncr.create") && r.status !== "abandoned" && candidates.length > 0;
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
        </div>
        {canRaise && (
          <button type="button" className={buttonClass.secondary} onClick={() => setRaising(true)}>
            Raise non-conformance
          </button>
        )}
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
        <p role="status" className="rounded-2xl border border-border-color bg-secondary-bg p-4 text-sm text-primary-text">
          Abandoned: {r.abandonReason}
        </p>
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
            <Question key={q.id} q={q} editable={editable} save={(body) => answer.mutate(body)} />
          ))}
        </ol>
        {answer.error && <div className="mt-3"><FormError error={answer.error} /></div>}
      </MenuCard>

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
              <button
                type="button"
                className={buttonClass.primary}
                disabled={r.problems.length > 0 || mutation.isPending}
                onClick={() => mutation.mutate({ path: `/audit-records/${r.id}/complete` }, { onSuccess: (done) => showToast({ type: done.result === "pass" ? "success" : "warning", title: `Audit ${done.result === "pass" ? "passed" : "failed"}`, message: `${done.reference}: ${formatScore(done.score)}` }) })}>
                {mutation.isPending ? "Completing…" : "Complete audit"}
              </button>
              <button type="button" className={buttonClass.neutral} onClick={() => setAbandoning(true)}>
                Abandon
              </button>
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
      {raising && <RaiseNcrDialog record={r} candidates={candidates} onClose={() => setRaising(false)} />}
    </div>
  );
};

export default AuditRecordPage;
