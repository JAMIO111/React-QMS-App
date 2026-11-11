import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeftIcon, ArrowDownIcon, ArrowUpIcon, PlusIcon, Trash2Icon, XIcon } from "@/components/icons";
import { useToast } from "../../contexts/ToastProvider";
import { useAudit, useAuditMutation, useOperationCodes } from "../../hooks/useAudits";
import { useMachines } from "../../hooks/useProcessControl";
import { useAllDepartments, useMembers, useRoles } from "../../hooks/useQmsApi";
import { useSupplierRegister } from "../../hooks/useSupplierQuality";
import { ANSWER_TYPES, AUDIT_TYPES, AUDITOR_KINDS, FREQUENCIES, emptyOption, emptyQuestion, isScoredType, measurementLimits, questionProblems, questionToForm, questionsBody } from "../../lib/audits";
import { describeApiError } from "../../lib/api-client";
import ComboField from "../ui/ComboField";
import Field from "../ui/Field";
import MenuCard from "../ui/MenuCard";
import RHFDatePickerPopout from "../ui/RHFDatePickerPopout";
import { ErrorNotice, FormError } from "../master-data/shared";
import { TextAreaField } from "../ncr/Pickers";
import CTAButton from "@/components/CTAButton";

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
  questions: (a?.questions ?? []).map(questionToForm),
  machineIds: (a?.targets ?? []).filter((t) => t.kind === "machine").map((t) => t.id),
  operations: (a?.targets ?? []).filter((t) => t.kind === "operation").map((t) => t.id),
  departmentIds: (a?.targets ?? []).filter((t) => t.kind === "department").map((t) => t.id),
  supplierIds: (a?.targets ?? []).filter((t) => t.kind === "supplier").map((t) => t.id),
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
    ...f.supplierIds.map((supplierId) => ({ kind: "supplier", supplierId })),
  ],
});

/** What a version holds: the parts of the body that, when different, make a new version and need a reason (the schedule and the expected auditor do not). */
const contentOf = (b) => JSON.stringify({ title: b.title, auditType: b.auditType, purpose: b.purpose, procedure: b.procedure, passMark: b.passMark, questions: b.questions, targets: [...b.targets].map((t) => JSON.stringify(t)).sort() });

const RATING_SCALES = [3, 4, 5, 6, 7, 8, 9, 10].map((n) => ({ value: String(n), label: `1 to ${n}` }));
const PASS_ANSWERS = [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }];

/** One of the "Relevant to" lists: a drop-down that adds to a list of chips, each with a button to take it off again. */
const RelevantList = ({ legend, addLabel, options, chosen, labelOf, onAdd, onRemove, empty }) => (
  <fieldset className="flex flex-col gap-2">
    <legend className="mb-1 text-sm font-medium text-secondary-text">{legend}</legend>
    <ComboField label={addLabel} value={null} onChange={(v) => v && onAdd(v)} options={options.filter((o) => !chosen.includes(o.value))} placeholder={options.length ? "Choose to add…" : empty} disabled={options.length === 0} />
    <ul aria-label={legend} className="flex flex-wrap gap-1">
      {chosen.map((id) => (
        <li key={id} className="flex items-center gap-1 rounded-full border border-border-color py-0.5 pl-2 pr-1 text-xs text-primary-text">
          {labelOf(id)}
          <button type="button" aria-label={`Remove ${legend.toLowerCase().replace(/s$/, "")} ${labelOf(id)}`} onClick={() => onRemove(id)} className="rounded-full p-0.5 hover:bg-border-color/60 cursor-pointer">
            <XIcon className="h-3 w-3" />
          </button>
        </li>
      ))}
    </ul>
  </fieldset>
);

/** The options of a multiple choice question: its words, and whether choosing it counts as acceptable. */
const OptionsEditor = ({ q, index, set }) => {
  const change = (k, patch) => set({ options: q.options.map((o) => (o.key === k ? { ...o, ...patch } : o)) });
  return (
    <fieldset className="flex flex-col gap-2 md:col-span-4">
      <legend className="text-sm font-medium text-secondary-text" data-required>
        Options
      </legend>
      <ul aria-label={`Options of question ${index + 1}`} className="flex flex-col gap-2">
        {q.options.map((o, i) => (
          <li key={o.key} className="flex flex-wrap items-end gap-2">
            <Field label={`Option ${i + 1}`} value={o.label} onChange={(e) => change(o.key, { label: e.target.value })} maxLength={100} className="min-w-48 flex-1" />
            <label className="flex items-center gap-2 pb-2 text-sm text-primary-text">
              <input type="checkbox" aria-label={`Option ${i + 1} is acceptable`} checked={o.passes} onChange={(e) => change(o.key, { passes: e.target.checked })} /> Acceptable
            </label>
            <button type="button" aria-label={`Remove option ${i + 1}`} disabled={q.options.length <= 2} onClick={() => set({ options: q.options.filter((x) => x.key !== o.key) })} className="mb-1 rounded p-1 text-error-color hover:bg-error-color/10 disabled:opacity-30 cursor-pointer">
              <Trash2Icon />
            </button>
          </li>
        ))}
      </ul>
      <CTAButton buttonType="button" type="neutral" size="md" className="w-fit" disabled={q.options.length >= 20} onClick={() => set({ options: [...q.options, emptyOption()] })}>
        Add an option
      </CTAButton>
    </fieldset>
  );
};

const QuestionRow = ({ q, index, count, onChange, onMove, onRemove }) => {
  const set = (patch) => onChange({ ...q, ...patch });
  const t = q.answerType;
  const scored = isScoredType(q);
  const type = ANSWER_TYPES.find((x) => x.value === t);
  const limits = t === "measurement" ? measurementLimits(q) : null;
  const rating = Number(q.ratingMax) || 5;
  const changeType = (v) => {
    const next = { ...q, answerType: v };
    set({ answerType: v, critical: isScoredType(next) ? q.critical : false });
  };
  return (
    <li className="flex flex-col gap-2 rounded-xl border border-border-color bg-primary-bg p-3" aria-label={`Question ${index + 1}`}>
      <div className="flex items-start gap-2">
        <span className="mt-2 w-6 shrink-0 text-xs tabular-nums text-secondary-text">{index + 1}.</span>
        <div className="grid min-w-0 flex-1 grid-cols-1 gap-2 md:grid-cols-3">
          <Field label="Question" required value={q.question} onChange={(e) => set({ question: e.target.value })} maxLength={500} className="md:col-span-2" />
          <ComboField label="Answered with" required value={t} onChange={changeType} options={ANSWER_TYPES} hint={type ? `For example: ${type.hint}` : undefined} />
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
        {(t === "yes_no" || t === "yes_no_na") && <ComboField label="Passes with" required value={q.passAnswer} onChange={(v) => set({ passAnswer: v ?? "yes" })} options={PASS_ANSWERS} />}
        {t === "numeric" && (
          <>
            <Field label="Lower limit" inputMode="decimal" value={q.lowerLimit} onChange={(e) => set({ lowerLimit: e.target.value })} hint="Scored only when a limit is given" />
            <Field label="Upper limit" inputMode="decimal" value={q.upperLimit} onChange={(e) => set({ upperLimit: e.target.value })} />
            <Field label="Unit" value={q.unit} onChange={(e) => set({ unit: e.target.value })} maxLength={20} />
          </>
        )}
        {t === "measurement" && (
          <>
            <Field label="Nominal" required inputMode="decimal" value={q.nominal} onChange={(e) => set({ nominal: e.target.value })} />
            <Field label="Tolerance −" required inputMode="decimal" value={q.tolMinus} onChange={(e) => set({ tolMinus: e.target.value })} hint="Below the nominal" />
            <Field label="Tolerance +" required inputMode="decimal" value={q.tolPlus} onChange={(e) => set({ tolPlus: e.target.value })} hint="Above the nominal" />
            <Field label="Unit" required value={q.unit} onChange={(e) => set({ unit: e.target.value })} maxLength={20} />
            {limits && (
              <p className="text-sm text-secondary-text md:col-span-3">
                Passes from {limits.lower} to {limits.upper} {q.unit}
              </p>
            )}
          </>
        )}
        {t === "multiple_choice" && <OptionsEditor q={q} index={index} set={set} />}
        {t === "rating" && (
          <>
            <ComboField label="Scale" required value={String(rating)} onChange={(v) => set({ ratingMax: v ?? "5", passRating: q.passRating && Number(q.passRating) > Number(v) ? "" : q.passRating })} options={RATING_SCALES} />
            <ComboField
              label="Lowest acceptable rating"
              value={q.passRating || null}
              onChange={(v) => set({ passRating: v ?? "" })}
              options={Array.from({ length: rating }, (_, i) => ({ value: String(i + 1), label: String(i + 1) }))}
              placeholder="Not scored"
              hint="Leave empty to record the rating without scoring it"
            />
          </>
        )}
        {t === "evidence" && <p className="text-sm text-secondary-text md:col-span-2">The auditor must add at least one photograph or document. It is not scored.</p>}
        {t === "text" && <p className="text-sm text-secondary-text md:col-span-2">The auditor writes a note. It is not scored.</p>}
        {scored && (
          <label className="flex items-center gap-2 self-end pb-2 text-sm text-primary-text">
            <input type="checkbox" checked={q.critical} onChange={(e) => set({ critical: e.target.checked })} /> Critical: the audit fails if this fails
          </label>
        )}
      </div>
    </li>
  );
};

/** Define or change an audit (/Audits/Templates/new and /:id/edit). */
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
  const suppliers = useSupplierRegister({ active: "active", pageSize: 100, sort: "name", order: "asc" });
  const operationCodes = useOperationCodes();
  const members = useMembers();
  const roles = useRoles();
  const [f, setF] = useState(() => fromAudit(audit));
  const [triedSave, setTriedSave] = useState(false);
  const [reason, setReason] = useState("");
  const set = (patch) => setF((x) => ({ ...x, ...patch }));
  // A change to what the audit says (not to the schedule or the expected auditor) is saved as a new version and needs a reason.
  const changed = !!audit && contentOf(toBody(f)) !== contentOf(toBody(fromAudit(audit)));

  const scheduled = f.frequencyKind !== "on_demand";
  const problems = [
    !f.title.trim() && "Give the audit a title",
    scheduled && !f.firstDueOn && "Give the first due date",
    f.frequencyKind === "every_n_days" && !(Number(f.interval) >= 1) && "Say how many days apart",
    f.auditorKind !== "none" && !f.auditorId && "Choose who is expected to do it",
    changed && reason.trim().length < 3 && "Say why the audit is changing",
    ...f.questions.flatMap((q, i) => questionProblems(q, i + 1)),
  ].filter(Boolean);
  const uniqueProblems = [...new Set(problems)];

  const auditorOptions =
    f.auditorKind === "person"
      ? (members.data?.data ?? []).filter((m) => m.status === "active" && m.userId).map((m) => ({ value: m.userId, label: [m.firstName, m.surname].filter(Boolean).join(" ") || m.email }))
      : f.auditorKind === "role"
        ? (roles.data?.data ?? []).map((r) => ({ value: r.id, label: r.name }))
        : (departments.data?.data ?? []).map((d) => ({ value: d.id, label: `${d.code} · ${d.name}` }));

  const machineOptions = (machines.data?.items ?? []).map((m) => ({ value: m.id, label: `${m.code} · ${m.name}` }));
  const departmentOptions = (departments.data?.data ?? []).map((d) => ({ value: d.id, label: `${d.code} · ${d.name}` }));
  const supplierOptions = (suppliers.data?.data ?? []).map((s) => ({ value: s.id, label: `${s.code} · ${s.displayName || s.name}` }));
  const operationOptions = (operationCodes.data ?? []).map((o) => ({ value: o.code, label: o.code, hint: o.name ?? undefined }));
  // An operation already on the audit stays choosable by its own spelling, whatever the plans say.
  const operationList = [...operationOptions, ...f.operations.filter((c) => !operationOptions.some((o) => o.value.toLowerCase() === c.toLowerCase())).map((c) => ({ value: c, label: c }))];
  const labelIn = (options) => (id) => options.find((o) => o.value === id)?.label ?? id;

  const move = (i, d) =>
    set({
      questions: f.questions.map((q, j, all) => (j === i ? all[i + d] : j === i + d ? all[i] : q)),
    });

  const submit = (e) => {
    e.preventDefault();
    setTriedSave(true);
    if (uniqueProblems.length) return;
    const body = { ...toBody(f), ...(changed ? { changeReason: reason.trim() } : {}) };
    mutation.mutate(audit ? { path: `/audits/${audit.id}`, method: "PATCH", body } : { path: "/audits", body }, {
      onSuccess: (saved) => {
        showToast({ type: "success", title: "Saved", message: audit ? `${saved.reference} updated${saved.version !== audit.version ? `, now version ${saved.version}` : ""}.` : `${saved.reference} defined.` });
        navigate(`/Audits/Templates/${saved.id}`);
      },
      onError: (error) => showToast({ type: "error", title: "Not saved", message: describeApiError(error) }),
    });
  };

  return (
    <form onSubmit={submit} noValidate className="flex w-full min-w-0 flex-1 min-h-0 flex-col gap-4 overflow-auto bg-primary-bg p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-2">
          <Link to={audit ? `/Audits/Templates/${audit.id}` : "/Audits/Templates"} className="flex w-fit items-center gap-1 text-sm text-link-color hover:underline">
            <ArrowLeftIcon /> {audit ? audit.reference : "Audits"}
          </Link>
          <h1 className="text-xl font-semibold text-primary-text">{audit ? `Edit ${audit.reference}` : "Define an audit"}</h1>
          {audit && (
            <p className="text-sm text-secondary-text">
              {audit.version ? `Version ${audit.version}. ` : ""}A change to what the audit says is saved as a new version, with a reason. Audits already done keep the questions and the version they were done against.
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <CTAButton to={audit ? `/Audits/Templates/${audit.id}` : "/Audits/Templates"} type="neutral" size="md">
            Cancel
          </CTAButton>
          <CTAButton buttonType="submit" type="main" size="lg" disabled={mutation.isPending} loading={mutation.isPending}>
            {mutation.isPending ? "Saving…" : audit ? "Save changes" : "Define audit"}
          </CTAButton>
        </div>
      </div>
      {triedSave && uniqueProblems.length > 0 && (
        <ul role="alert" aria-label="Still needed" className="list-disc rounded-lg border border-error-color/40 bg-error-color/10 py-2 pl-8 pr-3 text-sm text-primary-text">
          {uniqueProblems.map((p) => <li key={p}>{p}</li>)}
        </ul>
      )}
      <FormError error={mutation.error} />

      <MenuCard title="About this audit" subtitle="What it is and how often it is done">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field label="Title" required value={f.title} onChange={(e) => set({ title: e.target.value })} maxLength={200} className="md:col-span-2" />
          <ComboField label="Type" required value={f.auditType} onChange={(v) => set({ auditType: v ?? "process" })} options={AUDIT_TYPES} />
          <Field label="Pass mark (%)" required inputMode="numeric" value={f.passMark} onChange={(e) => set({ passMark: e.target.value })} hint="Every critical question must pass, and the score must reach this" />
          <TextAreaField label="Purpose" value={f.purpose} onChange={(v) => set({ purpose: v })} rows={2} maxLength={2000} className="md:col-span-2" />
          <ComboField label="How often" required value={f.frequencyKind} onChange={(v) => set({ frequencyKind: v ?? "monthly", ...(v === "on_demand" ? { firstDueOn: null } : {}) })} options={FREQUENCIES} />
          {f.frequencyKind === "every_n_days" && <Field label="Number of days" required inputMode="numeric" value={f.interval} onChange={(e) => set({ interval: e.target.value })} />}
          {scheduled && <RHFDatePickerPopout label="First due" required valueFormat="iso" value={f.firstDueOn} onChange={(v) => set({ firstDueOn: v })} />}
          {scheduled && <Field label="Grace period (days)" inputMode="numeric" value={f.graceDays} onChange={(e) => set({ graceDays: e.target.value })} hint="Days after the due date before it counts as missed" />}
          {scheduled && (
            <label className="flex items-center gap-2 self-end pb-2 text-sm text-primary-text">
              <input type="checkbox" checked={f.weekdaysOnly} onChange={(e) => set({ weekdaysOnly: e.target.checked })} /> Weekdays only
            </label>
          )}
          <ComboField label="Expected auditor" value={f.auditorKind} onChange={(v) => set({ auditorKind: v ?? "none", auditorId: null })} options={AUDITOR_KINDS} clearable={false} />
          {f.auditorKind !== "none" && <ComboField label={f.auditorKind === "person" ? "Person" : f.auditorKind === "role" ? "Role" : "Department"} required value={f.auditorId} onChange={(v) => set({ auditorId: v })} options={auditorOptions} placeholder="Choose…" />}
        </div>
      </MenuCard>

      <MenuCard title="Relevant to" subtitle="Whoever does the audit chooses which of these it was carried out on">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
          <RelevantList
            legend="Machines"
            addLabel="Add a machine"
            options={machineOptions}
            chosen={f.machineIds}
            labelOf={labelIn(machineOptions)}
            onAdd={(id) => set({ machineIds: [...f.machineIds, id] })}
            onRemove={(id) => set({ machineIds: f.machineIds.filter((x) => x !== id) })}
            empty="No machines yet"
          />
          <RelevantList
            legend="Operations"
            addLabel="Add an operation"
            options={operationList}
            chosen={f.operations}
            labelOf={(c) => c}
            onAdd={(code) => set({ operations: [...f.operations, code] })}
            onRemove={(code) => set({ operations: f.operations.filter((x) => x !== code) })}
            empty="No operations yet"
          />
          <RelevantList
            legend="Departments"
            addLabel="Add a department"
            options={departmentOptions}
            chosen={f.departmentIds}
            labelOf={labelIn(departmentOptions)}
            onAdd={(id) => set({ departmentIds: [...f.departmentIds, id] })}
            onRemove={(id) => set({ departmentIds: f.departmentIds.filter((x) => x !== id) })}
            empty="No departments yet"
          />
          <RelevantList
            legend="Suppliers"
            addLabel="Add a supplier"
            options={supplierOptions}
            chosen={f.supplierIds}
            labelOf={labelIn(supplierOptions)}
            onAdd={(id) => set({ supplierIds: [...f.supplierIds, id] })}
            onRemove={(id) => set({ supplierIds: f.supplierIds.filter((x) => x !== id) })}
            empty="No suppliers yet"
          />
        </div>
      </MenuCard>

      <MenuCard title="Procedure" subtitle="The steps the auditor follows">
        <TextAreaField label="Procedure" value={f.procedure} onChange={(v) => set({ procedure: v })} rows={8} maxLength={20000} />
      </MenuCard>

      <MenuCard
        title="Checklist"
        subtitle="Asked in this order. How each question is answered here is what the audit record shows."
        action={
          <CTAButton buttonType="button" type="neutral" size="md" className="flex items-center gap-1" onClick={() => set({ questions: [...f.questions, emptyQuestion()] })}>
            <PlusIcon className="h-4 w-4" aria-hidden="true" /> Add a question
          </CTAButton>
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

      {audit && (
        <MenuCard title="Reason for the change" subtitle={changed ? `Saved as version ${(audit.version ?? 0) + 1}, with this reason, in the version history` : "Needed when the title, type, purpose, procedure, pass mark, checklist or what it is relevant to changes"}>
          <TextAreaField
            label="Why is this changing?"
            required={changed}
            value={reason}
            onChange={setReason}
            rows={2}
            maxLength={1000}
            hint={changed ? undefined : "Nothing about what the audit says has changed yet. A change to the schedule or the expected auditor needs no reason."}
          />
        </MenuCard>
      )}
    </form>
  );
};

export default AuditForm;
