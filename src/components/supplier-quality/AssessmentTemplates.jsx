import { useState } from "react";
import { ArrowUpIcon, ChevronDownIcon, PlusIcon, Trash2Icon } from "@/components/icons";
import { useAssessmentMutation, useAssessmentTemplates } from "../../hooks/useSupplierQuality";
import { formatDateTime } from "../../lib/processControl";
import { ANSWER_TYPES, questionKey } from "../../lib/supplierQualification";
import CTAButton from "../CTAButton";
import ComboField from "../ui/ComboField";
import Dialog from "../ui/Dialog";
import Field from "../ui/Field";
import MenuCard from "../ui/MenuCard";
import Switch from "../ui/Switch";
import { ErrorNotice, FormError } from "../master-data/shared";

const blank = () => ({ key: "", section: "", text: "", answerType: "yes_no", weight: 3, critical: false, evidenceRequired: false, passRating: 3, fresh: true });

/** Edit the questions and pass mark of a template. Saved as a new version with a reason (or as version 1 of a new template). Existing question keys never change. */
const TemplateDialog = ({ template, onClose }) => {
  const mutation = useAssessmentMutation();
  const [name, setName] = useState(template?.name ?? "");
  const [description, setDescription] = useState(template?.description ?? "");
  const [questions, setQuestions] = useState((template?.questions ?? [blank()]).map((q) => ({ ...q, passRating: q.passRating ?? 3, fresh: !template })));
  const [passMark, setPassMark] = useState(String(template?.passMark ?? 75));
  const [reason, setReason] = useState("");
  const [problem, setProblem] = useState(null);
  const update = (i, patch) => setQuestions((qs) => qs.map((q, n) => (n === i ? { ...q, ...patch } : q)));
  const move = (i, by) => setQuestions((qs) => { const next = [...qs]; const [x] = next.splice(i, 1); next.splice(i + by, 0, x); return next; });

  const submit = (e) => {
    e.preventDefault();
    setProblem(null);
    if (!template && !name.trim()) return setProblem("Give the template a name.");
    if (questions.length === 0) return setProblem("Keep at least one question.");
    if (questions.some((q) => !q.text.trim())) return setProblem("Every question needs its wording.");
    if (!questions.some((q) => q.answerType !== "text")) return setProblem("At least one question must be scored (yes / no or rating).");
    if (!(Number(passMark) >= 1 && Number(passMark) <= 100)) return setProblem("The pass mark is 1 to 100.");
    if (template && reason.trim().length < 3) return setProblem("Say why the template is changing.");
    const taken = [];
    const body = questions.map((q) => {
      const key = q.fresh ? questionKey(q.text, taken) : q.key;
      taken.push(key);
      const scored = q.answerType !== "text";
      return { key, section: q.section.trim(), text: q.text.trim(), answerType: q.answerType, weight: scored ? Number(q.weight) : 1, critical: scored && !!q.critical, evidenceRequired: scored && !!q.evidenceRequired, ...(q.answerType === "rating" ? { passRating: Number(q.passRating) } : {}) };
    });
    if (template) mutation.mutate({ action: "saveTemplateVersion", id: template.id, body: { questions: body, passMark: Number(passMark), reason: reason.trim() } }, { onSuccess: onClose });
    else mutation.mutate({ action: "createTemplate", body: { name: name.trim(), description: description.trim(), questions: body, passMark: Number(passMark) } }, { onSuccess: onClose });
  };

  return (
    <Dialog title={template ? `Change “${template.name}”` : "New assessment template"} onClose={onClose} width="max-w-4xl">
      <form noValidate className="flex flex-col gap-4" onSubmit={submit}>
        {template ? (
          <p className="text-sm text-secondary-text">This saves version {template.version + 1}. Assessments already started keep the questions they began with.</p>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Name" required value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
            <Field label="Description" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} />
          </div>
        )}
        <ol className="flex flex-col gap-3" aria-label="Questions">
          {questions.map((q, i) => (
            <li key={q.key + i} className="flex flex-col gap-2 rounded-lg border border-border-color p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-semibold text-primary-text">Question {i + 1}</span>
                <div className="flex items-center gap-1">
                  <button type="button" aria-label={`Move question ${i + 1} up`} disabled={i === 0} onClick={() => move(i, -1)} className="rounded p-1 text-secondary-text hover:text-brand-primary disabled:opacity-30 cursor-pointer disabled:cursor-not-allowed"><ArrowUpIcon size={16} /></button>
                  <button type="button" aria-label={`Move question ${i + 1} down`} disabled={i === questions.length - 1} onClick={() => move(i, 1)} className="rounded p-1 text-secondary-text hover:text-brand-primary disabled:opacity-30 cursor-pointer disabled:cursor-not-allowed"><ChevronDownIcon size={16} /></button>
                  <button type="button" aria-label={`Remove question ${i + 1}`} onClick={() => setQuestions((qs) => qs.filter((_, n) => n !== i))} className="rounded p-1 text-secondary-text hover:text-error-color cursor-pointer"><Trash2Icon size={16} /></button>
                </div>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_12rem]">
                <Field label={`Question ${i + 1} wording`} required value={q.text} onChange={(e) => update(i, { text: e.target.value })} maxLength={500} />
                <Field label={`Section for question ${i + 1}`} value={q.section} onChange={(e) => update(i, { section: e.target.value })} maxLength={80} hint="Groups questions" />
              </div>
              <div className="flex flex-wrap items-end gap-3">
                <ComboField label={`Answer type of question ${i + 1}`} className="w-48" required value={q.answerType} onChange={(v) => update(i, { answerType: v ?? "yes_no" })} options={ANSWER_TYPES.map((t) => ({ value: t.id, label: t.name }))} />
                {q.answerType !== "text" && (
                  <>
                    <Field label={`Weight of question ${i + 1}`} type="number" min={1} max={10} className="w-24" value={q.weight} onChange={(e) => update(i, { weight: e.target.value })} />
                    {q.answerType === "rating" && <Field label={`Lowest passing rating of question ${i + 1}`} type="number" min={2} max={5} className="w-32" value={q.passRating} onChange={(e) => update(i, { passRating: e.target.value })} />}
                    <label className="flex items-center gap-2 pb-2 text-sm text-primary-text"><Switch checked={q.critical} onChange={(e) => update(i, { critical: e.target.checked })} aria-label={`Question ${i + 1} is critical`} /> Critical (a failure fails the assessment)</label>
                    <label className="flex items-center gap-2 pb-2 text-sm text-primary-text"><Switch checked={q.evidenceRequired} onChange={(e) => update(i, { evidenceRequired: e.target.checked })} aria-label={`Question ${i + 1} needs evidence`} /> Needs evidence</label>
                  </>
                )}
              </div>
            </li>
          ))}
        </ol>
        <div>
          <CTAButton buttonType="button" type="secondary" size="default" icon={PlusIcon} iconSize="h-4 w-4" onClick={() => setQuestions((qs) => [...qs, blank()])}>Add question</CTAButton>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[10rem_1fr]">
          <Field label="Pass mark (%)" type="number" min={1} max={100} value={passMark} onChange={(e) => setPassMark(e.target.value)} hint="Score needed to pass" />
          {template && <Field label="Why is it changing?" required value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} />}
        </div>
        {problem && <p role="alert" className="text-sm text-error-color">{problem}</p>}
        <FormError error={mutation.error} />
        <div className="flex justify-end gap-2">
          <CTAButton buttonType="button" type="neutral" size="md" onClick={onClose}>Cancel</CTAButton>
          <CTAButton buttonType="submit" type="main" size="md" disabled={mutation.isPending} loading={mutation.isPending}>{mutation.isPending ? "Saving…" : template ? "Save new version" : "Create template"}</CTAButton>
        </div>
      </form>
    </Dialog>
  );
};

/** Settings → Supplier quality: the assessment templates (versioned) used to qualify suppliers. */
const AssessmentTemplatesCard = ({ canConfigure }) => {
  const query = useAssessmentTemplates();
  const mutation = useAssessmentMutation();
  const [dialog, setDialog] = useState(null); // {} = new, template = change
  if (query.isLoading) return null;
  if (query.error) return <ErrorNotice error={query.error} />;
  const list = query.data.data;

  return (
    <MenuCard
      title="Assessment templates"
      subtitle="The questionnaires used to assess a supplier before it is approved. Changing one saves a new version; assessments already started keep the version they began with."
      action={canConfigure && <CTAButton buttonType="button" type="secondary" size="default" icon={PlusIcon} iconSize="h-4 w-4" onClick={() => setDialog({})}>New template</CTAButton>}>
      <ul className="flex flex-col divide-y divide-border-color" aria-label="Assessment templates">
        {list.map((t) => (
          <li key={t.id} className="flex flex-wrap items-center gap-3 py-3">
            <div className="min-w-0 flex-1">
              <p className={`text-sm font-medium ${t.active ? "text-primary-text" : "text-secondary-text"}`}>{t.name} <span className="font-normal text-secondary-text">· version {t.version}</span></p>
              <p className="text-xs text-secondary-text">{t.questions.length} questions · pass mark {t.passMark}{t.description ? ` · ${t.description}` : ""}</p>
              <details className="mt-1">
                <summary className="cursor-pointer text-xs text-secondary-text">Versions ({t.versions.length})</summary>
                <ul className="mt-1 text-xs text-secondary-text" aria-label={`Versions of ${t.name}`}>
                  {t.versions.map((v) => <li key={v.version}>Version {v.version} · {formatDateTime(v.createdAt)}{v.createdBy ? ` · ${v.createdBy.name}` : ""} · {v.questions} questions, pass mark {v.passMark} · {v.reason}</li>)}
                </ul>
              </details>
            </div>
            <Switch checked={t.active} disabled={!canConfigure} onChange={(e) => mutation.mutate({ action: "updateTemplate", id: t.id, body: { active: e.target.checked } })} aria-label={`${t.name} is in use`} />
            {canConfigure && <CTAButton buttonType="button" type="neutral" size="default" onClick={() => setDialog(t)}>Change questions</CTAButton>}
          </li>
        ))}
      </ul>
      <FormError error={mutation.error} />
      {dialog && <TemplateDialog template={dialog.id ? dialog : undefined} onClose={() => setDialog(null)} />}
    </MenuCard>
  );
};

export default AssessmentTemplatesCard;
