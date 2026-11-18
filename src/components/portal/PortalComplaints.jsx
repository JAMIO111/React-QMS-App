import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import CTAButton from "../CTAButton";
import Callout from "../ui/Callout";
import ComboField from "../ui/ComboField";
import Dialog from "../ui/Dialog";
import Field from "../ui/Field";
import RHFDatePickerPopout from "../ui/RHFDatePickerPopout";
import { FormError, TextAreaField } from "../master-data/shared";
import { openPortalComplaintFile, usePortalComplaintFileMutation, usePortalComplaintMutation, usePortalComplaintParts, usePortalComplaints, usePortalFigures } from "../../hooks/usePortal";
import SlidingToggle from "../ui/SlidingToggle";
import { Chip, Tile } from "../dashboard/DashboardGraphics";
import { PERIODS } from "../../lib/supplierPerformance";
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
                {(c.files?.length > 0 || c.status === "received") && <ComplaintFiles complaint={c} organisationId={access.organisationId} />}
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

/** A customer's own quality figures (PT5d): non-conformances raised against what we supply them and the 8Ds that answer them. Counts only. */
export function PortalFigures({ access }) {
  const [days, setDays] = useState("90");
  const figures = usePortalFigures(access.organisationId, Number(days));
  if (figures.isLoading || figures.error || figures.data?.available === false) return null;
  const { ncs, capas, period } = figures.data;
  const avg = (v, unit) => (v === null || v === undefined ? "—" : `${v} ${unit}`);
  return (
    <section aria-labelledby="portal-figures" className="flex flex-col gap-3 rounded-2xl border border-border-color bg-secondary-bg p-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="portal-figures" className="text-lg font-semibold">Quality of what we supply you</h2>
          <p className="text-sm text-secondary-text">{shortDate(period.from)} to {shortDate(period.to)}. Counts only; the details are in your complaints and the records we share.</p>
        </div>
        <SlidingToggle ariaLabel="Period" options={PERIODS} value={days} onChange={setDays} />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Tile label="Non-conformances">
          <span className="text-sm text-secondary-text">Non-conformances raised</span>
          <p className="text-3xl font-semibold">{ncs.raised}</p>
          <p className="flex flex-wrap gap-1 text-xs"><Chip>{ncs.critical} critical</Chip><Chip>{ncs.major} major</Chip><Chip>{ncs.minor} minor</Chip></p>
          <p className="text-xs text-secondary-text">
            {ncs.open} open{ncs.oldestOpenDays !== null ? `, the oldest ${ncs.oldestOpenDays} days (on average ${avg(ncs.averageOpenDays, "days")})` : ""}. {ncs.closedInPeriod} closed in this period, taking {avg(ncs.averageDaysToClose, "days")} on average.
          </p>
        </Tile>
        <Tile label="8Ds">
          <span className="text-sm text-secondary-text">8Ds started</span>
          <p className="text-3xl font-semibold">{capas.started}</p>
          <p className="text-xs text-secondary-text">
            {capas.inProgress} in progress. {capas.closedInPeriod} closed in this period, taking {avg(capas.averageDaysToClose, "days")} on average.
          </p>
        </Tile>
      </div>
    </section>
  );
}

const sizeWords = (n) => (n >= 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} kB`);

/** Photos and documents on a complaint (PT5e): add while we have not started work on it (up to ten), open any, take back your own. */
function ComplaintFiles({ complaint, organisationId }) {
  const mutate = usePortalComplaintFileMutation(organisationId);
  const input = useRef(null);
  const files = complaint.files ?? [];
  const adding = mutate.isPending && mutate.variables?.action === "add" && mutate.variables?.id === complaint.id;
  const open = complaint.status === "received" && files.length < 10;
  return (
    <div className="flex flex-col gap-2 border-t border-border-color px-4 py-3">
      {files.length > 0 && (
        <ul aria-label={`Files on ${complaint.reference}`} className="flex flex-col gap-1 text-sm">
          {files.map((f) => (
            <li key={f.id} className="flex items-center gap-2">
              <button type="button" className="min-w-0 truncate text-link-color hover:underline" onClick={() => openPortalComplaintFile(organisationId, f.id)}>{f.name}</button>
              <span className="text-xs text-secondary-text">{sizeWords(f.sizeBytes)}</span>
              {f.canRemove && <button type="button" aria-label={`Take back ${f.name}`} className="text-xs text-secondary-text hover:underline" onClick={() => mutate.mutate({ action: "remove", id: f.id })}>Take back</button>}
            </li>
          ))}
        </ul>
      )}
      {open && (
        <div>
          <input
            ref={input}
            type="file"
            aria-label={`Choose a file for ${complaint.reference}`}
            className="sr-only"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) mutate.mutate({ action: "add", id: complaint.id, file });
            }}
          />
          <CTAButton type="neutral" size="default" aria-label={`Add a file to ${complaint.reference}`} loading={adding} loadingText="Uploading…" onClick={() => input.current?.click()}>Add a file</CTAButton>
          <span className="ml-2 text-xs text-secondary-text">Up to ten files of 25 MB, until we start work on it.</span>
        </div>
      )}
      {mutate.error && <Callout tone="error" role="alert">{describeApiError(mutate.error)}</Callout>}
    </div>
  );
}
