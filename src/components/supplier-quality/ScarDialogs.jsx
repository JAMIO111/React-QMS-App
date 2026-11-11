import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Trash2Icon } from "@/components/icons";
import { useNcr, useNcrs } from "../../hooks/useNcr";
import { useScarMutation, useScarPeople, useSupplier, useSupplierRegister } from "../../hooks/useSupplierQuality";
import { usePermissions } from "../../hooks/useQmsApi";
import { formatDate, sourceLabel } from "../../lib/ncr";
import { ROOT_CAUSE_METHODS, SCAR_SEVERITIES, breachFrom, newClientKey, scarPath } from "../../lib/supplierScars";
import { OPEN_NC_STAGES } from "../../lib/supplierQuality";
import CTAButton from "../CTAButton";
import ComboField from "../ui/ComboField";
import Dialog from "../ui/Dialog";
import Field from "../ui/Field";
import { LotPicker } from "../production/pickers";
import { PartPicker } from "../ncr/Pickers";
import RHFDatePickerPopout from "../ui/RHFDatePickerPopout";
import SlidingToggle from "../ui/SlidingToggle";
import { FormError, TextAreaField } from "../master-data/shared";
import { todayIso } from "@/lib/localDate";

const today = () => todayIso();
const tomorrow = () => todayIso(1);
const inDays = (n) => todayIso(n);

/** The shell every SCAR command dialog uses: a form, the error line, Cancel and the main button. Nothing is sent until the form is valid. */
const CommandDialog = ({ title, intro, mutation, ok, submitLabel, pendingLabel, onClose, onSubmit, width, children }) => (
  <Dialog title={title} onClose={onClose} width={width}>
    <form
      noValidate
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (ok && !mutation.isPending) onSubmit();
      }}>
      {intro && <p className="text-sm text-secondary-text">{intro}</p>}
      {children}
      <FormError error={mutation.error} />
      <div className="flex justify-end gap-2">
        <CTAButton buttonType="button" type="neutral" size="md" onClick={onClose}>
          Cancel
        </CTAButton>
        <CTAButton buttonType="submit" type="main" size="lg" disabled={!ok || mutation.isPending} loading={mutation.isPending}>
          {mutation.isPending ? (pendingLabel ?? "Saving…") : submitLabel}
        </CTAButton>
      </div>
    </form>
  </Dialog>
);

const useCommand = (onClose) => {
  const mutation = useScarMutation();
  const run = (args) => mutation.mutate(args, { onSuccess: onClose });
  return [mutation, run];
};

/** Raise a SCAR against a supplier and link some of that supplier's open non-conformances. Sends a client key, so a retry cannot make a second one. */
export const CreateScarDialog = ({ supplier: fixedSupplier = null, ncrId = null, onClose }) => {
  const navigate = useNavigate();
  const mutation = useScarMutation();
  const clientKey = useRef(newClientKey());
  const [supplierId, setSupplierId] = useState(fixedSupplier?.id ?? null);
  const [search, setSearch] = useState("");
  const suppliers = useSupplierRegister({ q: search || undefined, pageSize: 25 }, { enabled: !fixedSupplier });
  const detail = useSupplier(supplierId);
  const ncrs = useNcrs({ supplierId, stage: OPEN_NC_STAGES, sort: "detectedAt", order: "desc", pageSize: 50 });
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [severity, setSeverity] = useState("minor");
  const [dueOn, setDueOn] = useState(inDays(14));
  const [contactId, setContactId] = useState(null);
  const [picked, setPicked] = useState(ncrId ? [ncrId] : []);
  const [requirement, setRequirement] = useState("");
  const [evidence, setEvidence] = useState("");
  const [containment, setContainment] = useState("");
  const [ownerId, setOwnerId] = useState(null);
  const people = useScarPeople();
  const rows = supplierId ? (ncrs.data?.data ?? []) : [];
  const toggle = (id) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  // The first non-conformance picked fills in the title, the problem and the requirement breached, unless the person has already written their own.
  const lead = picked[0] ?? null;
  const leadNcr = useNcr(lead);
  const touched = useRef(new Set());
  const edited = (field, set) => (e) => { touched.current.add(field); set(e.target.value); };
  useEffect(() => {
    const n = leadNcr.data;
    if (!lead || !n || n.id !== lead) return;
    const t = touched.current;
    if (!t.has("title") && n.title) setTitle(n.title);
    if (!t.has("description") && n.description) setDescription(n.description);
    if (!t.has("requirement")) setRequirement(breachFrom(n));
  }, [lead, leadNcr.data]);
  const ok = !!supplierId && title.trim().length >= 3;

  const submit = () =>
    mutation.mutate(
      {
        action: "create",
        body: {
          supplierId,
          title: title.trim(),
          ...(description.trim() ? { problemDescription: description.trim() } : {}),
          severity,
          ...(dueOn ? { responseDueOn: dueOn } : {}),
          ...(contactId ? { contactId } : {}),
          ...(requirement.trim() ? { requirementBreached: requirement.trim() } : {}),
          ...(evidence.trim() ? { objectiveEvidence: evidence.trim() } : {}),
          ...(containment.trim() ? { containmentRequirements: containment.trim() } : {}),
          ...(ownerId ? { ownerId } : {}),
          ncrIds: picked.filter((id) => rows.some((n) => n.id === id)),
          clientKey: clientKey.current,
        },
      },
      { onSuccess: (scar) => { onClose(); navigate(scarPath(scar.id)); } },
    );

  return (
    <CommandDialog title="Raise a SCAR" width="max-w-2xl" mutation={mutation} ok={ok} submitLabel="Create draft" pendingLabel="Creating…" onClose={onClose} onSubmit={submit}
      intro="A supplier corrective action request asks the supplier to investigate and fix a problem. It starts as a draft: nothing reaches the supplier until you issue it.">
      {fixedSupplier ? (
        <p className="text-sm text-primary-text">
          Supplier: <strong>{fixedSupplier.displayName || fixedSupplier.name}</strong>
        </p>
      ) : (
        <ComboField label="Supplier" required value={supplierId} onChange={(v) => { setSupplierId(v); setContactId(null); setPicked([]); }} placeholder="Search suppliers…" filterLocally={false} onSearchChange={setSearch}
          options={(suppliers.data?.data ?? []).map((s) => ({ value: s.id, label: `${s.code} · ${s.displayName || s.name}` }))} />
      )}
      <div className="flex flex-col gap-2">
        <ComboField label="Non-conformance this is about" value={null} onChange={(v) => v && !picked.includes(v) && setPicked((p) => [...p, v])} disabled={!supplierId}
          placeholder={!supplierId ? "Choose a supplier first" : ncrs.isLoading ? "Loading…" : rows.length === 0 ? "This supplier has no open non-conformances" : "Choose a non-conformance"}
          hint="The first one fills in the title, the problem and the requirement breached from the non-conformance. You can still change them."
          options={rows.filter((n) => !picked.includes(n.id)).map((n) => ({ value: n.id, label: `${n.reference} · ${n.title}`, hint: `${sourceLabel(n.source)} · detected ${formatDate(n.detectedAt)}` }))} />
        {picked.length > 0 && (
          <ul className="flex flex-wrap gap-1.5" aria-label="Linked non-conformances">
            {picked.map((id) => {
              const n = rows.find((x) => x.id === id);
              return (
                <li key={id} className="flex items-center gap-1 rounded-full border border-border-color px-2 py-0.5 text-sm text-primary-text">
                  {n ? `${n.reference} · ${n.title}` : leadNcr.data?.id === id ? `${leadNcr.data.reference} · ${leadNcr.data.title}` : "Non-conformance"}
                  <button type="button" aria-label={`Remove ${n?.reference ?? "non-conformance"}`} className="text-secondary-text hover:text-error-color" onClick={() => toggle(id)}><Trash2Icon /></button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <Field label="Title" required value={title} onChange={edited("title", setTitle)} maxLength={200} placeholder="For example: Bent brackets on pallet 4" />
      <TextAreaField label="The problem" value={description} onChange={edited("description", setDescription)} maxLength={4000} rows={3} hint="What the supplier is being asked to look into." />
      <TextAreaField label="Requirement breached" value={requirement} onChange={edited("requirement", setRequirement)} maxLength={2000} rows={2} hint="The drawing, specification, order or agreement the product did not meet" />
      <TextAreaField label="Objective evidence" value={evidence} onChange={(e) => setEvidence(e.target.value)} maxLength={4000} rows={2} hint="What shows it: measurements, photos, inspection references" />
      <TextAreaField label="Containment required" value={containment} onChange={(e) => setContainment(e.target.value)} maxLength={4000} rows={2} hint="What you need the supplier to do now: segregate stock, stop shipments, inspect stock, review earlier deliveries" />
      <div className="flex flex-col gap-1">
        <span className="text-sm font-medium text-secondary-text">Severity</span>
        <SlidingToggle ariaLabel="Severity" mode="radio" options={[...SCAR_SEVERITIES].reverse().map((s) => ({ value: s.key, label: s.label }))} value={severity} onChange={setSeverity} />
      </div>
      <ComboField label="Internal owner" value={ownerId} onChange={setOwnerId} placeholder="Me" hint="Who follows this SCAR up. Defaults to you." options={(people.data ?? []).map((p) => ({ value: p.userId, label: p.name }))} />
      <div className="grid gap-3 sm:grid-cols-2">
        <RHFDatePickerPopout label="Response due" valueFormat="iso" clearable value={dueOn} onChange={(v) => setDueOn(v ?? "")} minDate={today()} placeholder="No date yet" hint="Needed before it can be issued" />
        <ComboField label="Supplier contact" value={contactId} onChange={setContactId} placeholder="Choose later" disabled={!supplierId}
          options={(detail.data?.contacts ?? []).filter((c) => c.active).map((c) => ({ value: c.id, label: c.name, hint: c.email ?? undefined }))} />
      </div>
    </CommandDialog>
  );
};

/** Draft only: change what is being asked. Once issued, only the contact can change (a due date moves by extension). */
export const EditScarDialog = ({ scar, onClose }) => {
  const [mutation, run] = useCommand(onClose);
  const detail = useSupplier(scar.supplier.id);
  const [title, setTitle] = useState(scar.title);
  const [description, setDescription] = useState(scar.problemDescription ?? "");
  const [severity, setSeverity] = useState(scar.severity);
  const [dueOn, setDueOn] = useState(scar.responseDueOn ?? "");
  const [contactId, setContactId] = useState(scar.contact?.id ?? null);
  const [requirement, setRequirement] = useState(scar.requirementBreached ?? "");
  const [evidence, setEvidence] = useState(scar.objectiveEvidence ?? "");
  const [containment, setContainment] = useState(scar.containmentRequirements ?? "");
  const [ownerId, setOwnerId] = useState(scar.owner?.id ?? null);
  const people = useScarPeople();
  const ok = title.trim().length >= 3 && !!ownerId;
  return (
    <CommandDialog title="Edit the SCAR" width="max-w-2xl" mutation={mutation} ok={ok} submitLabel="Save" onClose={onClose}
      onSubmit={() => run({ action: "update", id: scar.id, body: { title: title.trim(), problemDescription: description.trim(), requirementBreached: requirement.trim(), objectiveEvidence: evidence.trim(), containmentRequirements: containment.trim(), severity, responseDueOn: dueOn || null, contactId, ownerId } })}>
      <Field label="Title" required value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
      <TextAreaField label="The problem" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={4000} rows={3} />
      <TextAreaField label="Requirement breached" value={requirement} onChange={(e) => setRequirement(e.target.value)} maxLength={2000} rows={2} />
      <TextAreaField label="Objective evidence" value={evidence} onChange={(e) => setEvidence(e.target.value)} maxLength={4000} rows={2} />
      <TextAreaField label="Containment required" value={containment} onChange={(e) => setContainment(e.target.value)} maxLength={4000} rows={2} />
      <SlidingToggle ariaLabel="Severity" mode="radio" options={[...SCAR_SEVERITIES].reverse().map((s) => ({ value: s.key, label: s.label }))} value={severity} onChange={setSeverity} />
      <ComboField label="Internal owner" required value={ownerId} onChange={setOwnerId} options={(people.data ?? []).map((p) => ({ value: p.userId, label: p.name }))} />
      <div className="grid gap-3 sm:grid-cols-2">
        <RHFDatePickerPopout label="Response due" valueFormat="iso" clearable value={dueOn} onChange={(v) => setDueOn(v ?? "")} minDate={today()} placeholder="No date yet" />
        <ComboField label="Supplier contact" value={contactId} onChange={setContactId} placeholder="None" options={(detail.data?.contacts ?? []).filter((c) => c.active).map((c) => ({ value: c.id, label: c.name }))} />
      </div>
    </CommandDialog>
  );
};

export const AcknowledgeDialog = ({ scar, onClose }) => {
  const [mutation, run] = useCommand(onClose);
  const [note, setNote] = useState("");
  return (
    <CommandDialog title="Record the supplier's acknowledgement" mutation={mutation} ok submitLabel="Record" onClose={onClose} onSubmit={() => run({ action: "acknowledge", id: scar.id, body: note.trim() ? { note: note.trim() } : {} })}
      intro="The supplier has confirmed they received the request. This is recorded by you on their behalf and does not start the review.">
      <TextAreaField label="How and who (optional)" value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} rows={2} hint="For example: confirmed by email from their quality manager" />
    </CommandDialog>
  );
};

/** What the supplier sent back. It is kept as it came and waits for our review: a response never closes a SCAR. */
export const ResponseDialog = ({ scar, onClose }) => {
  const [mutation, run] = useCommand(onClose);
  const [rootCause, setRootCause] = useState("");
  const [containment, setContainment] = useState("");
  const [corrective, setCorrective] = useState("");
  const [preventive, setPreventive] = useState("");
  const [planned, setPlanned] = useState("");
  const [respondedOn, setRespondedOn] = useState(today());
  const [by, setBy] = useState("");
  const [contactId, setContactId] = useState(scar.contact?.id ?? null);
  const [extent, setExtent] = useState("");
  const [escape, setEscape] = useState("");
  const [responsible, setResponsible] = useState("");
  const [method, setMethod] = useState(null);
  const detail = useSupplier(scar.supplier.id);
  const ok = rootCause.trim().length >= 3 && corrective.trim().length >= 3 && !!respondedOn;
  const body = () => ({
    rootCause: rootCause.trim(),
    ...(containment.trim() ? { containment: containment.trim() } : {}),
    correctiveAction: corrective.trim(),
    ...(preventive.trim() ? { preventiveAction: preventive.trim() } : {}),
    ...(planned ? { plannedCompletionOn: planned } : {}),
    respondedOn,
    ...(by.trim() ? { respondedByName: by.trim() } : {}),
    ...(contactId ? { contactId } : {}),
    ...(extent.trim() ? { extentOfCondition: extent.trim() } : {}),
    ...(escape.trim() ? { escapePoint: escape.trim() } : {}),
    ...(responsible.trim() ? { responsibleName: responsible.trim() } : {}),
    ...(method ? { rootCauseMethod: method } : {}),
  });
  return (
    <CommandDialog title={scar.responses.length ? "Record a new response" : "Record the supplier's response"} width="max-w-2xl" mutation={mutation} ok={ok} submitLabel="Record response" onClose={onClose}
      onSubmit={() => run({ action: "respond", id: scar.id, body: body() })}
      intro="Enter what the supplier told you. It waits for review: recording a response does not accept it or close the SCAR.">
      <TextAreaField label="Root cause" required value={rootCause} onChange={(e) => setRootCause(e.target.value)} maxLength={4000} rows={3} />
      <ComboField label="How the root cause was found" value={method} onChange={setMethod} placeholder="Not stated" clearable options={ROOT_CAUSE_METHODS} />
      <TextAreaField label="Escape point" value={escape} onChange={(e) => setEscape(e.target.value)} maxLength={4000} rows={2} hint="Why the problem was not caught before it reached us" />
      <TextAreaField label="Extent of condition" value={extent} onChange={(e) => setExtent(e.target.value)} maxLength={4000} rows={2} hint="Where else the same problem could be: other lots, parts or customers" />
      <TextAreaField label="Containment" value={containment} onChange={(e) => setContainment(e.target.value)} maxLength={4000} rows={2} hint="What was done about product already made or shipped" />
      <TextAreaField label="Corrective action" required value={corrective} onChange={(e) => setCorrective(e.target.value)} maxLength={4000} rows={3} />
      <TextAreaField label="Preventive action" value={preventive} onChange={(e) => setPreventive(e.target.value)} maxLength={4000} rows={2} />
      <div className="grid gap-3 sm:grid-cols-2">
        <RHFDatePickerPopout label="Responded on" required valueFormat="iso" value={respondedOn} onChange={(v) => setRespondedOn(v ?? "")} maxDate={today()} />
        <RHFDatePickerPopout label="Planned completion" valueFormat="iso" clearable value={planned} onChange={(v) => setPlanned(v ?? "")} minDate={today()} placeholder="Not given" />
        <Field label="Answered by" value={by} onChange={(e) => setBy(e.target.value)} maxLength={200} placeholder="Name at the supplier" />
        <Field label="Responsible for the corrective action" value={responsible} onChange={(e) => setResponsible(e.target.value)} maxLength={200} placeholder="Name at the supplier" />
        <ComboField label="Supplier contact" value={contactId} onChange={setContactId} placeholder="None" options={(detail.data?.contacts ?? []).filter((c) => c.active).map((c) => ({ value: c.id, label: c.name }))} />
      </div>
    </CommandDialog>
  );
};

/** Our decision on the latest response. */
export const ReviewDialog = ({ scar, initial = "accepted", onClose }) => {
  const [mutation, run] = useCommand(onClose);
  const [decision, setDecision] = useState(initial);
  const [note, setNote] = useState("");
  return (
    <CommandDialog title="Decide on the response" mutation={mutation} ok={note.trim().length >= 3} submitLabel="Record decision" onClose={onClose}
      onSubmit={() => run({ action: "review", id: scar.id, body: { decision, note: note.trim() } })}>
      <SlidingToggle ariaLabel="Decision" mode="radio" options={[{ value: "accepted", label: "Accept" }, { value: "revision_requested", label: "Ask for a revision" }]} value={decision} onChange={setDecision} />
      <TextAreaField label={decision === "accepted" ? "Why it is acceptable" : "What the supplier must change"} required value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} rows={3} hint="Kept with the response it is about" />
    </CommandDialog>
  );
};

export const ImplementationDialog = ({ scar, onClose }) => {
  const [mutation, run] = useCommand(onClose);
  const [description, setDescription] = useState("");
  const [on, setOn] = useState(today());
  const [evidence, setEvidence] = useState("");
  return (
    <CommandDialog title="Record implementation" mutation={mutation} ok={description.trim().length >= 3 && !!on} submitLabel="Record" onClose={onClose}
      onSubmit={() => run({ action: "implement", id: scar.id, body: { description: description.trim(), implementedOn: on, ...(evidence.trim() ? { evidenceNote: evidence.trim() } : {}) } })}
      intro="The accepted fix has been carried out. Whether it worked is checked separately, afterwards.">
      <TextAreaField label="What was implemented" required value={description} onChange={(e) => setDescription(e.target.value)} maxLength={4000} rows={3} />
      <RHFDatePickerPopout label="Implemented on" required valueFormat="iso" value={on} onChange={(v) => setOn(v ?? "")} maxDate={today()} />
      <TextAreaField label="Evidence (optional)" value={evidence} onChange={(e) => setEvidence(e.target.value)} maxLength={2000} rows={2} hint="For example: photo and updated procedure received by email" />
    </CommandDialog>
  );
};

/** Effectiveness: did the fix work. Effective closes the SCAR; not effective sends it back to the supplier. */
export const VerificationDialog = ({ scar, onClose }) => {
  const [mutation, run] = useCommand(onClose);
  const [result, setResult] = useState("effective");
  const [method, setMethod] = useState("");
  const [note, setNote] = useState("");
  return (
    <CommandDialog title="Verify effectiveness" mutation={mutation} ok={method.trim().length >= 3 && note.trim().length >= 3} submitLabel={result === "effective" ? "Verify and close" : "Record and send back"} onClose={onClose}
      onSubmit={() => run({ action: "verify", id: scar.id, body: { result, method: method.trim(), note: note.trim() } })}
      intro="Check that the problem has stopped. An effective result closes the SCAR; if it did not work, the supplier is asked for a new response.">
      <SlidingToggle ariaLabel="Result" mode="radio" options={[{ value: "effective", label: "Effective" }, { value: "not_effective", label: "Not effective" }]} value={result} onChange={setResult} />
      <Field label="How it was checked" required value={method} onChange={(e) => setMethod(e.target.value)} maxLength={1000} placeholder="For example: inspected the next three deliveries" />
      <TextAreaField label="What was found" required value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} rows={3} />
    </CommandDialog>
  );
};

export const ExtendDialog = ({ scar, onClose }) => {
  const [mutation, run] = useCommand(onClose);
  const [newDue, setNewDue] = useState("");
  const [reason, setReason] = useState("");
  return (
    <CommandDialog title="Request more time" mutation={mutation} ok={!!newDue && reason.trim().length >= 3} submitLabel="Request extension" onClose={onClose}
      onSubmit={() => run({ action: "extend", id: scar.id, body: { newDueOn: newDue, reason: reason.trim() } })}
      intro={`The response is due ${formatDate(scar.responseDueOn)}. The date does not move until someone else with approval rights approves the request; the original date is always kept.`}>
      <RHFDatePickerPopout label="New due date" required valueFormat="iso" value={newDue} onChange={(v) => setNewDue(v ?? "")} minDate={scar.responseDueOn ? new Date(new Date(`${scar.responseDueOn}T00:00:00`).getTime() + 86_400_000).toISOString().slice(0, 10) : tomorrow()} />
      <TextAreaField label="Why the supplier needs more time" required value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} rows={2} />
    </CommandDialog>
  );
};

/** Approve or reject a request for more time. Never the person who asked. */
export const DecideExtensionDialog = ({ extension, onClose }) => {
  const [mutation, run] = useCommand(onClose);
  const [decision, setDecision] = useState("approve");
  const [note, setNote] = useState("");
  return (
    <CommandDialog title="Decide on the extension" mutation={mutation} ok={note.trim().length >= 3} submitLabel="Record decision" onClose={onClose}
      onSubmit={() => run({ action: "decideExtension", id: extension.id, body: { approve: decision === "approve", note: note.trim() } })}
      intro={`The supplier asked for the response date to move from ${formatDate(extension.previousDueOn)} to ${formatDate(extension.newDueOn)}: ${extension.reason}`}>
      <SlidingToggle ariaLabel="Decision" mode="radio" options={[{ value: "approve", label: "Approve" }, { value: "reject", label: "Reject" }]} value={decision} onChange={setDecision} />
      <TextAreaField label={decision === "approve" ? "Why it is justified" : "Why not"} required value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} rows={2} />
    </CommandDialog>
  );
};

/** Add something the problem affects: a part, a material, a lot, a receipt, with a quantity. */
export const ItemDialog = ({ scar, onClose }) => {
  const [mutation, run] = useCommand(onClose);
  const { can } = usePermissions();
  const [part, setPart] = useState(null);
  const [lot, setLot] = useState(null);
  const [material, setMaterial] = useState("");
  const [receipt, setReceipt] = useState("");
  const [quantity, setQuantity] = useState("");
  const [notes, setNotes] = useState("");
  const qty = quantity.trim() === "" ? null : Number(quantity);
  const ok = !!(part || lot || material.trim() || receipt.trim()) && (qty === null || (Number.isFinite(qty) && qty >= 0));
  return (
    <CommandDialog title="Add an affected item" mutation={mutation} ok={ok} submitLabel="Add" onClose={onClose}
      onSubmit={() => run({ action: "addItem", id: scar.id, body: { ...(part ? { partId: part } : {}), ...(lot ? { lotId: lot } : {}), ...(material.trim() ? { material: material.trim() } : {}), ...(receipt.trim() ? { receiptReference: receipt.trim() } : {}), ...(qty !== null ? { quantity: qty } : {}), ...(notes.trim() ? { notes: notes.trim() } : {}) } })}
      intro="Name at least one of a part, a material, a lot or a receipt. A lot brings its part with it.">
      {can("master_data.read") && <PartPicker label="Part" value={part} onChange={(id) => setPart(id)} clearable />}
      {can("production.read") && <LotPicker label="Lot" partId={part ?? undefined} value={lot} onChange={(id) => setLot(id)} clearable />}
      <Field label="Material" value={material} onChange={(e) => setMaterial(e.target.value)} maxLength={200} placeholder="For example: steel bar 20 mm" />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Receipt or delivery reference" value={receipt} onChange={(e) => setReceipt(e.target.value)} maxLength={100} placeholder="Delivery note or PO" />
        <Field label="Quantity" type="number" min="0" step="any" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
      </div>
      <Field label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={1000} />
    </CommandDialog>
  );
};

/** Asks for a reason, then sends one command (cancel the SCAR, or end the link to a non-conformance). */
export const ReasonCommandDialog = ({ title, intro, label, submitLabel, action, id, onClose }) => {
  const [mutation, run] = useCommand(onClose);
  const [reason, setReason] = useState("");
  return (
    <CommandDialog title={title} intro={intro} mutation={mutation} ok={reason.trim().length >= 3} submitLabel={submitLabel} onClose={onClose} onSubmit={() => run({ action, id, body: { reason: reason.trim() } })}>
      <TextAreaField label={label} required value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} rows={3} />
    </CommandDialog>
  );
};

/** Link another of this supplier's open non-conformances. */
export const LinkNcrDialog = ({ scar, onClose }) => {
  const [mutation, run] = useCommand(onClose);
  const ncrs = useNcrs({ supplierId: scar.supplier.id, stage: OPEN_NC_STAGES, sort: "detectedAt", order: "desc", pageSize: 100 });
  const linked = new Set(scar.ncrs.filter((n) => !n.endedAt).map((n) => n.ncr.id));
  const options = (ncrs.data?.data ?? []).filter((n) => !linked.has(n.id)).map((n) => ({ value: n.id, label: `${n.reference} · ${n.title}`, hint: sourceLabel(n.source) }));
  const [ncrId, setNcrId] = useState(null);
  return (
    <CommandDialog title="Link a non-conformance" mutation={mutation} ok={!!ncrId} submitLabel="Link" pendingLabel="Linking…" onClose={onClose} onSubmit={() => run({ action: "linkNcr", id: scar.id, body: { ncrId } })}
      intro="Only open non-conformances that name this supplier can be linked.">
      <ComboField label="Non-conformance" required value={ncrId} onChange={setNcrId} placeholder="Choose one…" options={options} emptyMessage={ncrs.isLoading ? "Loading…" : "No other open non-conformance names this supplier"} />
    </CommandDialog>
  );
};
