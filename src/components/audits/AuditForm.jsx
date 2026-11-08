import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeftIcon, ArrowDownIcon, ArrowUpIcon, PlusIcon, Trash2Icon, XIcon } from "@/components/icons";
import { useToast } from "../../contexts/ToastProvider";
import { useAudit, useAuditMutation } from "../../hooks/useAudits";
import { useMachines } from "../../hooks/useProcessControl";
import { useAllDepartments, useMembers, useRoles } from "../../hooks/useQmsApi";
import { ANSWER_TYPES, AUDIT_TYPES, AUDITOR_KINDS, FREQUENCIES, emptyQuestion, questionsBody } from "../../lib/audits";
import { describeApiError } from "../../lib/api-client";
import Field from "../ui/Field";
import MenuCard from "../ui/MenuCard";
import RHFDatePickerPopout from "../ui/RHFDatePickerPopout";
import { ErrorNotice, FormError, SelectField, buttonClass } from "../master-data/shared";
import { TextAreaField } from "../ncr/Pickers";

const fromAudit = (a) => ({
  title: a?.title ?? "",
  auditType: a?.auditType ?? "process",
  purpose: a?.purpose ?? "",
  procedure: a?.procedure ?? "",
  frequencyKind: a?.frequency.kind ?? "monthly",
  interval: a?.frequency.interval ?? "",
  firstDueOn: a?.frequency.firstDueOn ?? null,
  graceDays: a?.graceDays ?? 0,
  weekdaysOnly: a?.weekdaysOnly ?? false,
  auditorKind: a?.auditor.kind ?? "none",
  auditorId: a?.auditor.id ?? null,
  passMark: a?.passMark ?? 100,
  questions: (a?.questions ?? []).map((q) => ({ key: q.id, question: q.question, guidance: q.guidance ?? "", answerType: q.answerType, passAnswer: q.passAnswer ?? "yes", unit: q.unit ?? "", lowerLimit: q.lowerLimit ?? "", upperLimit: q.upperLimit ?? "", critical: q.critical })),
  machineIds: (a?.targets ?? []).filter((t) => t.kind === "machine").map((t) => t.id),
  operations: (a?.targets ?? []).filter((t) => t.kind === "operation").map((t) => t.id),
  departmentIds: (a?.targets ?? []).filter((t) => t.kind === "department").map((t) => t.id),
});

const toBody = (f) => ({
  title: f.title.trim(),
  auditType: f.auditType,
  purpose: f.purpose.trim() || null,
  procedure: f.procedure.trim() || null,
  frequency:
    f.frequencyKind === "on_demand"
      ? { kind: "on_demand" }
      : { kind: f.frequencyKind, ...(f.frequencyKind === "every_n_days" ? { interval: Number(f.interval) } : {}), firstDueOn: f.firstDueOn },
  graceDays: Number(f.graceDays) || 0,
  weekdaysOnly: !!f.weekdaysOnly,
  auditor:
    f.auditorKind === "person" ? { kind: "person", userId: f.auditorId } : f.auditorKind === "role" ? { kind: "role", roleId: f.auditorId } : f.auditorKind === "department" ? { kind: "department", departmentId: f.auditorId } : { kind: "none" },
  passMark: Number(f.passMark),
  questions: questionsBody(f.questions),
  targets: [
    ...f.machineIds.map((machineId) => ({ kind: "machine", machineId })),
    ...f.operations.map((operationCode) => ({ kind: "operation", operationCode })),
    ...f.departmentIds.map((departmentId) => ({ kind: "department", departmentId })),
  ],
});

/** Tick boxes for choosing several of a list. */
const Checks = ({ legend, items, selected, onChange, empty }) => (
  <fieldset className="flex flex-col gap-1">
    <legend className="text-sm font-medium text-secondary-text">{legend}</legend>
    {items.length === 0 ? (
      <p className="text-sm text-secondary-text">{empty}</p>
    ) : (
      <div className="flex max-h-40 flex-col gap-1 overflow-y-auto rounded-lg border border-border-color p-2">
        {items.map((i) => (
          <label key={i.id} className="flex items-center gap-2 text-sm text-primary-text">
            <input type="checkbox" checked={selected.includes(i.id)} onChange={() => onChange(selected.includes(i.id) ? selected.filter((x) => x !== i.id) : [...selected, i.id])} />
            {i.label}
          </label>
        ))}
      </div>
    )}
  </fieldset>
);

const QuestionRow = ({ q, index, count, onChange, onMove, onRemove }) => {
  const set = (patch) => onChange({ ...q, ...patch });
  return (
    <li className="flex flex-col gap-2 rounded-xl border border-border-color bg-primary-bg p-3" aria-label={`Question ${index + 1}`}>
      <div className="flex items-start gap-2">
        <span className="mt-2 w-6 shrink-0 text-xs tabular-nums text-secondary-text">{index + 1}.</span>
        <div className="grid min-w-0 flex-1 grid-cols-1 gap-2 md:grid-cols-3">
          <Field label="Question" required value={q.question} onChange={(e) => set({ question: e.target.value })} maxLength={500} className="md:col-span-2" />
          <SelectField label="Answered with" required value={q.answerType} onChange={(v) => set({ answerType: v, critical: v === "text" ? false : q.critical })} options={ANSWER_TYPES} />
        </div>
        <div className="flex shrink-0 flex-col">
          <button type="button" aria-label={`Move question ${index + 1} up`} disabled={index === 0} onClick={() => onMove(-1)} className="rounded p-1 hover:bg-border-color/40 disabled:opacity-30 cursor-pointer">
            <ArrowUpIcon />
          </button>
          <button type="button" aria-label={`Move question ${index + 1} down`} disabled={index === count - 1} onClick={() => onMove(1)} className="rounded p-1 hover:bg-border-color/40 disabled:opacity-30 cursor-pointer">
            <ArrowDownIcon />
          </button>
        </div>
        <button type="button" aria-label={`Remove question ${index + 1}`} onClick={onRemove} className="rounded p-1 text-error-color hover:bg-error-color/10 cursor-pointer">
          <Trash2Icon />
        </button>
      </div>
      <div className="grid grid-cols-1 gap-2 pl-8 md:grid-cols-4">
        <TextAreaField label="Guidance for the auditor" value={q.guidance} onChange={(v) => set({ guidance: v })} rows={2} maxLength={2000} className="md:col-span-2" />
        {q.answerType === "yes_no" && (
          <SelectField label="Passes with" value={q.passAnswer} onChange={(v) => set({ passAnswer: v })} options={[{ value: "yes", label: "Yes" }, { value: "no", label: "No" }]} />
        )}
        {q.answerType === "number" && (
          <>
            <Field label="Lower limit" inputMode="decimal" value={q.lowerLimit} onChange={(e) => set({ lowerLimit: e.target.value })} />
            <Field label="Upper limit" inputMode="decimal" value={q.upperLimit} onChange={(e) => set({ upperLimit: e.target.value })} />
            <Field label="Unit" value={q.unit} onChange={(e) => set({ unit: e.target.value })} maxLength={20} />
          </>
        )}
        {q.answerType !== "text" && (
          <label className="flex items-center gap-2 self-end pb-2 text-sm text-primary-text">
            <input type="checkbox" checked={q.critical} onChange={(e) => set({ critical: e.target.checked })} /> Critical: the audit fails if this fails
          </label>
        )}
      </div>
    </li>
  );
};

/** Define or change an audit (/Documentation/Audits/new and /:id/edit). */
const AuditForm = () => {
  const { id } = useParams();
  const editing = !!id;
  const query = useAudit(id);
  if (editing && query.isLoading) return <p className="p-6 text-secondary-text">Loading…</p>;
  if (editing && (query.error || !query.data)) return <div className="p-6"><ErrorNotice error={query.error ?? new Error("Not found")} /></div>;
  return <AuditFormBody audit={editing ? query.data : null} />;
};

const AuditFormBody = ({ audit }) => {
  const navigate = useNavigate();
  const { showToast } = useToast();
  const mutation = useAuditMutation();
  const machines = useMachines({ includeInactive: false });
  const departments = useAllDepartments();
  const members = useMembers();
  const roles = useRoles();
  const [f, setF] = useState(() => fromAudit(audit));
  const [op, setOp] = useState("");
  const [triedSave, setTriedSave] = useState(false);
  const set = (patch) => setF((x) => ({ ...x, ...patch }));

  const scheduled = f.frequencyKind !== "on_demand";
  const problems = [
    !f.title.trim() && "Give the audit a title",
    scheduled && !f.firstDueOn && "Give the first due date",
    f.frequencyKind === "every_n_days" && !(Number(f.interval) >= 1) && "Say how many days apart",
    f.auditorKind !== "none" && !f.auditorId && "Choose who is expected to do it",
    f.questions.some((q) => !q.question.trim()) && "Every question needs its words",
    f.questions.some((q) => q.answerType === "number" && q.lowerLimit === "" && q.upperLimit === "") && "A number question needs a lower or an upper limit",
  ].filter(Boolean);

  const auditorOptions =
    f.auditorKind === "person"
      ? (members.data?.data ?? []).filter((m) => m.status === "active" && m.userId).map((m) => ({ value: m.userId, label: [m.firstName, m.surname].filter(Boolean).join(" ") || m.email }))
      : f.auditorKind === "role"
        ? (roles.data?.data ?? []).map((r) => ({ value: r.id, label: r.name }))
        : (departments.data?.data ?? []).map((d) => ({ value: d.id, label: `${d.code} · ${d.name}` }));

  const move = (i, d) =>
    set({
      questions: f.questions.map((q, j, all) => (j === i ? all[i + d] : j === i + d ? all[i] : q)),
    });
  const addOperation = () => {
    const code = op.trim();
    if (code && !f.operations.some((x) => x.toLowerCase() === code.toLowerCase())) set({ operations: [...f.operations, code] });
    setOp("");
  };

  const submit = (e) => {
    e.preventDefault();
    setTriedSave(true);
    if (problems.length) return;
    const body = toBody(f);
    mutation.mutate(audit ? { path: `/audits/${audit.id}`, method: "PATCH", body } : { path: "/audits", body }, {
      onSuccess: (saved) => {
        showToast({ type: "success", title: "Saved", message: audit ? `${saved.reference} updated.` : `${saved.reference} defined.` });
        navigate(`/Documentation/Audits/${saved.id}`);
      },
      onError: (error) => showToast({ type: "error", title: "Not saved", message: describeApiError(error) }),
    });
  };

  return (
    <form onSubmit={submit} noValidate className="flex w-full min-w-0 flex-1 min-h-0 flex-col gap-4 overflow-auto bg-primary-bg p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-2">
          <Link to={audit ? `/Documentation/Audits/${audit.id}` : "/Documentation/Audits"} className="flex w-fit items-center gap-1 text-sm text-link-color hover:underline">
            <ArrowLeftIcon /> {audit ? audit.reference : "Audits"}
          </Link>
          <h1 className="text-xl font-semibold text-primary-text">{audit ? `Edit ${audit.reference}` : "Define an audit"}</h1>
          {audit && <p className="text-sm text-secondary-text">Audits already done keep the questions they were done against.</p>}
        </div>
        <div className="flex items-center gap-2">
          <Link to={audit ? `/Documentation/Audits/${audit.id}` : "/Documentation/Audits"} className={buttonClass.neutral}>
            Cancel
          </Link>
          <button type="submit" className={buttonClass.primary} disabled={mutation.isPending}>
            {mutation.isPending ? "Saving…" : audit ? "Save changes" : "Define audit"}
          </button>
        </div>
      </div>
      {triedSave && problems.length > 0 && (
        <ul role="alert" aria-label="Still needed" className="list-disc rounded-lg border border-error-color/40 bg-error-color/10 py-2 pl-8 pr-3 text-sm text-primary-text">
          {problems.map((p) => <li key={p}>{p}</li>)}
        </ul>
      )}
      <FormError error={mutation.error} />

      <MenuCard title="About this audit" subtitle="What it is and how often it is done">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field label="Title" required value={f.title} onChange={(e) => set({ title: e.target.value })} maxLength={200} className="md:col-span-2" />
          <SelectField label="Type" required value={f.auditType} onChange={(v) => set({ auditType: v })} options={AUDIT_TYPES} />
          <Field label="Pass mark (%)" required inputMode="numeric" value={f.passMark} onChange={(e) => set({ passMark: e.target.value })} hint="Every critical question must pass, and the score must reach this" />
          <TextAreaField label="Purpose" value={f.purpose} onChange={(v) => set({ purpose: v })} rows={2} maxLength={2000} className="md:col-span-2" />
          <SelectField label="How often" required value={f.frequencyKind} onChange={(v) => set({ frequencyKind: v, ...(v === "on_demand" ? { firstDueOn: null } : {}) })} options={FREQUENCIES} />
          {f.frequencyKind === "every_n_days" && <Field label="Number of days" required inputMode="numeric" value={f.interval} onChange={(e) => set({ interval: e.target.value })} />}
          {scheduled && <RHFDatePickerPopout label="First due" required valueFormat="iso" value={f.firstDueOn} onChange={(v) => set({ firstDueOn: v })} />}
          {scheduled && <Field label="Grace period (days)" inputMode="numeric" value={f.graceDays} onChange={(e) => set({ graceDays: e.target.value })} hint="Days after the due date before it counts as missed" />}
          {scheduled && (
            <label className="flex items-center gap-2 self-end pb-2 text-sm text-primary-text">
              <input type="checkbox" checked={f.weekdaysOnly} onChange={(e) => set({ weekdaysOnly: e.target.checked })} /> Weekdays only
            </label>
          )}
          <SelectField label="Expected auditor" value={f.auditorKind} onChange={(v) => set({ auditorKind: v ?? "none", auditorId: null })} options={AUDITOR_KINDS} />
          {f.auditorKind !== "none" && <SelectField label={f.auditorKind === "person" ? "Person" : f.auditorKind === "role" ? "Role" : "Department"} required value={f.auditorId} onChange={(v) => set({ auditorId: v })} options={auditorOptions} placeholder="Choose…" />}
        </div>
      </MenuCard>

      <MenuCard title="Relevant to" subtitle="Whoever does the audit chooses which of these it was carried out on">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <Checks legend="Machines" items={(machines.data?.items ?? []).map((m) => ({ id: m.id, label: `${m.code} · ${m.name}` }))} selected={f.machineIds} onChange={(v) => set({ machineIds: v })} empty="No machines yet." />
          <fieldset className="flex flex-col gap-1">
            <legend className="text-sm font-medium text-secondary-text">Operations</legend>
            <div className="flex gap-2">
              <input
                aria-label="Operation code"
                value={op}
                onChange={(e) => setOp(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addOperation();
                  }
                }}
                placeholder="OP-20"
                maxLength={40}
                className="min-w-0 flex-1 rounded-lg border border-border-color bg-primary-bg px-3 py-2 text-sm text-primary-text"
              />
              <button type="button" className={buttonClass.neutral} onClick={addOperation} disabled={!op.trim()}>
                Add
              </button>
            </div>
            <ul aria-label="Operations" className="flex flex-wrap gap-1">
              {f.operations.map((code) => (
                <li key={code} className="flex items-center gap-1 rounded-full border border-border-color py-0.5 pl-2 pr-1 text-xs text-primary-text">
                  {code}
                  <button type="button" aria-label={`Remove operation ${code}`} onClick={() => set({ operations: f.operations.filter((x) => x !== code) })} className="rounded-full p-0.5 hover:bg-border-color/60 cursor-pointer">
                    <XIcon className="h-3 w-3" />
                  </button>
                </li>
              ))}
            </ul>
          </fieldset>
          <Checks legend="Departments" items={(departments.data?.data ?? []).map((d) => ({ id: d.id, label: `${d.code} · ${d.name}` }))} selected={f.departmentIds} onChange={(v) => set({ departmentIds: v })} empty="No departments yet." />
        </div>
      </MenuCard>

      <MenuCard title="Procedure" subtitle="The steps the auditor follows">
        <TextAreaField label="Procedure" value={f.procedure} onChange={(v) => set({ procedure: v })} rows={8} maxLength={20000} />
      </MenuCard>

      <MenuCard
        title="Checklist"
        subtitle="Asked in this order"
        action={
          <button type="button" className={`${buttonClass.neutral} flex items-center gap-1`} onClick={() => set({ questions: [...f.questions, emptyQuestion()] })}>
            <PlusIcon className="h-4 w-4" aria-hidden="true" /> Add a question
          </button>
        }>
        {f.questions.length === 0 ? (
          <p className="text-sm text-secondary-text">No questions yet.</p>
        ) : (
          <ol aria-label="Checklist" className="flex flex-col gap-3">
            {f.questions.map((q, i) => (
              <QuestionRow
                key={q.key}
                q={q}
                index={i}
                count={f.questions.length}
                onChange={(next) => set({ questions: f.questions.map((x, j) => (j === i ? next : x)) })}
                onMove={(d) => move(i, d)}
                onRemove={() => set({ questions: f.questions.filter((_, j) => j !== i) })}
              />
            ))}
          </ol>
        )}
      </MenuCard>
    </form>
  );
};

export default AuditForm;
