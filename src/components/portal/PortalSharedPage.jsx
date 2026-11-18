import { Link, useOutletContext, useParams } from "react-router-dom";
import Callout from "../ui/Callout";
import LoadingScreen from "../ui/LoadingScreen";
import CommentThread from "./CommentThread";
import { ArrowLeftIcon } from "@/components/icons";
import { openPortalDocumentFile, usePortalShare, usePortalShareMutation } from "../../hooks/usePortal";
import CTAButton from "@/components/CTAButton";
import DocumentEditor from "../documents/DocumentEditor";
import { TextAreaField } from "../master-data/shared";
import { useToast } from "../../contexts/ToastProvider";
import { useState } from "react";
import { formatBytes } from "../../lib/supplierQualification";
import { describeApiError } from "../../lib/api-client";
import { STAGES as NC_STAGES } from "../../lib/ncr";
import { STAGES as CAPA_STAGES } from "../../lib/capa";
import { longDateTime, shareKindLabel, sharedHeading, shortDate } from "../../lib/portal";

const Fact = ({ label, value }) =>
  value === null || value === undefined || value === "" ? null : (
    <>
      <dt className="text-secondary-text">{label}</dt>
      <dd className="min-w-0 whitespace-pre-wrap break-words text-primary-text">{value}</dd>
    </>
  );

const Block = ({ title, children }) => (
  <section aria-label={title} className="flex flex-col gap-2 rounded-2xl border border-border-color bg-secondary-bg p-5">
    <h2 className="text-lg font-semibold text-primary-text">{title}</h2>
    {children}
  </section>
);

const Facts = ({ children }) => <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[11rem_1fr]">{children}</dl>;

const stageWords = (kind, key) => (kind === "capa" ? CAPA_STAGES : NC_STAGES).find((s) => s.key === key)?.label ?? key;
const caps = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const status = (s) => ({ open: "Open", done: "Done", cancelled: "Cancelled" })[s] ?? s;
const decision = (d) => ({ rework: "Rework", repair: "Repair", scrap: "Scrap", use_as_is: "Use as is", return_to_supplier: "Return to supplier", concession: "Concession", customer_return: "Customer return" })[d] ?? d;
const containmentKind = (k) => ({ quarantine: "Quarantine", sort: "Sort", stop_ship: "Stop shipping", notify_customer: "Tell the customer", notify_supplier: "Tell the supplier", recall: "Recall", other: "Other" })[k] ?? k;

const Actions = ({ items, label, kind }) =>
  items.length === 0 ? <p className="text-sm text-secondary-text">None.</p> : (
    <ul aria-label={label} className="flex flex-col gap-2">
      {items.map((a, i) => (
        <li key={i} className="rounded-xl border border-border-color px-3 py-2 text-sm">
          <p className="text-primary-text">{kind ? `${containmentKind(a.kind)}: ` : ""}{a.description}</p>
          <p className="text-xs text-secondary-text">{status(a.status)}{a.dueDate ? ` · due ${shortDate(a.dueDate)}` : ""}{a.quantityContained != null ? ` · ${a.quantityContained} contained` : ""}</p>
          {a.resultNote && <p className="mt-1 text-xs text-secondary-text">Result: {a.resultNote}</p>}
        </li>
      ))}
    </ul>
  );

function NcRecord({ r }) {
  return (
    <>
      <Block title="What was found">
        <Facts>
          <Fact label="Description" value={r.description} />
          <Fact label="Requirement" value={r.requirement} />
          <Fact label="Actual result" value={r.actualResult} />
          <Fact label="Severity" value={caps(r.severity)} />
          <Fact label="Detected" value={shortDate(r.detectedAt)} />
        </Facts>
      </Block>
      <Block title="Which parts">
        <Facts>
          <Fact label="Part" value={[r.partNumber, r.partName].filter(Boolean).join(" · ")} />
          <Fact label="Revision" value={r.partRevision} />
          <Fact label="Lot" value={r.lotNumber} />
          <Fact label="Serial number" value={r.serialNumber} />
          <Fact label="Purchase order" value={r.purchaseOrder} />
          <Fact label="Your reference" value={r.customerReference} />
          <Fact label="Quantity affected" value={r.quantityAffected} />
          <Fact label="Quantity inspected" value={r.quantityInspected} />
        </Facts>
      </Block>
      <Block title="Containment"><Actions items={r.containment} label="Containment actions" kind /></Block>
      <Block title="Decision">
        {r.disposition.length === 0 ? <p className="text-sm text-secondary-text">No decision has been approved yet.</p> : (
          <ul aria-label="Approved decisions" className="flex flex-col gap-2">
            {r.disposition.map((d, i) => (
              <li key={i} className="rounded-xl border border-border-color px-3 py-2 text-sm">
                <p className="font-medium text-primary-text">{decision(d.decision)} · {d.quantity}{d.reference ? ` · ${d.reference}` : ""}</p>
                <p className="text-secondary-text">{d.instructions}</p>
              </li>
            ))}
          </ul>
        )}
      </Block>
    </>
  );
}

function CapaRecord({ r }) {
  return (
    <>
      <Block title="The problem">
        <Facts>
          <Fact label="Problem" value={r.problemStatement} />
          <Fact label="Who" value={r.problem.who} />
          <Fact label="What" value={r.problem.what} />
          <Fact label="Where" value={r.problem.where} />
          <Fact label="When" value={r.problem.when} />
          <Fact label="Why it matters" value={r.problem.why} />
          <Fact label="How it was found" value={r.problem.how} />
          <Fact label="How many" value={r.problem.howMany} />
        </Facts>
      </Block>
      <Block title="Containment">
        <Actions items={r.containment} label="Containment actions" />
        {r.noContainmentReason && <p className="text-sm text-secondary-text">No containment needed: {r.noContainmentReason}</p>}
      </Block>
      <Block title="Root causes">
        {r.rootCauses.length === 0 ? <p className="text-sm text-secondary-text">None confirmed yet.</p> : (
          <ul aria-label="Root causes" className="flex flex-col gap-2">
            {r.rootCauses.map((c, i) => <li key={i} className="rounded-xl border border-border-color px-3 py-2 text-sm"><span className="font-medium capitalize">{c.kind}:</span> {c.description}</li>)}
          </ul>
        )}
      </Block>
      <Block title="Corrective actions"><Actions items={r.correctiveActions} label="Corrective actions" /></Block>
      <Block title="Verification">
        {r.verification ? <p className="text-sm text-primary-text">{r.verification.effective ? "Verified effective" : "Not effective"} · {r.verification.method} · {shortDate(r.verification.date)}</p> : <p className="text-sm text-secondary-text">Not verified yet.</p>}
      </Block>
      <Block title="Preventing it happening again">
        <Actions items={r.preventiveActions} label="Preventive actions" />
        {r.noPreventiveReason && <p className="text-sm text-secondary-text">No preventive action needed: {r.noPreventiveReason}</p>}
        {r.lessonsLearned && <p className="whitespace-pre-wrap text-sm text-primary-text"><span className="font-medium">Lessons learned:</span> {r.lessonsLearned}</p>}
      </Block>
      {r.closedAt && <p className="text-sm text-secondary-text">Closed {shortDate(r.closedAt)}. The team had {r.teamSize} {r.teamSize === 1 ? "member" : "members"}.</p>}
    </>
  );
}

const SEVERITY = { low: "Low", medium: "Medium", high: "High", critical: "Critical" };

/** Acknowledging a document revision or a quality alert: once per person; a new revision asks again. */
function AcknowledgeBlock({ r, shareId, organisationId, what }) {
  const mutate = usePortalShareMutation(organisationId, shareId);
  const { showToast } = useToast();
  const [note, setNote] = useState("");
  if (r.acknowledgedAt) {
    return <Callout tone="success" title="You have acknowledged this">On {longDateTime(r.acknowledgedAt)}. {what === "document" ? "If a new revision is issued you will be asked again." : ""}</Callout>;
  }
  if (!r.canAcknowledge) return null;
  return (
    <Block title="Acknowledge">
      <p className="text-sm text-secondary-text">
        {what === "document" ? "Confirm you have read and understood this revision." : "Confirm you have read this alert and will do what it asks."} We record your name, the time and what you acknowledged.
      </p>
      <TextAreaField label="Note (optional)" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
      <div>
        <CTAButton type="main" size="md" loading={mutate.isPending}
          onClick={() => mutate.mutate({ action: "acknowledge", body: note.trim() ? { note: note.trim() } : {} }, { onError: (error) => showToast({ type: "error", title: "Not acknowledged", message: describeApiError(error) }) })}>
          Acknowledge
        </CTAButton>
      </div>
    </Block>
  );
}

function DocumentRecord({ r, shareId, organisationId }) {
  const { showToast } = useToast();
  const open = (fileId) => openPortalDocumentFile(organisationId, shareId, fileId).catch((error) => showToast({ type: "error", title: "Could not open the file", message: describeApiError(error) }));
  return (
    <>
      <Block title="The document">
        <Facts>
          <Fact label="Type" value={r.type} />
          <Fact label="Revision" value={r.revision} />
          <Fact label="In force from" value={shortDate(r.effectiveFrom)} />
          <Fact label="What changed" value={r.changeSummary} />
          <Fact label="About" value={r.description} />
        </Facts>
      </Block>
      {r.contentKind === "text" && r.body && (
        <Block title="Text"><div className="document-text"><DocumentEditor value={r.body} editable={false} label="Document text" /></div></Block>
      )}
      {r.files.length > 0 && (
        <Block title="Files">
          <ul aria-label="Files" className="flex flex-col gap-2">
            {r.files.map((f) => (
              <li key={f.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border-color px-3 py-2 text-sm">
                <span className="min-w-0 break-words text-primary-text">{f.fileName} <span className="text-secondary-text">· {formatBytes(f.sizeBytes)}{f.role === "main" ? "" : " · attachment"}</span></span>
                <CTAButton type="neutral" size="default" aria-label={`Open ${f.fileName}`} onClick={() => open(f.id)}>Open</CTAButton>
              </li>
            ))}
          </ul>
        </Block>
      )}
      <AcknowledgeBlock r={r} shareId={shareId} organisationId={organisationId} what="document" />
    </>
  );
}

function AlertRecord({ r, shareId, organisationId }) {
  return (
    <>
      <Block title="What happened">
        <Facts>
          <Fact label="Severity" value={SEVERITY[r.severity] ?? r.severity} />
          <Fact label="Category" value={caps(r.category)} />
          <Fact label="In force from" value={shortDate(r.effectiveDate)} />
          <Fact label="Until" value={shortDate(r.expiryDate)} />
          <Fact label="Acknowledge by" value={shortDate(r.acknowledgeBy)} />
          <Fact label="Details" value={r.description} />
        </Facts>
      </Block>
      <Block title="What we ask of you">
        {r.actions.length === 0 ? <p className="text-sm text-secondary-text">Nothing specific.</p> : (
          <ol aria-label="Actions" className="flex list-decimal flex-col gap-1 pl-5 text-sm text-primary-text">
            {r.actions.map((a) => <li key={a.position}>{a.description}</li>)}
          </ol>
        )}
      </Block>
      <AcknowledgeBlock r={r} shareId={shareId} organisationId={organisationId} what="alert" />
    </>
  );
}

/** One shared record as the party sees it (docs/external-portal-plan.md PT2), with the conversation. Opening it tells staff it has been seen. */
export default function PortalSharedPage() {
  const { shareId } = useParams();
  const { access } = useOutletContext();
  const share = usePortalShare(access.organisationId, shareId);
  const mutate = usePortalShareMutation(access.organisationId, shareId);

  if (access.mfaRequired) return null;
  if (share.isLoading) return <LoadingScreen />;
  if (share.error) {
    return (
      <>
        <Back />
        <Callout tone="error" role="alert">{share.error.status === 404 ? "This is not shared with you (any more)." : describeApiError(share.error)}</Callout>
      </>
    );
  }
  const { kind, record: r, comments } = share.data;
  const heading = sharedHeading(kind, r);
  return (
    <>
      <Back />
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-primary-text">{heading.code} <span className="font-normal text-secondary-text">·</span> {heading.title}</h1>
        <p className="text-sm text-secondary-text">
          {shareKindLabel(kind)}{kind === "ncr" || kind === "capa" ? ` · ${stageWords(kind, r.stage)}${r.severity ? ` · ${caps(r.severity)}` : ""}` : ""} · shared by {access.organisationName} on {shortDate(r.sharedAt)} · contact: {r.contact}
        </p>
      </header>
      {kind === "ncr" && <NcRecord r={r} />}
      {kind === "capa" && <CapaRecord r={r} />}
      {kind === "document" && <DocumentRecord r={r} shareId={shareId} organisationId={access.organisationId} />}
      {kind === "quality_alert" && <AlertRecord r={r} shareId={shareId} organisationId={access.organisationId} />}
      <Block title="Conversation">
        <CommentThread
          comments={comments}
          sending={mutate.isPending && mutate.variables?.action === "comment"}
          onSend={(body) => mutate.mutateAsync({ action: "comment", body: { body } })}
          onWithdraw={(c) => mutate.mutate({ action: "withdraw", id: c.id })}
          error={mutate.error && mutate.variables?.action !== "comment" ? mutate.error : null}
        />
      </Block>
    </>
  );
}

const Back = () => (
  <Link to="/portal" className="flex w-fit items-center gap-1 text-sm text-link-color hover:underline"><ArrowLeftIcon className="h-4 w-4" /> Back to your portal</Link>
);
