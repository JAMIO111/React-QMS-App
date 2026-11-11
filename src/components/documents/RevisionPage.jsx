import { useState } from "react";
import { useParams } from "react-router-dom";
import { Trash2Icon } from "@/components/icons";
import CTAButton from "@/components/CTAButton";
import { describeApiError } from "../../lib/api-client";
import { useToast } from "../../contexts/ToastProvider";
import { useDocumentFileMutation, useDocumentMutation, useDocumentRevision, useSaveDraft } from "../../hooks/useDocuments";
import { useBreadcrumbNames } from "../../lib/breadcrumbs";
import { documentPath, draftProblems, revisionLabel, REVISION_STATUS, statusLabel, statusPill } from "../../lib/documents";
import { ErrorNotice, FormError } from "../master-data/shared";
import Callout from "../ui/Callout";
import Dialog from "../ui/Dialog";
import Field from "../ui/Field";
import { AttachmentDrop } from "../ui/FileDrop";
import LoadingScreen from "../ui/LoadingScreen";
import MenuCard from "../ui/MenuCard";
import DocumentEditor from "./DocumentEditor";

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
 * and attachments, with a change summary. Submitting for review and approval arrive in DC2; until then a draft shows what it still needs.
 */
const RevisionPage = () => {
  const { id, revisionId } = useParams();
  const query = useDocumentRevision(revisionId);
  const fileMutation = useDocumentFileMutation();
  const saveBody = useSaveDraft(revisionId);
  const { showToast } = useToast();
  const [discarding, setDiscarding] = useState(false);
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
  const problems = draftProblems(rev);
  const files = rev.files;
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
            {doc.title} · written by {rev.author?.name ?? "Unknown"}
            {canEdit && (saveBody.isPending ? " · saving…" : " · saved")}
          </p>
        </div>
        <div className="flex gap-2">
          <CTAButton type="neutral" to={documentPath(doc.id)}>
            Back to the document
          </CTAButton>
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
          <Callout tone="warning" title="Still needed before it can go for review">
            <ul className="list-disc pl-5">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </Callout>
        ) : (
          <Callout tone="success">The draft has what it needs. Sending it for review and approval comes in the next release.</Callout>
        ))}

      <MenuCard title="Change summary">
        <ChangeSummary key={rev.id} revision={rev} canEdit={canEdit} />
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
    </div>
  );
};

export default RevisionPage;
