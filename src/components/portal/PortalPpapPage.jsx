import { useState } from "react";
import { Link, useOutletContext, useParams } from "react-router-dom";
import { ArrowLeftIcon } from "@/components/icons";
import CTAButton from "../CTAButton";
import Callout from "../ui/Callout";
import ComboField from "../ui/ComboField";
import Dialog from "../ui/Dialog";
import Field from "../ui/Field";
import LoadingScreen from "../ui/LoadingScreen";
import RHFDatePickerPopout from "../ui/RHFDatePickerPopout";
import { FormError, TextAreaField } from "../master-data/shared";
import { usePortalPpap, usePortalPpapMutation, usePortalPpaps } from "../../hooks/usePortal";
import { describeApiError } from "../../lib/api-client";
import { todayIso } from "../../lib/localDate";
import { PPAP_DECISION, PPAP_REQUEST_STATUS, ppapPath, shortDate } from "../../lib/portal";

const Fact = ({ label, value }) =>
  value === null || value === undefined || value === "" ? null : (
    <>
      <dt className="text-secondary-text">{label}</dt>
      <dd className="min-w-0 whitespace-pre-wrap break-words text-primary-text">{value}</dd>
    </>
  );

/** What to show beside a request: waiting, or what the customer answered. */
const answerPill = (r) => (r.status === "pending" ? PPAP_REQUEST_STATUS.pending : (PPAP_DECISION[r.decision] ?? PPAP_REQUEST_STATUS.answered));

/** The part approval submissions the organisation has asked this customer to answer, as a list (the page and the dashboard). */
export function PpapList({ access, onlyWaiting = false, heading = "Part approval submissions" }) {
  const ppaps = usePortalPpaps(access.organisationId, { enabled: access.partyKind === "customer" });
  const items = (ppaps.data?.data ?? []).filter((c) => !onlyWaiting || c.canDecide);
  if (access.partyKind !== "customer" || ppaps.isLoading || items.length === 0) return null;
  return (
    <section aria-labelledby="portal-ppaps" className="flex flex-col gap-3 rounded-2xl border border-warning-color/40 bg-secondary-bg p-5">
      <div>
        <h2 id="portal-ppaps" className="text-lg font-semibold">{heading}</h2>
        <p className="text-sm text-secondary-text">{access.organisationName} asks for your answer on these part approval submissions.</p>
      </div>
      <ul aria-label={heading} className="flex flex-col divide-y divide-border-color rounded-xl border border-border-color">
        {items.map((c) => {
          const pill = answerPill(c.status === "pending" ? c : { status: c.status, decision: c.submissionStatus });
          return (
            <li key={c.id}>
              <Link to={ppapPath(c.id, access.organisationId)} className="flex flex-wrap items-center gap-3 px-4 py-3 hover:bg-primary-bg">
                <span className="min-w-0 grow">
                  <span className="block truncate text-sm font-medium text-primary-text">{c.reference} · {c.partNumber} {c.partName}</span>
                  <span className="block text-xs text-secondary-text">
                    {c.theirPartNumber ? `Your number ${c.theirPartNumber} · ` : ""}Level {c.level} · asked {shortDate(c.requestedAt)}{c.answeredAt ? ` · answered ${shortDate(c.answeredAt)}` : ""}
                  </span>
                </span>
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${pill.tone}`}>{pill.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

const CHOICES = [
  { value: "approved", label: "Approve it" },
  { value: "interim_approved", label: "Approve it for now" },
  { value: "rejected", label: "Reject it" },
];

function DecideDialog({ request, mutation, onClose, start }) {
  const [kind, setKind] = useState(start);
  const [note, setNote] = useState("");
  const [reference, setReference] = useState("");
  const [expiresOn, setExpiresOn] = useState("");
  const needsNote = kind === "rejected" || kind === "interim_approved";
  const ok = (!needsNote || note.trim().length >= 3) && (kind !== "interim_approved" || !!expiresOn);
  return (
    <Dialog title={`Answer ${request.reference}`} onClose={onClose}>
      <form
        noValidate
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!ok || mutation.isPending) return;
          mutation.mutate(
            { kind, note: note.trim() || null, reference: reference.trim() || null, expiresOn: kind === "interim_approved" ? expiresOn : null },
            { onSuccess: onClose },
          );
        }}>
        <p className="text-sm text-secondary-text">Your answer is recorded today against this submission. It cannot be changed afterwards; the team is told at once.</p>
        <ComboField label="Your answer" required value={kind} onChange={(v) => setKind(v ?? "approved")} options={CHOICES} clearable={false} sort={false} />
        {kind === "interim_approved" && <RHFDatePickerPopout label="Approved until" required valueFormat="iso" minDate={todayIso(1)} value={expiresOn} onChange={(d) => setExpiresOn(d ?? "")} />}
        {kind !== "rejected" && <Field label="Your own reference" value={reference} onChange={(e) => setReference(e.target.value)} maxLength={100} hint="Optional: your approval number" />}
        <TextAreaField
          label={kind === "rejected" ? "What you cannot accept" : kind === "interim_approved" ? "The conditions" : "Note"}
          required={needsNote}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={2000}
          rows={3}
        />
        <FormError error={mutation.error} />
        <div className="flex justify-end gap-2">
          <CTAButton buttonType="button" type="neutral" size="md" onClick={onClose}>Cancel</CTAButton>
          <CTAButton buttonType="submit" type={kind === "rejected" ? "danger" : "main"} size="lg" disabled={!ok || mutation.isPending} loading={mutation.isPending}>Send my answer</CTAButton>
        </div>
      </form>
    </Dialog>
  );
}

const yesNo = (v) => (v === null || v === undefined ? null : v ? "Yes" : "No");

/** One request: the submission as the customer may see it (named fields only) and their answer. */
export default function PortalPpapPage() {
  const { requestId } = useParams();
  const { access } = useOutletContext();
  const query = usePortalPpap(access.organisationId, requestId);
  const mutation = usePortalPpapMutation(access.organisationId, requestId);
  const [deciding, setDeciding] = useState(null);
  if (query.isLoading) return <LoadingScreen />;
  if (query.error) return <Callout tone="error" role="alert">{describeApiError(query.error)}</Callout>;
  const p = query.data;
  const pill = answerPill(p);
  const w = p.warrant;
  return (
    <>
      <Link to="/portal/ppaps" className="flex w-fit items-center gap-1 text-sm text-link-color hover:underline">
        <ArrowLeftIcon className="h-4 w-4" /> Back to part approvals
      </Link>
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">{p.reference} · {p.partNumber} {p.partName}</h1>
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${pill.tone}`}>{pill.label}</span>
      </header>
      {p.requestNote && <Callout tone="info" title={`${access.organisationName} wrote`}>{p.requestNote}</Callout>}
      {p.status === "pending" && !p.canDecide && <Callout tone="warning">This submission no longer needs your answer.</Callout>}
      {p.submissionStatus === "interim_approved" && p.interimExpiresOn && <Callout tone="info">Approved for now until {shortDate(p.interimExpiresOn)}.</Callout>}
      <section aria-label="The submission" className="flex flex-col gap-2 rounded-2xl border border-border-color bg-secondary-bg p-5">
        <h2 className="text-lg font-semibold">The submission</h2>
        <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[11rem_1fr]">
          <Fact label="Part" value={`${p.partNumber} ${p.partName}`} />
          <Fact label="Your part number" value={p.theirPartNumber} />
          <Fact label="Revision" value={p.revision} />
          <Fact label="Submission level" value={p.level ? `Level ${p.level}` : null} />
          <Fact label="Reason" value={p.reason} />
          <Fact label="Sent" value={p.sentOn ? shortDate(p.sentOn) : null} />
          <Fact label="Your contact" value={p.contact} />
        </dl>
      </section>
      <section aria-label="What was submitted" className="flex flex-col gap-2 rounded-2xl border border-border-color bg-secondary-bg p-5">
        <h2 className="text-lg font-semibold">What was submitted</h2>
        {p.elements.length === 0 ? (
          <p className="text-sm text-secondary-text">Nothing is listed.</p>
        ) : (
          <ul aria-label="Elements" className="flex flex-col divide-y divide-border-color rounded-xl border border-border-color text-sm">
            {p.elements.map((e) => (
              <li key={e.name} className="flex flex-wrap items-center gap-2 px-4 py-2">
                <span className="min-w-0 grow text-primary-text">{e.name}</span>
                <span className="text-xs text-secondary-text">{e.requirement}</span>
                <span className="text-xs font-medium text-primary-text">{e.waived ? "Waived" : e.provided ? "Provided" : "Not provided"}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      {w && (
        <section aria-label="Part Submission Warrant" className="flex flex-col gap-2 rounded-2xl border border-border-color bg-secondary-bg p-5">
          <h2 className="text-lg font-semibold">Part Submission Warrant</h2>
          <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[11rem_1fr]">
            <Fact label="Part weight" value={w.partWeight != null ? `${w.partWeight} ${w.weightUnit}` : null} />
            <Fact label="Purchase order" value={w.purchaseOrder} />
            <Fact label="Engineering change level" value={w.engineeringChangeLevel} />
            <Fact label="Results meet the requirements" value={yesNo(w.resultsMeetRequirements)} />
            <Fact label="Declaration" value={w.declaration} />
            <Fact label="Signed by" value={w.signerName ? `${w.signerName}${w.signerTitle ? `, ${w.signerTitle}` : ""}` : null} />
            <Fact label="Phone" value={w.signerPhone} />
            <Fact label="Signed on" value={w.signedOn ? shortDate(w.signedOn) : null} />
          </dl>
        </section>
      )}
      <section aria-label="Your answer" className="flex flex-col gap-2 rounded-2xl border border-border-color bg-secondary-bg p-5">
        <h2 className="text-lg font-semibold">Your answer</h2>
        {p.status === "pending" ? (
          p.canDecide ? (
            <div className="flex flex-wrap gap-2">
              <CTAButton type="main" size="md" onClick={() => setDeciding("approved")}>Approve it</CTAButton>
              <CTAButton type="secondary" size="md" onClick={() => setDeciding("interim_approved")}>Approve it for now</CTAButton>
              <CTAButton type="neutral" size="md" onClick={() => setDeciding("rejected")}>I cannot accept it</CTAButton>
            </div>
          ) : (
            <p className="text-sm text-secondary-text">Nothing is needed from you.</p>
          )
        ) : (
          <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[11rem_1fr]">
            <Fact label="Answer" value={(PPAP_DECISION[p.decision] ?? PPAP_REQUEST_STATUS.answered).label} />
            <Fact label="Answered" value={p.answeredAt ? `${shortDate(p.answeredAt)}${p.answeredBy ? ` by ${p.answeredBy}` : ""}` : null} />
            <Fact label="Approved until" value={p.decisionExpiresOn ? shortDate(p.decisionExpiresOn) : null} />
            <Fact label="Your reference" value={p.yourReference} />
            <Fact label="Your note" value={p.decisionNote} />
          </dl>
        )}
      </section>
      {deciding && <DecideDialog request={p} start={deciding} mutation={mutation} onClose={() => setDeciding(null)} />}
    </>
  );
}
