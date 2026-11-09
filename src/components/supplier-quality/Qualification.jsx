import { useEffect, useState } from "react";
import { CircleCheckIcon, DownloadIcon, PlusIcon } from "@/components/icons";
import { generateSignedUrl, uploadFileToSupabase } from "@/api/supabaseApi";
import { useOrganisation } from "../../contexts/OrganisationProvider";
import { useToast } from "../../contexts/ToastProvider";
import { usePermissions } from "../../hooks/useQmsApi";
import { useQualificationMutation, useSupplierCertifications, useSupplierDocuments } from "../../hooks/useSupplierQuality";
import { describeApiError } from "../../lib/api-client";
import { formatDate } from "../../lib/ncr";
import { formatDateTime } from "../../lib/processControl";
import { CERTIFICATION_TYPES, DOCUMENT_TYPES, certificationTypeLabel, documentTypeLabel, expiryBadge, formatBytes } from "../../lib/supplierQualification";
import CTAButton from "../CTAButton";
import Callout from "../ui/Callout";
import ComboField from "../ui/ComboField";
import Dialog from "../ui/Dialog";
import DropdownMenu from "../ui/DropdownMenu";
import Field from "../ui/Field";
import { FileIcon } from "../ui/FileDrop";
import MenuCard from "../ui/MenuCard";
import RHFDatePickerPopout from "../ui/RHFDatePickerPopout";
import { EllipsisIcon } from "@/components/icons";
import { ErrorNotice, FormError, TextAreaField } from "../master-data/shared";

const nul = (v) => (typeof v === "string" ? v.trim() || null : v);

export const ExpiryBadge = ({ expiry }) => {
  const b = expiryBadge(expiry);
  return <span className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${b.tone}`}>{b.label}</span>;
};

const VerifiedMark = ({ verification }) =>
  verification ? (
    <span className="inline-flex items-center gap-1 text-xs text-success-color" title={`${formatDateTime(verification.at)}${verification.by ? ` by ${verification.by.name}` : ""}${verification.note ? `: ${verification.note}` : ""}`}>
      <CircleCheckIcon className="h-3.5 w-3.5" /> Verified
    </span>
  ) : (
    <span className="text-xs text-secondary-text">Not verified</span>
  );

/** The stored file, opened through a short-lived signed link. */
const openFile = async (path, showToast) => {
  const url = await generateSignedUrl("supplier-files", path);
  if (url) window.open(url, "_blank", "noopener,noreferrer");
  else showToast({ type: "error", title: "Could not open the file", message: "The link could not be made. Try again." });
};

/** Asks for a reason (or an optional note), then runs the command. */
const NoteDialog = ({ title, intro, label, required, confirmText, tone = "main", action, id, onClose }) => {
  const mutation = useQualificationMutation();
  const [text, setText] = useState("");
  return (
    <Dialog title={title} onClose={onClose}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          mutation.mutate({ action, id, body: required ? { reason: text.trim() } : text.trim() ? { note: text.trim() } : {} }, { onSuccess: onClose });
        }}>
        <p className="text-sm text-primary-text">{intro}</p>
        <TextAreaField label={label} value={text} onChange={(e) => setText(e.target.value)} required={required} maxLength={1000} rows={3} />
        <FormError error={mutation.error} />
        <div className="flex justify-end gap-2">
          <CTAButton buttonType="button" type="neutral" size="md" onClick={onClose}>Cancel</CTAButton>
          <CTAButton buttonType="submit" type={tone} size="lg" disabled={mutation.isPending || (required && text.trim().length < 3)}>
            {mutation.isPending ? "Saving…" : confirmText}
          </CTAButton>
        </div>
      </form>
    </Dialog>
  );
};

// ---- documents --------------------------------------------------------------------------------

/** Add a document (a file and its details), upload a new version of one, or edit the details of one that is not verified yet. */
export const DocumentDialog = ({ supplierId, document, replaces, onClose, onSaved }) => {
  const { organisationId } = useOrganisation();
  const mutation = useQualificationMutation();
  const { showToast } = useToast();
  const editing = !!document;
  const base = document ?? replaces;
  const [form, setForm] = useState({
    docType: base?.docType ?? "certificate", title: base?.title ?? "", revision: replaces ? "" : (base?.revision ?? ""), documentDate: replaces ? "" : (base?.documentDate ?? ""),
    expiresOn: replaces ? "" : (base?.expiresOn ?? ""), notes: replaces ? "" : (base?.notes ?? ""),
  });
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const details = { docType: form.docType, title: form.title.trim(), revision: nul(form.revision), documentDate: form.documentDate || null, expiresOn: form.expiresOn || null, notes: nul(form.notes) };

  const [dragActive, setDragActive] = useState(false);
  const chooseFile = (f) => {
    if (!f) return;
    setFile(f);
    setProblem(null);
    setForm((cur) => (cur.title.trim() ? cur : { ...cur, title: f.name.replace(/\.[^.]+$/, "") }));
  };

  const submit = async (e) => {
    e.preventDefault();
    e.stopPropagation(); // this dialog can open from inside another form
    setProblem(null);
    if (!form.title.trim()) return setProblem("Give the document a title.");
    if (form.documentDate && form.expiresOn && form.expiresOn < form.documentDate) return setProblem("The expiry date cannot be before the document date.");
    if (editing) return mutation.mutate({ action: "updateDocument", id: document.id, body: details }, { onSuccess: onClose });
    if (!file) return setProblem("Choose the file to upload.");
    setBusy(true);
    try {
      const { path } = await uploadFileToSupabase(file, "supplier-files", organisationId, supplierId, "supplier");
      mutation.mutate(
        { action: "addDocument", id: supplierId, body: { ...details, storagePath: path, fileName: file.name, contentType: file.type || null, sizeBytes: file.size, ...(replaces ? { replacesId: replaces.id } : {}) } },
        { onSuccess: (doc) => { onSaved?.(doc); onClose(); }, onError: (err) => showToast({ type: "error", title: "Not saved", message: describeApiError(err) }) },
      );
    } catch (err) {
      setProblem(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title={editing ? "Edit document" : replaces ? `New version of “${replaces.title}”` : "Add a document"} onClose={onClose}>
      <form noValidate className="flex flex-col gap-3" onSubmit={submit}>
        {replaces && <Callout tone="info">The new file replaces the current one. The old version stays on record as superseded.</Callout>}
        <ComboField label="Type" required value={form.docType} onChange={(v) => setForm((f) => ({ ...f, docType: v ?? "other" }))} options={DOCUMENT_TYPES.map((t) => ({ value: t.id, label: t.name }))} />
        <Field label="Title" required value={form.title} onChange={set("title")} maxLength={200} />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label="Revision" value={form.revision} onChange={set("revision")} maxLength={40} />
          <RHFDatePickerPopout label="Document date" valueFormat="iso" clearable value={form.documentDate} onChange={(v) => setForm((f) => ({ ...f, documentDate: v ?? "" }))} placeholder="Select a date" />
          <RHFDatePickerPopout label="Expires on" valueFormat="iso" clearable value={form.expiresOn} onChange={(v) => setForm((f) => ({ ...f, expiresOn: v ?? "" }))} placeholder="No expiry" />
        </div>
        <TextAreaField label="Notes" value={form.notes} onChange={set("notes")} maxLength={2000} rows={2} />
        {!editing && (
          <div className="flex flex-col gap-1">
            <span className="text-sm font-medium text-secondary-text" data-required>File</span>
            <label
              data-testid="document-drop"
              onDragEnter={(e) => { e.preventDefault(); setDragActive(true); }}
              onDragOver={(e) => { e.preventDefault(); setDragActive(true); }}
              onDragLeave={(e) => { e.preventDefault(); setDragActive(false); }}
              onDrop={(e) => { e.preventDefault(); setDragActive(false); chooseFile(e.dataTransfer?.files?.[0]); }}
              className={`flex cursor-pointer items-center gap-3 rounded-lg border-2 border-dashed px-4 py-3 text-sm transition-colors focus-within:border-brand-primary ${dragActive ? "border-brand-primary bg-brand-primary/5" : "border-border-color hover:border-brand-primary"}`}>
              <input type="file" aria-label="File" className="sr-only" onChange={(e) => chooseFile(e.target.files?.[0])} />
              {file ? (
                <>
                  <FileIcon name={file.name} type={file.type} className="h-8 w-8" />
                  <span className="min-w-0 flex-1"><span className="block truncate font-medium text-primary-text">{file.name}</span><span className="text-xs text-secondary-text">{formatBytes(file.size)} · click or drop to choose another</span></span>
                </>
              ) : (
                <span className="text-secondary-text">Drag a file here, or <span className="text-link-color underline">click to choose one</span>. Up to 25 MB.</span>
              )}
            </label>
          </div>
        )}
        {problem && <p role="alert" className="text-sm text-error-color">{problem}</p>}
        <FormError error={mutation.error} />
        <div className="flex justify-end gap-2">
          <CTAButton buttonType="button" type="neutral" size="md" onClick={onClose}>Cancel</CTAButton>
          <CTAButton buttonType="submit" type="main" size="lg" disabled={busy || mutation.isPending}>
            {busy || mutation.isPending ? "Saving…" : editing ? "Save" : "Add document"}
          </CTAButton>
        </div>
      </form>
    </Dialog>
  );
};

/** The stored file shown small: a picture for an image, otherwise the icon of its kind (Word, PDF, Excel…). */
const DocumentPreview = ({ document: d }) => {
  const [url, setUrl] = useState(null);
  const isImage = (d.contentType ?? "").startsWith("image/");
  useEffect(() => {
    if (!isImage) return undefined;
    let live = true;
    generateSignedUrl("supplier-files", d.storagePath).then((u) => live && setUrl(u)).catch(() => {});
    return () => { live = false; };
  }, [isImage, d.storagePath]);
  return (
    <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border-color bg-text-input-color" aria-hidden="true">
      {isImage && url ? <img src={url} alt="" className="h-full w-full object-cover" /> : <FileIcon name={d.fileName ?? ""} type={d.contentType} className="h-9 w-9" />}
    </div>
  );
};

/**
 * Choose one of a supplier's current documents, or add a new one without leaving the page: the same dialog as the Documents tab opens,
 * and on saving the new document is chosen. Documents out of date are marked in the list.
 */
export const DocumentPicker = ({ supplierId, documents, label, value, onChange, placeholder = "None", hint, clearable = true }) => {
  const { can } = usePermissions();
  const [adding, setAdding] = useState(false);
  const options = documents.filter((d) => d.status === "current").map((d) => ({ value: d.id, label: d.title, hint: d.expiry?.state === "expired" ? `${d.fileName ?? ""} · expired`.trim() : d.fileName }));
  return (
    <div className="flex flex-col gap-1.5">
      <ComboField label={label} value={value} onChange={onChange} options={options} placeholder={placeholder} clearable={clearable} hint={hint} />
      {supplierId && can("supplier_quality.manage") && (
        <CTAButton buttonType="button" type="neutral" size="default" icon={PlusIcon} iconSize="h-4 w-4" className="self-start" onClick={() => setAdding(true)}>Add a new document</CTAButton>
      )}
      {adding && <DocumentDialog supplierId={supplierId} onClose={() => setAdding(false)} onSaved={(doc) => doc?.id && onChange(doc.id)} />}
    </div>
  );
};

/** Documents of a supplier: current ones with their expiry and verification; superseded and removed ones listed below. */
export const DocumentsCard = ({ supplierId, canManage }) => {
  const query = useSupplierDocuments(supplierId);
  const { showToast } = useToast();
  const [dialog, setDialog] = useState(null); // { kind: "add" | "edit" | "replace" | "verify" | "remove", document? }
  const all = query.data?.data ?? [];
  const current = all.filter((d) => d.status === "current");
  const past = all.filter((d) => d.status !== "current");

  return (
    <MenuCard
      title="Documents"
      subtitle="Certificates, manuals, agreements and reports. A verified document is replaced by a new version, never edited."
      action={canManage && (
        <CTAButton buttonType="button" type="secondary" size="default" icon={PlusIcon} iconSize="h-4 w-4" onClick={() => setDialog({ kind: "add" })}>Add document</CTAButton>
      )}>
      {query.error && <ErrorNotice error={query.error} />}
      {query.isLoading ? (
        <p className="text-sm text-secondary-text">Loading…</p>
      ) : current.length === 0 ? (
        <p className="text-sm text-secondary-text">No documents yet.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border-color" aria-label="Current documents">
          {current.map((d) => (
            <li key={d.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
              <DocumentPreview document={d} />
              <div className="min-w-0 flex-1">
                <p className="font-medium text-primary-text">
                  {d.title}
                  {d.revision ? <span className="font-normal text-secondary-text"> · revision {d.revision}</span> : null}
                </p>
                <p className="text-sm text-secondary-text">
                  {documentTypeLabel(d.docType)} · {d.fileName} ({formatBytes(d.sizeBytes)}){d.documentDate ? ` · dated ${formatDate(d.documentDate)}` : ""}{d.expiresOn ? ` · expires ${formatDate(d.expiresOn)}` : ""}
                </p>
                <p className="mt-1 flex flex-wrap items-center gap-2">
                  <ExpiryBadge expiry={d.expiry} />
                  <VerifiedMark verification={d.verification} />
                </p>
                {d.notes && <p className="mt-1 text-sm text-secondary-text">{d.notes}</p>}
              </div>
              <div className="flex items-center gap-1">
                <CTAButton buttonType="button" type="neutral" size="default" icon={DownloadIcon} iconSize="h-4 w-4" onClick={() => openFile(d.storagePath, showToast)}>Open</CTAButton>
                {canManage && (
                  <DropdownMenu
                    label={`Actions for ${d.title}`}
                    width={220}
                    items={[
                      !d.verification && { label: "Verify", onSelect: () => setDialog({ kind: "verify", document: d }) },
                      !d.verification && { label: "Edit details", onSelect: () => setDialog({ kind: "edit", document: d }) },
                      { label: "Upload a new version", onSelect: () => setDialog({ kind: "replace", document: d }) },
                      { separator: true },
                      { label: "Remove", tone: "danger", onSelect: () => setDialog({ kind: "remove", document: d }) },
                    ]}
                    trigger={(props) => (
                      <button {...props} aria-label={`Actions for ${d.title}`} className="rounded-lg p-1.5 text-secondary-text hover:text-brand-primary cursor-pointer active:scale-97 transition-transform">
                        <EllipsisIcon size={18} />
                      </button>
                    )}
                  />
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {past.length > 0 && (
        <details className="mt-3">
          <summary className="cursor-pointer text-sm text-secondary-text">Superseded and removed documents ({past.length})</summary>
          <ul className="mt-2 flex flex-col gap-1 text-sm text-secondary-text" aria-label="Past documents">
            {past.map((d) => (
              <li key={d.id}>
                {d.title}{d.revision ? ` (revision ${d.revision})` : ""} · {d.status === "removed" ? `removed: ${d.removal?.reason}` : "superseded"} ·{" "}
                <button type="button" className="text-link-color hover:underline cursor-pointer" onClick={() => openFile(d.storagePath, showToast)}>open</button>
              </li>
            ))}
          </ul>
        </details>
      )}
      {(dialog?.kind === "add" || dialog?.kind === "edit" || dialog?.kind === "replace") && (
        <DocumentDialog supplierId={supplierId} document={dialog.kind === "edit" ? dialog.document : undefined} replaces={dialog.kind === "replace" ? dialog.document : undefined} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === "verify" && (
        <NoteDialog title={`Verify “${dialog.document.title}”`} intro="Confirm you have checked this document (for example against the issuer's own record). It is recorded with your name and the time, and the document can then no longer be edited." label="Note (optional)" confirmText="Verify" action="verifyDocument" id={dialog.document.id} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === "remove" && (
        <NoteDialog title={`Remove “${dialog.document.title}”`} intro="The document stops being in use. The record and file are kept." label="Why is it being removed?" required confirmText="Remove" tone="danger" action="removeDocument" id={dialog.document.id} onClose={() => setDialog(null)} />
      )}
    </MenuCard>
  );
};

// ---- certifications ---------------------------------------------------------------------------

/** Add, edit (until verified) or renew a certification. A renewal keeps the type and starts afresh. */
const CertificationDialog = ({ supplierId, certification, renew, documents, onClose }) => {
  const mutation = useQualificationMutation();
  const editing = !!certification && !renew;
  const base = renew ? null : certification;
  const [form, setForm] = useState({
    certType: certification?.certType ?? "iso_9001", title: base?.title ?? "", certificateNumber: base?.certificateNumber ?? "", issuingBody: base?.issuingBody ?? certification?.issuingBody ?? "",
    scope: base?.scope ?? certification?.scope ?? "", issuedOn: base?.issuedOn ?? "", expiresOn: base?.expiresOn ?? "", documentId: base?.document?.id ?? null, notes: base?.notes ?? "",
  });
  const [problem, setProblem] = useState(null);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = (e) => {
    e.preventDefault();
    setProblem(null);
    if (!form.certificateNumber.trim()) return setProblem("Enter the certificate number.");
    if (!form.issuingBody.trim()) return setProblem("Enter the issuing body.");
    if (form.issuedOn && form.expiresOn && form.expiresOn < form.issuedOn) return setProblem("The expiry date cannot be before the issue date.");
    const body = {
      title: nul(form.title), certificateNumber: form.certificateNumber.trim(), issuingBody: form.issuingBody.trim(), scope: nul(form.scope), issuedOn: form.issuedOn || null,
      expiresOn: form.expiresOn || null, documentId: form.documentId || null, notes: nul(form.notes),
    };
    if (renew) return mutation.mutate({ action: "renewCertification", id: certification.id, body }, { onSuccess: onClose });
    if (editing) return mutation.mutate({ action: "updateCertification", id: certification.id, body: { certType: form.certType, ...body } }, { onSuccess: onClose });
    mutation.mutate({ action: "addCertification", id: supplierId, body: { certType: form.certType, ...body } }, { onSuccess: onClose });
  };

  return (
    <Dialog title={renew ? `Renew ${certificationTypeLabel(certification.certType)}` : editing ? "Edit certification" : "Add a certification"} onClose={onClose}>
      <form noValidate className="flex flex-col gap-3" onSubmit={submit}>
        {renew && <Callout tone="info">Enter the details of the new certificate. The current one is superseded and stays on record; the new one needs verifying.</Callout>}
        <ComboField label="Standard" required disabled={renew} value={form.certType} onChange={(v) => setForm((f) => ({ ...f, certType: v ?? "other" }))} options={CERTIFICATION_TYPES.map((t) => ({ value: t.id, label: t.name }))} />
        {form.certType === "other" && <Field label="Name of the certification" value={form.title} onChange={set("title")} maxLength={200} />}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Certificate number" required value={form.certificateNumber} onChange={set("certificateNumber")} maxLength={100} />
          <Field label="Issuing body" required value={form.issuingBody} onChange={set("issuingBody")} maxLength={200} />
        </div>
        <TextAreaField label="Scope" value={form.scope} onChange={set("scope")} maxLength={2000} rows={2} hint="What the certificate covers" />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <RHFDatePickerPopout label="Issued on" valueFormat="iso" clearable value={form.issuedOn} onChange={(v) => setForm((f) => ({ ...f, issuedOn: v ?? "" }))} placeholder="Select a date" />
          <RHFDatePickerPopout label="Expires on" valueFormat="iso" clearable value={form.expiresOn} onChange={(v) => setForm((f) => ({ ...f, expiresOn: v ?? "" }))} placeholder="No expiry" />
        </div>
        <DocumentPicker supplierId={supplierId} documents={documents} label="Evidence document" value={form.documentId} onChange={(v) => setForm((f) => ({ ...f, documentId: v }))} hint="Choose a document of this supplier, or add a new one here" />
        <TextAreaField label="Notes" value={form.notes} onChange={set("notes")} maxLength={2000} rows={2} />
        {problem && <p role="alert" className="text-sm text-error-color">{problem}</p>}
        <FormError error={mutation.error} />
        <div className="flex justify-end gap-2">
          <CTAButton buttonType="button" type="neutral" size="md" onClick={onClose}>Cancel</CTAButton>
          <CTAButton buttonType="submit" type="main" size="lg" disabled={mutation.isPending}>{mutation.isPending ? "Saving…" : renew ? "Renew" : editing ? "Save" : "Add certification"}</CTAButton>
        </div>
      </form>
    </Dialog>
  );
};

/** Certifications of a supplier with the expiry state worked out when read. An expired certificate is a warning; it never changes the supplier's approval status. */
export const CertificationsCard = ({ supplierId, canManage }) => {
  const query = useSupplierCertifications(supplierId);
  const documents = useSupplierDocuments(supplierId, { enabled: canManage });
  const [dialog, setDialog] = useState(null); // { kind: "add" | "edit" | "renew" | "verify" | "withdraw", certification? }
  const { showToast } = useToast();
  const all = query.data?.data ?? [];
  const current = all.filter((c) => c.status === "current");
  const past = all.filter((c) => c.status !== "current");
  const expired = current.filter((c) => c.expiry.state === "expired");

  return (
    <MenuCard
      title="Certifications"
      subtitle="Standards the supplier is certified to. Expiry is shown here and on the watchlist; it never changes the approval status by itself."
      action={canManage && (
        <CTAButton buttonType="button" type="secondary" size="default" icon={PlusIcon} iconSize="h-4 w-4" onClick={() => setDialog({ kind: "add" })}>Add certification</CTAButton>
      )}>
      {query.error && <ErrorNotice error={query.error} />}
      {expired.length > 0 && (
        <Callout tone="error" role="status" title={expired.length === 1 ? "A certification has expired" : `${expired.length} certifications have expired`} className="mb-3">
          Check whether the supplier has renewed. The supplier's approval status has not changed; review it if it should.
        </Callout>
      )}
      {query.isLoading ? (
        <p className="text-sm text-secondary-text">Loading…</p>
      ) : current.length === 0 ? (
        <p className="text-sm text-secondary-text">No certifications recorded.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border-color" aria-label="Current certifications">
          {current.map((c) => (
            <li key={c.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
              <div className="min-w-0">
                <p className="font-medium text-primary-text">
                  {c.certType === "other" && c.title ? c.title : certificationTypeLabel(c.certType)}
                  <span className="font-normal text-secondary-text"> · {c.certificateNumber}</span>
                </p>
                <p className="text-sm text-secondary-text">
                  {c.issuingBody}{c.issuedOn ? ` · issued ${formatDate(c.issuedOn)}` : ""}{c.expiresOn ? ` · expires ${formatDate(c.expiresOn)}` : ""}
                </p>
                {c.scope && <p className="text-sm text-secondary-text">Scope: {c.scope}</p>}
                <p className="mt-1 flex flex-wrap items-center gap-2">
                  <ExpiryBadge expiry={c.expiry} />
                  <VerifiedMark verification={c.verification} />
                  {c.document && (
                    <button type="button" className="text-xs text-link-color hover:underline cursor-pointer" onClick={() => openFile(c.document.storagePath, showToast)}>
                      Evidence: {c.document.title}
                    </button>
                  )}
                </p>
              </div>
              {canManage && (
                <DropdownMenu
                  label={`Actions for ${certificationTypeLabel(c.certType)} ${c.certificateNumber}`}
                  width={220}
                  items={[
                    !c.verification && { label: "Verify", onSelect: () => setDialog({ kind: "verify", certification: c }) },
                    !c.verification && { label: "Edit details", onSelect: () => setDialog({ kind: "edit", certification: c }) },
                    { label: "Renew", onSelect: () => setDialog({ kind: "renew", certification: c }) },
                    { separator: true },
                    { label: "Withdraw", tone: "danger", onSelect: () => setDialog({ kind: "withdraw", certification: c }) },
                  ]}
                  trigger={(props) => (
                    <button {...props} aria-label={`Actions for ${certificationTypeLabel(c.certType)} ${c.certificateNumber}`} className="rounded-lg p-1.5 text-secondary-text hover:text-brand-primary cursor-pointer active:scale-97 transition-transform">
                      <EllipsisIcon size={18} />
                    </button>
                  )}
                />
              )}
            </li>
          ))}
        </ul>
      )}
      {past.length > 0 && (
        <details className="mt-3">
          <summary className="cursor-pointer text-sm text-secondary-text">Superseded and withdrawn certifications ({past.length})</summary>
          <ul className="mt-2 flex flex-col gap-1 text-sm text-secondary-text" aria-label="Past certifications">
            {past.map((c) => (
              <li key={c.id}>
                {certificationTypeLabel(c.certType)} · {c.certificateNumber} · {c.status === "withdrawn" ? `withdrawn: ${c.withdrawal?.reason}` : "superseded"}
              </li>
            ))}
          </ul>
        </details>
      )}
      {(dialog?.kind === "add" || dialog?.kind === "edit" || dialog?.kind === "renew") && (
        <CertificationDialog supplierId={supplierId} certification={dialog.certification} renew={dialog.kind === "renew"} documents={documents.data?.data ?? []} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === "verify" && (
        <NoteDialog title="Verify certification" intro="Confirm you have checked this certificate with the issuing body or its register. It is recorded with your name and the time, and it can then only be renewed, not edited." label="Note (optional)" confirmText="Verify" action="verifyCertification" id={dialog.certification.id} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === "withdraw" && (
        <NoteDialog title="Withdraw certification" intro="The certification stops counting. The record is kept." label="Why is it being withdrawn?" required confirmText="Withdraw" tone="danger" action="withdrawCertification" id={dialog.certification.id} onClose={() => setDialog(null)} />
      )}
    </MenuCard>
  );
};
