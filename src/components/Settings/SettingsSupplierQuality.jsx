import { useState } from "react";
import { PencilIcon, PlusIcon } from "@/components/icons";
import { useToast } from "../../contexts/ToastProvider";
import { usePermissions } from "../../hooks/useQmsApi";
import { useSupplierClassifications, useSupplierMutation } from "../../hooks/useSupplierQuality";
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
          <CTAButton buttonType="submit" type="main" size="md" disabled={mutation.isPending || !label.trim()}>
            {mutation.isPending ? "Saving…" : "Save"}
          </CTAButton>
        </div>
      </form>
    </Dialog>
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
    <div className="flex flex-col gap-4 p-4">
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
      {dialog && <ClassificationDialog existing={dialog.id ? dialog : undefined} onClose={() => setDialog(null)} />}
    </div>
  );
};

export default SettingsSupplierQuality;
