import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useNcrs } from "../../hooks/useNcr";
import { useScarMutation, useSupplier, useSupplierRegister } from "../../hooks/useSupplierQuality";
import { formatDate, sourceLabel } from "../../lib/ncr";
import { SCAR_SEVERITIES, newClientKey, scarPath } from "../../lib/supplierScars";
import { OPEN_NC_STAGES } from "../../lib/supplierQuality";
import CTAButton from "../CTAButton";
import ComboField from "../ui/ComboField";
import Dialog from "../ui/Dialog";
import Field from "../ui/Field";
import RHFDatePickerPopout from "../ui/RHFDatePickerPopout";
import SlidingToggle from "../ui/SlidingToggle";
import { FormError, TextAreaField } from "../master-data/shared";

const today = () => new Date().toISOString().slice(0, 10);
const tomorrow = () => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
const inDays = (n) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

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
        <CTAButton buttonType="submit" type="main" size="lg" disabled={!ok || mutation.isPending}>
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
  const rows = supplierId ? (ncrs.data?.data ?? []) : [];
  const toggle = (id) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
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
      <Field label="Title" required value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} placeholder="For example: Bent brackets on pallet 4" />
      <TextAreaField label="The problem" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={4000} rows={3} hint="What the supplier is being asked to look into." />
      <div className="flex flex-col gap-1">
        <span className="text-sm font-medium text-secondary-text">Severity</span>
        <SlidingToggle ariaLabel="Severity" mode="radio" options={[...SCAR_SEVERITIES].reverse().map((s) => ({ value: s.key, label: s.label }))} value={severity} onChange={setSeverity} />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <RHFDatePickerPopout label="Response due" valueFormat="iso" clearable value={dueOn} onChange={(v) => setDueOn(v ?? "")} minDate={today()} placeholder="No date yet" hint="Needed before it can be issued" />
        <ComboField label="Supplier contact" value={contactId} onChange={setContactId} placeholder="Choose later" disabled={!supplierId}
          options={(detail.data?.contacts ?? []).filter((c) => c.active).map((c) => ({ value: c.id, label: c.name, hint: c.email ?? undefined }))} />
      </div>
      <fieldset className="flex flex-col gap-1">
        <legend className="text-sm font-medium text-secondary-text">Non-conformances this is about</legend>
        {!supplierId ? (
          <p className="text-sm text-secondary-text">Choose a supplier to see its open non-conformances.</p>
        ) : ncrs.isLoading ? (
          <p className="text-sm text-secondary-text">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-secondary-text">This supplier has no open non-conformances. You can link some before issuing.</p>
        ) : (
          <ul className="flex max-h-48 flex-col gap-1 overflow-y-auto rounded-lg border border-border-color p-2">
            {rows.map((n) => (
              <li key={n.id}>
                <label className="flex cursor-pointer items-start gap-2 text-sm text-primary-text">
                  <input type="checkbox" className="mt-1" checked={picked.includes(n.id)} onChange={() => toggle(n.id)} />
                  <span>
                    <span className="font-medium">{n.reference}</span> · {n.title}
                    <span className="block text-xs text-secondary-text">{sourceLabel(n.source)} · detected {formatDate(n.detectedAt)}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </fieldset>
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
  const ok = title.trim().length >= 3;
  return (
    <CommandDialog title="Edit the SCAR" width="max-w-2xl" mutation={mutation} ok={ok} submitLabel="Save" onClose={onClose}
      onSubmit={() => run({ action: "update", id: scar.id, body: { title: title.trim(), problemDescription: description.trim(), severity, responseDueOn: dueOn || null, contactId } })}>
      <Field label="Title" required value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
      <TextAreaField label="The problem" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={4000} rows={3} />
      <SlidingToggle ariaLabel="Severity" mode="radio" options={[...SCAR_SEVERITIES].reverse().map((s) => ({ value: s.key, label: s.label }))} value={severity} onChange={setSeverity} />
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
  });
  return (
    <CommandDialog title={scar.responses.length ? "Record a new response" : "Record the supplier's response"} width="max-w-2xl" mutation={mutation} ok={ok} submitLabel="Record response" onClose={onClose}
      onSubmit={() => run({ action: "respond", id: scar.id, body: body() })}
      intro="Enter what the supplier told you. It waits for review: recording a response does not accept it or close the SCAR.">
      <TextAreaField label="Root cause" required value={rootCause} onChange={(e) => setRootCause(e.target.value)} maxLength={4000} rows={3} />
      <TextAreaField label="Containment" value={containment} onChange={(e) => setContainment(e.target.value)} maxLength={4000} rows={2} hint="What was done about product already made or shipped" />
      <TextAreaField label="Corrective action" required value={corrective} onChange={(e) => setCorrective(e.target.value)} maxLength={4000} rows={3} />
      <TextAreaField label="Preventive action" value={preventive} onChange={(e) => setPreventive(e.target.value)} maxLength={4000} rows={2} />
      <div className="grid gap-3 sm:grid-cols-2">
        <RHFDatePickerPopout label="Responded on" required valueFormat="iso" value={respondedOn} onChange={(v) => setRespondedOn(v ?? "")} maxDate={today()} />
        <RHFDatePickerPopout label="Planned completion" valueFormat="iso" clearable value={planned} onChange={(v) => setPlanned(v ?? "")} minDate={today()} placeholder="Not given" />
        <Field label="Answered by" value={by} onChange={(e) => setBy(e.target.value)} maxLength={200} placeholder="Name at the supplier" />
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
    <CommandDialog title="Extend the due date" mutation={mutation} ok={!!newDue && reason.trim().length >= 3} submitLabel="Extend" onClose={onClose}
      onSubmit={() => run({ action: "extend", id: scar.id, body: { newDueOn: newDue, reason: reason.trim() } })}
      intro={`The response is due ${formatDate(scar.responseDueOn)}. The original date is kept and the extension is recorded.`}>
      <RHFDatePickerPopout label="New due date" required valueFormat="iso" value={newDue} onChange={(v) => setNewDue(v ?? "")} minDate={scar.responseDueOn ? new Date(new Date(`${scar.responseDueOn}T00:00:00`).getTime() + 86_400_000).toISOString().slice(0, 10) : tomorrow()} />
      <TextAreaField label="Why" required value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} rows={2} />
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
