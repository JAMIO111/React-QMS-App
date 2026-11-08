import { useState } from "react";
import { useToast } from "../../contexts/ToastProvider";
import { useAuditMutation, useFindingClassifications } from "../../hooks/useAudits";
import { useEmployees } from "../../hooks/useNcr";
import { findingFromAnswer, findingKindLabel, suggestClassification } from "../../lib/audits";
import ComboField from "../ui/ComboField";
import Dialog from "../ui/Dialog";
import RHFDatePickerPopout from "../ui/RHFDatePickerPopout";
import { FormError, TextAreaField, buttonClass } from "../master-data/shared";

const inputClass = "w-full rounded-lg border border-border-color bg-text-input-color px-3 py-1.5 text-sm font-normal text-primary-text placeholder:text-tertiary-text focus:outline-none focus:border-brand-primary";

/**
 * Create a finding (from an answer, or on its own) or edit an open one. `record` is the audit record (id, reference); `question` is the question whose answer the finding is raised from
 * (leave it out for a standalone finding); `finding` is the one being edited. `onSaved(finding)` runs after it is saved.
 */
const FindingDialog = ({ record, question, finding, onClose, onSaved }) => {
  const { showToast } = useToast();
  const mutation = useAuditMutation();
  const classes = useFindingClassifications({ all: !!finding });
  const employees = useEmployees();
  const editing = !!finding;
  const start = question ? findingFromAnswer(question) : { title: "", description: "" };
  const [classificationId, setClassificationId] = useState(finding?.classification.id ?? null);
  const [title, setTitle] = useState(finding?.title ?? start.title);
  const [description, setDescription] = useState(finding?.description ?? start.description);
  const [requirement, setRequirement] = useState(finding?.requirement ?? "");
  const [ownerId, setOwnerId] = useState(finding?.owner?.id ?? null);
  const [dueOn, setDueOn] = useState(finding?.dueOn ?? null);

  // A new finding starts with the classification that suits the answer, until the person chooses one.
  const suggested = !editing && classes.data ? suggestClassification(classes.data, question)?.id : null;
  const chosen = classificationId ?? suggested ?? null;
  const options = (classes.data ?? [])
    .filter((c) => c.active || c.id === finding?.classification.id)
    .map((c) => ({ value: c.id, label: c.active ? c.label : `${c.label} (switched off)`, hint: findingKindLabel(c.kind), disabled: !c.active }));
  const ok = !!chosen && title.trim() && description.trim();

  const submit = (e) => {
    e.preventDefault();
    if (!ok) return;
    const body = {
      classificationId: chosen,
      title: title.trim(),
      description: description.trim(),
      requirement: requirement.trim() || null,
      ownerId: ownerId ?? null,
      dueOn: dueOn ?? null,
    };
    mutation.mutate(
      editing
        ? { path: `/audit-findings/${finding.id}`, method: "PATCH", body }
        : { path: `/audit-records/${record.id}/findings`, body: { ...body, ...(question?.response ? { responseId: question.response.id } : {}) } },
      {
        onSuccess: (saved) => {
          showToast({ type: "success", title: editing ? "Finding saved" : "Finding raised", message: saved.reference });
          onSaved?.(saved);
          onClose();
        },
      }
    );
  };

  return (
    <Dialog title={editing ? `Edit ${finding.reference}` : question ? `Create a finding from question ${question.sequence}` : "Add a finding"} onClose={onClose} width="max-w-2xl">
      <form noValidate onSubmit={submit} className="flex flex-col gap-3">
        <ComboField label="Classification" required value={chosen} onChange={setClassificationId} options={options} placeholder="Choose how serious it is" />
        <label className="flex flex-col gap-1 text-sm font-medium text-secondary-text" data-required>
          Title
          <input className={inputClass} value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} required aria-required="true" />
        </label>
        <TextAreaField label="What was found" required rows={4} value={description} maxLength={4000} onChange={(e) => setDescription(e.target.value)} />
        <TextAreaField label="Requirement it was measured against" rows={2} value={requirement} maxLength={2000} hint="The standard, procedure or specification, in your own words." onChange={(e) => setRequirement(e.target.value)} />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <ComboField label="Owner" value={ownerId} onChange={setOwnerId} options={(employees.data ?? []).filter((x) => x.active !== false).map((x) => ({ value: x.id, label: x.name, hint: x.jobTitle ?? undefined }))} placeholder="Nobody yet" hint="Who sees that it is dealt with." />
          <RHFDatePickerPopout label="Due" valueFormat="iso" clearable value={dueOn} onChange={(d) => setDueOn(d ?? null)} />
        </div>
        <FormError error={mutation.error} />
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={buttonClass.neutral}>
            Cancel
          </button>
          <button type="submit" disabled={!ok || mutation.isPending} className={buttonClass.primary}>
            {mutation.isPending ? "Saving…" : editing ? "Save finding" : "Raise finding"}
          </button>
        </div>
      </form>
    </Dialog>
  );
};

export default FindingDialog;
