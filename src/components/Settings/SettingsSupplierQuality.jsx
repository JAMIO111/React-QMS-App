import { useState } from "react";
import { PencilIcon, PlusIcon, Trash2Icon } from "@/components/icons";
import { useToast } from "../../contexts/ToastProvider";
import { usePermissions } from "../../hooks/useQmsApi";
import { useRiskModel, useRiskMutation, useSupplierClassifications, useSupplierMutation } from "../../hooks/useSupplierQuality";
import { formatDateTime } from "../../lib/processControl";
import AssessmentTemplatesCard from "../supplier-quality/AssessmentTemplates";
import ScorecardModelCard from "../supplier-quality/ScorecardModel";
import { factorKey } from "../../lib/supplierRisk";
import { describeApiError } from "../../lib/api-client";
import Dialog from "../ui/Dialog";
import Field from "../ui/Field";
import LoadingScreen from "../ui/LoadingScreen";
import MenuCard from "../ui/MenuCard";
import Switch from "../ui/Switch";
import { ErrorNotice, FormError } from "../master-data/shared";
import CTAButton from "@/components/CTAButton";

/** Add a classification or rename / describe one. The key is made from the name once and never changes. */
const ClassificationDialog = ({ existing, onClose }) => {
  const mutation = useSupplierMutation();
  const { showToast } = useToast();
  const [label, setLabel] = useState(existing?.label ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const save = (e) => {
    e.preventDefault();
    if (!label.trim()) return;
    const body = { label: label.trim(), description: description.trim() || null };
    mutation.mutate(existing ? { action: "updateClassification", id: existing.id, body } : { action: "createClassification", body }, {
      onSuccess: () => onClose(),
      onError: (err) => showToast({ type: "error", title: "Not saved", message: describeApiError(err) }),
    });
  };
  return (
    <Dialog title={existing ? `Edit ${existing.label}` : "Add a classification"} onClose={onClose}>
      <form noValidate onSubmit={save} className="flex flex-col gap-3">
        <Field label="Name" value={label} onChange={(e) => setLabel(e.target.value)} required maxLength={60} placeholder="e.g. Casting foundry" />
        <Field label="Description" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} hint="Optional" />
        <FormError error={mutation.error} />
        <div className="flex justify-end gap-2">
          <CTAButton buttonType="button" type="neutral" size="md" onClick={onClose}>
            Cancel
          </CTAButton>
          <CTAButton buttonType="submit" type="main" size="md" disabled={mutation.isPending || !label.trim()} loading={mutation.isPending}>
            {mutation.isPending ? "Saving…" : "Save"}
          </CTAButton>
        </div>
      </form>
    </Dialog>
  );
};

/** A new version of the risk model: factors and weights, which factors raise the rating, the band thresholds and the review interval. Earlier versions and assessments are untouched. */
const RiskModelDialog = ({ model, onClose }) => {
  const mutation = useRiskMutation();
  const [factors, setFactors] = useState(model.factors.map((f) => ({ ...f, fresh: false })));
  const [t, setT] = useState({ mediumFrom: String(model.thresholds.mediumFrom), highFrom: String(model.thresholds.highFrom), criticalFrom: String(model.thresholds.criticalFrom) });
  const [months, setMonths] = useState(String(model.reviewIntervalMonths));
  const [reason, setReason] = useState("");
  const [problem, setProblem] = useState(null);
  const update = (i, patch) => setFactors((fs) => fs.map((f, n) => (n === i ? { ...f, ...patch } : f)));

  const submit = (e) => {
    e.preventDefault();
    setProblem(null);
    const nums = { mediumFrom: Number(t.mediumFrom), highFrom: Number(t.highFrom), criticalFrom: Number(t.criticalFrom) };
    if (factors.length === 0) return setProblem("Keep at least one factor.");
    if (factors.some((f) => !f.label.trim())) return setProblem("Every factor needs a name.");
    if (!(nums.mediumFrom > 1 && nums.mediumFrom < nums.highFrom && nums.highFrom < nums.criticalFrom && nums.criticalFrom <= 4)) return setProblem("The bands must rise: above 1, medium below high below critical, and no more than 4.");
    if (!(Number(months) >= 1 && Number(months) <= 60)) return setProblem("The review interval is 1 to 60 months.");
    if (reason.trim().length < 3) return setProblem("Say why the model is changing.");
    const taken = [];
    const body = {
      factors: factors.map((f) => {
        const key = f.fresh ? factorKey(f.label, taken) : f.key;
        taken.push(key);
        return { key, label: f.label.trim(), description: (f.description ?? "").trim(), weight: Number(f.weight), escalates: !!f.escalates };
      }),
      thresholds: nums,
      reviewIntervalMonths: Number(months),
      reason: reason.trim(),
    };
    mutation.mutate({ action: "saveModel", body }, { onSuccess: onClose });
  };

  return (
    <Dialog title="Change the risk model" onClose={onClose} width="max-w-3xl">
      <form noValidate className="flex flex-col gap-4" onSubmit={submit}>
        <p className="text-sm text-secondary-text">This saves version {model.version + 1}. Assessments already made keep the version they were scored on; new ones use this one.</p>
        <ul className="flex flex-col gap-3" aria-label="Factors">
          {factors.map((f, i) => (
            <li key={f.key + i} className="flex flex-col gap-2 rounded-lg border border-border-color p-3">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_6rem_auto]">
                <Field label="Factor" required value={f.label} onChange={(e) => update(i, { label: e.target.value })} maxLength={80} />
                <Field label="Weight" required type="number" min={1} max={10} value={f.weight} onChange={(e) => update(i, { weight: e.target.value })} />
                <div className="flex items-end gap-2 pb-1">
                  <Switch checked={f.escalates} onChange={(e) => update(i, { escalates: e.target.checked })} aria-label={`${f.label || "Factor"} raises the rating when critical`} />
                  <span className="text-xs text-secondary-text">Critical raises the rating</span>
                  <button type="button" aria-label={`Remove ${f.label || "factor"}`} className="rounded-lg p-1.5 text-secondary-text hover:text-error-color cursor-pointer" onClick={() => setFactors((fs) => fs.filter((_, n) => n !== i))}>
                    <Trash2Icon size={16} />
                  </button>
                </div>
              </div>
              <Field label="What it asks" value={f.description ?? ""} onChange={(e) => update(i, { description: e.target.value })} maxLength={500} />
            </li>
          ))}
        </ul>
        <div>
          <CTAButton buttonType="button" type="secondary" size="default" icon={PlusIcon} iconSize="h-4 w-4" onClick={() => setFactors((fs) => [...fs, { key: "", label: "", description: "", weight: 3, escalates: false, fresh: true }])}>Add factor</CTAButton>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
          <Field label="Medium from" type="number" step="0.05" value={t.mediumFrom} onChange={(e) => setT((x) => ({ ...x, mediumFrom: e.target.value }))} hint="Weighted score, 1 to 4" />
          <Field label="High from" type="number" step="0.05" value={t.highFrom} onChange={(e) => setT((x) => ({ ...x, highFrom: e.target.value }))} />
          <Field label="Critical from" type="number" step="0.05" value={t.criticalFrom} onChange={(e) => setT((x) => ({ ...x, criticalFrom: e.target.value }))} />
          <Field label="Review every (months)" type="number" min={1} max={60} value={months} onChange={(e) => setMonths(e.target.value)} />
        </div>
        <Field label="Why is it changing?" required value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} />
        {problem && <p role="alert" className="text-sm text-error-color">{problem}</p>}
        <FormError error={mutation.error} />
        <div className="flex justify-end gap-2">
          <CTAButton buttonType="button" type="neutral" size="md" onClick={onClose}>Cancel</CTAButton>
          <CTAButton buttonType="submit" type="main" size="md" disabled={mutation.isPending} loading={mutation.isPending}>{mutation.isPending ? "Saving…" : "Save new version"}</CTAButton>
        </div>
      </form>
    </Dialog>
  );
};

/** The risk model in force: how supplier risk is scored. */
const RiskModelCard = ({ canConfigure }) => {
  const query = useRiskModel();
  const [open, setOpen] = useState(false);
  if (query.isLoading) return null;
  if (query.error) return <ErrorNotice error={query.error} />;
  const m = query.data;
  return (
    <MenuCard
      title="Supplier risk model"
      subtitle={`How risk assessments are scored (version ${m.version}). Each factor is scored low to critical; the weighted score gives a band, and a critical score on a factor that raises the rating lifts it to at least high.`}
      action={canConfigure && <CTAButton buttonType="button" type="secondary" size="default" onClick={() => setOpen(true)}>Change the model</CTAButton>}>
      <table className="w-full text-left text-sm" aria-label="Risk factors">
        <thead>
          <tr className="text-secondary-text">
            <th className="py-1 pr-3 font-medium">Factor</th>
            <th className="py-1 pr-3 font-medium">Weight</th>
            <th className="py-1 font-medium">Critical raises the rating</th>
          </tr>
        </thead>
        <tbody>
          {m.factors.map((f) => (
            <tr key={f.key} className="border-t border-border-color">
              <td className="py-1.5 pr-3 text-primary-text">{f.label}{f.description ? <span className="block text-xs text-secondary-text">{f.description}</span> : null}</td>
              <td className="py-1.5 pr-3 tabular-nums text-primary-text">{f.weight}</td>
              <td className="py-1.5 text-primary-text">{f.escalates ? "Yes" : "No"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-3 text-sm text-secondary-text">
        Medium from {m.thresholds.mediumFrom} · high from {m.thresholds.highFrom} · critical from {m.thresholds.criticalFrom} · review every {m.reviewIntervalMonths} months
      </p>
      <details className="mt-2">
        <summary className="cursor-pointer text-sm text-secondary-text">Versions ({m.versions.length})</summary>
        <ul className="mt-2 flex flex-col gap-1 text-sm text-secondary-text" aria-label="Model versions">
          {m.versions.map((v) => (
            <li key={v.version}>Version {v.version} · {formatDateTime(v.createdAt)}{v.createdBy ? ` · ${v.createdBy.name}` : ""} · {v.reason}</li>
          ))}
        </ul>
      </details>
      {open && <RiskModelDialog model={m} onClose={() => setOpen(false)} />}
    </MenuCard>
  );
};

/** Settings → Supplier quality: the classifications a supplier can have (organisation-configurable; switch off, never delete). */
const SettingsSupplierQuality = () => {
  const { can } = usePermissions();
  const canConfigure = can("supplier_quality.configure");
  const list = useSupplierClassifications({ all: true });
  const mutation = useSupplierMutation();
  const { showToast } = useToast();
  const [dialog, setDialog] = useState(null);
  if (list.isLoading) return <LoadingScreen />;
  if (list.error) return <ErrorNotice error={list.error} />;
  const toggle = (c, active) =>
    mutation.mutate({ action: "updateClassification", id: c.id, body: { active } }, { onError: (err) => showToast({ type: "error", title: "Not saved", message: describeApiError(err) }) });

  return (
    <div className="flex w-full flex-col gap-4">
      <MenuCard
        title="Supplier classifications"
        subtitle="What kind of supplier each one is. A supplier can have several. Switch one off to stop it being chosen; suppliers that already have it keep it."
        action={canConfigure && (
          <CTAButton buttonType="button" type="main" size="lg" onClick={() => setDialog({})}>
            <span className="flex items-center gap-1">
              <PlusIcon /> Add classification
            </span>
          </CTAButton>
        )}>
        <ul aria-label="Supplier classifications" className="flex flex-col divide-y divide-border-color">
          {list.data.data.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center gap-3 py-2">
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className={`text-sm font-medium ${c.active ? "text-primary-text" : "text-secondary-text"}`}>{c.label}</span>
                {c.description && <span className="text-xs text-secondary-text">{c.description}</span>}
              </div>
              <span className="w-28 text-right text-xs tabular-nums text-secondary-text">
                {c.suppliers} {c.suppliers === 1 ? "supplier" : "suppliers"}
              </span>
              <Switch checked={c.active} disabled={!canConfigure} onChange={(e) => toggle(c, e.target.checked)} aria-label={`${c.label} is in use`} />
              {canConfigure && (
                <button type="button" aria-label={`Edit ${c.label}`} className="rounded-lg p-1.5 text-primary-text hover:bg-border-color/50 cursor-pointer" onClick={() => setDialog(c)}>
                  <PencilIcon />
                </button>
              )}
            </li>
          ))}
        </ul>
      </MenuCard>
      <AssessmentTemplatesCard canConfigure={canConfigure} />
      <RiskModelCard canConfigure={canConfigure} />
      <ScorecardModelCard canConfigure={canConfigure} />
      {dialog && <ClassificationDialog existing={dialog.id ? dialog : undefined} onClose={() => setDialog(null)} />}
    </div>
  );
};

export default SettingsSupplierQuality;
