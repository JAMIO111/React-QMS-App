import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { MessageSquarePlusIcon, PlusIcon, XIcon } from "@/components/icons";
import CTAButton from "@/components/CTAButton";
import { describeApiError } from "../../lib/api-client";
import { useToast } from "../../contexts/ToastProvider";
import { useAuth } from "../../contexts/AuthProvider";
import { useDocumentMutation } from "../../hooks/useDocuments";
import { usePartFamilies } from "../../hooks/useProcessControl";
import { usePermissions } from "../../hooks/useQmsApi";
import { CHANGE_REQUEST_STATUS, formatDay, LINK_KIND, linkBody, revisionPath, statusPill } from "../../lib/documents";
import { MachinePicker, PartPicker } from "../ncr/Pickers";
import { FormError } from "../master-data/shared";
import Callout from "../ui/Callout";
import ComboField from "../ui/ComboField";
import Dialog from "../ui/Dialog";
import Field from "../ui/Field";
import MenuCard from "../ui/MenuCard";
import SlidingToggle from "../ui/SlidingToggle";

const useRun = () => {
  const mutation = useDocumentMutation();
  const { showToast } = useToast();
  const run = (payload, onDone) =>
    mutation.mutate(payload, { onSuccess: (r) => onDone?.(r), onError: (err) => showToast({ type: "error", title: "Not saved", message: describeApiError(err) }) });
  return { mutation, run };
};

const Buttons = ({ onClose, pending, disabled, label, type = "main" }) => (
  <div className="flex justify-end gap-2">
    <CTAButton buttonType="button" type="neutral" size="md" onClick={onClose}>
      Cancel
    </CTAButton>
    <CTAButton buttonType="submit" type={type} size="md" disabled={disabled || pending} loading={pending}>
      {label}
    </CTAButton>
  </div>
);

// ---- periodic review -------------------------------------------------------------------------------

const ReviewDialog = ({ doc, onClose }) => {
  const navigate = useNavigate();
  const { mutation, run } = useRun();
  const [outcome, setOutcome] = useState("no_change");
  const [note, setNote] = useState("");
  const ok = outcome === "revision_started" || note.trim().length >= 3;
  const save = (e) => {
    e.preventDefault();
    if (!ok) return;
    run({ action: "recordReview", id: doc.id, body: { outcome, note: note.trim() || undefined } }, (r) => {
      onClose();
      if (r?.startedRevisionId) navigate(revisionPath(doc.id, r.startedRevisionId));
    });
  };
  return (
    <Dialog title={`Review ${doc.number}`} onClose={onClose}>
      <form noValidate onSubmit={save} className="flex flex-col gap-3">
        <SlidingToggle
          ariaLabel="Outcome"
          mode="radio"
          options={[{ value: "no_change", label: "No change needed" }, { value: "revision_started", label: "Start a revision" }]}
          value={outcome}
          onChange={setOutcome}
        />
        <Field
          label={outcome === "no_change" ? "What was checked" : "Note"}
          required={outcome === "no_change"}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={2000}
          hint={outcome === "no_change" ? `The next review is due in ${doc.reviewMonthsEffective} months.` : "Optional. A draft is started from the revision in force."}
        />
        <FormError error={mutation.error} />
        <Buttons onClose={onClose} pending={mutation.isPending} disabled={!ok} label={outcome === "no_change" ? "Record the review" : "Start the revision"} />
      </form>
    </Dialog>
  );
};

/** When the document is next reviewed, the interval (the type's, or its own), and every review recorded so far. */
export const PeriodicReviewCard = ({ doc }) => {
  const { run } = useRun();
  const [open, setOpen] = useState(false);
  const [months, setMonths] = useState(doc.reviewMonths ?? "");
  const commit = () => {
    const n = months === "" ? null : Number(months);
    if (n !== null && (!Number.isInteger(n) || n < 1 || n > 120)) return;
    if (n === (doc.reviewMonths ?? null)) return;
    run({ action: "updateDocument", id: doc.id, body: { reviewMonths: n } });
  };
  return (
    <MenuCard
      title="Periodic review"
      subtitle={doc.reviewMonths ? `Every ${doc.reviewMonths} months (its own interval)` : `Every ${doc.reviewMonthsEffective} months (the ${doc.type.name.toLowerCase()} interval)`}
      action={
        doc.canManage &&
        doc.status === "active" && (
          <CTAButton type="secondary" onClick={() => setOpen(true)}>
            Record a review
          </CTAButton>
        )
      }>
      <div className="flex flex-col gap-3">
        {doc.status !== "active" ? (
          <p className="text-sm text-secondary-text">Reviews start once a revision is in force.</p>
        ) : doc.reviewOverdue ? (
          <Callout tone="error" title="Review overdue">
            It was due on {formatDay(doc.nextReviewOn)}.
          </Callout>
        ) : (
          <p className="text-sm text-primary-text">Next review due {formatDay(doc.nextReviewOn)}.</p>
        )}
        {doc.canManage && (
          <Field
            label="Its own interval in months"
            type="number"
            min="1"
            max="120"
            value={months}
            onChange={(e) => setMonths(e.target.value)}
            onBlur={commit}
            hint={`Empty to follow the type (${doc.type.name}).`}
          />
        )}
        {doc.reviews.length > 0 && (
          <ul aria-label="Reviews" className="divide-y divide-border-color">
            {doc.reviews.map((r) => (
              <li key={r.id} className="py-2 text-sm">
                <span className="text-primary-text">
                  {formatDay(r.at)} · {r.outcome === "no_change" ? "No change needed" : "Revision started"}
                  {r.revisionLetter ? ` (rev ${r.revisionLetter})` : ""}
                </span>
                <span className="text-secondary-text">
                  {r.by ? ` · ${r.by}` : ""}
                  {r.note ? ` · ${r.note}` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
      {open && <ReviewDialog doc={doc} onClose={() => setOpen(false)} />}
    </MenuCard>
  );
};

// ---- change requests -------------------------------------------------------------------------------

const RaiseDialog = ({ doc, onClose }) => {
  const { mutation, run } = useRun();
  const [what, setWhat] = useState("");
  const [why, setWhy] = useState("");
  const ok = what.trim().length >= 3 && why.trim().length >= 3;
  const save = (e) => {
    e.preventDefault();
    if (ok) run({ action: "raiseChangeRequest", id: doc.id, body: { what: what.trim(), why: why.trim() } }, onClose);
  };
  return (
    <Dialog title={`Ask for a change to ${doc.number}`} onClose={onClose}>
      <form noValidate onSubmit={save} className="flex flex-col gap-3">
        <Field label="What should change" value={what} onChange={(e) => setWhat(e.target.value)} required maxLength={2000} />
        <Field label="Why" value={why} onChange={(e) => setWhy(e.target.value)} required maxLength={2000} />
        <p className="text-sm text-secondary-text">A document manager accepts it into a new revision or declines it, and you are told either way.</p>
        <FormError error={mutation.error} />
        <Buttons onClose={onClose} pending={mutation.isPending} disabled={!ok} label="Send the request" />
      </form>
    </Dialog>
  );
};

const DeclineDialog = ({ request, onClose }) => {
  const { mutation, run } = useRun();
  const [reason, setReason] = useState("");
  const ok = reason.trim().length >= 3;
  const save = (e) => {
    e.preventDefault();
    if (ok) run({ action: "declineChangeRequest", id: request.id, body: { reason: reason.trim() } }, onClose);
  };
  return (
    <Dialog title={`Decline ${request.reference}`} onClose={onClose}>
      <form noValidate onSubmit={save} className="flex flex-col gap-3">
        <Field label="Why?" value={reason} onChange={(e) => setReason(e.target.value)} required maxLength={1000} hint="The person who asked is told." />
        <FormError error={mutation.error} />
        <Buttons onClose={onClose} pending={mutation.isPending} disabled={!ok} label="Decline" type="danger" />
      </form>
    </Dialog>
  );
};

/** One change request with what can be done to it: accept or decline (managers), withdraw (the person who asked). */
export const ChangeRequestRow = ({ request, canManage, showDocument = false }) => {
  const { user } = useAuth();
  const { mutation, run } = useRun();
  const navigate = useNavigate();
  const [declining, setDeclining] = useState(false);
  const open = request.status === "open";
  return (
    <li className="flex flex-col gap-1 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium text-primary-text">
          {request.reference}
          {showDocument && (
            <>
              {" · "}
              <Link to={`/Documentation/Documents/${request.document.id}`} className="hover:underline">
                {request.document.number} {request.document.title}
              </Link>
            </>
          )}
        </span>
        <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${statusPill(CHANGE_REQUEST_STATUS, request.status)}`}>{CHANGE_REQUEST_STATUS[request.status]?.label}</span>
      </div>
      <p className="text-sm text-primary-text">{request.what}</p>
      <p className="text-sm text-secondary-text">
        Why: {request.why} · {request.requestedBy?.name ?? "Unknown"}, {formatDay(request.createdAt)}
      </p>
      {request.status === "declined" && <p className="text-sm text-error-color">Declined: {request.decisionReason}</p>}
      {request.revision && (
        <Link to={revisionPath(request.document.id, request.revision.id)} className="w-fit text-sm text-link-color hover:underline">
          {request.revision.letter ? `Rev ${request.revision.letter}` : "The draft"} it went into
        </Link>
      )}
      {open && (
        <div className="flex flex-wrap gap-2 pt-1">
          {canManage && (
            <CTAButton
              type="success"
              loading={mutation.isPending}
              onClick={() => run({ action: "acceptChangeRequest", id: request.id }, (r) => r?.revision && navigate(revisionPath(r.document.id, r.revision.id)))}>
              Accept into a revision
            </CTAButton>
          )}
          {canManage && (
            <CTAButton type="danger" onClick={() => setDeclining(true)}>
              Decline
            </CTAButton>
          )}
          {request.requestedBy?.id === user?.id && (
            <CTAButton type="neutral" loading={mutation.isPending} onClick={() => run({ action: "withdrawChangeRequest", id: request.id })}>
              Withdraw
            </CTAButton>
          )}
        </div>
      )}
      {declining && <DeclineDialog request={request} onClose={() => setDeclining(false)} />}
    </li>
  );
};

/** Requests for a change to this document: anyone who may read it asks; managers accept or decline. */
export const ChangeRequestsCard = ({ doc }) => {
  const { can } = usePermissions();
  const [raising, setRaising] = useState(false);
  const canAsk = can("documentation.read") && doc.status !== "discarded";
  return (
    <MenuCard
      title="Change requests"
      subtitle={doc.canManage ? "Every request for a change" : "Your requests for a change"}
      action={
        canAsk && (
          <CTAButton type="secondary" icon={MessageSquarePlusIcon} onClick={() => setRaising(true)}>
            Ask for a change
          </CTAButton>
        )
      }>
      {doc.changeRequests.length === 0 ? (
        <p className="text-sm text-secondary-text">No change requests.</p>
      ) : (
        <ul aria-label="Change requests" className="-my-3 divide-y divide-border-color">
          {doc.changeRequests.map((c) => (
            <ChangeRequestRow key={c.id} request={c} canManage={doc.canManage} />
          ))}
        </ul>
      )}
      {raising && <RaiseDialog doc={doc} onClose={() => setRaising(false)} />}
    </MenuCard>
  );
};

// ---- links -----------------------------------------------------------------------------------------

/** Where the document applies: parts, part families, machines and operation codes. It then shows on those pages and on jobs for them. */
export const LinksCard = ({ doc }) => {
  const { run } = useRun();
  const families = usePartFamilies();
  const [op, setOp] = useState("");
  const editable = doc.canManage;
  if (!editable && doc.links.length === 0) return null;
  const save = (links) => run({ action: "setLinks", id: doc.id, body: { links: links.map(linkBody) } });
  const has = (kind, refId) => doc.links.some((l) => l.kind === kind && String(l.refId).toUpperCase() === String(refId).toUpperCase());
  const add = (kind, refId, label) => refId && !has(kind, refId) && save([...doc.links, { kind, refId, label }]);
  const familyOptions = (families.data?.items ?? []).filter((f) => !has("part_family", f.id)).map((f) => ({ value: f.id, label: f.name, hint: f.code }));
  return (
    <MenuCard title="Where it applies" subtitle="Parts, part families, machines and operations. Shown there and on jobs for them, for information.">
      <div className="flex flex-col gap-3">
        {doc.links.length === 0 ? (
          <p className="text-sm text-secondary-text">Not linked to anything.</p>
        ) : (
          <ul aria-label="Where it applies" className="flex flex-wrap gap-2">
            {doc.links.map((l) => (
              <li key={l.id} className="flex items-center gap-1 rounded-full bg-primary-bg px-3 py-1 text-sm text-primary-text">
                <span className="text-secondary-text">{LINK_KIND[l.kind]}:</span> {l.label}
                {editable && (
                  <button type="button" aria-label={`Remove ${l.label}`} onClick={() => save(doc.links.filter((x) => x !== l))} className="text-icon-color hover:text-error-color">
                    <XIcon className="h-3.5 w-3.5" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {editable && (
          <div className="grid gap-3 sm:grid-cols-2">
            <PartPicker label="Add a part" value={null} onChange={(id, item) => add("part", id, item?.name)} />
            <ComboField label="Add a part family" value={null} onChange={(v) => add("part_family", v, familyOptions.find((f) => f.value === v)?.label)} options={familyOptions} placeholder="Choose a family" />
            <MachinePicker label="Add a machine" value={null} onChange={(id, item) => add("machine", id, item?.name)} />
            <div className="flex items-end gap-2">
              <Field label="Add an operation" value={op} onChange={(e) => setOp(e.target.value)} maxLength={40} placeholder="e.g. OP-20" />
              <CTAButton
                type="neutral"
                icon={PlusIcon}
                aria-label="Add the operation"
                disabled={!op.trim()}
                onClick={() => {
                  add("operation", op.trim(), op.trim());
                  setOp("");
                }}
              />
            </div>
          </div>
        )}
      </div>
    </MenuCard>
  );
};
