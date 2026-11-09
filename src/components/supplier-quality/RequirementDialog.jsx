import { useState } from "react";
import { PlusIcon, Trash2Icon } from "@/components/icons";
import { usePermissions } from "../../hooks/useQmsApi";
import { useIncomingMutation } from "../../hooks/useIncoming";
import { usePartFamilies } from "../../hooks/useProcessControl";
import { useSupplierClassifications, useSupplierRegister } from "../../hooks/useSupplierQuality";
import { LEVELS, RISKS, STRATEGIES } from "../../lib/incoming";
import CTAButton from "../CTAButton";
import Callout from "../ui/Callout";
import ComboField from "../ui/ComboField";
import Dialog from "../ui/Dialog";
import Field from "../ui/Field";
import { PartPicker } from "../ncr/Pickers";
import { FormError, TextAreaField } from "../master-data/shared";

let bandId = 0;
const band = (over = {}) => ({ id: ++bandId, fromQuantity: "", toQuantity: "", sampleSize: "", acceptNumber: "0", ...over });
const int = (v) => (v === "" || v === null || v === undefined ? null : Number(v));

/**
 * Write or edit a draft inspection requirement. Nothing applies until a different person with approval rights approves it. A requirement that reduces inspection (reduced or skip level,
 * skip-lot, none) is never applied to a part with a critical characteristic, whatever it says.
 */
const RequirementDialog = ({ requirement = null, approved = [], onClose }) => {
  const { can } = usePermissions();
  const mutation = useIncomingMutation();
  const [name, setName] = useState(requirement?.name ?? "");
  const [supplierId, setSupplierId] = useState(requirement?.supplier?.id ?? null);
  const [partId, setPartId] = useState(requirement?.part?.id ?? null);
  const [familyId, setFamilyId] = useState(requirement?.partFamily?.id ?? null);
  const [classificationId, setClassificationId] = useState(requirement?.classification?.id ?? null);
  const [risk, setRisk] = useState(requirement?.riskRating ?? null);
  const [strategy, setStrategy] = useState(requirement?.strategy ?? "full");
  const [level, setLevel] = useState(requirement?.level ?? "normal");
  const [sampleSize, setSampleSize] = useState(requirement?.sampleSize?.toString() ?? "");
  const [percentage, setPercentage] = useState(requirement?.percentage?.toString() ?? "");
  const [skipEvery, setSkipEvery] = useState(requirement?.skipEvery?.toString() ?? "");
  const [acceptNumber, setAcceptNumber] = useState(String(requirement?.acceptNumber ?? 0));
  const [plan, setPlan] = useState((requirement?.plan ?? [{}]).map((b) => band({ fromQuantity: String(b.fromQuantity ?? ""), toQuantity: String(b.toQuantity ?? ""), sampleSize: String(b.sampleSize ?? ""), acceptNumber: String(b.acceptNumber ?? 0) })));
  const [operationCode, setOperationCode] = useState(requirement?.operationCode ?? "INCOMING");
  const [rationale, setRationale] = useState(requirement?.rationale ?? "");
  const [supersedesId, setSupersedesId] = useState(requirement?.supersedesId ?? null);
  const [supplierSearch, setSupplierSearch] = useState("");
  const suppliers = useSupplierRegister({ q: supplierSearch || undefined, pageSize: 25 });
  const families = usePartFamilies({});
  const classifications = useSupplierClassifications();

  const fields = STRATEGIES.find((s) => s.value === strategy)?.fields ?? [];
  const reduces = level === "reduced" || level === "skip" || strategy === "none" || strategy === "skip_lot";
  const needs = {
    sampleSize: !fields.includes("sampleSize") || Number(sampleSize) >= 1,
    percentage: !fields.includes("percentage") || (Number(percentage) > 0 && Number(percentage) <= 100),
    skipEvery: !fields.includes("skipEvery") || Number(skipEvery) >= 2,
    plan: !fields.includes("plan") || (plan.length > 0 && plan.every((b) => int(b.fromQuantity) >= 1 && int(b.toQuantity) >= int(b.fromQuantity) && int(b.sampleSize) >= 1 && int(b.acceptNumber) >= 0 && int(b.acceptNumber) < int(b.sampleSize))),
  };
  const ok = name.trim() && operationCode.trim() && Object.values(needs).every(Boolean);

  const submit = () => {
    const body = {
      name: name.trim(), supplierId, partId, partFamilyId: familyId, classificationId, riskRating: risk, strategy, level, operationCode: operationCode.trim(), rationale: rationale.trim() || null, supersedesId,
      sampleSize: fields.includes("sampleSize") ? int(sampleSize) : null,
      percentage: fields.includes("percentage") ? Number(percentage) : null,
      skipEvery: fields.includes("skipEvery") ? int(skipEvery) : null,
      acceptNumber: fields.includes("acceptNumber") ? (int(acceptNumber) ?? 0) : 0,
      plan: fields.includes("plan") ? plan.map((b) => ({ fromQuantity: int(b.fromQuantity), toQuantity: int(b.toQuantity), sampleSize: int(b.sampleSize), acceptNumber: int(b.acceptNumber) ?? 0 })) : null,
    };
    mutation.mutate(requirement ? { action: "updateRequirement", id: requirement.id, body } : { action: "createRequirement", body }, { onSuccess: onClose });
  };
  const patchBand = (id, changes) => setPlan((p) => p.map((b) => (b.id === id ? { ...b, ...changes } : b)));

  return (
    <Dialog title={requirement ? "Edit the draft requirement" : "Write an inspection requirement"} onClose={onClose} width="max-w-3xl">
      <form noValidate className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); if (ok && !mutation.isPending) submit(); }}>
        <p className="text-sm text-secondary-text">What to inspect when a delivery arrives. It is a draft until a different person with approval rights approves it. The most specific approved requirement that fits a delivery is the one used.</p>
        <Field label="Name" required value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder="For example: Acme castings, 10% sample" />
        <fieldset className="grid gap-3 rounded-lg border border-border-color p-3 sm:grid-cols-2">
          <legend className="px-1 text-sm font-medium text-secondary-text">Applies to (leave all empty for the default)</legend>
          <ComboField label="Supplier" clearable value={supplierId} onChange={setSupplierId} placeholder="Any supplier" filterLocally={false} onSearchChange={setSupplierSearch}
            options={(suppliers.data?.data ?? []).map((s) => ({ value: s.id, label: `${s.code} · ${s.displayName || s.name}` }))} />
          {can("master_data.read") && <PartPicker label="Part" value={partId} onChange={(id) => setPartId(id)} clearable />}
          <ComboField label="Part family" clearable value={familyId} onChange={setFamilyId} placeholder="Any family" options={(families.data?.items ?? []).map((f) => ({ value: f.id, label: f.name }))} />
          <ComboField label="Supplier classification" clearable value={classificationId} onChange={setClassificationId} placeholder="Any classification" options={(classifications.data?.data ?? []).filter((c) => c.active).map((c) => ({ value: c.id, label: c.label }))} />
          <ComboField label="Supplier risk" clearable value={risk} onChange={setRisk} placeholder="Any risk" options={RISKS} />
        </fieldset>
        <div className="grid gap-3 sm:grid-cols-2">
          <ComboField label="What to inspect" required value={strategy} onChange={setStrategy} options={STRATEGIES.map((s) => ({ value: s.value, label: s.label, hint: s.hint }))} />
          <ComboField label="Inspection level" required value={level} onChange={setLevel} options={LEVELS} hint="Reduced and skip are controls being relaxed" />
        </div>
        {(fields.includes("sampleSize") || fields.includes("percentage") || fields.includes("skipEvery") || fields.includes("acceptNumber")) && (
          <div className="grid gap-3 sm:grid-cols-4">
            {fields.includes("sampleSize") && <Field label="Sample size" required type="number" min="1" value={sampleSize} onChange={(e) => setSampleSize(e.target.value)} />}
            {fields.includes("percentage") && <Field label="Percentage" required type="number" min="0" max="100" step="any" value={percentage} onChange={(e) => setPercentage(e.target.value)} />}
            {fields.includes("skipEvery") && <Field label="Inspect every Nth delivery" required type="number" min="2" value={skipEvery} onChange={(e) => setSkipEvery(e.target.value)} />}
            {fields.includes("acceptNumber") && <Field label="Failing samples allowed" type="number" min="0" value={acceptNumber} onChange={(e) => setAcceptNumber(e.target.value)} hint="0 = any failure rejects" />}
          </div>
        )}
        {fields.includes("plan") && (
          <fieldset className="flex flex-col gap-2">
            <legend className="text-sm font-medium text-secondary-text">Sampling plan: bands of lot size</legend>
            {plan.map((b, i) => (
              <div key={b.id} className="grid gap-2 sm:grid-cols-5">
                <Field label={`Band ${i + 1} from`} type="number" min="1" value={b.fromQuantity} onChange={(e) => patchBand(b.id, { fromQuantity: e.target.value })} />
                <Field label={`Band ${i + 1} to`} type="number" min="1" value={b.toQuantity} onChange={(e) => patchBand(b.id, { toQuantity: e.target.value })} />
                <Field label={`Band ${i + 1} sample size`} type="number" min="1" value={b.sampleSize} onChange={(e) => patchBand(b.id, { sampleSize: e.target.value })} />
                <Field label={`Band ${i + 1} accept`} type="number" min="0" value={b.acceptNumber} onChange={(e) => patchBand(b.id, { acceptNumber: e.target.value })} />
                <div className="flex items-end">{plan.length > 1 && <button type="button" aria-label={`Remove band ${i + 1}`} className="p-2 text-secondary-text hover:text-error-color" onClick={() => setPlan((p) => p.filter((x) => x.id !== b.id))}><Trash2Icon /></button>}</div>
              </div>
            ))}
            <CTAButton buttonType="button" type="secondary" size="default" icon={PlusIcon} className="self-start" onClick={() => setPlan((p) => [...p, band()])}>Add a band</CTAButton>
            <p className="text-xs text-secondary-text">Enter the table your organisation uses. A lot outside every band is inspected in full.</p>
          </fieldset>
        )}
        <Field label="Control plan operation" required value={operationCode} onChange={(e) => setOperationCode(e.target.value)} maxLength={40} hint="The operation of the part's control plan that holds the incoming checks" />
        <ComboField label="Replaces" clearable value={supersedesId} onChange={setSupersedesId} placeholder="Nothing: a new requirement" options={approved.filter((a) => a.id !== requirement?.id).map((a) => ({ value: a.id, label: a.name }))} hint="Approving this one then supersedes the old one" />
        <TextAreaField label="Why" value={rationale} onChange={(e) => setRationale(e.target.value)} maxLength={1000} rows={2} hint="Kept with the requirement" />
        {reduces && <Callout tone="warning" title="This reduces inspection">An approver must give a reason. It is never applied to a part with a critical characteristic (or without a usable control plan): those are inspected in full.</Callout>}
        <FormError error={mutation.error} />
        <div className="flex justify-end gap-2">
          <CTAButton buttonType="button" type="neutral" size="md" onClick={onClose}>Cancel</CTAButton>
          <CTAButton buttonType="submit" type="main" size="lg" disabled={!ok || mutation.isPending}>{mutation.isPending ? "Saving…" : requirement ? "Save draft" : "Save as draft"}</CTAButton>
        </div>
      </form>
    </Dialog>
  );
};

export default RequirementDialog;
