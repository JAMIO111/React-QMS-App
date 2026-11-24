import { useState } from "react";
import CTAButton from "../CTAButton";
import Callout from "../ui/Callout";
import ComboField from "../ui/ComboField";
import Dialog from "../ui/Dialog";
import Field from "../ui/Field";
import RHFDatePickerPopout from "../ui/RHFDatePickerPopout";
import { FormError, TextAreaField } from "../master-data/shared";
import { usePortalChangeParts, usePortalChangeRequestMutation, usePortalChangeRequests } from "../../hooks/usePortal";
import { describeApiError } from "../../lib/api-client";
import { todayIso } from "@/lib/localDate";
import { CHANGE_REQUEST_STATUS, CHANGE_WORDS, shortDate } from "../../lib/portal";

/**
 * Change requests (CH6a): a customer asks for a change to one of their parts, a supplier tells us about a change to a process. Either reaches us as a draft
 * change the quality team reviews, so the status here is plain: received, under review, accepted, done, declined or cancelled. Nothing is decided here.
 */
export default function PortalChangeRequests({ access }) {
  const words = CHANGE_WORDS[access.partyKind] ?? CHANGE_WORDS.customer;
  const requests = usePortalChangeRequests(access.organisationId);
  const [open, setOpen] = useState(false);
  const items = requests.data?.data ?? [];
  return (
    <section aria-labelledby="portal-change-requests" className="flex flex-col gap-3 rounded-2xl border border-border-color bg-secondary-bg p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="portal-change-requests" className="text-lg font-semibold">{words.heading}</h2>
          <p className="text-sm text-secondary-text">{words.intro}</p>
        </div>
        <CTAButton type="main" size="md" onClick={() => setOpen(true)}>{words.button}</CTAButton>
      </div>
      {requests.error ? (
        <Callout tone="error" role="alert">{describeApiError(requests.error)}</Callout>
      ) : items.length === 0 ? (
        <p className="text-sm text-secondary-text">{words.empty}</p>
      ) : (
        <ul aria-label={words.heading} className="flex flex-col divide-y divide-border-color rounded-xl border border-border-color">
          {items.map((c) => {
            const status = CHANGE_REQUEST_STATUS[c.status] ?? CHANGE_REQUEST_STATUS.received;
            return (
              <li key={c.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="min-w-0 grow">
                  <p className="truncate text-sm font-medium text-primary-text">{c.reference} · {c.title}</p>
                  <p className="text-xs text-secondary-text">
                    Sent {shortDate(c.raisedAt)}
                    {c.partNumber ? ` · ${c.partNumber}` : ""}
                    {c.wantedOn ? ` · wanted from ${shortDate(`${c.wantedOn}T12:00:00Z`)}` : ""}
                  </p>
                </div>
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${status.tone}`}>{status.label}</span>
              </li>
            );
          })}
        </ul>
      )}
      {open && <ChangeRequestDialog access={access} words={words} onClose={() => setOpen(false)} />}
    </section>
  );
}

const blank = () => ({ title: "", description: "", reason: "", partId: null, wantedOn: null });

function ChangeRequestDialog({ access, words, onClose }) {
  const parts = usePortalChangeParts(access.organisationId);
  const mutate = usePortalChangeRequestMutation(access.organisationId);
  const [form, setForm] = useState(blank);
  const [clientKey] = useState(() => crypto.randomUUID());
  const [error, setError] = useState(null);
  const set = (key) => (value) => setForm((f) => ({ ...f, [key]: value }));
  const problem = form.title.trim().length < 3 ? "Give the change a short title." : form.description.trim().length < 10 ? "Describe the change in a sentence or two." : null;

  const submit = (e) => {
    e.preventDefault();
    if (problem) return setError(new Error(problem));
    setError(null);
    mutate.mutate(
      { title: form.title.trim(), description: form.description.trim(), reason: form.reason.trim() || null, partId: form.partId || null, wantedOn: form.wantedOn || null, clientKey },
      { onSuccess: onClose, onError: setError },
    );
  };

  return (
    <Dialog title={words.dialog} onClose={onClose} width="max-w-2xl">
      <form onSubmit={submit} noValidate className="flex flex-col gap-3">
        <Field label={words.title} required value={form.title} onChange={(e) => set("title")(e.target.value)} maxLength={200} placeholder={words.titleHint} />
        <TextAreaField label={words.description} required value={form.description} onChange={(e) => set("description")(e.target.value)} rows={4} />
        <TextAreaField label={words.reason} value={form.reason} onChange={(e) => set("reason")(e.target.value)} rows={2} />
        <ComboField
          label="Part"
          value={form.partId}
          onChange={set("partId")}
          options={(parts.data?.data ?? []).map((p) => ({ value: p.id, label: `${p.partNumber} · ${p.name}`, hint: p.theirPartNumber ? `Your number ${p.theirPartNumber}` : undefined }))}
          placeholder="Choose the part, if it is about one"
          clearable
        />
        <RHFDatePickerPopout label={words.wanted} value={form.wantedOn} onChange={set("wantedOn")} valueFormat="iso" minDate={new Date(`${todayIso()}T00:00:00`)} clearable />
        <FormError error={error} />
        <div className="flex justify-end gap-2">
          <CTAButton type="neutral" size="md" onClick={onClose}>Cancel</CTAButton>
          <CTAButton type="main" size="md" buttonType="submit" loading={mutate.isPending}>{words.send}</CTAButton>
        </div>
      </form>
    </Dialog>
  );
}
