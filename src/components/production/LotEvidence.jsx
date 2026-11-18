import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import CTAButton from "@/components/CTAButton";
import Callout from "../ui/Callout";
import ComboField from "../ui/ComboField";
import Dialog from "../ui/Dialog";
import Field from "../ui/Field";
import { FormError, TextAreaField } from "../master-data/shared";
import { generateSignedUrl, uploadFileToSupabase } from "../../api/supabaseApi";
import { useOrganisation } from "../../contexts/OrganisationProvider";
import { usePermissions } from "../../hooks/useQmsApi";
import { apiFetch, describeApiError } from "../../lib/api-client";
import { refreshOrganisation } from "../../lib/refresh";
import { EVIDENCE_KINDS, evidenceKindLabel, shortDate } from "../../lib/portal";

const keyOf = (org, lot) => ["api", "org", org, "external-access", "lot-evidence", lot];
const sizeWords = (n) => (n >= 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} kB`);

/**
 * Files shared with a customer from a lot (PT5f): a certificate of conformance, an inspection report. Each file is shared with one customer the lot is for;
 * that customer sees and opens it in their portal. Shown to people who may share with the portal; nothing here changes the lot.
 */
export default function LotEvidence({ lotId }) {
  const { organisationId } = useOrganisation();
  const { can } = usePermissions();
  const queryClient = useQueryClient();
  const allowed = can("external_access.share");
  const evidence = useQuery({ queryKey: keyOf(organisationId, lotId), queryFn: () => apiFetch(`/external-access/lots/${lotId}/evidence`, { organisationId }), enabled: !!organisationId && !!lotId && allowed, retry: false });
  const save = useMutation({
    mutationFn: async ({ action, id, file, form, reason }) => {
      if (action === "remove") return apiFetch(`/external-access/lot-evidence/${id}/remove`, { method: "POST", body: { reason }, organisationId });
      const stored = await uploadFileToSupabase(file, "lot-evidence", organisationId, lotId, "lot");
      return apiFetch(`/external-access/lots/${lotId}/evidence`, {
        method: "POST",
        organisationId,
        body: { customerId: form.customerId, kind: form.kind, description: form.description.trim() || null, path: stored.path, fileName: file.name || "file", contentType: file.type || null, sizeBytes: file.size },
      });
    },
    onSuccess: (data) => queryClient.setQueryData(keyOf(organisationId, lotId), data),
    onSettled: () => refreshOrganisation(queryClient, organisationId),
  });
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState(null);
  if (!allowed || evidence.error || !evidence.data) return null;
  const { data: files, customers } = evidence.data;
  const live = files.filter((f) => !f.removedAt);
  const past = files.filter((f) => f.removedAt);
  if (customers.length === 0 && files.length === 0) return null;

  const open = async (f) => {
    const url = await generateSignedUrl("lot-evidence", f.storagePath);
    if (url) window.open(url, "_blank", "noopener");
  };

  return (
    <section aria-label="Shared with customers" className="mt-4 flex flex-col gap-2 rounded-xl border border-border-color p-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h3 className="text-base font-semibold">Shared with customers</h3>
          <p className="text-xs text-secondary-text">Certificates and inspection reports a customer can open in their portal.</p>
        </div>
        {customers.length > 0 && <CTAButton type="neutral" size="default" onClick={() => setAdding(true)}>Share a file</CTAButton>}
      </div>
      {live.length === 0 ? (
        <p className="text-sm text-secondary-text">Nothing shared from this lot yet.</p>
      ) : (
        <ul aria-label="Files shared from this lot" className="flex flex-col divide-y divide-border-color">
          {live.map((f) => (
            <li key={f.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
              <div className="min-w-0 grow">
                <button type="button" className="truncate font-medium text-link-color hover:underline" onClick={() => open(f)}>{f.fileName}</button>
                <p className="truncate text-xs text-secondary-text">{evidenceKindLabel(f.kind)} · {f.customerName} · {sizeWords(f.sizeBytes)} · {shortDate(f.addedAt)} by {f.addedBy}{f.description ? ` · ${f.description}` : ""}</p>
              </div>
              <CTAButton type="neutral" size="default" aria-label={`Stop sharing ${f.fileName}`} onClick={() => setRemoving(f)}>Stop sharing</CTAButton>
            </li>
          ))}
        </ul>
      )}
      {past.length > 0 && (
        <details className="text-xs text-secondary-text">
          <summary className="cursor-pointer">Earlier files ({past.length})</summary>
          <ul className="mt-1">{past.map((f) => <li key={f.id}>{f.fileName} for {f.customerName}: stopped {shortDate(f.removedAt)} ({f.removeReason})</li>)}</ul>
        </details>
      )}
      {adding && <ShareDialog customers={customers} save={save} onClose={() => { save.reset(); setAdding(false); }} />}
      {removing && <RemoveDialog file={removing} save={save} onClose={() => { save.reset(); setRemoving(null); }} />}
    </section>
  );
}

function ShareDialog({ customers, save, onClose }) {
  const input = useRef(null);
  const [form, setForm] = useState({ customerId: customers.length === 1 ? customers[0].id : null, kind: "certificate_of_conformance", description: "" });
  const [file, setFile] = useState(null);
  const submit = (e) => {
    e.preventDefault();
    save.mutate({ action: "add", file, form }, { onSuccess: onClose });
  };
  return (
    <Dialog title="Share a file with a customer" onClose={onClose}>
      <form onSubmit={submit} noValidate className="flex flex-col gap-3">
        <ComboField label="Customer" required value={form.customerId} onChange={(v) => setForm((f) => ({ ...f, customerId: v }))} options={customers.map((c) => ({ value: c.id, label: c.name }))} placeholder="Choose the customer" />
        <ComboField label="What is it" required value={form.kind} onChange={(v) => setForm((f) => ({ ...f, kind: v }))} options={EVIDENCE_KINDS.map((k) => ({ value: k.id, label: k.name }))} />
        <Field label="Description" value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} maxLength={300} placeholder="Optional, shown beside the file" />
        <div className="flex flex-wrap items-center gap-2">
          <input ref={input} type="file" aria-label="Choose the file" className="sr-only" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          <CTAButton type="secondary" size="md" onClick={() => input.current?.click()}>{file ? "Choose another file" : "Choose the file"}</CTAButton>
          <span className="text-sm text-secondary-text">{file ? `${file.name} (${sizeWords(file.size)})` : "Up to 25 MB"}</span>
        </div>
        <FormError error={save.error} />
        <div className="flex justify-end gap-2">
          <CTAButton type="neutral" size="md" onClick={onClose}>Cancel</CTAButton>
          <CTAButton type="main" size="md" buttonType="submit" disabled={!file || !form.customerId} loading={save.isPending}>Share</CTAButton>
        </div>
      </form>
    </Dialog>
  );
}

function RemoveDialog({ file, save, onClose }) {
  const [reason, setReason] = useState("");
  return (
    <Dialog title={`Stop sharing ${file.fileName}?`} onClose={onClose}>
      <form
        noValidate
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate({ action: "remove", id: file.id, reason }, { onSuccess: onClose });
        }}>
        <Callout tone="warning">{file.customerName} stops seeing it at once. It is kept here for you.</Callout>
        <TextAreaField label="Reason" required rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
        {save.error && <p role="alert" className="text-sm text-error-color">{describeApiError(save.error)}</p>}
        <div className="flex justify-end gap-2">
          <CTAButton type="neutral" size="md" onClick={onClose}>Cancel</CTAButton>
          <CTAButton type="danger" size="md" buttonType="submit" disabled={reason.trim().length < 3} loading={save.isPending}>Stop sharing</CTAButton>
        </div>
      </form>
    </Dialog>
  );
}
