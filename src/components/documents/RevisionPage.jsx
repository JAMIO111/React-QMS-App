import { useState } from "react";
import { useParams } from "react-router-dom";
import { Trash2Icon } from "@/components/icons";
import CTAButton from "@/components/CTAButton";
import { describeApiError } from "../../lib/api-client";
import { useToast } from "../../contexts/ToastProvider";
import { useDocumentFileMutation, useDocumentMutation, useDocumentRevision, useSaveDraft } from "../../hooks/useDocuments";
import { useBreadcrumbNames } from "../../lib/breadcrumbs";
import { documentPath, formatDay, revisionLabel, REVISION_STATUS, statusLabel, statusPill } from "../../lib/documents";
import { ErrorNotice, FormError } from "../master-data/shared";
import Callout from "../ui/Callout";
import Dialog from "../ui/Dialog";
import Field from "../ui/Field";
import { AttachmentDrop } from "../ui/FileDrop";
import LoadingScreen from "../ui/LoadingScreen";
import MenuCard from "../ui/MenuCard";
import DocumentEditor from "./DocumentEditor";
import { CompareCard, MyTurnCard, SignersCard, SignoffsCard, SubmitButton } from "./ReviewPanels";
import { AcknowledgeCard, AcknowledgeDaysField, RecipientsCard } from "./ReadersPanels";
import CopiesCard from "./ControlledCopy";
import RHFDatePickerPopout from "../ui/RHFDatePickerPopout";
import { todayIso } from "../../lib/localDate";

/** An external document's revision is recorded as issued (DC5): the issuer's own revision, and when it takes effect here. */
const IssueExternalDialog = ({ revision, onClose }) => {
  const mutation = useDocumentMutation();
  const { showToast } = useToast();
  const [issuerRevision, setIssuerRevision] = useState("");
  const [effectiveFrom, setEffectiveFrom] = useState(todayIso());
  const [summary, setSummary] = useState(revision.changeSummary ?? "");
  const needsSummary = ["active", "withdrawn"].includes(revision.document.status);
  const ready = issuerRevision.trim() && /^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom) && (!needsSummary || summary.trim().length >= 3);
  const save = (e) => {
    e.preventDefault();
    if (!ready) return;
    const body = { issuerRevision: issuerRevision.trim(), effectiveFrom };
    if (summary.trim()) body.changeSummary = summary.trim();
    mutation.mutate(
      { action: "issueExternal", id: revision.id, body },
      { onSuccess: onClose, onError: (err) => showToast({ type: "error", title: "Not recorded", message: describeApiError(err) }) },
    );
  };
  return (
    <Dialog title="Record this issue" onClose={onClose}>
      <form noValidate onSubmit={save} className="flex flex-col gap-3">
        <p className="text-sm text-secondary-text">
          {revision.document.issuer} issued this document, so it is not reviewed here. Record it as rev {revision.plannedLetter}; from the date given it is the revision in force
          {needsSummary ? " and the one before is superseded" : ""}.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Their revision" value={issuerRevision} onChange={(e) => setIssuerRevision(e.target.value)} required maxLength={40} placeholder="e.g. Issue 4, 2024-03" />
          <RHFDatePickerPopout label="In force from" required value={effectiveFrom} onChange={(v) => setEffectiveFrom(v ?? "")} valueFormat="iso" hint="A past date (when it applied) or a future one" />
        </div>
        <Field label="What changed" value={summary} onChange={(e) => setSummary(e.target.value)} required={needsSummary} maxLength={2000} hint={needsSummary ? "Readers see it with the new revision" : "Optional for the first issue"} />
        <FormError error={mutation.error} />
        <div className="flex justify-end gap-2">
          <CTAButton buttonType="button" type="neutral" size="md" onClick={onClose}>
            Cancel
          </CTAButton>
          <CTAButton buttonType="submit" type="main" size="md" disabled={!ready || mutation.isPending} loading={mutation.isPending}>
            Record as issued
          </CTAButton>
        </div>
      </form>
    </Dialog>
  );
};

const DiscardDialog = ({ revision, onClose }) => {
  const mutation = useDocumentMutation();
  const { showToast } = useToast();
  const [reason, setReason] = useState("");
  const only = revision.document.status === "draft";
  const save = (e) => {
    e.preventDefault();
    if (reason.trim().length < 3) return;
    mutation.mutate(
      { action: "discardRevision", id: revision.id, body: { reason: reason.trim() } },
      { onSuccess: onClose, onError: (err) => showToast({ type: "error", title: "Not discarded", message: describeApiError(err) }) },
    );
  };
  return (
    <Dialog title="Discard this draft" onClose={onClose}>
      <form noValidate onSubmit={save} className="flex flex-col gap-3">
        <p className="text-sm text-secondary-text">
          {only
            ? `This is the only draft of ${revision.document.number}, so the document is discarded too. Its number is kept and never reused.`
            : "The draft is kept, marked discarded, and can no longer change."}
        </p>
        <Field label="Why?" value={reason} onChange={(e) => setReason(e.target.value)} required maxLength={500} />
        <FormError error={mutation.error} />
        <div className="flex justify-end gap-2">
          <CTAButton buttonType="button" type="neutral" size="md" onClick={onClose}>
            Cancel
          </CTAButton>
          <CTAButton buttonType="submit" type="danger" size="md" disabled={reason.trim().length < 3 || mutation.isPending} loading={mutation.isPending}>
            Discard
          </CTAButton>
        </div>
      </form>
    </Dialog>
  );
};

/** What changed and why: saved when the field is left. */
const ChangeSummary = ({ revision, canEdit }) => {
  const save = useSaveDraft(revision.id);
  const { showToast } = useToast();
  const [value, setValue] = useState(revision.changeSummary ?? "");
  const required = revision.sequence > 1;
  if (!canEdit) {
    return <p className="whitespace-pre-wrap text-sm text-primary-text">{revision.changeSummary || (required ? "—" : "First issue")}</p>;
  }
  const commit = () => {
    const next = value.trim() || null;
    if (next === (revision.changeSummary ?? null)) return;
    save.mutate({ changeSummary: next }, { onError: (err) => showToast({ type: "error", title: "Not saved", message: describeApiError(err) }) });
  };
  return (
    <div>
      <Field
        label="Change summary"
        required={required}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        maxLength={2000}
        hint={required ? "What changed and why. Readers see it with the new revision." : "Optional for the first issue"}
      />
    </div>
  );
};

/**
 * A revision (`/Documentation/Documents/:id/revisions/:revisionId`). A draft is written here: text in the editor (saved as typing pauses) or the main file
 * and attachments, with a change summary, reviewers and an approver; then it is sent for review, reviewed, approved and takes effect (DC2).
 */
const RevisionPage = () => {
  const { id, revisionId } = useParams();
  const query = useDocumentRevision(revisionId);
  const fileMutation = useDocumentFileMutation();
  const saveBody = useSaveDraft(revisionId);
  const { showToast } = useToast();
  const [discarding, setDiscarding] = useState(false);
  const [issuing, setIssuing] = useState(false);
  const rev = query.data;
  const label = rev ? revisionLabel(rev, rev.plannedLetter) : null;
  useBreadcrumbNames([
    { path: `/Documentation/Documents/${id}`, label: rev ? `${rev.document.number} · ${rev.document.title}` : null },
    { path: `/Documentation/Documents/${id}/revisions`, label: "Revisions", to: documentPath(id) },
    { path: `/Documentation/Documents/${id}/revisions/${revisionId}`, label },
    { path: "/Documentation", label: "Documentation", to: "/Documentation/Documents" },
  ]);

  if (query.isLoading) return <LoadingScreen />;
  if (query.error) return <ErrorNotice error={query.error} />;
  const doc = rev.document;
  const canEdit = rev.canEdit;
  const problems = rev.problems;
  const files = rev.files;
  const external = doc.origin === "external";
  const asList = (list) => ({ data: list, isLoading: false });
  const saveText = (json) =>
    saveBody.mutate({ body: json }, { onError: (err) => showToast({ type: "error", title: "Text not saved", message: describeApiError(err) }) });

  return (
    <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col gap-4 overflow-y-auto bg-primary-bg p-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold text-primary-text">
              {doc.number} · {label}
            </h1>
            <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${statusPill(REVISION_STATUS, rev.status)}`}>{statusLabel(REVISION_STATUS, rev.status)}</span>
          </div>
          <p className="text-sm text-secondary-text">
            {doc.title} · {external ? `issued by ${doc.issuer}${doc.externalReference ? ` (${doc.externalReference})` : ""}, recorded by` : "written by"} {rev.author?.name ?? "Unknown"}
            {canEdit && (saveBody.isPending ? " · saving…" : " · saved")}
          </p>
        </div>
        <div className="flex gap-2">
          <CTAButton type="neutral" to={documentPath(doc.id)}>
            Back to the document
          </CTAButton>
          {!external && <SubmitButton revision={rev} />}
          {rev.canRecordIssue && (
            <CTAButton type="main" disabled={problems.length > 0} onClick={() => setIssuing(true)}>
              Record this issue
            </CTAButton>
          )}
          {canEdit && (
            <CTAButton type="danger" icon={Trash2Icon} onClick={() => setDiscarding(true)}>
              Discard draft
            </CTAButton>
          )}
        </div>
      </header>

      {rev.status === "discarded" && (
        <Callout tone="warning" title="Discarded">
          {rev.discardReason}
          {rev.discardedBy ? ` (${rev.discardedBy})` : ""}
        </Callout>
      )}
      {rev.status === "draft" && !canEdit && <Callout tone="info">This draft is being written. Only document managers can change it.</Callout>}
      {canEdit &&
        (problems.length ? (
          <Callout tone="warning" title={external ? "Still needed before it can be recorded as issued" : "Still needed before it can be sent for review"}>
            <ul className="list-disc pl-5">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </Callout>
        ) : (
          <Callout tone="success">
            {external
              ? rev.canRecordIssue
                ? "The draft has what it needs. Record it as issued when it is ready."
                : "The draft has what it needs. Someone who can issue documents records it as issued."
              : "The draft has what it needs. Send it for review when it is ready."}
          </Callout>
        ))}
      <AcknowledgeCard revision={rev} />
      <MyTurnCard revision={rev} />
      {rev.status === "in_review" && !rev.myTurn && <Callout tone="info">In review: waiting for {rev.signoffs.filter((x) => x.round === rev.reviewRound && x.decision === "pending").map((x) => x.person.name).join(", ") || "the reviewers"}.</Callout>}
      {rev.status === "awaiting_approval" && !rev.myTurn && <Callout tone="info">Every reviewer has accepted it. Waiting for {rev.approver?.name ?? "the approver"} to approve it.</Callout>}
      {rev.status === "approved" && <Callout tone="info" title="Approved">Approved by {rev.approvedBy ?? "the approver"}; it takes effect on {formatDay(rev.effectiveFrom)}. Until then the revision in force stays in force.</Callout>}
      {rev.status === "effective" && (
        <Callout tone="success" title="In force">
          In force since {formatDay(rev.effectiveFrom)}, {external ? "recorded as issued" : "approved"} by {rev.approvedBy ?? "the approver"}.
        </Callout>
      )}
      {rev.status === "superseded" && <Callout tone="warning" title="Superseded">Replaced on {formatDay(rev.supersededAt)}. Kept for the record; not for use.</Callout>}
      {rev.status === "withdrawn" && <Callout tone="error" title="Withdrawn">{rev.withdrawReason}{rev.withdrawnBy ? ` (${rev.withdrawnBy}, ${formatDay(rev.withdrawnAt)})` : ""}</Callout>}
      {rev.status === "draft" && rev.signoffs.some((x) => x.decision === "returned") && (
        <Callout tone="warning" title="Sent back">
          {rev.signoffs.filter((x) => x.decision === "returned" && x.round === rev.reviewRound).map((x) => `${x.person.name}: ${x.comment}`).join(" · ")}
        </Callout>
      )}

      <RecipientsCard revision={rev} />
      {!external && <SignersCard revision={rev} canEdit={canEdit} />}
      {!external && <SignoffsCard revision={rev} />}
      <CopiesCard revision={rev} />
      <CompareCard revision={rev} />

      <MenuCard title="Change summary">
        <div className="flex flex-col gap-3">
          <ChangeSummary key={rev.id} revision={rev} canEdit={canEdit} />
          <AcknowledgeDaysField key={`days-${rev.id}`} revision={rev} />
        </div>
      </MenuCard>

      {doc.contentKind === "text" ? (
        <MenuCard title="Text" subtitle={canEdit ? "Saved as you type." : undefined}>
          <div>
            <DocumentEditor key={rev.id} value={rev.body} editable={canEdit} onChange={saveText} />
          </div>
        </MenuCard>
      ) : (
        <MenuCard title="Main file" subtitle="The document itself. A PDF is best for reading; attach the editable source below. A new file replaces the old one.">
          <div>
            <AttachmentDrop
              recordId={rev.id}
              bucket="document-files"
              folder="document"
              attachments={asList(files.filter((f) => f.role === "main"))}
              mutation={fileMutation}
              attachUrl={`/document-revisions/${rev.id}/files`}
              itemBase="/document-files"
              extraBody={{ role: "main" }}
              title="Main file"
              canEdit={canEdit}
            />
          </div>
        </MenuCard>
      )}

      <MenuCard title="Attachments" subtitle="Supporting files: the editable source, a flowchart, a blank form.">
        <div>
          <AttachmentDrop
            recordId={rev.id}
            bucket="document-files"
            folder="document"
            attachments={asList(files.filter((f) => f.role === "attachment"))}
            mutation={fileMutation}
            attachUrl={`/document-revisions/${rev.id}/files`}
            itemBase="/document-files"
            extraBody={{ role: "attachment" }}
            title="Attachments"
            canEdit={canEdit}
          />
        </div>
      </MenuCard>

      {discarding && <DiscardDialog revision={rev} onClose={() => setDiscarding(false)} />}
      {issuing && <IssueExternalDialog revision={rev} onClose={() => setIssuing(false)} />}
    </div>
  );
};

export default RevisionPage;
