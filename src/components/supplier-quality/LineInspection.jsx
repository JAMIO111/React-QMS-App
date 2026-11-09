import { useState } from "react";
import { Link } from "react-router-dom";
import { usePermissions } from "../../hooks/useQmsApi";
import { useIncomingMutation } from "../../hooks/useIncoming";
import { DECISIONS, LINE_STATUS, levelLabel, strategyLabel } from "../../lib/incoming";
import { ncrPath } from "../../lib/ncr";
import { certificateSummary } from "../../lib/materialCertificates";
import CTAButton from "../CTAButton";
import { RecordCertificateDialog } from "./CertificateDialogs";
import Callout from "../ui/Callout";
import ComboField from "../ui/ComboField";
import Dialog from "../ui/Dialog";
import Field from "../ui/Field";
import { FormError, TextAreaField } from "../master-data/shared";

export const LineStatusPill = ({ status }) => {
  const s = LINE_STATUS[status] ?? LINE_STATUS.not_required;
  return <span className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${s.tone}`}>{s.label}</span>;
};

const DispositionDialog = ({ line, onClose }) => {
  const mutation = useIncomingMutation();
  const [decision, setDecision] = useState(null);
  const [reason, setReason] = useState("");
  const [conditions, setConditions] = useState("");
  const ok = decision && reason.trim() && (decision !== "conditional" || conditions.trim());
  return (
    <Dialog title="Decide what happens to this material" onClose={onClose} width="max-w-lg">
      <form noValidate className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); if (ok && !mutation.isPending) mutation.mutate({ action: "disposition", id: line.id, body: { decision, reason: reason.trim(), conditions: decision === "conditional" ? conditions.trim() : null } }, { onSuccess: onClose }); }}>
        <p className="text-sm text-secondary-text">Accepting needs an acceptable inspection where one is required. Accepting on conditions, or changing a rejection, needs approval rights. Every decision is kept.</p>
        <ComboField label="Decision" required value={decision} onChange={setDecision} options={DECISIONS} />
        {decision === "conditional" && <TextAreaField label="Conditions" required value={conditions} onChange={(e) => setConditions(e.target.value)} maxLength={2000} rows={2} />}
        <TextAreaField label="Why" required value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} rows={3} />
        <FormError error={mutation.error} />
        <div className="flex justify-end gap-2">
          <CTAButton buttonType="button" type="neutral" size="md" onClick={onClose}>Cancel</CTAButton>
          <CTAButton buttonType="submit" type="main" size="lg" disabled={!ok || mutation.isPending}>{mutation.isPending ? "Saving…" : "Record decision"}</CTAButton>
        </div>
      </form>
    </Dialog>
  );
};

const RaiseNcrDialog = ({ line, onClose }) => {
  const mutation = useIncomingMutation();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [severity, setSeverity] = useState("minor");
  const [quantity, setQuantity] = useState(String(line.quantityReceived ?? ""));
  const ok = title.trim() && description.trim();
  return (
    <Dialog title="Raise a non-conformance" onClose={onClose} width="max-w-lg">
      <form noValidate className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); if (ok && !mutation.isPending) mutation.mutate({ action: "raiseNcr", id: line.id, body: { title: title.trim(), description: description.trim(), severity, quantity: quantity ? Number(quantity) : null } }, { onSuccess: onClose }); }}>
        <p className="text-sm text-secondary-text">A draft non-conformance is made, naming the supplier, the part and the lot, with source goods receiving. Pick its category on the non-conformance before opening it.</p>
        <Field label="Title" required value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
        <TextAreaField label="What is wrong" required value={description} onChange={(e) => setDescription(e.target.value)} maxLength={4000} rows={4} />
        <div className="grid gap-3 sm:grid-cols-2">
          <ComboField label="Severity" required value={severity} onChange={setSeverity} options={[{ value: "minor", label: "Minor" }, { value: "major", label: "Major" }, { value: "critical", label: "Critical" }]} />
          <Field label="Quantity affected" type="number" min="0" step="any" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
        </div>
        <FormError error={mutation.error} />
        <div className="flex justify-end gap-2">
          <CTAButton buttonType="button" type="neutral" size="md" onClick={onClose}>Cancel</CTAButton>
          <CTAButton buttonType="submit" type="main" size="lg" disabled={!ok || mutation.isPending}>{mutation.isPending ? "Saving…" : "Raise non-conformance"}</CTAButton>
        </div>
      </form>
    </Dialog>
  );
};

/** Under one receipt line: why inspection is (not) needed, how far it has got, the decision and the actions open to the person. */
export const LineInspection = ({ line, receiptCancelled, supplier }) => {
  const { can } = usePermissions();
  const mutation = useIncomingMutation();
  const [dialog, setDialog] = useState(null);
  const d = line.determination;
  const a = line.assessment;
  const live = !receiptCancelled;
  const canManage = can("receiving.manage");
  return (
    <div className="flex flex-col gap-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <LineStatusPill status={line.status} />
        {line.lotStatus === "on_hold" && <span className="text-xs text-secondary-text">Lot on hold</span>}
      </div>
      {d && (
        <p className="text-xs text-secondary-text">
          {d.required ? `${strategyLabel(d.strategy)}, ${levelLabel(d.level).toLowerCase()}${d.sampleSize ? `, ${d.sampleSize} units` : ""}` : "No inspection required"}
          {d.ruleName ? ` · rule: ${d.ruleName}` : ""} · {d.basis}
        </p>
      )}
      {a && d?.required && (
        <p className="text-xs text-secondary-text">
          {a.inspectionId ? <Link to={`/Inspections/${a.inspectionId}`} className="text-link-color hover:underline">{a.inspectionReference}</Link> : "Not started"}
          {a.inspectionId && ` · ${a.samples}${a.requiredSamples ? ` of ${a.requiredSamples}` : ""} sampled, ${a.failedSamples} failing · ${a.outcome === "acceptable" ? "acceptable" : a.outcome === "not_acceptable" ? "not acceptable" : "incomplete"}`}
        </p>
      )}
      {line.disposition?.reason && <p className="text-xs text-secondary-text">“{line.disposition.reason}” — {line.disposition.decidedBy?.name}{line.disposition.conditions ? ` · Conditions: ${line.disposition.conditions}` : ""}</p>}
      <p className="text-xs text-secondary-text">{certificateSummary(line.certificates)}</p>
      {line.ncrs?.length > 0 && <p className="text-xs">{line.ncrs.map((n) => <Link key={n.id} to={ncrPath(n.id)} className="mr-2 text-link-color hover:underline">{n.reference}</Link>)}</p>}
      {live && canManage && (
        <div className="flex flex-wrap gap-3 text-xs">
          {d?.required && !a?.inspectionId && can("inspection.record") && (
            <button type="button" className="text-link-color hover:underline" disabled={mutation.isPending} aria-label={`Start inspection of line ${line.lot?.lotNumber ?? ""}`} onClick={() => mutation.mutate({ action: "startInspection", id: line.id, body: {} })}>Start inspection</button>
          )}
          <button type="button" className="text-link-color hover:underline" onClick={() => setDialog("disposition")}>Decide</button>
          <button type="button" className="text-link-color hover:underline" onClick={() => setDialog("certificate")}>Add certificate</button>
          {can("ncr.create") && <button type="button" className="text-link-color hover:underline" onClick={() => setDialog("ncr")}>Raise non-conformance</button>}
        </div>
      )}
      {mutation.error && <Callout tone="error">{mutation.error.message}</Callout>}
      {dialog === "disposition" && <DispositionDialog line={line} onClose={() => setDialog(null)} />}
      {dialog === "certificate" && <RecordCertificateDialog line={line} supplier={supplier} onClose={() => setDialog(null)} />}
      {dialog === "ncr" && <RaiseNcrDialog line={line} onClose={() => setDialog(null)} />}
    </div>
  );
};
