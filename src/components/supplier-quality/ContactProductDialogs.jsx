import { useState } from "react";
import { useToast } from "../../contexts/ToastProvider";
import { useSupplierMutation } from "../../hooks/useSupplierQuality";
import { describeApiError } from "../../lib/api-client";
import { CONTACT_ROLES, PRODUCT_KINDS } from "../../lib/supplierQuality";
import Dialog from "../ui/Dialog";
import Field from "../ui/Field";
import RHFComboBox from "../ui/RHFComboBox";
import Switch from "../ui/Switch";
import { PartPicker } from "../ncr/Pickers";
import { FormError } from "../master-data/shared";
import CTAButton from "@/components/CTAButton";

const nul = (v) => (typeof v === "string" ? v.trim() || null : v);
const area = "rounded-lg border border-border-color bg-text-input-color px-3 py-2 text-sm font-normal text-primary-text focus:outline-none focus:border-brand-primary";

/** Add or edit a supplier contact. A contact is deactivated, never deleted; a new primary contact replaces the old one. */
export const ContactDialog = ({ supplierId, contact, onClose }) => {
  const mutation = useSupplierMutation();
  const { showToast } = useToast();
  const [form, setForm] = useState({
    name: contact?.name ?? "", jobTitle: contact?.jobTitle ?? "", role: contact?.role ?? "other", email: contact?.email ?? "", phone: contact?.phone ?? "",
    isPrimary: contact?.isPrimary ?? false, active: contact?.active ?? true, notes: contact?.notes ?? "",
  });
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const submit = (e) => {
    e.preventDefault();
    if (!form.name.trim()) return;
    const body = { name: form.name.trim(), jobTitle: nul(form.jobTitle), role: form.role, email: nul(form.email), phone: nul(form.phone), isPrimary: form.isPrimary && form.active, notes: nul(form.notes), ...(contact ? { active: form.active } : {}) };
    mutation.mutate(contact ? { action: "updateContact", id: contact.id, body } : { action: "addContact", id: supplierId, body }, {
      onSuccess: () => onClose(),
      onError: (err) => showToast({ type: "error", title: "Not saved", message: describeApiError(err) }),
    });
  };
  return (
    <Dialog title={contact ? `Edit ${contact.name}` : "Add contact"} onClose={onClose}>
      <form noValidate onSubmit={submit} className="flex flex-col gap-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Name" value={form.name} onChange={set("name")} required maxLength={120} />
          <Field label="Job title" value={form.jobTitle} onChange={set("jobTitle")} maxLength={120} />
          <RHFComboBox label="Role" value={form.role} onChange={(v) => setForm((f) => ({ ...f, role: v ?? "other" }))} options={CONTACT_ROLES} sort={false} />
          <Field label="Phone" value={form.phone} onChange={set("phone")} maxLength={40} />
          <Field label="Email" value={form.email} onChange={set("email")} maxLength={200} className="sm:col-span-2" />
        </div>
        <label className="flex flex-col gap-1 text-sm font-medium text-secondary-text">
          Notes
          <textarea className={area} rows={2} maxLength={1000} value={form.notes} onChange={set("notes")} />
        </label>
        <Switch className="text-sm text-primary-text" checked={form.isPrimary && form.active} disabled={!form.active} onChange={(e) => setForm((f) => ({ ...f, isPrimary: e.target.checked }))}>
          Primary contact (replaces the current one)
        </Switch>
        {contact && (
          <Switch className="text-sm text-primary-text" checked={form.active} onChange={(e) => setForm((f) => ({ ...f, active: e.target.checked }))}>
            Active
          </Switch>
        )}
        <FormError error={mutation.error} />
        <div className="flex justify-end gap-2">
          <CTAButton buttonType="button" type="neutral" size="md" onClick={onClose}>
            Cancel
          </CTAButton>
          <CTAButton buttonType="submit" type="main" size="md" disabled={mutation.isPending || !form.name.trim()} loading={mutation.isPending}>
            {mutation.isPending ? "Saving…" : "Save"}
          </CTAButton>
        </div>
      </form>
    </Dialog>
  );
};

/** Link a part of ours, or describe a material or service, that this supplier supplies. What is supplied cannot be changed afterwards: end the link and add another. */
export const ProductDialog = ({ supplierId, onClose }) => {
  const mutation = useSupplierMutation();
  const { showToast } = useToast();
  const [kind, setKind] = useState("part");
  const [part, setPart] = useState(null);
  const [description, setDescription] = useState("");
  const [supplierPartNumber, setSupplierPartNumber] = useState("");
  const [notes, setNotes] = useState("");
  const ok = kind === "part" ? !!part?.id : !!description.trim();
  const submit = (e) => {
    e.preventDefault();
    if (!ok) return;
    mutation.mutate(
      { action: "addProduct", id: supplierId, body: { kind, ...(kind === "part" ? { partId: part.id } : { description: description.trim() }), supplierPartNumber: nul(supplierPartNumber), notes: nul(notes) } },
      { onSuccess: () => onClose(), onError: (err) => showToast({ type: "error", title: "Not linked", message: describeApiError(err) }) }
    );
  };
  return (
    <Dialog title="Add product or service" onClose={onClose}>
      <form noValidate onSubmit={submit} className="flex flex-col gap-3">
        <RHFComboBox label="Kind" value={kind} onChange={(v) => { setKind(v ?? "part"); setPart(null); }} options={PRODUCT_KINDS} sort={false} required />
        {kind === "part" ? (
          <PartPicker label="Part" required value={part?.id ?? null} current={part?.id ? { id: part.id, partNumber: part.name ?? "" } : undefined} onChange={(id, item) => setPart(id ? { id, name: item?.name } : null)} />
        ) : (
          <Field label={kind === "material" ? "Material" : "Service"} required value={description} onChange={(e) => setDescription(e.target.value)} maxLength={200} hint={kind === "material" ? "e.g. 316L bar, 25 mm" : "e.g. Case hardening"} />
        )}
        <Field label="Supplier's own part number" value={supplierPartNumber} onChange={(e) => setSupplierPartNumber(e.target.value)} maxLength={60} />
        <label className="flex flex-col gap-1 text-sm font-medium text-secondary-text">
          Notes
          <textarea className={area} rows={2} maxLength={1000} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>
        <FormError error={mutation.error} />
        <div className="flex justify-end gap-2">
          <CTAButton buttonType="button" type="neutral" size="md" onClick={onClose}>
            Cancel
          </CTAButton>
          <CTAButton buttonType="submit" type="main" size="md" disabled={mutation.isPending || !ok} loading={mutation.isPending}>
            {mutation.isPending ? "Saving…" : "Add"}
          </CTAButton>
        </div>
      </form>
    </Dialog>
  );
};
