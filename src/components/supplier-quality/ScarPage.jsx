import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { PencilIcon, PlusIcon } from "@/components/icons";
import { usePermissions } from "../../hooks/useQmsApi";
import { useScar, useScarMutation } from "../../hooks/useSupplierQuality";
import { formatDate, ncrPath } from "../../lib/ncr";
import { formatDateTime } from "../../lib/processControl";
import { EXTENSION_STATUS, SCAR_STAGES, rootCauseMethodLabel, scarIsRunning, scarStageIndex, scarStatusOf } from "../../lib/supplierScars";
import { useBreadcrumbNames } from "../../lib/breadcrumbs";
import Breadcrumb from "../Breadcrumb";
import CTAButton from "../CTAButton";
import Callout from "../ui/Callout";
import Dialog from "../ui/Dialog";
import LoadingScreen from "../ui/LoadingScreen";
import MenuCard from "../ui/MenuCard";
import { ErrorNotice, FormError } from "../master-data/shared";
import { StagePill } from "../ncr/Pills";
import { AcknowledgeDialog, DecideExtensionDialog, EditScarDialog, ExtendDialog, ImplementationDialog, ItemDialog, LinkNcrDialog, ReasonCommandDialog, ResponseDialog, ReviewDialog, VerificationDialog } from "./ScarDialogs";
import { OverdueFlag, ScarSeverityPill, ScarStatusPill } from "./ScarPills";

const Fact = ({ label, children }) => (
  <div className="min-w-0">
    <dt className="text-xs text-secondary-text">{label}</dt>
    <dd className="text-sm text-primary-text">{children ?? "—"}</dd>
  </div>
);

const by = (p, at) => (p ? `${p.name}, ${formatDateTime(at)}` : formatDateTime(at));

/** The five stages kept visibly apart; the current one is marked and finished ones are ticked. */
const StageRail = ({ status }) => {
  const at = scarStageIndex(status);
  return (
    <ol className="flex flex-wrap gap-2" aria-label="Stages">
      {SCAR_STAGES.map((s, i) => {
        const state = at === -1 ? "off" : i < at ? "done" : i === at ? "current" : "todo";
        const tone = { done: "border-success-color/40 bg-success-color/10 text-success-color", current: "border-brand-primary bg-brand-primary/10 text-primary-text font-medium", todo: "border-border-color text-secondary-text", off: "border-border-color text-secondary-text opacity-60" }[state];
        return (
          <li key={s.key} aria-current={state === "current" ? "step" : undefined} className={`rounded-full border px-3 py-1 text-xs ${tone}`}>
            {state === "done" ? "✓ " : `${i + 1}. `}{s.label}
          </li>
        );
      })}
    </ol>
  );
};

/** What to do next, by status, limited to what this person may do. The database still checks every step. */
const nextActions = (scar, can, open) => {
  const manage = can("supplier_quality.manage");
  const approve = can("supplier_quality.approve");
  const a = [];
  const push = (label, onClick, type = "main") => a.push({ label, onClick, type });
  if (manage) {
    switch (scar.status) {
      case "draft": push("Issue to the supplier", () => open({ kind: "issue" })); break;
      case "issued": push("Record a response", () => open({ kind: "respond" })); push("Record acknowledgement", () => open({ kind: "acknowledge" }), "secondary"); break;
      case "acknowledged": push("Record a response", () => open({ kind: "respond" })); break;
      case "revision_requested": push("Record a new response", () => open({ kind: "respond" })); break;
      case "response_received": push("Start the review", () => open({ kind: "startReview" })); break;
      case "under_review": push("Accept the response", () => open({ kind: "review", initial: "accepted" })); push("Ask for a revision", () => open({ kind: "review", initial: "revision_requested" }), "secondary"); break;
      case "accepted": push("Record implementation", () => open({ kind: "implement" })); break;
      case "verifying": push("Record more implementation", () => open({ kind: "implement" }), "secondary"); break;
      default: break;
    }
    if (["issued", "acknowledged", "revision_requested"].includes(scar.status) && !scar.extensions.some((e) => e.status === "pending")) push("Request more time", () => open({ kind: "extend" }), "neutral");
  }
  if (approve && scar.status === "verifying") a.unshift({ label: "Verify effectiveness", onClick: () => open({ kind: "verify" }), type: "main" });
  return a;
};

const NEEDS = {
  draft: "Check the details, link the non-conformances and set a response due date, then issue it.",
  issued: "Waiting for the supplier. Record their response when it arrives (an acknowledgement is optional).",
  acknowledged: "The supplier has it. Waiting for their response.",
  response_received: "A response is in. Start the review when you are ready to read it.",
  under_review: "Decide whether the response is acceptable.",
  revision_requested: "The supplier is asked to answer again. Record the new response when it arrives.",
  accepted: "The response is accepted. Record when the fix has been carried out.",
  verifying: "The fix is in. Someone with approval rights checks it worked; an effective result closes the SCAR.",
  closed: "Closed: the fix was verified effective.",
  cancelled: "Cancelled.",
};

const ScarPage = () => {
  const { id } = useParams();
  const { can } = usePermissions();
  const query = useScar(id);
  useBreadcrumbNames([{ path: `/Supplier-Quality/SCARs/${id}`, label: query.data?.reference }]);
  const [dialog, setDialog] = useState(null);
  const mutation = useScarMutation();
  const open = (d) => setDialog(d);
  const close = () => setDialog(null);

  if (query.isLoading) return <LoadingScreen />;
  if (query.error) return <div className="p-4"><ErrorNotice error={query.error} /></div>;
  const s = query.data;
  const manage = can("supplier_quality.manage");
  const running = scarIsRunning(s.status);
  const actions = nextActions(s, can, open);
  const liveItems = s.items.filter((i) => !i.endedAt);
  const endedItems = s.items.filter((i) => i.endedAt);
  const liveNcrs = s.ncrs.filter((n) => !n.endedAt);
  const endedNcrs = s.ncrs.filter((n) => n.endedAt);
  const draft = s.status === "draft";

  const run = (kind) => {
    if (kind === "issue") mutation.mutate({ action: "issue", id: s.id }, { onSuccess: close });
    if (kind === "startReview") mutation.mutate({ action: "startReview", id: s.id }, { onSuccess: close });
  };

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col gap-4 overflow-y-auto p-4">
      <Breadcrumb />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold text-primary-text">{s.reference}</h1>
            <ScarStatusPill status={s.status} />
            <ScarSeverityPill severity={s.severity} />
          </div>
          <p className="text-lg text-primary-text">{s.title}</p>
          <p className="text-sm text-secondary-text">
            <Link to={`/Suppliers/${s.supplier.id}`} className="text-link-color hover:underline">{s.supplier.code} · {s.supplier.name}</Link>
            {s.contact && <> · contact {s.contact.name}</>}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {manage && draft && <CTAButton type="secondary" size="default" icon={PencilIcon} onClick={() => open({ kind: "edit" })}>Edit</CTAButton>}
          {manage && running && <CTAButton type="danger" size="default" onClick={() => open({ kind: "cancel" })}>Cancel SCAR</CTAButton>}
        </div>
      </div>

      <StageRail status={s.status} />

      {s.overdue && <Callout tone="error" title={`The response is ${s.daysOverdue} ${s.daysOverdue === 1 ? "day" : "days"} late`}>It was due {formatDate(s.responseDueOn)}. Chase the supplier, or extend the date with a reason.</Callout>}
      {s.status === "cancelled" && <Callout tone="warning" title="Cancelled">{s.cancelReason} <span className="text-secondary-text">({by(s.cancelledBy, s.cancelledAt)})</span></Callout>}
      {s.status === "closed" && <Callout tone="success" title="Closed">Verified effective {by(s.closedBy, s.closedAt)}.</Callout>}
      {running && (
        <MenuCard title="Next" subtitle={NEEDS[s.status]}>
          {actions.length === 0 ? (
            <p className="text-sm text-secondary-text">{s.status === "verifying" ? "Waiting for someone with approval rights to verify effectiveness." : "Nothing for you to do here."}</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {actions.map((a) => <CTAButton key={a.label} type={a.type} size="md" onClick={a.onClick}>{a.label}</CTAButton>)}
            </div>
          )}
          {s.status === "verifying" && !can("supplier_quality.approve") && actions.length > 0 && <p className="mt-2 text-sm text-secondary-text">Waiting for someone with approval rights to verify effectiveness.</p>}
          {mutation.error && <div className="mt-2"><ErrorNotice error={mutation.error} /></div>}
        </MenuCard>
      )}

      <MenuCard title="The request" subtitle="What the supplier is being asked to do.">
        <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Fact label="Response due">{s.responseDueOn ? <>{formatDate(s.responseDueOn)}<OverdueFlag scar={s} /></> : null}</Fact>
          <Fact label="Originally due">{s.originalResponseDueOn && s.originalResponseDueOn !== s.responseDueOn ? formatDate(s.originalResponseDueOn) : null}</Fact>
          <Fact label="Issued">{s.issuedAt ? by(s.issuedBy, s.issuedAt) : null}</Fact>
          <Fact label="Acknowledged">{s.acknowledgedAt ? `${by(s.acknowledgedBy, s.acknowledgedAt)}${s.acknowledgedNote ? ` — ${s.acknowledgedNote}` : ""}` : null}</Fact>
          <Fact label="Internal owner">{s.owner?.name}</Fact>
          <Fact label="Internal 8D">{s.capa ? <Link to={`/CAPA/${s.capa.id}`} className="text-link-color hover:underline">{s.capa.reference}</Link> : null}</Fact>
          <Fact label="Raised">{by(s.createdBy, s.createdAt)}</Fact>
        </dl>
        {s.problemDescription && <p className="mt-3 whitespace-pre-wrap text-sm text-primary-text">{s.problemDescription}</p>}
        {(s.requirementBreached || s.objectiveEvidence || s.containmentRequirements) && (
          <dl className="mt-3 grid gap-3 sm:grid-cols-3">
            <Fact label="Requirement breached">{s.requirementBreached}</Fact>
            <Fact label="Objective evidence">{s.objectiveEvidence}</Fact>
            <Fact label="Containment required">{s.containmentRequirements}</Fact>
          </dl>
        )}
      </MenuCard>

      <MenuCard title="Affected items" subtitle="The parts, materials, lots and deliveries the problem touches."
        action={manage && running ? <CTAButton type="secondary" size="default" icon={PlusIcon} onClick={() => open({ kind: "item" })}>Add</CTAButton> : null}>
        {liveItems.length === 0 ? <p className="text-sm text-secondary-text">None listed yet.</p> : (
          <ul className="flex flex-col divide-y divide-border-color" aria-label="Affected items">
            {liveItems.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm text-primary-text">
                <span>
                  {[i.part && `${i.part.partNumber} · ${i.part.name}`, i.lot && `Lot ${i.lot.lotNumber}`, i.material, i.receiptReference && `Receipt ${i.receiptReference}`].filter(Boolean).join(" · ")}
                  {i.quantity !== null && <span className="text-secondary-text"> · quantity {i.quantity}</span>}
                  {i.notes && <span className="block text-xs text-secondary-text">{i.notes}</span>}
                </span>
                {manage && running && <button type="button" className="text-xs text-secondary-text hover:underline" onClick={() => open({ kind: "removeItem", itemId: i.id })}>Remove</button>}
              </li>
            ))}
          </ul>
        )}
        {endedItems.length > 0 && (
          <details className="mt-2 text-sm text-secondary-text">
            <summary className="cursor-pointer">{endedItems.length} removed</summary>
            <ul className="mt-1 flex flex-col gap-1">{endedItems.map((i) => <li key={i.id}>{i.part?.partNumber ?? i.material ?? i.receiptReference ?? "Item"} — {i.endReason}</li>)}</ul>
          </details>
        )}
      </MenuCard>

      <MenuCard title="Non-conformances" subtitle="The supplier's non-conformances this request is about."
        action={manage && running ? <CTAButton type="secondary" size="default" icon={PlusIcon} onClick={() => open({ kind: "link" })}>Link</CTAButton> : null}>
        {liveNcrs.length === 0 ? <p className="text-sm text-secondary-text">None linked yet. At least one is needed before the SCAR can be issued.</p> : (
          <ul className="flex flex-col divide-y divide-border-color" aria-label="Linked non-conformances">
            {liveNcrs.map((n) => (
              <li key={n.linkId} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="text-sm text-primary-text"><Link to={ncrPath(n.ncr.id)} className="text-link-color hover:underline">{n.ncr.reference}</Link> · {n.ncr.title}</span>
                <span className="flex items-center gap-3"><StagePill stage={n.ncr.stage} />
                  {manage && running && <button type="button" className="text-xs text-secondary-text hover:underline" onClick={() => open({ kind: "unlink", linkId: n.linkId, label: n.ncr.reference })}>Unlink</button>}
                </span>
              </li>
            ))}
          </ul>
        )}
        {endedNcrs.length > 0 && (
          <details className="mt-2 text-sm text-secondary-text">
            <summary className="cursor-pointer">{endedNcrs.length} unlinked</summary>
            <ul className="mt-1 flex flex-col gap-1">{endedNcrs.map((n) => <li key={n.linkId}>{n.ncr.reference} — {n.endReason}</li>)}</ul>
          </details>
        )}
      </MenuCard>

      <MenuCard title="Supplier responses" subtitle="What the supplier said, kept exactly as recorded, each with our decision on it.">
        {s.responses.length === 0 ? <p className="text-sm text-secondary-text">No response yet.</p> : (
          <ol className="flex flex-col gap-4" aria-label="Responses">
            {s.responses.map((r) => (
              <li key={r.id} className="rounded-lg border border-border-color p-3">
                <p className="mb-2 text-sm font-medium text-primary-text">Response {r.seq} <span className="font-normal text-secondary-text">· {formatDate(r.respondedOn)}{r.respondedByName ? ` · ${r.respondedByName}` : ""} · recorded {by(r.receivedBy, r.receivedAt)}</span></p>
                <dl className="grid gap-3 sm:grid-cols-2">
                  <Fact label="Root cause">{r.rootCause}</Fact>
                  <Fact label="Containment">{r.containment}</Fact>
                  <Fact label="Root cause method">{rootCauseMethodLabel(r.rootCauseMethod)}</Fact>
                  <Fact label="Escape point">{r.escapePoint}</Fact>
                  <Fact label="Extent of condition">{r.extentOfCondition}</Fact>
                  <Fact label="Corrective action">{r.correctiveAction}</Fact>
                  <Fact label="Responsible for it">{r.responsibleName}</Fact>
                  <Fact label="Preventive action">{r.preventiveAction}</Fact>
                  <Fact label="Planned completion">{r.plannedCompletionOn ? formatDate(r.plannedCompletionOn) : null}</Fact>
                </dl>
                {r.review ? (
                  <Callout tone={r.review.decision === "accepted" ? "success" : "warning"} title={r.review.decision === "accepted" ? "Accepted" : "Revision requested"} className="mt-3">
                    {r.review.note} <span className="text-secondary-text">({by(r.review.reviewedBy, r.review.reviewedAt)})</span>
                  </Callout>
                ) : <p className="mt-2 text-xs text-secondary-text">Not reviewed yet.</p>}
              </li>
            ))}
          </ol>
        )}
      </MenuCard>

      <MenuCard title="Implementation" subtitle="The accepted fix being carried out. Whether it worked is checked below.">
        {s.implementations.length === 0 ? <p className="text-sm text-secondary-text">Nothing implemented yet.</p> : (
          <ul className="flex flex-col divide-y divide-border-color" aria-label="Implementation">
            {s.implementations.map((i) => (
              <li key={i.id} className="py-2 text-sm text-primary-text">
                {i.description}
                <span className="block text-xs text-secondary-text">Implemented {formatDate(i.implementedOn)} · recorded {by(i.recordedBy, i.recordedAt)}{i.evidenceNote ? ` · ${i.evidenceNote}` : ""}</span>
              </li>
            ))}
          </ul>
        )}
      </MenuCard>

      <MenuCard title="Effectiveness verification" subtitle="Did the fix work. Only an effective result closes the SCAR.">
        {s.verifications.length === 0 ? <p className="text-sm text-secondary-text">Not checked yet.</p> : (
          <ul className="flex flex-col gap-2" aria-label="Verifications">
            {s.verifications.map((v) => (
              <li key={v.id}>
                <Callout tone={v.result === "effective" ? "success" : "error"} title={v.result === "effective" ? "Effective" : "Not effective"}>
                  <strong>{v.method}.</strong> {v.note} <span className="text-secondary-text">({by(v.verifiedBy, v.verifiedAt)})</span>
                </Callout>
              </li>
            ))}
          </ul>
        )}
      </MenuCard>

      {s.extensions.length > 0 && (
        <MenuCard title="Due-date extensions" subtitle="Asked for by one person and decided by another. The date moves only when one is approved; the original date is kept.">
          <ul className="flex flex-col divide-y divide-border-color" aria-label="Extensions">
            {s.extensions.map((e) => (
              <li key={e.id} className="flex flex-wrap items-start justify-between gap-2 py-2 text-sm text-primary-text">
                <span>
                  {formatDate(e.previousDueOn)} → {formatDate(e.newDueOn)} · {e.reason}
                  <span className="block text-xs text-secondary-text">Asked {by(e.extendedBy, e.extendedAt)}</span>
                  {e.status !== "pending" && e.decidedAt && <span className="block text-xs text-secondary-text">{EXTENSION_STATUS[e.status].label}{e.decidedBy ? ` by ${e.decidedBy.name}` : ""}, {formatDateTime(e.decidedAt)}{e.decisionNote ? ` — ${e.decisionNote}` : ""}</span>}
                </span>
                <span className="flex items-center gap-2">
                  <span className={`inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${EXTENSION_STATUS[e.status].tone}`}>{EXTENSION_STATUS[e.status].label}</span>
                  {e.canDecide && <CTAButton type="main" size="default" onClick={() => open({ kind: "decideExtension", extension: e })}>Decide</CTAButton>}
                  {e.status === "pending" && manage && running && <button type="button" className="text-xs text-secondary-text hover:underline" onClick={() => open({ kind: "withdrawExtension", extensionId: e.id })}>Withdraw</button>}
                </span>
              </li>
            ))}
          </ul>
        </MenuCard>
      )}

      <MenuCard title="History" subtitle="Every status change, kept.">
        <ol className="flex flex-col divide-y divide-border-color" aria-label="History">
          {s.history.map((h) => (
            <li key={h.id} className="flex flex-wrap items-baseline justify-between gap-2 py-2 text-sm text-primary-text">
              <span>{h.fromStatus ? `${scarStatusOf(h.fromStatus).label} → ` : ""}<strong>{scarStatusOf(h.toStatus).label}</strong>{h.reason ? <span className="text-secondary-text"> · {h.reason}</span> : null}</span>
              <span className="text-xs text-secondary-text">{by(h.changedBy, h.changedAt)}</span>
            </li>
          ))}
        </ol>
      </MenuCard>

      {dialog?.kind === "edit" && <EditScarDialog scar={s} onClose={close} />}
      {dialog?.kind === "acknowledge" && <AcknowledgeDialog scar={s} onClose={close} />}
      {dialog?.kind === "respond" && <ResponseDialog scar={s} onClose={close} />}
      {dialog?.kind === "review" && <ReviewDialog scar={s} initial={dialog.initial} onClose={close} />}
      {dialog?.kind === "implement" && <ImplementationDialog scar={s} onClose={close} />}
      {dialog?.kind === "verify" && <VerificationDialog scar={s} onClose={close} />}
      {dialog?.kind === "extend" && <ExtendDialog scar={s} onClose={close} />}
      {dialog?.kind === "item" && <ItemDialog scar={s} onClose={close} />}
      {dialog?.kind === "decideExtension" && <DecideExtensionDialog extension={dialog.extension} onClose={close} />}
      {dialog?.kind === "removeItem" && <ReasonCommandDialog title="Remove this item" intro="The item is removed from the list and kept, with the reason." label="Why is it being removed?" submitLabel="Remove" action="removeItem" id={dialog.itemId} onClose={close} />}
      {dialog?.kind === "withdrawExtension" && <ReasonCommandDialog title="Withdraw the request" intro="The request is withdrawn and kept, with the reason." label="Why is it being withdrawn?" submitLabel="Withdraw" action="withdrawExtension" id={dialog.extensionId} onClose={close} />}
      {dialog?.kind === "link" && <LinkNcrDialog scar={s} onClose={close} />}
      {dialog?.kind === "cancel" && <ReasonCommandDialog title="Cancel this SCAR" intro="A cancelled SCAR is kept, with the reason, but cannot be worked on." label="Why is it being cancelled?" submitLabel="Cancel SCAR" action="cancel" id={s.id} onClose={close} />}
      {dialog?.kind === "unlink" && <ReasonCommandDialog title={`Unlink ${dialog.label}`} intro="The link is ended and kept, with the reason." label="Why is it being unlinked?" submitLabel="Unlink" action="unlinkNcr" id={dialog.linkId} onClose={close} />}
      {(dialog?.kind === "issue" || dialog?.kind === "startReview") && (
        <ConfirmCommand kind={dialog.kind} pending={mutation.isPending} error={mutation.error} onConfirm={() => run(dialog.kind)} onClose={close} />
      )}
    </div>
  );
};


/** A plain "are you sure" for the two commands that need no input. */
const ConfirmCommand = ({ kind, pending, error, onConfirm, onClose }) => (
  <Dialog title={kind === "issue" ? "Issue this SCAR" : "Start the review"} onClose={onClose}>
    <div className="flex flex-col gap-3">
      <p className="text-sm text-secondary-text">
        {kind === "issue" ? "The SCAR becomes the supplier's request and its content is fixed: only the contact can change afterwards, and the due date can only move by a recorded extension." : "You are about to review the latest response. You will then accept it or ask for a revision."}
      </p>
      <FormError error={error} />
      <div className="flex justify-end gap-2">
        <CTAButton buttonType="button" type="neutral" size="md" onClick={onClose}>Cancel</CTAButton>
        <CTAButton buttonType="button" type="main" size="lg" disabled={pending} onClick={onConfirm}>{pending ? "Saving…" : kind === "issue" ? "Issue" : "Start review"}</CTAButton>
      </div>
    </div>
  </Dialog>
);

export default ScarPage;
