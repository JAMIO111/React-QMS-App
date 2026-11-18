import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import CTAButton from "@/components/CTAButton";
import Switch from "@/components/ui/Switch";
import Dialog from "../ui/Dialog";
import Field from "../ui/Field";
import ComboField from "../ui/ComboField";
import { FormError, TextAreaField } from "./shared";
import { useOrganisation } from "../../contexts/OrganisationProvider";
import { apiFetch } from "../../lib/api-client";
import { refreshOrganisation } from "../../lib/refresh";
import { CONTACT_ROLES, contactRoleLabel } from "../../lib/supplierQuality";

const keyOf = (org, id) => ["api", "org", org, "customer-contacts", id];

/** A customer's contacts (X17): several, one primary, deactivated never deleted. Staff data; the customer never sees it in the portal. */
export default function CustomerContacts({ customerId, canManage }) {
  const { organisationId } = useOrganisation();
  const queryClient = useQueryClient();
  const contacts = useQuery({ queryKey: keyOf(organisationId, customerId), queryFn: () => apiFetch(`/customers/${customerId}/contacts`, { organisationId }), enabled: !!organisationId && !!customerId, retry: false });
  const save = useMutation({
    mutationFn: ({ id, body }) => (id ? apiFetch(`/customer-contacts/${id}`, { method: "PATCH", body, organisationId }) : apiFetch(`/customers/${customerId}/contacts`, { method: "POST", body, organisationId })),
    onSuccess: (data) => queryClient.setQueryData(keyOf(organisationId, customerId), data),
    onSettled: () => refreshOrganisation(queryClient, organisationId),
  });
  const [editing, setEditing] = useState(null);
  const items = contacts.data?.data ?? [];
  if (contacts.error) return null;

  return (
    <section aria-label="Contacts" className="mt-4 flex flex-col gap-2 rounded-xl border border-border-color p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-base font-semibold">Contacts</h3>
        {canManage && <CTAButton type="neutral" size="default" onClick={() => setEditing("new")}>Add a contact</CTAButton>}
      </div>
      {items.length === 0 ? (
        <p className="text-sm text-secondary-text">No contacts yet.</p>
      ) : (
        <ul aria-label="Customer contacts" className="flex flex-col divide-y divide-border-color">
          {items.map((c) => (
            <li key={c.id} className={`flex flex-wrap items-center gap-3 py-2 text-sm ${c.active ? "" : "opacity-60"}`}>
              <div className="min-w-0 grow">
                <p className="truncate font-medium text-primary-text">
                  {c.name}
                  {c.isPrimary && <span className="ml-2 rounded-full bg-brand-primary/15 px-2 py-0.5 text-xs font-medium text-brand-primary">Primary</span>}
                  {!c.active && <span className="ml-2 text-xs font-normal text-secondary-text">Inactive</span>}
                </p>
                <p className="truncate text-xs text-secondary-text">{[contactRoleLabel(c.role), c.jobTitle, c.email, c.phone].filter(Boolean).join(" · ")}</p>
              </div>
              {canManage && (
                <>
                  <Switch checked={c.active} aria-label={`${c.name} is active`} onChange={(e) => save.mutate({ id: c.id, body: { active: e.target.checked } })} />
                  <CTAButton type="neutral" size="default" aria-label={`Edit ${c.name}`} onClick={() => setEditing(c)}>Edit</CTAButton>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {save.error && !editing && <FormError error={save.error} />}
      {editing && <ContactDialog contact={editing === "new" ? null : editing} save={save} onClose={() => { save.reset(); setEditing(null); }} />}
    </section>
  );
}

function ContactDialog({ contact, save, onClose }) {
  const [f, setF] = useState({
    name: contact?.name ?? "", jobTitle: contact?.jobTitle ?? "", role: contact?.role ?? "other", email: contact?.email ?? "", phone: contact?.phone ?? "", notes: contact?.notes ?? "", isPrimary: contact?.isPrimary ?? false,
  });
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v }));
  const submit = (e) => {
    e.preventDefault();
    const clean = (v) => (v.trim() === "" ? null : v.trim());
    save.mutate(
      { id: contact?.id, body: { name: f.name.trim(), jobTitle: clean(f.jobTitle), role: f.role, email: clean(f.email), phone: clean(f.phone), notes: clean(f.notes), isPrimary: f.isPrimary } },
      { onSuccess: onClose },
    );
  };
  return (
    <Dialog title={contact ? `Edit ${contact.name}` : "Add a contact"} onClose={onClose}>
      <form onSubmit={submit} noValidate className="flex flex-col gap-3">
        <Field label="Name" required value={f.name} onChange={(e) => set("name")(e.target.value)} maxLength={120} />
        <div className="grid gap-3 sm:grid-cols-2">
          <ComboField label="Role" value={f.role} onChange={set("role")} options={CONTACT_ROLES.map((r) => ({ value: r.id, label: r.name }))} />
          <Field label="Job title" value={f.jobTitle} onChange={(e) => set("jobTitle")(e.target.value)} maxLength={120} />
          <Field label="Email" type="email" value={f.email} onChange={(e) => set("email")(e.target.value)} maxLength={200} />
          <Field label="Phone" value={f.phone} onChange={(e) => set("phone")(e.target.value)} maxLength={40} />
        </div>
        <TextAreaField label="Notes" rows={2} value={f.notes} onChange={(e) => set("notes")(e.target.value)} maxLength={1000} />
        <label className="flex items-center gap-2 text-sm"><Switch checked={f.isPrimary} aria-label="Primary contact" onChange={(e) => set("isPrimary")(e.target.checked)} /> Primary contact</label>
        <FormError error={save.error} />
        <div className="flex justify-end gap-2">
          <CTAButton type="neutral" size="md" onClick={onClose}>Cancel</CTAButton>
          <CTAButton type="main" size="md" buttonType="submit" disabled={f.name.trim() === ""} loading={save.isPending}>Save</CTAButton>
        </div>
      </form>
    </Dialog>
  );
}
