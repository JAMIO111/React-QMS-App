import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { PencilIcon } from "@/components/icons";
import CTAButton from "@/components/CTAButton";
import { describeApiError } from "../../lib/api-client";
import { useToast } from "../../contexts/ToastProvider";
import { useCustomFieldPeople } from "../../hooks/useCustomFields";
import { useDocument, useDocumentMutation } from "../../hooks/useDocuments";
import { useBreadcrumbNames } from "../../lib/breadcrumbs";
import { contentKindLabel, DOCUMENT_STATUS, revisionLabel, revisionPath, REVISION_STATUS, statusLabel, statusPill } from "../../lib/documents";
import { ErrorNotice, FormError } from "../master-data/shared";
import Callout from "../ui/Callout";
import ComboField from "../ui/ComboField";
import Dialog from "../ui/Dialog";
import Field from "../ui/Field";
import LoadingScreen from "../ui/LoadingScreen";
import MenuCard from "../ui/MenuCard";

const Fact = ({ label, children }) => (
  <div className="flex flex-col">
    <dt className="text-xs font-medium uppercase tracking-wide text-secondary-text">{label}</dt>
    <dd className="text-sm text-primary-text">{children}</dd>
  </div>
);

const formatDate = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "—");

/** Title, description and owner (the number, type and content kind never change). */
const EditDialog = ({ doc, onClose }) => {
  const mutation = useDocumentMutation();
  const people = useCustomFieldPeople();
  const { showToast } = useToast();
  const [title, setTitle] = useState(doc.title);
  const [description, setDescription] = useState(doc.description ?? "");
  const [ownerId, setOwnerId] = useState(doc.owner?.id ?? null);
  const options = (people.data ?? []).map((p) => ({ value: p.id, label: p.name }));
  const ready = title.trim() && ownerId;
  const save = (e) => {
    e.preventDefault();
    if (!ready) return;
    mutation.mutate(
      { action: "updateDocument", id: doc.id, body: { title: title.trim(), description: description.trim() || null, ownerId } },
      { onSuccess: onClose, onError: (err) => showToast({ type: "error", title: "Not saved", message: describeApiError(err) }) },
    );
  };
  return (
    <Dialog title={`Edit ${doc.number}`} onClose={onClose} width="max-w-xl">
      <form noValidate onSubmit={save} className="flex flex-col gap-3">
        <Field label="Title" value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} />
        <ComboField label="Owner" required value={ownerId} onChange={setOwnerId} options={options} placeholder="Who looks after it" />
        <Field label="Description" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={1000} hint="Optional: scope or purpose" />
        <p className="text-sm text-secondary-text">The number, type and whether it is a file or written here never change.</p>
        <FormError error={mutation.error} />
        <div className="flex justify-end gap-2">
          <CTAButton buttonType="button" type="neutral" size="md" onClick={onClose}>
            Cancel
          </CTAButton>
          <CTAButton buttonType="submit" type="main" size="md" disabled={!ready || mutation.isPending} loading={mutation.isPending}>
            Save
          </CTAButton>
        </div>
      </form>
    </Dialog>
  );
};

/** A document (`/Documentation/Documents/:id`): what it is, who owns it, and its revisions. Review, approval and the revision in force arrive in DC2. */
const DocumentPage = () => {
  const { id } = useParams();
  const query = useDocument(id);
  const [editing, setEditing] = useState(false);
  const doc = query.data;
  useBreadcrumbNames([
    { path: `/Documentation/Documents/${id}`, label: doc ? `${doc.number} · ${doc.title}` : null },
    { path: "/Documentation", label: "Documentation", to: "/Documentation/Documents" },
  ]);

  if (query.isLoading) return <LoadingScreen />;
  if (query.error) return <ErrorNotice error={query.error} />;
  const draft = doc.inProgress;

  return (
    <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col gap-4 overflow-y-auto bg-primary-bg p-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold text-primary-text">{doc.number}</h1>
            <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${statusPill(DOCUMENT_STATUS, doc.status)}`}>{statusLabel(DOCUMENT_STATUS, doc.status)}</span>
          </div>
          <p className="text-lg text-primary-text">{doc.title}</p>
        </div>
        {doc.canManage && (
          <CTAButton type="secondary" icon={PencilIcon} onClick={() => setEditing(true)}>
            Edit details
          </CTAButton>
        )}
      </header>

      {doc.status === "discarded" && (
        <Callout tone="warning" title="Discarded">
          Its only draft was discarded before it was ever issued. The number {doc.number} is kept and never reused.
        </Callout>
      )}
      {draft && (
        <Callout
          tone="info"
          title={`${statusLabel(REVISION_STATUS, draft.status)} in progress`}
          action={
            <CTAButton type="main" to={revisionPath(doc.id, draft.id)}>
              {draft.status === "draft" && doc.canManage ? "Open the draft" : "Open it"}
            </CTAButton>
          }>
          {doc.status === "draft" ? `The first revision will be rev ${doc.nextLetter} once it is submitted and approved.` : `The next revision will be rev ${doc.nextLetter}.`}
        </Callout>
      )}

      <MenuCard title="Details">
        <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Fact label="Type">
            {doc.type.name} ({doc.type.prefix})
          </Fact>
          <Fact label="Content">{contentKindLabel(doc.contentKind)}</Fact>
          <Fact label="Owner">{doc.owner?.name ?? "—"}</Fact>
          <Fact label="Created">{formatDate(doc.createdAt)}</Fact>
          {doc.numberTyped && <Fact label="Brought across">Numbered by hand; revisions continue from {doc.startLetter}</Fact>}
          {doc.description && (
            <div className="sm:col-span-2 lg:col-span-4">
              <Fact label="Description">{doc.description}</Fact>
            </div>
          )}
        </dl>
      </MenuCard>

      <MenuCard title="Revisions" subtitle="Each revision is written, reviewed, approved and then frozen. A change is always a new revision.">
        <ul className="-my-3 divide-y divide-border-color" aria-label="Revisions">
          {doc.revisions.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <div className="flex flex-col">
                <Link to={revisionPath(doc.id, r.id)} className="font-medium text-primary-text hover:underline">
                  {revisionLabel(r, r.status === "draft" ? doc.nextLetter : null)}
                </Link>
                <span className="text-sm text-secondary-text">
                  {r.author?.name ?? "Unknown"} · started {formatDate(r.createdAt)}
                  {r.changeSummary ? ` · ${r.changeSummary}` : ""}
                  {r.discardReason ? ` · discarded: ${r.discardReason}` : ""}
                </span>
              </div>
              <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${statusPill(REVISION_STATUS, r.status)}`}>{statusLabel(REVISION_STATUS, r.status)}</span>
            </li>
          ))}
        </ul>
      </MenuCard>

      {editing && <EditDialog doc={doc} onClose={() => setEditing(false)} />}
    </div>
  );
};

export default DocumentPage;
