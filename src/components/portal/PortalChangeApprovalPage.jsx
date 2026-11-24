import { useState } from "react";
import { Link, useOutletContext, useParams } from "react-router-dom";
import { ArrowLeftIcon } from "@/components/icons";
import CTAButton from "../CTAButton";
import Callout from "../ui/Callout";
import Dialog from "../ui/Dialog";
import Field from "../ui/Field";
import LoadingScreen from "../ui/LoadingScreen";
import { FormError, TextAreaField } from "../master-data/shared";
import { usePortalChangeApproval, usePortalChangeApprovalMutation, usePortalChangeApprovals } from "../../hooks/usePortal";
import { describeApiError } from "../../lib/api-client";
import { CHANGE_APPROVAL_STATUS, changeApprovalPath, shortDate } from "../../lib/portal";

const Fact = ({ label, value }) =>
  value === null || value === undefined || value === "" ? null : (
    <>
      <dt className="text-secondary-text">{label}</dt>
      <dd className="min-w-0 whitespace-pre-wrap break-words text-primary-text">{value}</dd>
    </>
  );

/** The changes the organisation has asked this customer to approve (CH6b), on the change requests page and the dashboard. Nothing here changes anything for the organisation but the customer's answer. */
export function ChangeApprovalList({ access, onlyWaiting = false, heading = "Changes for you to approve" }) {
  const approvals = usePortalChangeApprovals(access.organisationId, { enabled: access.partyKind === "customer" });
  const items = (approvals.data?.data ?? []).filter((c) => !onlyWaiting || c.canDecide);
  if (access.partyKind !== "customer" || approvals.isLoading || items.length === 0) return null;
  return (
    <section aria-labelledby="portal-change-approvals" className="flex flex-col gap-3 rounded-2xl border border-warning-color/40 bg-secondary-bg p-5">
      <div>
        <h2 id="portal-change-approvals" className="text-lg font-semibold">{heading}</h2>
        <p className="text-sm text-secondary-text">{access.organisationName} asks for your approval before these changes go ahead.</p>
      </div>
      <ul aria-label={heading} className="flex flex-col divide-y divide-border-color rounded-xl border border-border-color">
        {items.map((c) => {
          const status = CHANGE_APPROVAL_STATUS[c.status] ?? CHANGE_APPROVAL_STATUS.pending;
          return (
            <li key={c.id}>
              <Link to={changeApprovalPath(c.id, access.organisationId)} className="flex flex-wrap items-center gap-3 px-4 py-3 hover:bg-primary-bg">
                <span className="min-w-0 grow">
                  <span className="block truncate text-sm font-medium text-primary-text">{c.reference} · {c.title}</span>
                  <span className="block text-xs text-secondary-text">Asked {shortDate(c.requestedAt)}{c.decidedAt ? ` · answered ${shortDate(c.decidedAt)}` : ""}</span>
                </span>
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${status.tone}`}>{status.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function DecideDialog({ approve, request, mutation, onClose }) {
  const [note, setNote] = useState("");
  const [reference, setReference] = useState("");
  const ok = approve || note.trim().length >= 3;
  return (
    <Dialog title={approve ? "Approve this change" : "Say what you cannot accept"} onClose={onClose}>
      <form
        noValidate
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!ok || mutation.isPending) return;
          mutation.mutate({ approve, note: note.trim() || null, reference: approve ? reference.trim() || null : null }, { onSuccess: onClose });
        }}>
        <p className="text-sm text-secondary-text">
          {approve ? "Your approval is recorded against this change. It cannot be changed afterwards." : "Your answer is recorded and the team is told. It cannot be changed afterwards; they may ask you again once it is dealt with."} ({request.reference})
        </p>
        {approve && <Field label="Your own reference" value={reference} onChange={(e) => setReference(e.target.value)} maxLength={200} hint="Optional: your approval or change number" />}
        <TextAreaField label={approve ? "Note" : "What you cannot accept"} required={!approve} value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} rows={3} />
        <FormError error={mutation.error} />
        <div className="flex justify-end gap-2">
          <CTAButton buttonType="button" type="neutral" size="md" onClick={onClose}>Cancel</CTAButton>
          <CTAButton buttonType="submit" type={approve ? "main" : "danger"} size="lg" disabled={!ok || mutation.isPending} loading={mutation.isPending}>{approve ? "Approve" : "Send"}</CTAButton>
        </div>
      </form>
    </Dialog>
  );
}

/** One request: the change as the customer may see it (named fields only) and their answer. */
export default function PortalChangeApprovalPage() {
  const { approvalId } = useParams();
  const { access } = useOutletContext();
  const query = usePortalChangeApproval(access.organisationId, approvalId);
  const mutation = usePortalChangeApprovalMutation(access.organisationId, approvalId);
  const [deciding, setDeciding] = useState(null);
  if (query.isLoading) return <LoadingScreen />;
  if (query.error) return <Callout tone="error" role="alert">{describeApiError(query.error)}</Callout>;
  const c = query.data;
  const status = CHANGE_APPROVAL_STATUS[c.status] ?? CHANGE_APPROVAL_STATUS.pending;
  return (
    <>
      <Link to="/portal/change-requests" className="flex w-fit items-center gap-1 text-sm text-link-color hover:underline">
        <ArrowLeftIcon className="h-4 w-4" /> Back to change requests
      </Link>
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">{c.reference} · {c.title}</h1>
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${status.tone}`}>{status.label}</span>
        {c.expedited && <span className="rounded-full bg-warning-color/20 px-2 py-0.5 text-xs font-medium text-primary-text">Expedited</span>}
      </header>
      {c.requestNote && <Callout tone="info" title={`${access.organisationName} wrote`}>{c.requestNote}</Callout>}
      {c.status === "pending" && !c.open && <Callout tone="warning">This change is no longer open, so it no longer needs your answer.</Callout>}
      <section aria-label="The change" className="flex flex-col gap-2 rounded-2xl border border-border-color bg-secondary-bg p-5">
        <h2 className="text-lg font-semibold">The change</h2>
        <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[11rem_1fr]">
          <Fact label="Kind of change" value={c.type} />
          <Fact label="What is changing" value={c.whatIsChanging} />
          <Fact label="Why" value={c.why} />
          <Fact label="Applies" value={c.appliesFrom} />
          <Fact label="Stock already made" value={c.stock} />
          <Fact label="Asked on" value={shortDate(c.requestedAt)} />
          <Fact label="Your contact" value={c.contact} />
        </dl>
      </section>
      <section aria-label="Your parts" className="flex flex-col gap-2 rounded-2xl border border-border-color bg-secondary-bg p-5">
        <h2 className="text-lg font-semibold">Your parts it covers</h2>
        {c.parts.length === 0 ? (
          <p className="text-sm text-secondary-text">None of your parts are named on it.</p>
        ) : (
          <ul aria-label="Parts" className="flex flex-col divide-y divide-border-color rounded-xl border border-border-color text-sm">
            {c.parts.map((p) => (
              <li key={p.partNumber} className="px-4 py-2">
                <span className="font-medium text-primary-text">{p.partNumber}</span> {p.name}
                {p.theirPartNumber ? <span className="text-secondary-text"> · your number {p.theirPartNumber}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-label="Your answer" className="flex flex-col gap-2 rounded-2xl border border-border-color bg-secondary-bg p-5">
        <h2 className="text-lg font-semibold">Your answer</h2>
        {c.status === "pending" ? (
          c.canDecide ? (
            <div className="flex flex-wrap gap-2">
              <CTAButton type="main" size="md" onClick={() => setDeciding("approve")}>Approve this change</CTAButton>
              <CTAButton type="neutral" size="md" onClick={() => setDeciding("reject")}>I cannot accept it</CTAButton>
            </div>
          ) : (
            <p className="text-sm text-secondary-text">Nothing is needed from you.</p>
          )
        ) : (
          <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[11rem_1fr]">
            <Fact label="Answer" value={status.label} />
            <Fact label="Answered" value={c.decidedAt ? `${shortDate(c.decidedAt)}${c.decidedBy ? ` by ${c.decidedBy}` : ""}` : null} />
            <Fact label="Your reference" value={c.yourReference} />
            <Fact label="Your note" value={c.decisionNote} />
          </dl>
        )}
      </section>
      {deciding && <DecideDialog approve={deciding === "approve"} request={c} mutation={mutation} onClose={() => setDeciding(null)} />}
    </>
  );
}
