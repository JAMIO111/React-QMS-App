import { useState } from "react";
import { useToast } from "../../contexts/ToastProvider";
import { useSupplierClassifications, useSupplierMutation } from "../../hooks/useSupplierQuality";
import { describeApiError } from "../../lib/api-client";
import { SUPPLIER_TYPES } from "../../lib/supplierQuality";
import Dialog from "../ui/Dialog";
import Field from "../ui/Field";
import RHFComboBox from "../ui/RHFComboBox";
import Switch from "../ui/Switch";
import { FormError } from "../master-data/shared";
import AddressFields from "../master-data/AddressFields";
import CompanyContactFields from "../master-data/CompanyContactFields";
import { addressBody, EMPTY_ADDRESS } from "../../lib/address";
import CTAButton from "@/components/CTAButton";
import { CustomFieldInputs } from "../custom-fields/CustomFieldsCard";
import { withCustomValues } from "../../lib/customFields";
import { changesSince } from "../../lib/editConflicts";
import { useImportLocks } from "../../hooks/useImportLocks";
import LockedMark from "../ui/LockedMark";

const emptyForm = {
  code: "", name: "", displayName: "", supplierType: null, ...EMPTY_ADDRESS,
  website: "", email: "", phone: "", purchasingReference: "", companyNumber: "", vatNumber: "", notes: "", active: true,
};
const nullIfEmpty = (v) => (typeof v === "string" ? v.trim() || null : v);

/** Add a supplier (it always starts Pending Approval) or edit one. Approval status is changed separately, with a reason, never here. */
const SupplierDialog = ({ supplier, onClose, onSaved }) => {
  const mutation = useSupplierMutation();
  const classifications = useSupplierClassifications({ all: !!supplier });
  const { showToast } = useToast();
  const editing = !!supplier;
  const [form, setForm] = useState(editing ? { ...emptyForm, ...Object.fromEntries(Object.entries(supplier).filter(([k]) => k in emptyForm).map(([k, v]) => [k, v ?? emptyForm[k]])) } : emptyForm);
  const [classIds, setClassIds] = useState(editing ? supplier.classifications.map((c) => c.id) : []);
  const [customValues, setCustomValues] = useState({});
  const [opened] = useState(supplier);
  const { lock } = useImportLocks("supplier", supplier?.id);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const pick = (k) => (v) => setForm((f) => ({ ...f, [k]: v ?? null }));
  const options = classifications.data?.data ?? [];
  const toggleClass = (id) => setClassIds((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  const submit = (e) => {
    e.preventDefault();
    if (!form.name.trim() || (!editing && !form.code.trim())) return;
    const body = {
      ...(editing ? { active: form.active } : { code: form.code.trim() }),
      name: form.name.trim(),
      displayName: nullIfEmpty(form.displayName),
      supplierType: form.supplierType,
      ...addressBody(form),
      website: nullIfEmpty(form.website),
      email: nullIfEmpty(form.email),
      phone: nullIfEmpty(form.phone),
      purchasingReference: nullIfEmpty(form.purchasingReference),
      companyNumber: nullIfEmpty(form.companyNumber),
      vatNumber: nullIfEmpty(form.vatNumber),
      notes: nullIfEmpty(form.notes),
    };
    const fail = (err) => showToast({ type: "error", title: "Not saved", message: describeApiError(err) });
    if (editing) {
      // An edit shows at once and the dialog closes; useSupplierMutation puts it back with a toast when refused. Classifications follow the edit
      // (never alongside it: both change the supplier, and the edit carries the version it was based on).
      const changedClasses = supplier.classifications.map((c) => c.id).sort().join(",") !== [...classIds].sort().join(",");
      const show = changedClasses ? { classifications: options.filter((c) => classIds.includes(c.id)).map((c) => ({ id: c.id, label: c.label })) } : {};
      mutation
        .mutateAsync({ action: "update", id: supplier.id, body: changesSince(opened, body), show })
        .then((saved) => {
          onSaved?.(saved);
          if (changedClasses) mutation.mutate({ action: "classifications", id: supplier.id, body: { classificationIds: classIds }, show });
        })
        .catch(() => {}); // toasted by the hook
      onClose();
    } else {
      mutation.mutate(
        { action: "create", body: { ...body, classificationIds: classIds, ...withCustomValues(customValues) } },
        {
          onSuccess: (saved) => {
            showToast({ type: "success", title: "Saved", message: "The supplier was added. It is Pending Approval." });
            onSaved?.(saved);
            onClose();
          },
          onError: fail,
        }
      );
    }
  };

  return (
    <Dialog title={editing ? `Edit ${supplier.code}` : "Add supplier"} onClose={onClose} width="max-w-3xl">
      <form noValidate onSubmit={submit} className="flex flex-col gap-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {!editing && <Field label="Code" value={form.code} onChange={set("code")} required maxLength={20} hint="Short reference, e.g. ACME" />}
          <Field label="Legal name" value={form.name} onChange={set("name")} required maxLength={200} {...lock("name")} />
          <Field label="Trading name" value={form.displayName} onChange={set("displayName")} maxLength={100} hint="Shown in lists (optional)" {...lock("displayName")} />
          <RHFComboBox label="Supplier type" value={form.supplierType} onChange={pick("supplierType")} options={SUPPLIER_TYPES} placeholder="Choose a type" clearable sort={false} {...lock("supplierType")} />
          <Field label="Purchasing reference" value={form.purchasingReference} onChange={set("purchasingReference")} maxLength={60} hint="Their account or vendor number in purchasing" {...lock("purchasingReference")} />
          <Field label="Company number" value={form.companyNumber} onChange={set("companyNumber")} maxLength={40} {...lock("companyNumber")} />
          <Field label="VAT number" value={form.vatNumber} onChange={set("vatNumber")} maxLength={40} {...lock("vatNumber")} />
          <CompanyContactFields form={form} set={set} lock={lock} />
          <AddressFields form={form} set={set} pick={pick} lock={lock} />
        </div>
        <fieldset>
          <legend className="text-sm font-medium text-secondary-text">Classifications</legend>
          <div className="mt-1 flex flex-wrap gap-1">
            {options.length === 0 && <span className="text-sm text-secondary-text">None configured yet.</span>}
            {options.map((c) => {
              const on = classIds.includes(c.id);
              return (
                <label key={c.id} className={`cursor-pointer rounded-full border px-2 py-0.5 text-xs ${on ? "border-brand-primary bg-brand-primary text-white" : "border-border-color hover:bg-border-color/40"} ${!c.active ? "opacity-60" : ""}`}>
                  <input type="checkbox" className="sr-only" checked={on} onChange={() => toggleClass(c.id)} disabled={!c.active && !on} />
                  {c.label}
                  {!c.active && " (off)"}
                </label>
              );
            })}
          </div>
        </fieldset>
        <label className="flex flex-col gap-1 text-sm font-medium text-secondary-text">
          <span>
            Notes
            {lock("notes").lockedBy && <LockedMark by={lock("notes").lockedBy} />}
          </span>
          <textarea value={form.notes} onChange={set("notes")} disabled={!!lock("notes").lockedBy} maxLength={2000} rows={3} className="rounded-lg border border-border-color bg-text-input-color px-3 py-2 text-sm font-normal text-primary-text focus:outline-none focus:border-brand-primary" />
        </label>
        {editing && (
          <Switch className="text-sm text-primary-text" checked={form.active} onChange={(e) => setForm((f) => ({ ...f, active: e.target.checked }))} {...lock("active")}>
            Active (inactive suppliers are hidden from pickers; this is separate from approval)
          </Switch>
        )}
        {!editing && <CustomFieldInputs entityType="supplier" values={customValues} onChange={setCustomValues} />}
        {!editing && <p className="text-xs text-secondary-text">A new supplier is Pending Approval. Approval is decided separately, by someone who may approve, with a reason.</p>}
        <FormError error={mutation.error} />
        <div className="flex justify-end gap-2">
          <CTAButton buttonType="button" type="neutral" size="md" onClick={onClose}>
            Cancel
          </CTAButton>
          <CTAButton buttonType="submit" type="main" size="md" disabled={(!editing && mutation.isPending) || !form.name.trim() || (!editing && !form.code.trim())} loading={!editing && mutation.isPending}>
            {!editing && mutation.isPending ? "Saving…" : editing ? "Save" : "Add supplier"}
          </CTAButton>
        </div>
      </form>
    </Dialog>
  );
};

export default SupplierDialog;
