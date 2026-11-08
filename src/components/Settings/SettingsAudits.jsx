import { useState } from "react";
import { PencilIcon, PlusIcon } from "@/components/icons";
import { useToast } from "../../contexts/ToastProvider";
import { useAuditMutation, useFindingClassifications, useUpdateClassification } from "../../hooks/useAudits";
import { usePermissions } from "../../hooks/useQmsApi";
import { describeApiError } from "../../lib/api-client";
import { FINDING_KINDS, FINDING_KIND_PILL, findingKindLabel, SEVERITIES, severityLabel } from "../../lib/audits";
import ComboField from "../ui/ComboField";
import Dialog from "../ui/Dialog";
import LoadingScreen from "../ui/LoadingScreen";
import MenuCard from "../ui/MenuCard";
import Switch from "../ui/Switch";
import { FormError } from "../master-data/shared";
import CTAButton from "@/components/CTAButton";

const inputClass = "w-full rounded-lg border border-border-color bg-text-input-color px-3 py-1.5 text-sm font-normal text-primary-text focus:outline-none focus:border-brand-primary";

/** Add a classification (key, name, kind, default severity) or rename / re-severity one. The key and kind never change once it exists. */
const ClassificationDialog = ({ existing, onClose }) => {
  const mutation = useAuditMutation();
  const update = useUpdateClassification();
  const { showToast } = useToast();
  const [label, setLabel] = useState(existing?.label ?? "");
  const [key, setKey] = useState("");
  const [kind, setKind] = useState(existing?.kind ?? "nonconformity");
  const [severity, setSeverity] = useState(existing?.defaultSeverity ?? null);
  const isNc = (existing?.kind ?? kind) === "nonconformity";
  const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
  const keyValue = key || slug(label);
  const ok = label.trim() && (existing || /^[a-z][a-z0-9_]{1,40}$/.test(keyValue));
  const save = (e) => {
    e.preventDefault();
    if (!ok) return;
    if (existing) {
      update.mutate(
        { id: existing.id, body: { label: label.trim(), defaultSeverity: isNc ? severity : null } },
        { onSuccess: () => onClose(), onError: (err) => showToast({ type: "error", title: "Not saved", message: describeApiError(err) }) }
      );
    } else {
      mutation.mutate(
        { path: "/audit-finding-classifications", body: { key: keyValue, label: label.trim(), kind, defaultSeverity: isNc ? (severity ?? null) : null } },
        { onSuccess: () => onClose() }
      );
    }
  };
  return (
    <Dialog title={existing ? `Edit ${existing.label}` : "Add a classification"} onClose={onClose}>
      <form noValidate onSubmit={save} className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-sm font-medium text-secondary-text" data-required>
          Name
          <input className={inputClass} value={label} maxLength={60} onChange={(e) => setLabel(e.target.value)} required aria-required="true" placeholder="e.g. Critical non-conformity" />
        </label>
        {!existing && (
          <label className="flex flex-col gap-1 text-sm font-medium text-secondary-text" data-required>
            Key
            <input className={inputClass} value={keyValue} maxLength={41} onChange={(e) => setKey(e.target.value)} required aria-required="true" />
            <span className="text-xs font-normal">Lower-case letters, digits and underscores. It cannot be changed afterwards.</span>
          </label>
        )}
        <ComboField
          label="Kind"
          required
          disabled={!!existing}
          value={existing?.kind ?? kind}
          onChange={setKind}
          options={FINDING_KINDS}
          hint={existing ? "The kind cannot be changed: it decides whether a finding can be raised as a non-conformance." : "Only a non-conformity can be raised as a non-conformance."}
        />
        {isNc && <ComboField label="Default severity of a non-conformance raised from it" value={severity} onChange={setSeverity} options={SEVERITIES} placeholder="None (choose each time)" />}
        <FormError error={mutation.error ?? update.error} />
        <div className="flex justify-end gap-2">
          <CTAButton buttonType="button" onClick={onClose} type="neutral" size="md">
            Cancel
          </CTAButton>
          <CTAButton buttonType="submit" disabled={!ok || mutation.isPending || update.isPending} type="main" size="lg">
            {existing ? "Save" : "Add classification"}
          </CTAButton>
        </div>
      </form>
    </Dialog>
  );
};

/** Settings → Audits: the classifications a finding can have. */
const SettingsAudits = () => {
  const { can } = usePermissions();
  const canManage = can("audits.manage");
  const { data, isLoading, error } = useFindingClassifications({ all: true });
  const update = useUpdateClassification();
  const { showToast } = useToast();
  const [dialog, setDialog] = useState(null);

  if (isLoading) return <LoadingScreen />;
  if (error) return <p className="p-6 text-error-color">{describeApiError(error)}</p>;
  const toggle = (c, active) => update.mutate({ id: c.id, body: { active } }, { onError: (e) => showToast({ type: "error", title: "Not saved", message: describeApiError(e) }) });

  return (
    <div className="flex flex-col gap-4 p-4">
      <MenuCard
        title="Finding classifications"
        subtitle="How an audit finding is classified. Switch one off to stop it being chosen; findings already using it keep it."
        action={
          canManage && (
            <CTAButton buttonType="button" type="main" size="lg" onClick={() => setDialog({})}>
              <span className="flex items-center gap-1">
                <PlusIcon /> Add classification
              </span>
            </CTAButton>
          )
        }>
        <ul aria-label="Finding classifications" className="flex flex-col divide-y divide-border-color">
          {data.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center gap-3 py-2">
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className={`text-sm font-medium ${c.active ? "text-primary-text" : "text-secondary-text"}`}>{c.label}</span>
                <span className="font-mono text-xs text-secondary-text">{c.key}</span>
              </div>
              <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${FINDING_KIND_PILL[c.kind]}`}>{findingKindLabel(c.kind)}</span>
              <span className="w-28 text-xs text-secondary-text">{c.kind === "nonconformity" ? `Severity: ${severityLabel(c.defaultSeverity)}` : ""}</span>
              <span className="w-24 text-right text-xs tabular-nums text-secondary-text">
                {c.findingCount} {c.findingCount === 1 ? "finding" : "findings"}
              </span>
              <Switch checked={c.active} disabled={!canManage} onChange={(e) => toggle(c, e.target.checked)} aria-label={`${c.label} is in use`} />
              {canManage && (
                <button type="button" aria-label={`Edit ${c.label}`} className="rounded-lg p-1.5 text-primary-text hover:bg-border-color/50 cursor-pointer" onClick={() => setDialog(c)}>
                  <PencilIcon />
                </button>
              )}
            </li>
          ))}
        </ul>
      </MenuCard>
      {dialog && <ClassificationDialog existing={dialog.id ? dialog : undefined} onClose={() => setDialog(null)} />}
    </div>
  );
};

export default SettingsAudits;
