import { useState } from "react";
import { useCertificateMutation } from "../../hooks/useMaterialCertificates";
import { useSupplierDocuments, useSupplierRegister } from "../../hooks/useSupplierQuality";
import { CERT_KINDS } from "../../lib/materialCertificates";
import CTAButton from "../CTAButton";
import ComboField from "../ui/ComboField";
import Dialog from "../ui/Dialog";
import Field from "../ui/Field";
import RHFDatePickerPopout from "../ui/RHFDatePickerPopout";
import { DocumentPicker } from "./Qualification";
import { FormError, TextAreaField } from "../master-data/shared";

/**
 * Record a material certificate. From a receipt line (`line` + `supplier`) the supplier, part and lot are known; from the register the person names a supplier and a heat number.
 * The certificate file is a current document of the supplier, uploaded under its documents first.
 */
export const RecordCertificateDialog = ({ line = null, supplier = null, certificate = null, onClose }) => {
  const mutation = useCertificateMutation();
  const [supplierId, setSupplierId] = useState(certificate?.supplier.id ?? supplier?.id ?? null);
  const [supplierSearch, setSupplierSearch] = useState("");
  const suppliers = useSupplierRegister({ q: supplierSearch || undefined, pageSize: 25 }, { enabled: !supplier && !certificate });
  const docs = useSupplierDocuments(supplierId, { enabled: !!supplierId });
  const [number, setNumber] = useState(certificate?.certificateNumber ?? "");
  const [kind, setKind] = useState(certificate?.kind ?? "mill_test_report");
  const [heat, setHeat] = useState(certificate?.heatNumber ?? "");
  const [material, setMaterial] = useState(certificate?.material ?? "");
  const [spec, setSpec] = useState(certificate?.specification ?? "");
  const [issuedOn, setIssuedOn] = useState(certificate?.issuedOn ?? null);
  const [documentId, setDocumentId] = useState(certificate?.document?.id ?? null);
  const [notes, setNotes] = useState(certificate?.notes ?? "");
  const traced = !!line || !!certificate?.receiptLine || !!certificate?.lot || heat.trim();
  const covers = !!line?.part || !!line?.material || !!certificate || material.trim();
  const ok = supplierId && number.trim() && kind && traced && covers;

  const submit = () => {
    const body = { certificateNumber: number.trim(), kind, heatNumber: heat.trim() || null, specification: spec.trim() || null, issuedOn, documentId, notes: notes.trim() || null };
    if (certificate) return mutation.mutate({ action: "update", id: certificate.id, body: { ...body, material: certificate.part ? undefined : material.trim() || null } }, { onSuccess: onClose });
    mutation.mutate({ action: "record", body: { ...body, supplierId, receiptLineId: line?.id ?? null, material: line ? undefined : material.trim() || null } }, { onSuccess: onClose });
  };

  return (
    <Dialog title={certificate ? "Edit the certificate" : "Record a material certificate"} onClose={onClose} width="max-w-2xl">
      <form noValidate className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); if (ok && !mutation.isPending) submit(); }}>
        <p className="text-sm text-secondary-text">
          {line ? "It covers this receipt line and its lot." : "Name the heat number so the certificate can be traced; recording it from a receipt line links the line and lot too."} A quality manager accepts or rejects it afterwards.
        </p>
        {!supplier && !certificate && (
          <ComboField label="Supplier" required value={supplierId} onChange={setSupplierId} filterLocally={false} onSearchChange={setSupplierSearch}
            options={(suppliers.data?.data ?? []).map((s) => ({ value: s.id, label: `${s.code} · ${s.displayName || s.name}` }))} />
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Certificate number" required value={number} onChange={(e) => setNumber(e.target.value)} maxLength={100} />
          <ComboField label="Kind" required value={kind} onChange={setKind} options={CERT_KINDS} />
          <Field label="Heat number" required={!line && !certificate?.receiptLine && !certificate?.lot} value={heat} onChange={(e) => setHeat(e.target.value)} maxLength={100} hint="Leave empty only when the receipt line or lot traces it" />
          <Field label="Specification" value={spec} onChange={(e) => setSpec(e.target.value)} maxLength={200} placeholder="For example EN 10025 S355" />
          {!line && !certificate?.part && <Field label="Material" required value={material} onChange={(e) => setMaterial(e.target.value)} maxLength={200} hint="What it covers, in words" />}
          <RHFDatePickerPopout label="Issued on" value={issuedOn} onChange={setIssuedOn} valueFormat="iso" clearable maxDate={new Date()} />
        </div>
        <DocumentPicker supplierId={supplierId} documents={docs.data?.data ?? []} label="Certificate file" value={documentId} onChange={setDocumentId} placeholder={supplierId ? "Choose a document of the supplier" : "Choose the supplier first"} hint="A document of the supplier, or add a new one here" />
        <TextAreaField label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} rows={2} />
        <FormError error={mutation.error} />
        <div className="flex justify-end gap-2">
          <CTAButton buttonType="button" type="neutral" size="md" onClick={onClose}>Cancel</CTAButton>
          <CTAButton buttonType="submit" type="main" size="lg" disabled={!ok || mutation.isPending}>{mutation.isPending ? "Saving…" : certificate ? "Save changes" : "Record certificate"}</CTAButton>
        </div>
      </form>
    </Dialog>
  );
};

/** Accept or reject (a rejection needs a note) or withdraw (a reason) a certificate. */
export const CertificateDecisionDialog = ({ certificate, mode, onClose }) => {
  const mutation = useCertificateMutation();
  const [text, setText] = useState("");
  const [accept, setAccept] = useState(mode !== "reject");
  const withdraw = mode === "withdraw";
  const need = withdraw || !accept ? 3 : 0;
  const title = withdraw ? "Withdraw the certificate" : "Review the certificate";
  const submit = () =>
    mutation.mutate(withdraw ? { action: "withdraw", id: certificate.id, body: { reason: text.trim() } } : { action: "review", id: certificate.id, body: { accept, note: text.trim() || null } }, { onSuccess: onClose });
  return (
    <Dialog title={`${title}: ${certificate.certificateNumber}`} onClose={onClose} width="max-w-lg">
      <form noValidate className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); if (text.trim().length >= need && !mutation.isPending) submit(); }}>
        <p className="text-sm text-secondary-text">
          {withdraw ? "A withdrawn certificate is kept, with the reason, and no longer counts. Record the right one afterwards." : "Check the heat, grade and values against the order. A reviewed certificate cannot be edited; withdraw it if it is wrong."}
        </p>
        {!withdraw && (
          <div className="flex gap-2">
            <CTAButton buttonType="button" type={accept ? "success" : "neutral"} size="md" onClick={() => setAccept(true)} aria-pressed={accept}>Accept</CTAButton>
            <CTAButton buttonType="button" type={accept ? "neutral" : "danger"} size="md" onClick={() => setAccept(false)} aria-pressed={!accept}>Reject</CTAButton>
          </div>
        )}
        <TextAreaField label={withdraw ? "Why is it being withdrawn?" : accept ? "Note" : "Why is it rejected?"} required={need > 0} value={text} onChange={(e) => setText(e.target.value)} maxLength={1000} rows={3} />
        <FormError error={mutation.error} />
        <div className="flex justify-end gap-2">
          <CTAButton buttonType="button" type="neutral" size="md" onClick={onClose}>Cancel</CTAButton>
          <CTAButton buttonType="submit" type={withdraw || !accept ? "danger" : "main"} size="lg" disabled={text.trim().length < need || mutation.isPending}>{mutation.isPending ? "Saving…" : withdraw ? "Withdraw" : accept ? "Accept" : "Reject"}</CTAButton>
        </div>
      </form>
    </Dialog>
  );
};
