import { useState } from "react";
import { Link } from "react-router-dom";
import CTAButton from "../CTAButton";
import Callout from "../ui/Callout";
import ComboField from "../ui/ComboField";
import Dialog from "../ui/Dialog";
import Field from "../ui/Field";
import RHFDatePickerPopout from "../ui/RHFDatePickerPopout";
import { FormError, TextAreaField } from "../master-data/shared";
import { usePortalComplaintMutation, usePortalComplaintParts, usePortalComplaints } from "../../hooks/usePortal";
import { describeApiError } from "../../lib/api-client";
import { todayIso } from "@/lib/localDate";
import { COMPLAINT_STATUS, sharedPath, shortDate } from "../../lib/portal";

/**
 * Complaints (PT5a): what a customer has raised and a way to raise another. A complaint reaches us as a draft the quality team reviews, so the status here
 * is plain: received, in progress, closed or cancelled. Once we share the record with them it links to it.
 */
export default function PortalComplaints({ access }) {
  const complaints = usePortalComplaints(access.organisationId);
  const [open, setOpen] = useState(false);
  const items = complaints.data?.data ?? [];
  return (
    <section aria-labelledby="portal-complaints" className="flex flex-col gap-3 rounded-2xl border border-border-color bg-secondary-bg p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="portal-complaints" className="text-lg font-semibold">Your complaints</h2>
          <p className="text-sm text-secondary-text">Tell {access.organisationName} about a problem with what they supplied. Their quality team reviews every one.</p>
        </div>
        <CTAButton type="main" size="md" onClick={() => setOpen(true)}>Raise a complaint</CTAButton>
      </div>
      {complaints.error ? (
        <Callout tone="error" role="alert">{describeApiError(complaints.error)}</Callout>
      ) : items.length === 0 ? (
        <p className="text-sm text-secondary-text">You have not raised any complaints yet.</p>
      ) : (
        <ul aria-label="Your complaints" className="flex flex-col divide-y divide-border-color rounded-xl border border-border-color">
          {items.map((c) => {
            const status = COMPLAINT_STATUS[c.status];
            const body = (
              <>
                <div className="min-w-0 grow">
                  <p className="truncate text-sm font-medium text-primary-text">{c.reference} · {c.title}</p>
                  <p className="text-xs text-secondary-text">
                    Raised {shortDate(c.raisedAt)}
                    {c.partNumber ? ` · ${c.partNumber}` : ""}
                    {c.lot ? ` · Lot ${c.lot}` : ""}
                  </p>
                </div>
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${status.tone}`}>{status.label}</span>
              </>
            );
            return (
              <li key={c.id}>
                {c.shareId ? (
                  <Link to={sharedPath(c.shareId, access.organisationId)} className="flex flex-wrap items-center gap-3 px-4 py-3 hover:bg-primary-bg">{body}</Link>
                ) : (
                  <div className="flex flex-wrap items-center gap-3 px-4 py-3">{body}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {open && <ComplaintDialog access={access} onClose={() => setOpen(false)} />}
    </section>
  );
}

const blank = () => ({ title: "", description: "", partId: null, quantity: "", lot: "", customerReference: "", detectedOn: todayIso() });

function ComplaintDialog({ access, onClose }) {
  const parts = usePortalComplaintParts(access.organisationId);
  const mutate = usePortalComplaintMutation(access.organisationId);
  const [form, setForm] = useState(blank);
  const [clientKey] = useState(() => crypto.randomUUID());
  const [error, setError] = useState(null);
  const set = (key) => (value) => setForm((f) => ({ ...f, [key]: value }));
  const problem = form.title.trim().length < 3 ? "Give the complaint a short title." : form.description.trim().length < 10 ? "Describe what is wrong in a sentence or two." : null;

  const submit = (e) => {
    e.preventDefault();
    if (problem) return setError(new Error(problem));
    setError(null);
    mutate.mutate(
      {
        title: form.title.trim(),
        description: form.description.trim(),
        partId: form.partId || null,
        quantity: form.quantity === "" ? null : Number(form.quantity),
        lot: form.lot.trim() || null,
        customerReference: form.customerReference.trim() || null,
        detectedOn: form.detectedOn || null,
        clientKey,
      },
      { onSuccess: onClose, onError: setError },
    );
  };

  return (
    <Dialog title="Raise a complaint" onClose={onClose} width="max-w-2xl">
      <form onSubmit={submit} noValidate className="flex flex-col gap-3">
        <Field label="Title" required value={form.title} onChange={(e) => set("title")(e.target.value)} maxLength={200} placeholder="For example: Brackets cracked on arrival" />
        <TextAreaField label="What is wrong" required value={form.description} onChange={(e) => set("description")(e.target.value)} rows={4} />
        <ComboField
          label="Part"
          value={form.partId}
          onChange={set("partId")}
          options={(parts.data?.data ?? []).map((p) => ({ value: p.id, label: `${p.partNumber} · ${p.name}`, hint: p.customerPartNumber ? `Your number ${p.customerPartNumber}` : undefined }))}
          placeholder="Choose the part"
          clearable
        />
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="How many are affected" type="number" min="0" value={form.quantity} onChange={(e) => set("quantity")(e.target.value)} />
          <Field label="Lot or batch" value={form.lot} onChange={(e) => set("lot")(e.target.value)} maxLength={100} />
          <Field label="Your reference" value={form.customerReference} onChange={(e) => set("customerReference")(e.target.value)} maxLength={100} />
        </div>
        <RHFDatePickerPopout label="When you found it" value={form.detectedOn} onChange={set("detectedOn")} valueFormat="iso" maxDate={new Date()} />
        <FormError error={error} />
        <div className="flex justify-end gap-2">
          <CTAButton type="neutral" size="md" onClick={onClose}>Cancel</CTAButton>
          <CTAButton type="main" size="md" buttonType="submit" loading={mutate.isPending}>Send complaint</CTAButton>
        </div>
      </form>
    </Dialog>
  );
}
